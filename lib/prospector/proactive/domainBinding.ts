// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — DOMAINE PREMIÈRE-PARTIE ADJUGÉ.
//
// ── CONTRAT SÉMANTIQUE EXACT (AdjudicatedFirstPartyDomain) ──────────────────
// « Un humain authentifié a adjugé CET HÔTE EXACT comme hôte première-partie
// d'un SIREN DÉJÀ RÉSOLU, sur la base d'une matière légale capturée par
// Prospector lui-même. Ce n'est NI une preuve de propriété DNS/du domaine,
// NI une déclaration de registre. »
//
// Trois concepts jamais confondus :
//   RÉSOLUTION D'ENTITÉ  — QUI est l'entreprise (SIREN autoritatif) ;
//   AUTORITÉ DE DOMAINE  — QUEL hôte première-partie a été adjugé pour elle ;
//   SOURCE EVIDENCE      — CE QU'une URL a affirmé.
// Une liaison de domaine ne résout JAMAIS une entité non résolue.
//
// Deux enregistrements APPEND-ONLY, aucune ligne mutable :
//   DomainProofObservationV0 — capture serveur immuable (l'identité inclut
//     proofObservedAt : la revalidation du jeudi est un FAIT HISTORIQUE
//     distinct de la capture du lundi, même à contenu identique) ;
//   DomainAdjudicationV0 — décision humaine immuable (l'identité inclut
//     acteur ET instant : ACCEPTED→REJECTED→ACCEPTED = trois enregistrements).
// La « liaison courante » est DÉRIVÉE à la lecture, jamais persistée.
//
// ── LIMITE RÉSIDUELLE ASSUMÉE ───────────────────────────────────────────────
// Un domaine vendu/compromis qui ressert une matière légale périmée OCTET
// POUR OCTET est indistinguable par ce mécanisme seul. On ne prétend pas le
// contraire : l'adjudication humaine et la revalidation-à-l'usage réduisent la
// fenêtre, elles ne la ferment pas.
import { createHash } from 'node:crypto'

import { getItemStrict, insertItemIfAbsent, listItemsStrict } from '../../supabase/store'
import { canonicalJson } from './acquisitionV2'
import { isStrictInstant } from './types'
import { captureLegalProof, normalizeHost, type ProofDeps } from './legalProofFetch'

export const DOMAIN_PROOF_OBSERVATION_KIND = 'prospector_domain_proof_observation'
export const DOMAIN_ADJUDICATION_KIND = 'prospector_domain_adjudication'
export const DOMAIN_PROOF_OBSERVATION_CONTRACT = 'domain-proof-observation-v0'
export const DOMAIN_ADJUDICATION_CONTRACT = 'domain-adjudication-v0'
/** Taille maximale de l'ancre de preuve persistée. */
export const PROOF_ANCHOR_MAX = 400

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

export interface DomainProofObservationV0 {
  id: string
  workspaceId: string
  contractVersion: 'domain-proof-observation-v0'
  siren: string
  /** Hôte lié — minuscules, un seul `www.` de tête retiré, RIEN d'autre. */
  domainHost: string
  proofUrl: string
  finalUrl: string
  /** Horloge SERVEUR de la capture — jamais fournie par le navigateur. */
  proofObservedAt: string
  proofContentHash: string
  /** TOUS les SIRENs à 9 chiffres détectés — triés, dédupliqués, jamais réduits au plus commode. */
  sirensFound: string[]
  targetSirenFound: boolean
  /** Diagnostic SEUL — jamais autoritatif, jamais flou au-delà de la normalisation close. */
  legalNameObserved?: boolean
  /** Extrait LITTÉRAL borné autour du SIREN cible, dérivé PAR LE SERVEUR. */
  proofAnchor: string
  recordHash: string
}

export interface DomainAdjudicationV0 {
  id: string
  workspaceId: string
  contractVersion: 'domain-adjudication-v0'
  observationId: string
  verdict: 'ACCEPTED_FIRST_PARTY' | 'REJECTED'
  /** Acteur et instant DÉRIVÉS PAR LE SERVEUR — jamais du corps de requête. */
  adjudicatedBy: string
  adjudicatedAt: string
  recordHash: string
}

export type DomainAuthority = 'REGISTRY_DECLARED' | 'HUMAN_ADJUDICATED_LEGAL_NOTICE'

// ── IDENTITÉS ───────────────────────────────────────────────────────────────

export function domainProofObservationId(
  ws: string, siren: string, domainHost: string, proofUrl: string,
  proofObservedAt: string, proofContentHash: string,
): string {
  return `dpo_${sha256(`domain-proof-observation:v0:${ws}\n${siren}\n${domainHost}\n${proofUrl}\n${proofObservedAt}\n${proofContentHash}`).slice(0, 32)}`
}

