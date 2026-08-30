// FACTUAL_MEMORY_TEST_HARNESS_001 — HARNAIS DE FUMÉE DE LA MÉMOIRE FACTUELLE.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// Un banc d'essai OBSERVATIONNEL : il exécute le VRAI pipeline factuel
// (registre des candidats → Bridge → registre des assertions versionnées →
// ancres canoniques) avec des fixtures dorées ou un cas manuel, puis RELIT ce
// qui a été persisté avec les primitives de lecture cloisonnées de production,
// et ne rend PASS que si la relecture prouve chaque objet attendu.
//
//   ÉCRIRE → RELIRE → VÉRIFIER → RAPPORTER.
//
// ── CE QU'IL N'EST PAS ──────────────────────────────────────────────────────
// Aucune logique métier dupliquée, aucune persistance parallèle, aucun
// endpoint HTTP, aucun LLM, aucun réseau, aucun appel payant. La projection
// Evidence est VALIDÉE mais PAS persistée par le harnais : sa persistance
// appartient à la route d'adjudication authentifiée, que ce banc ne
// contourne pas (limite documentée, pas un oubli).
//
// ── ISOLATION ───────────────────────────────────────────────────────────────
// Espace de travail DÉTERMINISTE et RÉSERVÉ (`ws_factual_harness`), compte
// synthétique — jamais un identifiant de production. L'exécution REFUSE tout
// environnement qui ne se prouve pas non-production (fail closed).
import {
  hitFromCandidate, registerCandidates, readCandidate,
} from '../signalCandidates'
import {
  promoteToEvidence, sourceEvidenceFromHit,
  type HumanFactConfirmation, type SourceEvidence,
} from '../signalBridge'
import {
  buildSourceAssertions, readSourceAssertion, recordSourceAssertions,
  isSourceAssertion, sourceAssertionsEnabled, SOURCE_ASSERTION_KIND,
} from '../sourceAssertion'
import {
  buildCanonicalAnchors, recordCanonicalAnchors, canonicalFactsEnabled,
  readCanonicalEvent, readCanonicalStateSnapshot,
  CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND,
} from '../canonicalFact'
import { canonicalJson, isAcquisitionFactV2 } from '../acquisitionV2'
import type { CandidateRead } from '../signalCandidates'
import { isEvidenceEvent } from '../validators'
import { mapClaim, canonicalKey } from '../signalBridge'
import { supabaseConfigured } from '../../../supabase/client'
import { deleteItem, listItemsStrict } from '../../../supabase/store'
import { SIGNAL_CANDIDATE_KIND } from '../signalCandidates'
import type { AcquisitionFactV2, SignalHit } from '../../../../types/prospector'

// ── CONSTANTES D'ISOLATION ──────────────────────────────────────────────────

/** Espace RÉSERVÉ au harnais. Le nettoyage refuse tout autre espace. */
export const HARNESS_WORKSPACE = 'ws_factual_harness'
/** SIREN synthétique — n'existe pas au registre ; jamais un compte réel. */
export const HARNESS_ACCOUNT = 'acc_siren_999000001'
const JOUR_FAIT = '2026-08-12'
const OBSERVED = '2026-09-30T12:00:00.000Z'
const SITE = 'https://example.test'

// ── MODÈLE DE RÉSULTAT (métadonnées de harnais, PAS un schéma factuel) ──────

export type HarnessVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'INVALID_INPUT'

export interface HarnessStep { name: string; ok: boolean; detail?: string }

export interface HarnessEnvironment {
  mode: 'LOCAL_SUPABASE' | 'IN_MEMORY'
  environment: 'LOCAL'
  workspace: string
  database: string
  sourceAssertions: string
  canonicalFacts: string
}

export interface HarnessPersistedRow { id: string; kind: string; summary: string }

export interface HarnessResult {
  caseName: string
  verdict: HarnessVerdict
  reason?: string
  environment?: HarnessEnvironment
  input: Record<string, unknown>
  steps: HarnessStep[]
  persisted: HarnessPersistedRow[]
  expected: Record<string, number>
  actual: Record<string, number>
  /** Lignes du tableau HIRING (jour / décompte / méthode / ids). */
  table?: Array<Record<string, string | number>>
}

