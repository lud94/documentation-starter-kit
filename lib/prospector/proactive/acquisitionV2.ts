import type {
  AcquisitionFactV2,
  AcquisitionFamilyV2,
  AcquisitionRawDetail,
  ExecutiveChangeDirection,
  ExecutiveRoleSeniority,
  FundingInvestorRole,
  FundingPayloadV2,
  FundingRoundStage,
  HiringCount,
  HiringCountMethod,
  MoneyApprox,
  MoneyCurrency,
  MoneyExact,
  PersonExternalRefKind,
  PersonRef,
  PersonVerification,
  SignalClaimNature,
  SignalDatePrecision,
  SignalEventStatus,
  SignalRoleFunction,
  SignalRoleStatus,
} from '../../../types/prospector'
import { createHash } from 'node:crypto'

// ⚠️ DEPUIS `types.ts`, PAS DEPUIS LE BRIDGE : le Bridge importe ce module
// (mapping V2), et l'importer en retour créerait un cycle. `types.ts` est le
// point acyclique du domaine — c'est là que `jourReel` vit désormais.
import { jourReel } from './types'

// CONTRAT D'ACQUISITION V2 — helpers PURS et déterministes.
// (SIGNAL_ACQUISITION_CONTRACT_002_IMPLEMENTATION_CORE_001)
//
// Ce module ne persiste rien, n'appelle rien, ne lit aucune prose pour en
// déduire un fait : il valide des champs CLOS et normalise des valeurs par des
// règles fermées. Tout ce qu'il ne sait pas normaliser avec certitude est
// refusé (fail closed), jamais estimé.

// ── VOCABULAIRES EXÉCUTABLES ────────────────────────────────────────────────
// Alignement PROUVÉ à la compilation avec les types persistés : si l'un des
// deux dérive, l'affectation du tuple `[true, …]` cesse de compiler.

type MemeVocabulaire<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const FAMILLES = Object.freeze(['FUNDING', 'EXECUTIVE_CHANGE', 'HIRING_SNAPSHOT'] as const)
const DEVISES = Object.freeze(['EUR', 'USD', 'GBP', 'CHF'] as const)
const ROLES_INVESTISSEUR = Object.freeze(['LEAD', 'PARTICIPANT', 'UNKNOWN'] as const)
const STADES = Object.freeze(['SEED', 'SERIES_A', 'SERIES_B', 'SERIES_C_PLUS', 'DEBT', 'UNKNOWN'] as const)
const DIRECTIONS = Object.freeze(['APPOINTMENT', 'DEPARTURE', 'UNKNOWN'] as const)
const SENIORITES = Object.freeze(['C_LEVEL', 'VP_DIRECTOR', 'OTHER', 'UNKNOWN'] as const)
const VERIFICATIONS = Object.freeze(['VERIFIED_EXTERNAL_REF', 'NAME_ONLY'] as const)
const REFS_EXTERNES = Object.freeze(['LINKEDIN_URL', 'PAPPERS_DIRIGEANT_ID'] as const)
const METHODES_DECOMPTE = Object.freeze(['SOURCE_DECLARED', 'ENUMERATED_POSTINGS'] as const)
const NATURES = Object.freeze(['EVENT', 'STATE', 'UNKNOWN'] as const)
const STATUTS_EVT = Object.freeze(['COMPLETED', 'ANNOUNCED_FUTURE', 'UNKNOWN'] as const)
const PRECISIONS = Object.freeze(['DAY', 'MONTH', 'UNKNOWN'] as const)
const FONCTIONS = Object.freeze(['SALES', 'TECH', 'OFFICE_PEOPLE', 'EXEC_OTHER', 'UNKNOWN'] as const)
const STATUTS_ROLE = Object.freeze(['OPEN', 'FILLED', 'UNKNOWN'] as const)