export function domainAdjudicationId(
  ws: string, observationId: string, verdict: string, adjudicatedBy: string, adjudicatedAt: string,
): string {
  return `dad_${sha256(`domain-adjudication:v0:${ws}\n${observationId}\n${verdict}\n${adjudicatedBy}\n${adjudicatedAt}`).slice(0, 32)}`
}

export function observationRecordHash(o: Omit<DomainProofObservationV0, 'id' | 'recordHash'>): string {
  return sha256(canonicalJson({ ...o }))
}
export function adjudicationRecordHash(a: Omit<DomainAdjudicationV0, 'id' | 'recordHash'>): string {
  return sha256(canonicalJson({ ...a }))
}

// ── EXTRACTION DÉTERMINISTE DE LA MATIÈRE LÉGALE ────────────────────────────

// 9 chiffres, séparateurs espace/point tolérés — jamais à l'intérieur d'une
// suite de chiffres plus longue (un SIRET de 14 chiffres expose son SIREN via
// la variante espacée usuelle ; un simple nombre long n'en fabrique pas un).
const SIREN_DANS_TEXTE = /(?<!\d)(\d{3})[ .]?(\d{3})[ .]?(\d{3})(?!\d)/g

/** Tous les SIRENs distincts détectés, normalisés à 9 chiffres, triés. */
export function extractSirens(texte: string): string[] {
  const vus = new Set<string>()
  SIREN_DANS_TEXTE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SIREN_DANS_TEXTE.exec(String(texte))) !== null) vus.add(`${m[1]}${m[2]}${m[3]}`)
  return [...vus].sort()
}

/**
 * Ancre LITTÉRALE bornée autour de la PREMIÈRE occurrence du SIREN cible —
 * extraction déterministe serveur, jamais un LLM, jamais le navigateur.
 * Cible absente ⇒ ancre autour du premier SIREN trouvé, sinon vide.
 */
export function buildProofAnchor(texte: string, targetSiren: string): string {
  const corps = String(texte)
  const motif = new RegExp(`(?<!\\d)${targetSiren.slice(0, 3)}[ .]?${targetSiren.slice(3, 6)}[ .]?${targetSiren.slice(6, 9)}(?!\\d)`)
  let m = motif.exec(corps)
  if (!m) { SIREN_DANS_TEXTE.lastIndex = 0; m = SIREN_DANS_TEXTE.exec(corps) }
  if (!m) return ''
  const debut = Math.max(0, m.index - 160)
  const fin = Math.min(corps.length, m.index + m[0].length + 160)
  return corps.slice(debut, fin).replace(/\s+/g, ' ').trim().slice(0, PROOF_ANCHOR_MAX)
}

/** Normalisation CLOSE de raison sociale — diagnostic seul, jamais autoritatif. */
const FORMES_JURIDIQUES = ['sas', 'sasu', 'sarl', 'sa', 'eurl', 'sci', 'snc']
export function normalizeLegalName(nom: string): string {
  let n = String(nom).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const f of FORMES_JURIDIQUES) n = n.replace(new RegExp(`\\b${f}\\b`, 'g'), ' ')
  return n.replace(/[^a-z0-9]+/g, ' ').trim()
}

// ── ENREGISTREMENT (APPEND-ONLY) ────────────────────────────────────────────

export interface ObservationInput {
  siren: string
  domainHost: string
  proofUrl: string
  finalUrl: string
  body: string
  /** Raison sociale du registre, pour le diagnostic `legalNameObserved`. */
  registryLegalName?: string
}

export type ObservationRecordResult =
  | { ok: true; observation: DomainProofObservationV0; created: boolean }
  | { ok: false; reason: 'INVALID_INPUT' | 'WRITE_FAILED' }