export interface HarnessOptions {
  /** Mode unitaire EXPLICITE : repli mémoire admis ET ANNONCÉ comme tel. */
  allowMemory?: boolean
  /** Cas manuel (PART 4) — enveloppe JSON documentée ci-dessous. */
  manualCase?: unknown
  /** COUTURE DE TEST (H9) : exécutée entre l'écriture et la relecture. */
  betweenWriteAndVerify?: () => void | Promise<void>
}

// ── GARDE D'ENVIRONNEMENT — FAIL CLOSED ─────────────────────────────────────

const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function urlSupabaseBrute(): string | undefined {
  // Mêmes NOMS de variables que `lib/supabase/client.ts` — les VALEURS ne sont
  // jamais imprimées ni journalisées par ce harnais.
  return process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || process.env.SUPABASE_PROJECT_URL
}

/**
 * L'environnement doit se PROUVER non-production. Toute ambiguïté ⇒ refus.
 * Aucune valeur d'environnement n'est recopiée dans un refus.
 */
export function verifyHarnessEnvironment(
  allowMemory: boolean,
): { ok: true; env: HarnessEnvironment } | { ok: false; reason: string } {
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, reason: 'PRODUCTION_REFUSED: NODE_ENV=production' }
  }
  if (process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined) {
    return { ok: false, reason: 'PRODUCTION_REFUSED: exécution Vercel détectée' }
  }

  const drapeaux = {
    sourceAssertions: sourceAssertionsEnabled() ? 'ON (process-local)' : 'OFF',
    canonicalFacts: canonicalFactsEnabled() ? 'ON (process-local)' : 'OFF',
  }
  if (!sourceAssertionsEnabled() || !canonicalFactsEnabled()) {
    return {
      ok: false,
      reason: 'FLAGS_OFF: SIGNAL_ARCH_V1_SOURCE_ASSERTIONS et SIGNAL_ARCH_V1_CANONICAL_FACTS '
        + 'doivent être activés pour CE processus (le lanceur du harnais le fait ; rien n\'est persisté)',
    }
  }

  if (supabaseConfigured()) {
    let hote = ''
    try { hote = new URL(String(urlSupabaseBrute())).hostname } catch { hote = '' }
    if (!HOTES_LOCAUX.has(hote)) {
      // ⚠️ L'hôte n'est PAS recopié : un refus ne doit divulguer aucune valeur.
      return { ok: false, reason: 'NON_LOCAL_DATABASE_REFUSED: SUPABASE_URL ne désigne pas localhost' }
    }
    return {
      ok: true,
      env: {
        mode: 'LOCAL_SUPABASE', environment: 'LOCAL', workspace: HARNESS_WORKSPACE,
        database: `supabase local (${hote}, via SUPABASE_URL)`, ...drapeaux,
      },
    }
  }

  if (!allowMemory) {
    // ⚠️ JAMAIS de repli silencieux : un test de persistance sans persistance
    // n'est pas un PASS, c'est un prérequis manquant.
    return {
      ok: false,
      reason: 'LOCAL_SUPABASE_REQUIRED: aucune base locale détectée '
        + '(`npm run db:test:up`), ou relancer explicitement en mode -Memory (unitaire, non persistant)',
    }
  }
  return {
    ok: true,
    env: {
      mode: 'IN_MEMORY', environment: 'LOCAL', workspace: HARNESS_WORKSPACE,
      database: 'repli mémoire du processus (globalThis Map) — RIEN n\'est persisté', ...drapeaux,
    },
  }
}

// ── FIXTURES DORÉES (contrat V2 de production, aucune variante) ─────────────

function v2Funding(amountMinor = 1_200_000_000, asPublished = '€12M'): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'FUNDING',
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: JOUR_FAIT, occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'ACME TEST lève 12 M€ en série A', icebreaker: 'bravo pour la série A' },
    extraction: { mode: 'claude-web', promptVersion: 'factual-harness-golden' },
    payload: {
      family: 'FUNDING',
      amount: { amountMinor, currency: 'EUR', asPublished },
      roundStage: 'SERIES_A',
      investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }],
    },
  }
}

function v2Executive(): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'EXECUTIVE_CHANGE',
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: JOUR_FAIT, occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'Marie Dupont nommée CRO', icebreaker: 'félicitations' },
    extraction: { mode: 'claude-web', promptVersion: 'factual-harness-golden' },
    payload: {
      family: 'EXECUTIVE_CHANGE', direction: 'APPOINTMENT',
      roleFunction: 'SALES', roleSeniority: 'C_LEVEL',
      person: { fullNameRaw: 'Marie Dupont', normalizedName: 'marie dupont', verification: 'NAME_ONLY' },
      roleTitleRaw: 'CRO',
    },
  }
}