const _alignement: [
  MemeVocabulaire<(typeof FAMILLES)[number], AcquisitionFamilyV2>,
  MemeVocabulaire<(typeof DEVISES)[number], MoneyCurrency>,
  MemeVocabulaire<(typeof ROLES_INVESTISSEUR)[number], FundingInvestorRole>,
  MemeVocabulaire<(typeof STADES)[number], FundingRoundStage>,
  MemeVocabulaire<(typeof DIRECTIONS)[number], ExecutiveChangeDirection>,
  MemeVocabulaire<(typeof SENIORITES)[number], ExecutiveRoleSeniority>,
  MemeVocabulaire<(typeof VERIFICATIONS)[number], PersonVerification>,
  MemeVocabulaire<(typeof REFS_EXTERNES)[number], PersonExternalRefKind>,
  MemeVocabulaire<(typeof METHODES_DECOMPTE)[number], HiringCountMethod>,
  MemeVocabulaire<(typeof NATURES)[number], SignalClaimNature>,
  MemeVocabulaire<(typeof STATUTS_EVT)[number], SignalEventStatus>,
  MemeVocabulaire<(typeof PRECISIONS)[number], SignalDatePrecision>,
  MemeVocabulaire<(typeof FONCTIONS)[number], SignalRoleFunction>,
  MemeVocabulaire<(typeof STATUTS_ROLE)[number], SignalRoleStatus>
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true]
void _alignement

function dans(liste: readonly string[], v: unknown): boolean {
  return typeof v === 'string' && liste.indexOf(v) !== -1
}

/**
 * Ensemble de clés CLOS : toutes les requises présentes, aucune clé hors
 * (requises ∪ optionnelles). C'est ce verrou qui rend impossible l'ajout
 * silencieux d'un champ non contractuel — une « confiance » numérique
 * universelle en tête — sur l'enveloppe comme sur chaque payload.
 */
function clesCloses(
  obj: Record<string, unknown>,
  requises: readonly string[],
  optionnelles: readonly string[] = []
): boolean {
  for (const k of requises) if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  for (const k of Object.keys(obj)) {
    if (requises.indexOf(k) === -1 && optionnelles.indexOf(k) === -1) return false
  }
  return true
}