/** Construit et persiste UNE observation immuable depuis une capture RÉUSSIE. */
export async function recordDomainProofObservation(
  input: ObservationInput, ws: string, now: () => Date = () => new Date(),
): Promise<ObservationRecordResult> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  const siren = String(input?.siren || '').trim()
  const domainHost = normalizeHost(input?.domainHost)
  if (!/^\d{9}$/.test(siren) || !domainHost) return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.proofUrl !== 'string' || !input.proofUrl.startsWith('https://')) return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.finalUrl !== 'string' || !input.finalUrl.startsWith('https://')) return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.body !== 'string') return { ok: false, reason: 'INVALID_INPUT' }
  // L'hôte FINAL doit rester l'hôte lié (modulo `www.`) — défense en profondeur,
  // la capture l'impose déjà.
  let hoteFinal: string | null = null
  try { hoteFinal = normalizeHost(new URL(input.finalUrl).hostname) } catch { hoteFinal = null }
  if (hoteFinal !== domainHost) return { ok: false, reason: 'INVALID_INPUT' }

  const proofObservedAt = now().toISOString()
  if (!isStrictInstant(proofObservedAt)) return { ok: false, reason: 'INVALID_INPUT' }
  const proofContentHash = sha256(input.body)
  const sirensFound = extractSirens(input.body)
  const targetSirenFound = sirensFound.includes(siren)

  const sansIntegrite: Omit<DomainProofObservationV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: DOMAIN_PROOF_OBSERVATION_CONTRACT,
    siren,
    domainHost,
    proofUrl: input.proofUrl,
    finalUrl: input.finalUrl,
    proofObservedAt,
    proofContentHash,
    sirensFound,
    targetSirenFound,
    ...(typeof input.registryLegalName === 'string' && input.registryLegalName.trim() !== ''
      ? {
          legalNameObserved: normalizeLegalName(input.body).includes(normalizeLegalName(input.registryLegalName))
            && normalizeLegalName(input.registryLegalName) !== '',
        }
      : {}),
    proofAnchor: buildProofAnchor(input.body, siren),
  }
  const id = domainProofObservationId(ws, siren, domainHost, input.proofUrl, proofObservedAt, proofContentHash)
  const observation: DomainProofObservationV0 = {
    id, ...sansIntegrite, recordHash: observationRecordHash(sansIntegrite),
  }
  if (await insertItemIfAbsent(DOMAIN_PROOF_OBSERVATION_KIND, id, observation, ws)) {
    return { ok: true, observation, created: true }
  }
  const relu = await readDomainProofObservation(id, ws)
  if (relu.ok === true && canonicalJson(relu.observation as any) === canonicalJson(observation as any)) {
    return { ok: true, observation: relu.observation, created: false } // rejeu strictement identique
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const clesCloses = (obj: Record<string, unknown>, requises: readonly string[], optionnelles: readonly string[] = []): boolean => {
  const admises = new Set([...requises, ...optionnelles])
  return requises.every((c) => c in obj) && Object.keys(obj).every((c) => admises.has(c))
}

/** Validation PURE d'une ligne d'observation relue — utilisée par lecture ET dérivation. */
export function isDomainProofObservation(v: unknown, ws: string): v is DomainProofObservationV0 {
  if (!objet(v)) return false
  if (!clesCloses(v, [
    'id', 'workspaceId', 'contractVersion', 'siren', 'domainHost', 'proofUrl', 'finalUrl',
    'proofObservedAt', 'proofContentHash', 'sirensFound', 'targetSirenFound', 'proofAnchor', 'recordHash',
  ], ['legalNameObserved'])) return false
  if (v.workspaceId !== ws) return false
  if (v.contractVersion !== DOMAIN_PROOF_OBSERVATION_CONTRACT) return false
  if (typeof v.siren !== 'string' || !/^\d{9}$/.test(v.siren)) return false
  if (typeof v.domainHost !== 'string' || normalizeHost(v.domainHost) !== v.domainHost) return false
  if (typeof v.proofUrl !== 'string' || !v.proofUrl.startsWith('https://')) return false
  if (typeof v.finalUrl !== 'string' || !v.finalUrl.startsWith('https://')) return false
  if (!isStrictInstant(v.proofObservedAt)) return false
  if (typeof v.proofContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.proofContentHash)) return false
  if (!Array.isArray(v.sirensFound) || v.sirensFound.some((s) => typeof s !== 'string' || !/^\d{9}$/.test(s))) return false
  // Cohérence interne : le drapeau cible DOIT refléter la liste.
  if (v.targetSirenFound !== (v.sirensFound as string[]).includes(v.siren)) return false
  if (v.legalNameObserved !== undefined && typeof v.legalNameObserved !== 'boolean') return false
  if (typeof v.proofAnchor !== 'string' || v.proofAnchor.length > PROOF_ANCHOR_MAX) return false
  if (typeof v.recordHash !== 'string') return false
  const { id: _i, recordHash: _r, ...sans } = v as any
  if (v.recordHash !== observationRecordHash(sans)) return false
  if (domainProofObservationId(ws, String(v.siren), String(v.domainHost), String(v.proofUrl), String(v.proofObservedAt), String(v.proofContentHash)) !== v.id) return false
  return true
}

export type ObservationRead =
  | { ok: true; observation: DomainProofObservationV0 }
  | { ok: false; reason: 'OBSERVATION_UNKNOWN' | 'OBSERVATION_TAMPERED' | 'STORE_UNAVAILABLE' }