function v2Hiring(valeur: number): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'HIRING_SNAPSHOT',
    claimNature: 'STATE', eventStatus: 'UNKNOWN',
    occurredAt: null, occurredAtPrecision: 'UNKNOWN', sourcePublishedAt: null,
    rawDetail: { detail: `${valeur} postes Sales ouverts`, icebreaker: 'ça recrute' },
    extraction: { mode: 'claude-web', promptVersion: 'factual-harness-golden' },
    payload: {
      family: 'HIRING_SNAPSHOT', roleFunction: 'SALES', roleStatus: 'OPEN',
      openingsObserved: { value: valeur, method: 'ENUMERATED_POSTINGS' },
    },
  }
}

/**
 * COQUILLE HÉRITÉE HONNÊTE d'un cas MANUEL — dérivée du fait V2, champ à
 * champ, JAMAIS inventée (FACTUAL_MANUAL_REPLAY_PARITY_001, défaut A).
 *
 * ⚠️ Les six fixtures dorées gardent `hitDe` tel quel : leurs identités de
 * candidats signées ne doivent pas bouger d'un octet. Ici, un EXECUTIVE réel
 * ne peut plus être enregistré sous une revendication héritée « levée » datée
 * d'un jour synthétique, et `sourcePublishedAt` du fait V2 atteint la
 * provenance. `UNKNOWN` reste préférable à une valeur de compatibilité
 * fabriquée.
 */
function hitManuel(url: string, v2: AcquisitionFactV2, identite: IdentiteCompte): SignalHit {
  const etat = v2.family === 'HIRING_SNAPSHOT'
  const type = v2.family === 'FUNDING' ? 'levée' : v2.family === 'EXECUTIVE_CHANGE' ? 'actu' : 'recrutement'
  return {
    company: identite.company, signalType: type,
    detail: v2.rawDetail.detail, icebreaker: v2.rawDetail.icebreaker,
    sourceUrl: url, verified: false, siren: identite.siren,
    claimNature: v2.claimNature,
    eventStatus: v2.eventStatus,
    eventDate: etat ? null : v2.occurredAt,
    eventDatePrecision: etat ? 'UNKNOWN' : v2.occurredAtPrecision,
    sourcePublishedAt: v2.sourcePublishedAt,
    roleStatus: etat ? (v2.payload as any).roleStatus : 'UNKNOWN',
    roleFunction: v2.family === 'FUNDING' ? 'UNKNOWN' : (v2.payload as any).roleFunction,
    extraction: v2.extraction,
    v2,
  } as SignalHit
}

function hitDe(url: string, v2: AcquisitionFactV2, identite: IdentiteCompte): SignalHit {
  const etat = v2.family === 'HIRING_SNAPSHOT'
  return {
    company: identite.company, signalType: etat ? 'recrutement' : 'levée',
    detail: '', icebreaker: '', sourceUrl: url, verified: false,
    siren: identite.siren,
    claimNature: etat ? 'STATE' : 'EVENT',
    eventStatus: etat ? 'UNKNOWN' : 'COMPLETED',
    eventDate: etat ? null : JOUR_FAIT, eventDatePrecision: etat ? 'UNKNOWN' : 'DAY',
    sourcePublishedAt: null,
    roleStatus: etat ? 'OPEN' : 'UNKNOWN', roleFunction: etat ? 'SALES' : 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'factual-harness-golden' },
    v2,
  } as SignalHit
}

/**
 * ÉGALITÉ SÉMANTIQUE de deux blocs V2 — par la sérialisation CANONIQUE de
 * production (clés triées récursivement), JAMAIS par `JSON.stringify`.
 *
 * ⚠️ LA LEÇON DU PREMIER RUN WINDOWS RÉEL. PostgreSQL `jsonb` NE PRÉSERVE PAS
 * l'ordre des clés : un bloc relu de la base revient réordonné. Le validateur
 * (`isAcquisitionFactV2`, structurel) et les identités (`candidateId`,
 * `assertedFactHash`, bâtis sur `canonicalJson`) y sont insensibles — mesuré.
 * Mais une comparaison `JSON.stringify` dépend de l'ordre d'insertion : elle
 * était vraie en mémoire et fausse contre la vraie base, faisant échouer le
 * harnais sur un fait pourtant intact.
 */