function objetSimple(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── PERSONNE ────────────────────────────────────────────────────────────────

const CIVILITE = /^(m\.|mr\.?|mrs\.?|ms\.?|mme|mlle|dr\.?|monsieur|madame)\s+/i

/**
 * Normalisation CONSERVATRICE d'un nom de personne : NFKC, minuscules,
 * espaces réduits, civilités de tête retirées. RIEN de plus — pas de
 * suppression de diacritiques, pas d'initiales développées, pas de fuzzy :
 * la fausse scission est acceptée, la fausse fusion est le vrai danger.
 */
export function normalizePersonName(brut: string): string {
  let nom = brut.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  while (CIVILITE.test(nom)) nom = nom.replace(CIVILITE, '')
  return nom
}

/**
 * Clé d'identité de personne — TOUJOURS scopée au compte quand elle repose
 * sur le seul nom. Deux homonymes dans deux entreprises ne peuvent pas
 * fusionner ; deux homonymes dans la MÊME entreprise fusionnent, risque
 * résiduel documenté, mitigé uniquement par une référence externe.
 */
export function personKeyV2(person: PersonRef, accountId: string): string | null {
  if (typeof accountId !== 'string' || accountId.length === 0) return null
  if (person.externalRef) return `${person.externalRef.kind}:${person.externalRef.value}`
  if (person.normalizedName.length === 0) return null
  return `name:${person.normalizedName}@${accountId}`
}

export function isPersonRef(v: unknown): v is PersonRef {
  if (!objetSimple(v)) return false
  if (!clesCloses(v, ['fullNameRaw', 'normalizedName', 'verification'], ['externalRef'])) return false
  if (typeof v.fullNameRaw !== 'string' || v.fullNameRaw.trim().length === 0) return false
  // La forme normalisée est RECALCULÉE, jamais crue sur parole : une
  // normalisation mutée (ou fuzzifiée) en amont serait invisible sinon.
  if (v.normalizedName !== normalizePersonName(v.fullNameRaw)) return false
  if (v.normalizedName.length === 0) return false
  if (!dans(VERIFICATIONS, v.verification)) return false
  const ref = v.externalRef
  if (ref !== undefined) {
    if (!objetSimple(ref)) return false
    if (!clesCloses(ref, ['kind', 'value'])) return false
    if (!dans(REFS_EXTERNES, ref.kind)) return false
    if (typeof ref.value !== 'string' || ref.value.length === 0) return false
  }
  // Cohérence stricte : VERIFIED ⇔ référence externe présente.
  if (v.verification === 'VERIFIED_EXTERNAL_REF') return ref !== undefined
  return ref === undefined
}

// ── ARGENT ──────────────────────────────────────────────────────────────────

export type MoneyParse = { amount: MoneyExact } | { amountApprox: MoneyApprox }

const MARQUE_APPROX =
  /(?:^|[\s(])(about|around|approximately|approx\.?|nearly|almost|roughly|some|environ|presque|quelque)(?=[\s€$£\d])|[~≈]|pr[eè]s de/i
const MARQUE_INTERVALLE = /\b(between|entre|from)\b|\bto\b|\band\b|\bet\b|\bà\b|(?:\d\s*[-–—]\s*[\d€$£])/i
const NOMBRE = /(\d+(?:[.,]\d+)?)\s*(k|m|mn|b|bn|md|millions?|milliards?|billions?|thousand|mille)?\b/gi

const MULTIPLICATEURS: Record<string, number> = {
  k: 1e3, thousand: 1e3, mille: 1e3,
  m: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, md: 1e9, milliard: 1e9, milliards: 1e9, billion: 1e9, billions: 1e9,
}

function deviseUnique(brut: string): MoneyCurrency | null {
  const vues: MoneyCurrency[] = []
  if (/€|\beuros?\b|\bEUR\b/i.test(brut)) vues.push('EUR')
  if (/\$|\bUSD\b|\bdollars?\b/i.test(brut)) vues.push('USD')
  if (/£|\bGBP\b/i.test(brut)) vues.push('GBP')
  if (/\bCHF\b|\bfrancs? suisses?\b/i.test(brut)) vues.push('CHF')
  return vues.length === 1 ? vues[0] : null
}

/**
 * Analyse DÉTERMINISTE et FERMÉE d'un montant publié.
 *
 * « €12m » → exact. « environ 12 M€ » → approximatif (le type porte
 * l'approximation ; AUCUNE borne n'est inventée). « between €8m and €12m »,
 * devise inconnue, plusieurs nombres, « seven-figure » → null : la prose
 * reste dans `asPublished`/rawDetail, aucun nombre n'est fabriqué.
 */
export function parseMoney(brut: string): MoneyParse | null {
  if (typeof brut !== 'string') return null
  const texte = brut.normalize('NFKC').trim()
  if (texte.length === 0 || MARQUE_INTERVALLE.test(texte)) return null

  const devise = deviseUnique(texte)
  if (devise === null) return null

  NOMBRE.lastIndex = 0
  const nombres: Array<{ valeur: number; mult: number }> = []
  let m: RegExpExecArray | null
  while ((m = NOMBRE.exec(texte)) !== null) {
    const valeur = Number(m[1].replace(',', '.'))
    const suffixe = (m[2] || '').toLowerCase()
    const mult = suffixe === '' ? 1 : MULTIPLICATEURS[suffixe]
    if (mult === undefined || !isFinite(valeur)) return null
    nombres.push({ valeur, mult })
  }
  // Exactement UN nombre : deux nombres = intervalle ou énumération, refusés.
  if (nombres.length !== 1) return null

  const { valeur, mult } = nombres[0]
  const centimes = valeur * mult * 100
  const arrondi = Math.round(centimes)
  // Un montant qui ne tombe pas sur un centime entier n'est pas représentable
  // exactement : refus plutôt qu'arrondi silencieux.
  if (!Number.isSafeInteger(arrondi) || Math.abs(centimes - arrondi) > 1e-6 || arrondi <= 0) {
    return null
  }

  if (MARQUE_APPROX.test(texte)) {
    return { amountApprox: { magnitudeMinor: arrondi, currency: devise, asPublished: brut } }
  }
  return { amount: { amountMinor: arrondi, currency: devise, asPublished: brut } }
}

function moneyValide(v: unknown, champMinor: 'amountMinor' | 'magnitudeMinor'): boolean {
  if (!objetSimple(v)) return false
  if (!clesCloses(v, [champMinor, 'currency', 'asPublished'])) return false
  const minor = v[champMinor]
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0) return false
  if (!dans(DEVISES, v.currency)) return false
  return typeof v.asPublished === 'string' && v.asPublished.length > 0
}

// ── DÉCOMPTE D'OUVERTURES ───────────────────────────────────────────────────

/**
 * ZÉRO est une valeur pleine : une source déterministe peut confirmer zéro
 * poste ouvert. Seule l'absence d'observation se dit par l'absence du champ.
 */
export function isHiringCount(v: unknown): v is HiringCount {
  if (!objetSimple(v)) return false
  if (!clesCloses(v, ['value', 'method'], ['asPublished'])) return false
  if (typeof v.value !== 'number' || !Number.isSafeInteger(v.value) || v.value < 0) return false
  if (!dans(METHODES_DECOMPTE, v.method)) return false
  if (v.asPublished !== undefined && typeof v.asPublished !== 'string') return false
  return true
}

// ── VALIDATION DE L'ENVELOPPE V2 ────────────────────────────────────────────

const MOIS_REEL = /^(\d{4})-(\d{2})$/

function moisReel(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = MOIS_REEL.exec(v)
  if (!m) return false
  const mois = Number(m[2])
  return mois >= 1 && mois <= 12
}

function rawDetailValide(v: unknown): v is AcquisitionRawDetail {
  if (!objetSimple(v)) return false
  if (!clesCloses(v, ['detail', 'icebreaker'], ['sourceExcerpt'])) return false
  if (typeof v.detail !== 'string' || typeof v.icebreaker !== 'string') return false
  return v.sourceExcerpt === undefined || typeof v.sourceExcerpt === 'string'
}

function extractionValide(v: unknown): boolean {
  if (!objetSimple(v)) return false
  if (!clesCloses(v, ['mode', 'promptVersion'], ['model'])) return false
  if (v.mode !== 'exa+claude' && v.mode !== 'claude-web') return false
  if (typeof v.promptVersion !== 'string' || v.promptVersion.length === 0) return false
  return v.model === undefined || typeof v.model === 'string'
}

function payloadFunding(p: Record<string, unknown>): boolean {
  if (!clesCloses(p, ['family', 'roundStage'], ['amount', 'amountApprox', 'investors'])) return false
  if (!dans(STADES, p.roundStage)) return false
  // Exclusifs : un montant est exact OU approximatif, jamais les deux.
  if (p.amount !== undefined && p.amountApprox !== undefined) return false
  if (p.amount !== undefined && !moneyValide(p.amount, 'amountMinor')) return false
  if (p.amountApprox !== undefined && !moneyValide(p.amountApprox, 'magnitudeMinor')) return false
  if (p.investors !== undefined) {
    if (!Array.isArray(p.investors)) return false
    for (const inv of p.investors) {
      if (!objetSimple(inv)) return false
      if (!clesCloses(inv, ['nameRaw', 'role'])) return false
      if (typeof inv.nameRaw !== 'string' || inv.nameRaw.trim().length === 0) return false
      if (!dans(ROLES_INVESTISSEUR, inv.role)) return false
    }
  }
  return true
}

function payloadExecutive(p: Record<string, unknown>): boolean {
  if (!clesCloses(p, ['family', 'direction', 'roleFunction', 'roleSeniority', 'person'], ['roleTitleRaw'])) {
    return false
  }
  if (!dans(DIRECTIONS, p.direction)) return false
  if (!dans(FONCTIONS, p.roleFunction)) return false
  if (!dans(SENIORITES, p.roleSeniority)) return false
  if (!isPersonRef(p.person)) return false
  return p.roleTitleRaw === undefined || typeof p.roleTitleRaw === 'string'
}

function payloadHiring(p: Record<string, unknown>): boolean {
  if (!clesCloses(p, ['family', 'roleFunction', 'roleStatus'], ['openingsObserved'])) return false
  if (!dans(FONCTIONS, p.roleFunction)) return false
  if (!dans(STATUTS_ROLE, p.roleStatus)) return false
  return p.openingsObserved === undefined || isHiringCount(p.openingsObserved)
}

/**
 * Validation FAIL CLOSED de l'enveloppe V2.
 *
 * Absent (undefined) = hérité V1 valide — la décision d'accepter l'absence
 * appartient à l'appelant. PRÉSENT = doit être entier et cohérent :
 *  - double discriminant enveloppe/payload identiques ;
 *  - FUNDING et EXECUTIVE_CHANGE sont des EVENT ; HIRING_SNAPSHOT un STATE
 *    (occurredAt null, précision UNKNOWN) ;
 *  - précision DAY ⇒ jour calendaire réel ; MONTH ⇒ AAAA-MM réel ;
 *    UNKNOWN ⇒ occurredAt null (une date sans précision est une fausse précision) ;
 *  - ensembles de clés CLOS partout — aucun champ hors contrat, donc aucune
 *    « confiance » numérique universelle possible.
 */
export function isAcquisitionFactV2(v: unknown): v is AcquisitionFactV2 {
  if (!objetSimple(v)) return false
  if (
    !clesCloses(v, [
      'contractVersion', 'family', 'claimNature', 'eventStatus', 'occurredAt',
      'occurredAtPrecision', 'sourcePublishedAt', 'rawDetail', 'extraction', 'payload',
    ])
  ) {
    return false
  }
  if (v.contractVersion !== 'v2') return false
  if (!dans(FAMILLES, v.family)) return false
  if (!dans(NATURES, v.claimNature)) return false
  if (!dans(STATUTS_EVT, v.eventStatus)) return false
  if (!dans(PRECISIONS, v.occurredAtPrecision)) return false
  if (v.sourcePublishedAt !== null && (typeof v.sourcePublishedAt !== 'string' || v.sourcePublishedAt.length === 0)) {
    return false
  }
  if (!rawDetailValide(v.rawDetail)) return false
  if (!extractionValide(v.extraction)) return false
  if (!objetSimple(v.payload)) return false
  if (v.payload.family !== v.family) return false

  // Cohérence temporelle par famille.
  if (v.family === 'HIRING_SNAPSHOT') {
    if (v.claimNature !== 'STATE') return false
    if (v.occurredAt !== null || v.occurredAtPrecision !== 'UNKNOWN') return false
  } else {
    if (v.claimNature !== 'EVENT') return false
    if (v.occurredAtPrecision === 'DAY' && !jourReel(v.occurredAt)) return false
    if (v.occurredAtPrecision === 'MONTH' && !moisReel(v.occurredAt)) return false
    if (v.occurredAtPrecision === 'UNKNOWN' && v.occurredAt !== null) return false
  }

  if (v.family === 'FUNDING') return payloadFunding(v.payload)
  if (v.family === 'EXECUTIVE_CHANGE') return payloadExecutive(v.payload)
  return payloadHiring(v.payload)
}

// ── PROJECTION SÉMANTIQUE & VERSION DE CONTENU ──────────────────────────────
// (SIGNAL_ACQUISITION_CONTRACT_002_E2E_BRIDGE_001_R1, arbitrage A)
//
// Une assertion de source signifie désormais : « CETTE source a affirmé CETTE
// version sémantique de CETTE revendication canonique. » La version est un
// condensat d'une projection FERMÉE du fait structuré — jamais de l'objet brut.
//
// EXCLUS du condensat, délibérément :
//   rawDetail / detail / icebreaker / sourceExcerpt  → prose d'audit
//   extraction                                        → métadonnée de fabrication
//   provenance / publisher / sourcePublishedAt        → qualification de source
//   retrievedAt / observedAt / acceptance             → horloges de traitement
//   URL / candidateId / Evidence.id                   → identités portées ailleurs
//   asPublished                                       → la PHRASE publiée ; « €12M »
//                                                       et « 12 M€ » énoncent le
//                                                       MÊME fait sémantique
//   occurredAt / accountId / type                     → déjà dans canonicalClaimKey
//                                                       (les dupliquer créerait une
//                                                       seconde source de vérité)

/**
 * Sérialisation canonique déterministe : clés triées récursivement, aucune
 * dépendance à l'ordre d'insertion. Réservée aux objets JSON purs.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const cles = Object.keys(v as Record<string, unknown>).sort()
  const corps = cles
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
  return `{${corps.join(',')}}`
}

/**
 * Empreinte CONSERVATRICE d'un nom d'investisseur — pour le tri et le condensat
 * SEULEMENT. NFKC, espaces réduits, trim. PAS de minuscules, pas de
 * suppression de diacritiques : aucune identité d'organisation n'est créée,
 * `nameRaw` original reste ce qui est persisté.
 */
function empreinteInvestisseur(nameRaw: string): string {
  return nameRaw.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/**
 * Projection sémantique FERMÉE d'un fait V2 — l'entrée du condensat de version.
 *
 * `accountId` sert UNIQUEMENT à la clé de personne (scopée au compte pour
 * NAME_ONLY) ; il n'est pas réinjecté par ailleurs.
 *
 * ⚠️ L'ORDRE DU TABLEAU `investors` NE CHANGE PAS LA SÉMANTIQUE : il est trié
 * sur une représentation déterministe avant condensat.
 */
export function semanticFactProjection(
  fact: AcquisitionFactV2, accountId: string,
): Record<string, unknown> | null {
  if (!isAcquisitionFactV2(fact)) return null

  if (fact.payload.family === 'FUNDING') {
    const p = fact.payload
    const investisseurs = (p.investors ?? [])
      .map((i) => ({ name: empreinteInvestisseur(i.nameRaw), role: i.role }))
      .sort((a, b) => {
        const ka = `${a.name}\n${a.role}`
        const kb = `${b.name}\n${b.role}`
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })
    return {
      family: 'FUNDING',
      ...(p.amount
        ? { amount: { amountMinor: p.amount.amountMinor, currency: p.amount.currency } }
        : {}),
      ...(p.amountApprox
        ? {
            amountApprox: {
              magnitudeMinor: p.amountApprox.magnitudeMinor,
              currency: p.amountApprox.currency,
            },
          }
        : {}),
      roundStage: p.roundStage,
      ...(investisseurs.length > 0 ? { investors: investisseurs } : {}),
    }
  }

  if (fact.payload.family === 'EXECUTIVE_CHANGE') {
    const p = fact.payload
    const personne = personKeyV2(p.person, accountId)
    if (personne === null) return null
    // ⚠️ `roleTitleRaw` EXCLU : c'est de la prose descriptive. Deux articles
    // titrant « CRO » et « Chief Revenue Officer » énoncent le même fait.
    return {
      family: 'EXECUTIVE_CHANGE',
      direction: p.direction,
      personKey: personne,
      roleFunction: p.roleFunction,
      roleSeniority: p.roleSeniority,
    }
  }

  const p = fact.payload
  return {
    family: 'HIRING_SNAPSHOT',
    roleFunction: p.roleFunction,
    roleStatus: p.roleStatus,
    ...(p.openingsObserved
      ? {
          openingsObserved: {
            value: p.openingsObserved.value,
            method: p.openingsObserved.method,
          },
        }
      : {}),
  }
}

/**
 * Version sémantique du fait affirmé — le 4e (événement) ou 5e (état) segment
 * de l'identité `source-assertion:v2:`. `null` ⇒ fait inexploitable ⇒ AUCUNE
 * assertion (fail closed), jamais un condensat deviné.
 */
export function assertedFactHash(fact: AcquisitionFactV2, accountId: string): string | null {
  const projection = semanticFactProjection(fact, accountId)
  if (projection === null) return null
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex').slice(0, 32)
}