export async function readDomainProofObservation(id: unknown, ws: string): Promise<ObservationRead> {
  if (typeof id !== 'string' || !/^dpo_[0-9a-f]{32}$/.test(id)) return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  const lu = await getItemStrict<DomainProofObservationV0>(DOMAIN_PROOF_OBSERVATION_KIND, id, ws)
  if (lu.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  if (!lu.value) return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  if ((lu.value as any).id !== id || !isDomainProofObservation(lu.value, ws)) {
    return { ok: false, reason: 'OBSERVATION_TAMPERED' }
  }
  return { ok: true, observation: lu.value }
}

export type AdjudicationRecordResult =
  | { ok: true; adjudication: DomainAdjudicationV0; created: boolean }
  | { ok: false; reason: 'INVALID_INPUT' | 'OBSERVATION_UNKNOWN' | 'OBSERVATION_TAMPERED' | 'OBSERVATION_NOT_ELIGIBLE' | 'STORE_UNAVAILABLE' | 'WRITE_FAILED' }

/**
 * Décision humaine APPEND-ONLY. Le navigateur ne fournit QUE observationId et
 * verdict ; acteur/instant viennent du serveur. Une observation où le SIREN
 * cible est ABSENT ne peut pas être ACCEPTÉE — refus, pas de réparation.
 */
export async function recordDomainAdjudication(
  input: { observationId: unknown; verdict: unknown }, adjudicatedBy: string, ws: string,
  now: () => Date = () => new Date(),
): Promise<AdjudicationRecordResult> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof adjudicatedBy !== 'string' || adjudicatedBy.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  const verdict = input?.verdict
  if (verdict !== 'ACCEPTED_FIRST_PARTY' && verdict !== 'REJECTED') return { ok: false, reason: 'INVALID_INPUT' }

  const obs = await readDomainProofObservation(input?.observationId, ws)
  if (obs.ok === false) {
    return obs.reason === 'STORE_UNAVAILABLE'
      ? { ok: false, reason: 'STORE_UNAVAILABLE' }
      : { ok: false, reason: obs.reason }
  }
  if (verdict === 'ACCEPTED_FIRST_PARTY' && obs.observation.targetSirenFound !== true) {
    return { ok: false, reason: 'OBSERVATION_NOT_ELIGIBLE' }
  }

  const adjudicatedAt = now().toISOString()
  if (!isStrictInstant(adjudicatedAt)) return { ok: false, reason: 'INVALID_INPUT' }
  const sansIntegrite: Omit<DomainAdjudicationV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: DOMAIN_ADJUDICATION_CONTRACT,
    observationId: obs.observation.id,
    verdict,
    adjudicatedBy: adjudicatedBy.trim(),
    adjudicatedAt,
  }
  const id = domainAdjudicationId(ws, obs.observation.id, verdict, adjudicatedBy.trim(), adjudicatedAt)
  const adjudication: DomainAdjudicationV0 = {
    id, ...sansIntegrite, recordHash: adjudicationRecordHash(sansIntegrite),
  }
  if (await insertItemIfAbsent(DOMAIN_ADJUDICATION_KIND, id, adjudication, ws)) {
    return { ok: true, adjudication, created: true }
  }
  const relu = await getItemStrict<DomainAdjudicationV0>(DOMAIN_ADJUDICATION_KIND, id, ws)
  if (relu.ok === true && relu.value && canonicalJson(relu.value as any) === canonicalJson(adjudication as any)) {
    return { ok: true, adjudication, created: false }
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

export function isDomainAdjudication(v: unknown, ws: string): v is DomainAdjudicationV0 {
  if (!objet(v)) return false
  if (!clesCloses(v, ['id', 'workspaceId', 'contractVersion', 'observationId', 'verdict', 'adjudicatedBy', 'adjudicatedAt', 'recordHash'])) return false
  if (v.workspaceId !== ws) return false
  if (v.contractVersion !== DOMAIN_ADJUDICATION_CONTRACT) return false
  if (typeof v.observationId !== 'string' || !/^dpo_[0-9a-f]{32}$/.test(v.observationId)) return false
  if (v.verdict !== 'ACCEPTED_FIRST_PARTY' && v.verdict !== 'REJECTED') return false
  if (typeof v.adjudicatedBy !== 'string' || v.adjudicatedBy.trim() === '') return false
  if (!isStrictInstant(v.adjudicatedAt)) return false
  const { id: _i, recordHash: _r, ...sans } = v as any
  if (v.recordHash !== adjudicationRecordHash(sans)) return false
  if (domainAdjudicationId(ws, String(v.observationId), String(v.verdict), String(v.adjudicatedBy), String(v.adjudicatedAt)) !== v.id) return false
  return true
}

// ── ÉLIGIBILITÉ COURANTE — DÉRIVÉE, JAMAIS PERSISTÉE ────────────────────────

export type AdjudicatedEligibility =
  | { eligible: true; domainHost: string; authority: 'HUMAN_ADJUDICATED_LEGAL_NOTICE' }
  | {
      eligible: false
      reason:
        | 'NO_ACCEPTED_ADJUDICATION'
        | 'LATEST_REJECTED'
        | 'REVALIDATION_FAILED'
        | 'PROOF_CHANGED'
        | 'STORE_UNAVAILABLE'
        | 'INVALID_INPUT'
    }

/**
 * Un domaine adjugé peut décerner le grade A pour CE geste uniquement si :
 *  1. le SIREN est déjà résolu (l'appelant l'a établi — jamais ici) ;
 *  2. la DERNIÈRE adjudication applicable (adjudicatedAt, puis id) pour
 *     (SIREN, hôte exact) est ACCEPTED_FIRST_PARTY sur une observation
 *     strictement valide ;
 *  3. la preuve est RE-CAPTURÉE À L'USAGE et son contenu est OCTET POUR OCTET
 *     celui de l'observation adjugée. Contenu changé ⇒ la nouvelle observation
 *     est persistée (append) et attend une NOUVELLE adjudication humaine —
 *     l'ancienne ne décerne RIEN. Faux négatif > faux positif : aucun
 *     lissage/normalisation de contenu n'est tenté ici.
 */
export async function eligibleAdjudicatedDomain(
  siren: string, sourceHost: string, ws: string,
  capture: (domainHost: string, proofUrl: string, deps?: ProofDeps) => ReturnType<typeof captureLegalProof> = captureLegalProof,
  now: () => Date = () => new Date(),
): Promise<AdjudicatedEligibility> {
  const s = String(siren || '').trim()
  const hote = normalizeHost(sourceHost)
  if (!/^\d{9}$/.test(s) || !hote || typeof ws !== 'string' || ws.trim() === '') {
    return { eligible: false, reason: 'INVALID_INPUT' }
  }

  const obsLues = await listItemsStrict<DomainProofObservationV0>(DOMAIN_PROOF_OBSERVATION_KIND, ws)
  if (obsLues.ok === false) return { eligible: false, reason: 'STORE_UNAVAILABLE' }
  const observations = new Map<string, DomainProofObservationV0>()
  for (const o of obsLues.values) {
    if (isDomainProofObservation(o, ws) && o.siren === s && o.domainHost === hote) observations.set(o.id, o)
  }

  const adjLues = await listItemsStrict<DomainAdjudicationV0>(DOMAIN_ADJUDICATION_KIND, ws)
  if (adjLues.ok === false) return { eligible: false, reason: 'STORE_UNAVAILABLE' }
  const applicables = adjLues.values
    .filter((a) => isDomainAdjudication(a, ws) && observations.has(a.observationId))
    .sort((a, b) => (a.adjudicatedAt === b.adjudicatedAt
      ? (a.id < b.id ? 1 : -1)
      : (a.adjudicatedAt < b.adjudicatedAt ? 1 : -1)))
  const derniere = applicables[0]
  if (!derniere) return { eligible: false, reason: 'NO_ACCEPTED_ADJUDICATION' }
  if (derniere.verdict !== 'ACCEPTED_FIRST_PARTY') return { eligible: false, reason: 'LATEST_REJECTED' }
  const adjugee = observations.get(derniere.observationId)!

  // ── REVALIDATION À L'USAGE — jamais un grade A depuis une preuve d'hier seul.
  const recapture = await capture(hote, adjugee.proofUrl)
  if (recapture.ok === false) return { eligible: false, reason: 'REVALIDATION_FAILED' }
  const persistee = await recordDomainProofObservation(
    {
      siren: s, domainHost: hote, proofUrl: adjugee.proofUrl,
      finalUrl: recapture.finalUrl, body: recapture.body,
    },
    ws, now,
  )
  if (persistee.ok === false) return { eligible: false, reason: 'REVALIDATION_FAILED' }
  if (
    persistee.observation.proofContentHash !== adjugee.proofContentHash
    || persistee.observation.targetSirenFound !== true
  ) {
    return { eligible: false, reason: 'PROOF_CHANGED' }
  }
  return { eligible: true, domainHost: hote, authority: 'HUMAN_ADJUDICATED_LEGAL_NOTICE' }
}