export function sameSemanticFact(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * Diagnostic SÛR d'une relecture de candidat — une raison fermée, jamais une
 * valeur d'environnement ni un contenu brut.
 */
export function diagnoseCandidateReadBack(
  lu: CandidateRead | null, attendu: AcquisitionFactV2,
): { ok: boolean; reason: string } {
  if (lu === null) return { ok: false, reason: 'CANDIDATE_NOT_ISSUED' }
  if (lu.ok === false) {
    // Les DEUX états de `readCandidate` restent distincts : « absent ici » et
    // « je n'ai pas pu regarder » n'appellent pas le même geste.
    return { ok: false, reason: lu.state }
  }
  if (lu.candidate.claim.v2 === null) return { ok: false, reason: 'CANDIDATE_V2_ABSENT_AFTER_READ' }
  if (!sameSemanticFact(lu.candidate.claim.v2, attendu)) {
    return { ok: false, reason: 'CANDIDATE_V2_MISMATCH_AFTER_READ' }
  }
  return { ok: true, reason: 'OK' }
}

interface Ronde { url: string; fact: AcquisitionFactV2; retrievedAt: string }

/**
 * Identité de COMPTE d'un cas — synthétique par défaut, RÉELLE en mode manuel.
 *
 * ⚠️ BLOCKER 1 (FACTUAL_REAL_WORLD_MANUAL_001) : l'enveloppe manuelle
 * acceptait `account` puis l'IGNORAIT — un cas Lupin Dental passait sous
 * l'identité ACME TEST. Le compte fourni traverse désormais tout le pipeline
 * (candidat → SourceEvidence → Evidence → assertions → ancres), TOUJOURS dans
 * l'espace isolé du harnais : aucune identité de production n'est créée.
 */
interface IdentiteCompte {
  company: string
  siren: string
  accountId: string
  /**
   * Site officiel du compte — le SEUL chemin vers le grade A pour une source
   * mono-URL (politique de source inchangée : une seule source B ne qualifie
   * pas). Optionnel et fourni par l'enveloppe manuelle ; absent ⇒ la politique
   * normale s'applique, aucun grade n'est offert.
   */
  officialWebsite: string | null
}

const IDENTITE_SYNTHETIQUE: IdentiteCompte = Object.freeze({
  company: 'ACME TEST', siren: '999000001', accountId: HARNESS_ACCOUNT,
  officialWebsite: SITE,
})

interface CasHarnais {
  description: string
  rondes: Ronde[]
  attendu: { assertions: number; events: number; snapshots: number }
  /** Absente ⇒ identité synthétique ACME TEST (les six cas dorés, inchangés). */
  identite?: IdentiteCompte
  /** Cas MANUEL réel : coquille héritée HONNÊTE dérivée du fait V2. */
  manuel?: true
}

const D = (j: string) => `${j}T07:30:00.000Z`

export const HARNESS_CASES: Readonly<Record<string, CasHarnais>> = Object.freeze({
  funding: {
    description: 'FUNDING doré : €12M / EUR / SERIES_A / Index Ventures LEAD',
    rondes: [{ url: `${SITE}/acme-series-a`, fact: v2Funding(), retrievedAt: D('2026-08-13') }],
    attendu: { assertions: 1, events: 1, snapshots: 0 },
  },
  executive: {
    description: 'EXECUTIVE doré : Marie Dupont, CRO, C_LEVEL, APPOINTMENT, NAME_ONLY',
    rondes: [{ url: `${SITE}/acme-cro`, fact: v2Executive(), retrievedAt: D('2026-08-13') }],
    attendu: { assertions: 1, events: 1, snapshots: 0 },
  },
  hiring: {
    description: 'HIRING doré : 15 → 22 → 8 postes Sales observés (ENUMERATED_POSTINGS)',
    rondes: [
      { url: `${SITE}/acme-careers`, fact: v2Hiring(15), retrievedAt: D('2026-09-01') },
      { url: `${SITE}/acme-careers`, fact: v2Hiring(22), retrievedAt: D('2026-09-15') },
      { url: `${SITE}/acme-careers`, fact: v2Hiring(8), retrievedAt: D('2026-09-30') },
    ],
    attendu: { assertions: 3, events: 0, snapshots: 3 },
  },
  'funding-correction': {
    description: 'Correction éditoriale : MÊME URL, €10M puis €12M — 2 assertions, 1 événement',
    rondes: [
      { url: `${SITE}/acme-series-a`, fact: v2Funding(1_000_000_000, '€10M'), retrievedAt: D('2026-08-13') },
      { url: `${SITE}/acme-series-a`, fact: v2Funding(), retrievedAt: D('2026-08-14') },
    ],
    attendu: { assertions: 2, events: 1, snapshots: 0 },
  },
  'funding-disagreement': {
    description: 'Désaccord multi-sources : URL A €10M, URL B €12M — 2 assertions, 1 événement',
    rondes: [
      { url: `${SITE}/presse-a`, fact: v2Funding(1_000_000_000, '€10M'), retrievedAt: D('2026-08-13') },
      { url: `${SITE}/presse-b`, fact: v2Funding(), retrievedAt: D('2026-08-13') },
    ],
    attendu: { assertions: 2, events: 1, snapshots: 0 },
  },
  'hiring-same-day-correction': {
    description: 'Correction même jour : 15 puis 16 — 2 assertions, 1 instantané',
    rondes: [
      { url: `${SITE}/acme-careers`, fact: v2Hiring(15), retrievedAt: D('2026-09-01') },
      { url: `${SITE}/acme-careers`, fact: v2Hiring(16), retrievedAt: '2026-09-01T20:00:00.000Z' },
    ],
    attendu: { assertions: 2, events: 0, snapshots: 1 },
  },
})

// ── CAS MANUEL (PART 4) ─────────────────────────────────────────────────────
//
// Contrat JSON — une ENVELOPPE MINCE autour du contrat de production
// `AcquisitionFactV2`, validé par LE MÊME validateur :
//
//   {
//     "account":     { "company": "ACME TEST", "siren": "999000001" },
//     "sourceUrl":   "https://example.test/mon-cas",
//     "retrievedAt": "2026-09-01T07:30:00.000Z",
//     "fact":        { ...AcquisitionFactV2... }
//   }

function casManuel(brut: unknown): { ok: true; cas: CasHarnais } | { ok: false; reason: string } {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) {
    return { ok: false, reason: 'MANUAL_INVALID: le fichier doit contenir un objet JSON' }
  }
  const m = brut as any
  const siren = String(m?.account?.siren ?? '')
  if (!/^\d{9}$/.test(siren)) {
    return { ok: false, reason: 'MANUAL_INVALID: account.siren doit compter 9 chiffres (synthétique accepté)' }
  }
  if (typeof m.sourceUrl !== 'string' || typeof m.retrievedAt !== 'string') {
    return { ok: false, reason: 'MANUAL_INVALID: sourceUrl et retrievedAt sont requis' }
  }
  // ⚠️ LE MÊME VALIDATEUR QUE LA PRODUCTION. Aucun second schéma.
  if (!isAcquisitionFactV2(m.fact)) {
    return { ok: false, reason: 'MANUAL_INVALID: fact ne satisfait pas AcquisitionFactV2 (fail closed, rien n\'est persisté)' }
  }
  const fact = m.fact as AcquisitionFactV2
  const etat = fact.family === 'HIRING_SNAPSHOT'
  const company = String(m?.account?.company ?? '').trim()
  if (company === '') {
    return { ok: false, reason: 'MANUAL_INVALID: account.company est requis' }
  }
  return {
    ok: true,
    cas: {
      description: `Cas manuel ${fact.family}`,
      rondes: [{ url: m.sourceUrl, fact, retrievedAt: m.retrievedAt }],
      attendu: { assertions: 1, events: etat ? 0 : 1, snapshots: etat ? 1 : 0 },
      manuel: true,
      // ⚠️ L'identité FOURNIE fait foi : `acc_siren_<siren réel>`, dans le
      // SEUL espace du harnais. Rien n'est créé côté production/staging.
      identite: {
        company, siren, accountId: `acc_siren_${siren}`,
        officialWebsite: typeof m?.account?.officialWebsite === 'string' && m.account.officialWebsite.trim() !== ''
          ? m.account.officialWebsite.trim()
          : null,
      },
    },
  }
}

// ── EXÉCUTION D'UNE RONDE — PIPELINE DE PRODUCTION, RIEN D'AUTRE ────────────

function confirmation(cle: string, urls: string[]): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED', canonicalKey: cle, confirmedBy: 'harness_operator',
    confirmedAt: OBSERVED, sourceUrls: urls,
  }
}

export async function runFactualCase(
  caseName: string, opts: HarnessOptions = {},
): Promise<HarnessResult> {
  const steps: HarnessStep[] = []
  const persisted: HarnessPersistedRow[] = []
  const echec = (verdict: HarnessVerdict, reason: string, extra: Partial<HarnessResult> = {}): HarnessResult => ({
    caseName, verdict, reason, input: {}, steps, persisted,
    expected: {}, actual: {}, ...extra,
  })

  const garde = verifyHarnessEnvironment(opts.allowMemory === true)
  if (garde.ok === false) {
    return echec(garde.reason.startsWith('MANUAL_INVALID') ? 'INVALID_INPUT' : 'BLOCKED', garde.reason)
  }
  const env = garde.env

  let cas: CasHarnais
  if (caseName === 'manual') {
    const m = casManuel(opts.manualCase)
    if (m.ok === false) return echec('INVALID_INPUT', m.reason, { environment: env })
    cas = m.cas
  } else {
    const defini = HARNESS_CASES[caseName]
    if (!defini) {
      return echec('INVALID_INPUT',
        `CASE_UNKNOWN: '${caseName}' — cas disponibles : ${Object.keys(HARNESS_CASES).join(', ')}, manual`,
        { environment: env })
    }
    cas = defini
  }

  const identite = cas.identite ?? IDENTITE_SYNTHETIQUE
  const input: Record<string, unknown> = {
    company: identite.company, account: identite.accountId, description: cas.description,
    sources: cas.rondes.map((r) => r.url),
  }

  const assertionsVues = new Map<string, { sourceUrl: string; fact: AcquisitionFactV2 }>()
  const eventsVus = new Map<string, string>()
  const snapshotsVus = new Map<string, string>()
  const table: Array<Record<string, string | number>> = []
  let ok = true
  const etape = (name: string, passe: boolean, detail?: string) => {
    steps.push({ name, ok: passe, ...(detail ? { detail } : {}) })
    if (!passe) ok = false
    return passe
  }

  for (const [i, rondePartagee] of cas.rondes.entries()) {
    const tag = cas.rondes.length > 1 ? ` (ronde ${i + 1})` : ''
    // ⚠️ COPIE PROFONDE PAR RONDE. Le repli mémoire du magasin stocke des
    // RÉFÉRENCES : sans copie, un objet persisté puis muté (une couture de
    // sabotage, un consommateur aval) muterait la FIXTURE partagée du module,
    // et chaque exécution suivante partirait d'un fait silencieusement altéré.
    const ronde: Ronde = JSON.parse(JSON.stringify(rondePartagee))

    // 1 — VALIDATION V2, par le validateur de production.
    if (!etape(`V2 validation${tag}`, isAcquisitionFactV2(ronde.fact))) continue

    // 2 — CANDIDAT : enregistrement serveur puis RELECTURE cloisonnée.
    const hit = cas.manuel === true
      ? hitManuel(ronde.url, ronde.fact, identite)
      : hitDe(ronde.url, ronde.fact, identite)
    const [cid] = await registerCandidates([hit], HARNESS_WORKSPACE)
    const luCandidat = cid ? await readCandidate(cid, HARNESS_WORKSPACE) : null
    const diag = diagnoseCandidateReadBack(luCandidat, ronde.fact)
    if (!etape(`Candidate${tag}`, diag.ok, diag.ok ? (cid as string) : `${diag.reason}${cid ? ` (${cid})` : ''}`)) continue
    persisted.push({ id: cid as string, kind: SIGNAL_CANDIDATE_KIND, summary: 'candidat (bloc V2 relu conforme)' })

    // ── REJEU COMME EN PRODUCTION (défaut B) ──────────────────────────────
    // ⚠️ À PARTIR D'ICI, LE HIT ORIGINAL N'EST PLUS UNE ENTRÉE. La route
    // `/api/signals/promote` reconstruit le hit DEPUIS LE REGISTRE
    // (`hitFromCandidate(readCandidate(...))`) — c'est la frontière de
    // confiance que ce banc doit exercer. L'objet en mémoire n'a servi qu'à
    // ÉMETTRE le candidat.
    const hitRejoue = hitFromCandidate((luCandidat as { ok: true; candidate: any }).candidate)

    // 3 — PROMOTION : Bridge réel, adjudication synthétique EXPLICITE.
    const source = sourceEvidenceFromHit(hitRejoue, identite.officialWebsite, { kind: 'ORIGINAL' }, { kind: 'UNVERIFIABLE' }, ronde.retrievedAt)
    if (!etape(`SourceEvidence${tag}`, !!source && sameSemanticFact(source.hit.v2, ronde.fact))) continue
    const claim = mapClaim(hitRejoue)
    if (typeof claim === 'string') { etape(`Evidence${tag}`, false, `mapClaim: ${claim}`); continue }
    const cle = canonicalKey(identite.accountId, claim)
    const promotion = promoteToEvidence({
      accountId: identite.accountId, observedAt: OBSERVED, sources: [source as SourceEvidence],
      confirmations: [confirmation(cle, [ronde.url])],
    })
    if (promotion.ok === false) { etape(`Evidence${tag}`, false, `refus: ${promotion.reason}`); continue }
    const evidenceOk = isEvidenceEvent(promotion.evidence)
      && sameSemanticFact((promotion.evidence as any).structuredFact, ronde.fact)
    // ⚠️ VALIDÉE, PAS PERSISTÉE PAR LE HARNAIS — voir l'en-tête du module.
    if (!etape(`Evidence${tag}`, evidenceOk, `${String(promotion.evidence.type)} (validée ; projection non persistée par le harnais)`)) continue

    // 4 — REGISTRE DES ASSERTIONS : écriture réelle puis relecture par id.
    const lot = {
      workspaceId: HARNESS_WORKSPACE, accountId: identite.accountId, canonicalClaimKey: promotion.canonicalKey,
      evidence: promotion.evidence, qualifyingSources: promotion.qualifyingSources,
    }
    const bilan = await recordSourceAssertions([lot], HARNESS_WORKSPACE)
    const construites = buildSourceAssertions(lot)

    if (opts.betweenWriteAndVerify) await opts.betweenWriteAndVerify()

    let assertionsOk = bilan.failed === 0 && construites.length > 0
    for (const a of construites) {
      const relu = await readSourceAssertion(a.id, HARNESS_WORKSPACE)
      const present = relu.ok === true && !!relu.value
        && isSourceAssertion(relu.value)
        && relu.value.workspaceId === HARNESS_WORKSPACE
        && relu.value.id === a.id
        && sameSemanticFact(relu.value.structuredFact, ronde.fact)
      if (!present) { assertionsOk = false; continue }
      assertionsVues.set(a.id, { sourceUrl: a.sourceUrl, fact: ronde.fact })
      persisted.push({ id: a.id, kind: SOURCE_ASSERTION_KIND, summary: `assertion versionnée (${a.sourceUrl})` })
    }
    if (!etape(`SourceAssertion${tag}`, assertionsOk)) continue

    // 5 — ANCRES CANONIQUES : dérivées des DURABLES, puis relues par id.
    const ancres = buildCanonicalAnchors({ ...lot, durableAssertionIds: new Set(bilan.durableIds) })
    await recordCanonicalAnchors([lot], HARNESS_WORKSPACE, new Set(bilan.durableIds))
    let ancresOk = true
    if (ancres.event) {
      const relu = await readCanonicalEvent(ancres.event.id, HARNESS_WORKSPACE)
      const present = relu.ok === true && !!relu.value
        && relu.value.workspaceId === HARNESS_WORKSPACE && relu.value.type === 'FUNDING_ROUND'
        && relu.value.occurredAt === ancres.event.occurredAt
      if (present) {
        eventsVus.set(ancres.event.id, 'FUNDING_ROUND')
        persisted.push({ id: ancres.event.id, kind: CANONICAL_EVENT_KIND, summary: `FUNDING_ROUND ${relu.ok === true && relu.value ? relu.value.occurredAt : ''}` })
      } else ancresOk = false
    }
    for (const e of ancres.execEvents) {
      const relu = await readCanonicalEvent(e.id, HARNESS_WORKSPACE)
      const present = relu.ok === true && !!relu.value
        && (relu.value as any).workspaceId === HARNESS_WORKSPACE
        && (relu.value as any).type === e.type
        && (relu.value as any).personKey === e.personKey
      if (present) {
        eventsVus.set(e.id, e.type)
        persisted.push({ id: e.id, kind: CANONICAL_EVENT_KIND, summary: `${e.type} ${e.personKey}` })
      } else ancresOk = false
    }
    for (const s of ancres.snapshots) {
      const relu = await readCanonicalStateSnapshot(s.id, HARNESS_WORKSPACE)
      const present = relu.ok === true && !!relu.value
        && relu.value.workspaceId === HARNESS_WORKSPACE
        && relu.value.stateObservedDay === s.stateObservedDay
      if (present) {
        snapshotsVus.set(s.id, s.stateObservedDay)
        persisted.push({ id: s.id, kind: CANONICAL_STATE_SNAPSHOT_KIND, summary: `HIRING_SNAPSHOT ${s.stateObservedDay}` })
      } else ancresOk = false
    }
    const nomAncre = ancres.snapshots.length > 0 ? 'CanonicalStateSnapshot' : 'CanonicalEvent'
    if (!etape(`${nomAncre}${tag}`, ancresOk)) continue

    // Tableau HIRING — CONSTAT, aucune interprétation.
    if (ronde.fact.family === 'HIRING_SNAPSHOT') {
      const p = ronde.fact.payload as any
      const [aid] = [...assertionsVues.keys()].slice(-1)
      table.push({
        day: ronde.retrievedAt.slice(0, 10),
        openings: p.openingsObserved?.value ?? '',
        method: p.openingsObserved?.method ?? '',
        assertion: aid ?? '',
        snapshot: ancres.snapshots[0]?.id ?? '',
      })
    }
  }

  const expected = cas.attendu as unknown as Record<string, number>
  const actual = {
    assertions: assertionsVues.size, events: eventsVus.size, snapshots: snapshotsVus.size,
  }
  const comptesOk = actual.assertions === cas.attendu.assertions
    && actual.events === cas.attendu.events
    && actual.snapshots === cas.attendu.snapshots
  steps.push({
    name: 'Read-back counts', ok: comptesOk,
    detail: `attendu ${JSON.stringify(expected)} / relu ${JSON.stringify(actual)}`,
  })
  if (!comptesOk) ok = false

  // ── RAPPORT « PERSISTED » : OBJETS DURABLES UNIQUES (kind + id) ──────────
  // ⚠️ REPORTING SEULEMENT (HARNESS_PERSISTED_REPORT_DUPLICATE_001). Dans un
  // cas multi-rondes, la MÊME ancre canonique est relue et vérifiée à chaque
  // ronde — c'est l'idempotence voulue de la persistance, pas un doublon en
  // base. La liste rapportée dédouble par identité durable ; les compteurs
  // attendu/relu, eux, étaient déjà calculés sur des ensembles d'identités.
  const uniques = new Map<string, HarnessPersistedRow>()
  for (const p of persisted) {
    const cle = `${p.kind}|${p.id}`
    if (!uniques.has(cle)) uniques.set(cle, p)
  }

  return {
    caseName, verdict: ok ? 'PASS' : 'FAIL', environment: env, input, steps,
    persisted: [...uniques.values()],
    expected, actual, ...(table.length > 0 ? { table } : {}),
  }
}

// ── NETTOYAGE — ESPACE DU HARNAIS UNIQUEMENT, PRIMITIVES SERVEUR ────────────
//
// ⚠️ AUCUN AFFAIBLISSEMENT de la propriété serveur des `kind` : `deleteItem`
// est une primitive serveur, jamais exposée au navigateur, et l'espace est
// CODÉ EN DUR — ce nettoyage ne peut viser que les données du harnais.

const KINDS_HARNAIS = [
  SIGNAL_CANDIDATE_KIND, SOURCE_ASSERTION_KIND,
  CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND,
] as const

export async function cleanupHarnessWorkspace(): Promise<{ ok: boolean; deleted: number; reason?: string }> {
  const garde = verifyHarnessEnvironment(true)
  if (garde.ok === false) return { ok: false, deleted: 0, reason: garde.reason }

  let deleted = 0
  for (const kind of KINDS_HARNAIS) {
    const lus = await listItemsStrict<any>(kind, HARNESS_WORKSPACE)
    if (lus.ok === false) return { ok: false, deleted, reason: 'STORE_UNAVAILABLE pendant le nettoyage' }
    for (const doc of lus.values) {
      if (doc?.id && await deleteItem(kind, String(doc.id), HARNESS_WORKSPACE)) deleted++
    }
  }
  return { ok: true, deleted }
}
