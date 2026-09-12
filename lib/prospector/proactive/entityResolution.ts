// ENTITY_RESOLUTION_ADJUDICATION_001 — ADJUDICATION D'ENTITÉ, CADRÉE CANDIDAT.
//
// ── PRINCIPE ARCHITECTURAL GELÉ ─────────────────────────────────────────────
// L'adjudication V0 résout CE ResearchCandidate IMMUABLE → UN candidat officiel
// du registre. Elle ne crée NI alias nom→SIREN, NI identité de compte
// d'espace, NI réutilisation entre candidats : deux candidats « Defacto »
// exigent deux adjudications. Faux négatif > faux positif — un futur
// EntityAlias est un ticket séparé, rien n'en est passé en contrebande ici.
//
// ── CE QUE CHAQUE ENREGISTREMENT SIGNIFIE ───────────────────────────────────
// EntityResolutionObservationV0 : « le serveur a interrogé le registre officiel
// avec CETTE requête (dérivée du candidat, jamais du navigateur) à CET instant
// et a reçu EXACTEMENT cette FENÊTRE CLASSÉE de candidats. » ⚠️ C'est une
// fenêtre de pertinence — JAMAIS un énoncé exhaustif sur toutes les entités
// légales françaises.
// EntityResolutionAdjudicationV0 : « un humain authentifié a SÉLECTIONNÉ un
// candidat officiel de cette fenêtre (ou les a tous rejetés). » L'humain
// choisit parmi les candidats du registre — il ne CRÉE jamais l'identité
// légale. `NONE_OF_OBSERVED_CANDIDATES` signifie UNIQUEMENT « chaque candidat
// de CETTE fenêtre persistée a été rejeté » — pas « aucune entité n'existe ».
//
// Append-only des deux côtés ; aucune ligne « résolution courante » mutable —
// la décision effective est DÉRIVÉE à la lecture.
import { createHash } from 'node:crypto'

import { getItemStrict, insertItemIfAbsent, listItemsStrict } from '../../supabase/store'
import {
  lookupByName, lookupBySiren, normaliserRaisonSociale, type CompanyLookup,
} from '../datagouv'
import { canonicalJson } from './acquisitionV2'
import { isStrictInstant } from './types'
import type { SignalCandidate } from './signalCandidates'

export const ENTITY_RESOLUTION_OBSERVATION_KIND = 'prospector_entity_resolution_observation'
export const ENTITY_RESOLUTION_ADJUDICATION_KIND = 'prospector_entity_resolution_adjudication'
export const ENTITY_RESOLUTION_OBSERVATION_CONTRACT = 'entity-resolution-observation-v0'
export const ENTITY_RESOLUTION_ADJUDICATION_CONTRACT = 'entity-resolution-adjudication-v0'
export const ENTITY_RESULT_WINDOW = 10

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

/** Cliché MINIMAL d'un candidat registre — SANS `website` (autre couche d'autorité). */
export interface RegistryCandidateSnapshot {
  siren: string
  name: string
  city: string
  naf: string
  effectif?: string
  dirigeant?: string
  active?: boolean
}

export interface EntityResolutionObservationV0 {
  id: string
  workspaceId: string
  contractVersion: 'entity-resolution-observation-v0'
  /** Le ResearchCandidate SUJET — l'adjudication ne vaut que pour lui. */
  subjectCandidateId: string
  queryRaw: string
  queryNormalized: string
  source: 'recherche-entreprises'
  /** Horloge SERVEUR. Jeudi ≠ lundi, même à fenêtre identique. */
  retrievedAt: string
  resultWindow: number
  returnedCount: number
  /** ORDRE DU REGISTRE PRÉSERVÉ — jamais trié silencieusement. */
  candidates: RegistryCandidateSnapshot[]
  candidatesHash: string
  recordHash: string
}

export interface EntityResolutionAdjudicationV0 {
  id: string
  workspaceId: string
  contractVersion: 'entity-resolution-adjudication-v0'
  observationId: string
  verdict: 'ACCEPTED_CANDIDATE' | 'NONE_OF_OBSERVED_CANDIDATES'
  /** Requis ssi ACCEPTED — pur SÉLECTEUR, DOIT appartenir au cliché observé. */
  selectedSiren?: string
  /** Acteur et instant DÉRIVÉS PAR LE SERVEUR — jamais du corps de requête. */
  adjudicatedBy: string
  adjudicatedAt: string
  recordHash: string
}

// ── IDENTITÉS ───────────────────────────────────────────────────────────────

export function entityObservationId(
  ws: string, subjectCandidateId: string, queryNormalized: string, retrievedAt: string, candidatesHash: string,
): string {
  return `ero_${sha256(`entity-resolution-observation:v0:${ws}\n${subjectCandidateId}\n${queryNormalized}\n${retrievedAt}\n${candidatesHash}`).slice(0, 32)}`
}
export function entityAdjudicationId(
  ws: string, observationId: string, verdict: string, selectedSiren: string, adjudicatedBy: string, adjudicatedAt: string,
): string {
  return `era_${sha256(`entity-resolution-adjudication:v0:${ws}\n${observationId}\n${verdict}\n${selectedSiren}\n${adjudicatedBy}\n${adjudicatedAt}`).slice(0, 32)}`
}
export function entityCandidatesHash(candidates: RegistryCandidateSnapshot[]): string {
  return sha256(canonicalJson(candidates as any))
}
const recordHashDe = (o: Record<string, unknown>) => sha256(canonicalJson({ ...o }))

// ── VALIDATION STRICTE — SÉMANTIQUE, JAMAIS recordHash SEUL ─────────────────

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const clesCloses = (obj: Record<string, unknown>, requises: readonly string[], optionnelles: readonly string[] = []): boolean => {
  const admises = new Set([...requises, ...optionnelles])
  return requises.every((c) => c in obj) && Object.keys(obj).every((c) => admises.has(c))
}

function candidatSnapshotValide(v: unknown): v is RegistryCandidateSnapshot {
  if (!objet(v)) return false
  if (!clesCloses(v, ['siren', 'name', 'city', 'naf'], ['effectif', 'dirigeant', 'active'])) return false
  if (typeof v.siren !== 'string' || !/^\d{9}$/.test(v.siren)) return false
  if (typeof v.name !== 'string' || typeof v.city !== 'string' || typeof v.naf !== 'string') return false
  if (v.effectif !== undefined && typeof v.effectif !== 'string') return false
  if (v.dirigeant !== undefined && typeof v.dirigeant !== 'string') return false
  if (v.active !== undefined && typeof v.active !== 'boolean') return false
  return true
}

export function isEntityResolutionObservation(v: unknown, ws: string): v is EntityResolutionObservationV0 {
  if (!objet(v)) return false
  if (!clesCloses(v, [
    'id', 'workspaceId', 'contractVersion', 'subjectCandidateId', 'queryRaw', 'queryNormalized',
    'source', 'retrievedAt', 'resultWindow', 'returnedCount', 'candidates', 'candidatesHash', 'recordHash',
  ])) return false
  if (v.workspaceId !== ws) return false
  if (v.contractVersion !== ENTITY_RESOLUTION_OBSERVATION_CONTRACT) return false
  if (typeof v.subjectCandidateId !== 'string' || !/^cand_[0-9a-f]{32}$/.test(v.subjectCandidateId)) return false
  if (typeof v.queryRaw !== 'string' || v.queryRaw.trim() === '') return false
  // La normalisation est RECALCULÉE avec l'implémentation de production.
  if (v.queryNormalized !== normaliserRaisonSociale(String(v.queryRaw))) return false
  if (v.source !== 'recherche-entreprises') return false
  if (!isStrictInstant(v.retrievedAt)) return false
  if (v.resultWindow !== ENTITY_RESULT_WINDOW) return false
  if (!Array.isArray(v.candidates) || !v.candidates.every(candidatSnapshotValide)) return false
  if (v.returnedCount !== v.candidates.length) return false
  if (v.candidatesHash !== entityCandidatesHash(v.candidates as RegistryCandidateSnapshot[])) return false
  const { id: _i, recordHash: _r, ...sans } = v as any
  if (v.recordHash !== recordHashDe(sans)) return false
  if (entityObservationId(ws, String(v.subjectCandidateId), String(v.queryNormalized), String(v.retrievedAt), String(v.candidatesHash)) !== v.id) return false
  return true
}

export function isEntityResolutionAdjudication(v: unknown, ws: string): v is EntityResolutionAdjudicationV0 {
  if (!objet(v)) return false
  if (!clesCloses(v, ['id', 'workspaceId', 'contractVersion', 'observationId', 'verdict', 'adjudicatedBy', 'adjudicatedAt', 'recordHash'], ['selectedSiren'])) return false
  if (v.workspaceId !== ws) return false
  if (v.contractVersion !== ENTITY_RESOLUTION_ADJUDICATION_CONTRACT) return false
  if (typeof v.observationId !== 'string' || !/^ero_[0-9a-f]{32}$/.test(v.observationId)) return false
  if (v.verdict !== 'ACCEPTED_CANDIDATE' && v.verdict !== 'NONE_OF_OBSERVED_CANDIDATES') return false
  // Cohérence verdict ↔ sélecteur — jamais un drapeau cru.
  if (v.verdict === 'ACCEPTED_CANDIDATE' && (typeof v.selectedSiren !== 'string' || !/^\d{9}$/.test(v.selectedSiren))) return false
  if (v.verdict === 'NONE_OF_OBSERVED_CANDIDATES' && v.selectedSiren !== undefined) return false
  if (typeof v.adjudicatedBy !== 'string' || v.adjudicatedBy.trim() === '') return false
  if (!isStrictInstant(v.adjudicatedAt)) return false
  const { id: _i, recordHash: _r, ...sans } = v as any
  if (v.recordHash !== recordHashDe(sans)) return false
  if (entityAdjudicationId(ws, String(v.observationId), String(v.verdict), String(v.selectedSiren ?? ''), String(v.adjudicatedBy), String(v.adjudicatedAt)) !== v.id) return false
  return true
}

// ── OBSERVATION — ENREGISTREMENT DEPUIS UNE RÉPONSE REGISTRE AMBIGUË ────────

export type ObservationRecord =
  | { ok: true; observation: EntityResolutionObservationV0; created: boolean }
  | { ok: false; reason: 'INVALID_INPUT' | 'WRITE_FAILED' }

export async function recordEntityResolutionObservation(
  input: { candidate: SignalCandidate; lookup: CompanyLookup }, ws: string, now: () => Date = () => new Date(),
): Promise<ObservationRecord> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  const candidate = input?.candidate
  if (!candidate || !/^cand_[0-9a-f]{32}$/.test(String(candidate.id))) return { ok: false, reason: 'INVALID_INPUT' }
  const queryRaw = String(candidate.claim?.company || '').trim()
  if (queryRaw === '') return { ok: false, reason: 'INVALID_INPUT' }
  const bruts = input?.lookup?.candidates
  if (!Array.isArray(bruts) || bruts.length === 0) return { ok: false, reason: 'INVALID_INPUT' }

  // Cliché MINIMAL, ordre du registre préservé, `website` volontairement exclu.
  const candidates: RegistryCandidateSnapshot[] = []
  for (const c of bruts) {
    const siren = String(c?.siren || '').trim()
    if (!/^\d{9}$/.test(siren)) return { ok: false, reason: 'INVALID_INPUT' }
    candidates.push({
      siren,
      name: String(c?.name || ''),
      city: String(c?.city || ''),
      naf: String(c?.naf || ''),
      ...(typeof c?.effectif === 'string' ? { effectif: c.effectif } : {}),
      ...(typeof c?.dirigeant === 'string' ? { dirigeant: c.dirigeant } : {}),
      ...(typeof c?.active === 'boolean' ? { active: c.active } : {}),
    })
  }

  const retrievedAt = now().toISOString()
  if (!isStrictInstant(retrievedAt)) return { ok: false, reason: 'INVALID_INPUT' }
  const queryNormalized = normaliserRaisonSociale(queryRaw)
  const candidatesHash = entityCandidatesHash(candidates)
  const sans: Omit<EntityResolutionObservationV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: ENTITY_RESOLUTION_OBSERVATION_CONTRACT,
    subjectCandidateId: candidate.id,
    queryRaw,
    queryNormalized,
    source: 'recherche-entreprises',
    retrievedAt,
    resultWindow: ENTITY_RESULT_WINDOW,
    returnedCount: candidates.length,
    candidates,
    candidatesHash,
  }
  const id = entityObservationId(ws, candidate.id, queryNormalized, retrievedAt, candidatesHash)
  const observation: EntityResolutionObservationV0 = { id, ...sans, recordHash: recordHashDe(sans) }
  if (await insertItemIfAbsent(ENTITY_RESOLUTION_OBSERVATION_KIND, id, observation, ws)) {
    return { ok: true, observation, created: true }
  }
  const relu = await readEntityResolutionObservation(id, ws)
  if (relu.ok === true && canonicalJson(relu.observation as any) === canonicalJson(observation as any)) {
    return { ok: true, observation: relu.observation, created: false }
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

export type ObservationRead =
  | { ok: true; observation: EntityResolutionObservationV0 }
  | { ok: false; reason: 'OBSERVATION_UNKNOWN' | 'OBSERVATION_TAMPERED' | 'STORE_UNAVAILABLE' }

export async function readEntityResolutionObservation(id: unknown, ws: string): Promise<ObservationRead> {
  if (typeof id !== 'string' || !/^ero_[0-9a-f]{32}$/.test(id)) return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  const lu = await getItemStrict<EntityResolutionObservationV0>(ENTITY_RESOLUTION_OBSERVATION_KIND, id, ws)
  if (lu.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  if (!lu.value) return { ok: false, reason: 'OBSERVATION_UNKNOWN' }
  if ((lu.value as any).id !== id || !isEntityResolutionObservation(lu.value, ws)) {
    return { ok: false, reason: 'OBSERVATION_TAMPERED' }
  }
  return { ok: true, observation: lu.value }
}

// ── ADJUDICATION — APPEND-ONLY, RÈGLE NONE §8 ───────────────────────────────

export type AdjudicationRecord =
  | { ok: true; adjudication: EntityResolutionAdjudicationV0; created: boolean }
  | {
      ok: false
      reason:
        | 'INVALID_INPUT'
        | 'OBSERVATION_UNKNOWN'
        | 'OBSERVATION_TAMPERED'
        | 'SIREN_NOT_IN_OBSERVATION'
        | 'CANDIDATE_NOT_ELIGIBLE'
        | 'OBSERVATION_DOES_NOT_COVER_CURRENT_SELECTION'
        | 'HISTORY_TAMPERED'
        | 'STORE_UNAVAILABLE'
        | 'WRITE_FAILED'
    }

export async function recordEntityResolutionAdjudication(
  input: { observationId: unknown; verdict: unknown; selectedSiren?: unknown },
  adjudicatedBy: string, ws: string, now: () => Date = () => new Date(),
): Promise<AdjudicationRecord> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof adjudicatedBy !== 'string' || adjudicatedBy.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  const verdict = input?.verdict
  if (verdict !== 'ACCEPTED_CANDIDATE' && verdict !== 'NONE_OF_OBSERVED_CANDIDATES') {
    return { ok: false, reason: 'INVALID_INPUT' }
  }

  const obs = await readEntityResolutionObservation(input?.observationId, ws)
  if (obs.ok === false) {
    return obs.reason === 'STORE_UNAVAILABLE'
      ? { ok: false, reason: 'STORE_UNAVAILABLE' }
      : { ok: false, reason: obs.reason }
  }
  const observation = obs.observation

  let selectedSiren: string | undefined
  if (verdict === 'ACCEPTED_CANDIDATE') {
    // ⚠️ PUR SÉLECTEUR : le SIREN DOIT appartenir au cliché persisté — jamais
    // un SIREN arbitraire, jamais un payload navigateur.
    const s = String(input?.selectedSiren || '').trim()
    if (!/^\d{9}$/.test(s)) return { ok: false, reason: 'INVALID_INPUT' }
    const choisi = observation.candidates.find((c) => c.siren === s)
    if (!choisi) return { ok: false, reason: 'SIREN_NOT_IN_OBSERVATION' }
    // Politique V0 « compte courant » : une entité EXPLICITEMENT inactive dans
    // le cliché ne peut pas être sélectionnée ; `active` absent est toléré ICI
    // (la revalidation à l'usage exige `active === true` de toute façon).
    if (choisi.active === false) return { ok: false, reason: 'CANDIDATE_NOT_ELIGIBLE' }
    selectedSiren = s
  } else {
    if (input?.selectedSiren !== undefined) return { ok: false, reason: 'INVALID_INPUT' }
    // ── RÈGLE NONE (§8) — un NONE ne révoque JAMAIS une sélection qu'il n'a
    // pas montrée : si le candidat sujet a déjà une sélection ACCEPTED
    // effective A et que A n'apparaît PAS dans cette fenêtre, refuser.
    const courante = await effectiveHumanDecision(observation.subjectCandidateId, ws)
    if (courante.kind === 'STORE_UNAVAILABLE') return { ok: false, reason: 'STORE_UNAVAILABLE' }
    if (courante.kind === 'HISTORY_TAMPERED') return { ok: false, reason: 'HISTORY_TAMPERED' }
    if (courante.kind === 'ACCEPTED'
      && !observation.candidates.some((c) => c.siren === courante.siren)) {
      return { ok: false, reason: 'OBSERVATION_DOES_NOT_COVER_CURRENT_SELECTION' }
    }
  }

  const adjudicatedAt = now().toISOString()
  if (!isStrictInstant(adjudicatedAt)) return { ok: false, reason: 'INVALID_INPUT' }
  const sans: Omit<EntityResolutionAdjudicationV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: ENTITY_RESOLUTION_ADJUDICATION_CONTRACT,
    observationId: observation.id,
    verdict,
    ...(selectedSiren !== undefined ? { selectedSiren } : {}),
    adjudicatedBy: adjudicatedBy.trim(),
    adjudicatedAt,
  }
  const id = entityAdjudicationId(ws, observation.id, verdict, selectedSiren ?? '', adjudicatedBy.trim(), adjudicatedAt)
  const adjudication: EntityResolutionAdjudicationV0 = { id, ...sans, recordHash: recordHashDe(sans) }
  if (await insertItemIfAbsent(ENTITY_RESOLUTION_ADJUDICATION_KIND, id, adjudication, ws)) {
    return { ok: true, adjudication, created: true }
  }
  const relu = await getItemStrict<EntityResolutionAdjudicationV0>(ENTITY_RESOLUTION_ADJUDICATION_KIND, id, ws)
  if (relu.ok === true && relu.value && canonicalJson(relu.value as any) === canonicalJson(adjudication as any)) {
    return { ok: true, adjudication, created: false }
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

// ── DÉCISION HUMAINE EFFECTIVE — DÉRIVÉE, CADRÉE CANDIDAT ───────────────────

export type EffectiveHumanDecision =
  | { kind: 'ACCEPTED'; siren: string; adjudicationId: string; observation: EntityResolutionObservationV0 }
  | { kind: 'NONE'; observation: EntityResolutionObservationV0 }
  | { kind: 'ABSENT' }
  | { kind: 'STORE_UNAVAILABLE' }
  | { kind: 'HISTORY_TAMPERED' }

/**
 * ⚠️ AUCUNE réutilisation par NOM : seules les observations dont
 * `subjectCandidateId` est EXACTEMENT ce candidat comptent — un second « Mio »
 * du même espace n'hérite RIEN. Toute observation référencée invalide/falsifiée
 * fait tomber la décision (fail closed, jamais un drapeau cru).
 */
export async function effectiveHumanDecision(candidateId: string, ws: string): Promise<EffectiveHumanDecision> {
  const obsLues = await listItemsStrict<EntityResolutionObservationV0>(ENTITY_RESOLUTION_OBSERVATION_KIND, ws)
  if (obsLues.ok === false) return { kind: 'STORE_UNAVAILABLE' }
  // ⚠️ UNE LIGNE FALSIFIÉE N'EST JAMAIS SILENCIEUSEMENT IGNORÉE quand elle
  // PEUT participer à la décision de CE candidat : corrompre l'enregistrement
  // le plus récent ne doit jamais faire « remonter » une décision plus
  // ancienne, ni rouvrir la voie automatique. Une ligne corrompue dont le
  // sujet BRUT désigne un AUTRE candidat n'empoisonne pas celui-ci ; un sujet
  // illisible est falsifié-pour-tous (on ne peut pas prouver qu'il est
  // étranger) ⇒ fail closed.
  const observations = new Map<string, EntityResolutionObservationV0>()
  const obsIdsSujets = new Set<string>() // ids BRUTS d'observations rattachables à ce candidat
  for (const o of obsLues.values) {
    if (isEntityResolutionObservation(o, ws)) {
      if (o.subjectCandidateId === candidateId) { observations.set(o.id, o); obsIdsSujets.add(o.id) }
      continue
    }
    const sujetBrut = (o as any)?.subjectCandidateId
    if (typeof sujetBrut !== 'string' || !/^cand_[0-9a-f]{32}$/.test(sujetBrut)) {
      return { kind: 'HISTORY_TAMPERED' } // sujet illisible : impossible de prouver « étranger »
    }
    if (sujetBrut === candidateId) return { kind: 'HISTORY_TAMPERED' }
    // sujet lisible ET étranger : n'empoisonne pas ce candidat.
  }
  const adjLues = await listItemsStrict<EntityResolutionAdjudicationV0>(ENTITY_RESOLUTION_ADJUDICATION_KIND, ws)
  if (adjLues.ok === false) return { kind: 'STORE_UNAVAILABLE' }
  const applicables: EntityResolutionAdjudicationV0[] = []
  for (const a of adjLues.values) {
    if (isEntityResolutionAdjudication(a, ws)) {
      // (une observation de CE candidat falsifiée a déjà fait échouer plus
      // haut : ici, une observation inconnue est forcément celle d'un autre
      // candidat — hors sujet.)
      if (!observations.has(a.observationId)) continue
      // Cohérence sémantique adjudication ↔ cliché : une sélection ACCEPTED
      // hors du cliché observé n'est pas « filtrée » — c'est une falsification.
      if (a.verdict === 'ACCEPTED_CANDIDATE'
        && !observations.get(a.observationId)!.candidates.some((c) => c.siren === a.selectedSiren)) {
        return { kind: 'HISTORY_TAMPERED' }
      }
      applicables.push(a)
      continue
    }
    const obsBrute = (a as any)?.observationId
    if (typeof obsBrute !== 'string' || !/^ero_[0-9a-f]{32}$/.test(obsBrute)) {
      return { kind: 'HISTORY_TAMPERED' } // lien illisible : fail closed
    }
    if (observations.has(obsBrute) || obsIdsSujets.has(obsBrute)) {
      return { kind: 'HISTORY_TAMPERED' } // adjudication corrompue rattachée à CE candidat
    }
    // rattachée (lisiblement) à une observation étrangère : hors sujet.
  }
  if (observations.size === 0 && applicables.length === 0) return { kind: 'ABSENT' }
  applicables.sort((a, b) => (a.adjudicatedAt === b.adjudicatedAt
    ? (a.id < b.id ? 1 : -1)
    : (a.adjudicatedAt < b.adjudicatedAt ? 1 : -1)))
  const derniere = applicables[0]
  if (!derniere) return { kind: 'ABSENT' }
  const observation = observations.get(derniere.observationId)!
  return derniere.verdict === 'ACCEPTED_CANDIDATE'
    ? { kind: 'ACCEPTED', siren: derniere.selectedSiren as string, adjudicationId: derniere.id, observation }
    : { kind: 'NONE', observation }
}

// ── RÉSOLVEUR COMPOSITE — MATRICE AUTO/HUMAIN EXPLICITE ─────────────────────

export type EntityResolutionAuthority = 'AUTO_EXACT_REGISTRY' | 'HUMAN_SELECTED_REGISTRY_CANDIDATE'

export type EntityResolutionResult =
  | {
      state: 'RESOLVED'
      siren: string
      name?: string
      website?: string
      entityAuthority: EntityResolutionAuthority
      entityResolutionAdjudicationId?: string
    }
  | { state: 'NOT_RESOLVED' }
  | { state: 'IDENTITY_CONFLICT' }
  | { state: 'HISTORY_TAMPERED' }
  | { state: 'REGISTRY_UNAVAILABLE' }
  | { state: 'STORE_UNAVAILABLE' }

export interface EntityResolverDeps {
  lookupByName: typeof lookupByName
  lookupBySiren: typeof lookupBySiren
}
const depsReels: EntityResolverDeps = { lookupByName, lookupBySiren }

/**
 * Résout l'entité POUR CE CANDIDAT. Matrice CLOSE (§13 du ticket) :
 *   1. pas d'humain + auto exact A            → A (AUTO_EXACT_REGISTRY)
 *   2. pas d'humain + auto ambigu/introuvable → NOT_RESOLVED
 *   3. humain A + auto ambigu/introuvable     → revalidation lookupBySiren(A)
 *      (found + resolved + siren strictement égal + active === true — inactif
 *      OU inconnu ⇒ fail closed) → A (HUMAN_SELECTED_REGISTRY_CANDIDATE + era)
 *   4. humain A + auto exact A                → A (AUTO — l'autorité automatique
 *      suffit seule, aucun era requis en aval)
 *   5. humain A + auto exact B ≠ A            → IDENTITY_CONFLICT, fail closed
 *   6. dernier humain NONE + auto exact B :
 *        B FIGURAIT dans la fenêtre rejetée   → IDENTITY_CONFLICT (vu et rejeté)
 *        B n'y figurait PAS                   → B (AUTO — NONE ne dit rien de B)
 *   7. dernier humain NONE + auto non résolu  → NOT_RESOLVED
 * Après TOUTE résolution : `candidateSiren` présent et différent ⇒
 * IDENTITY_CONFLICT — il reste non-autoritatif, jamais promu.
 * Panne registre ⇒ REGISTRY_UNAVAILABLE (rejouable), jamais « introuvable ».
 */
export async function resolveEntityForCandidate(
  candidate: SignalCandidate, ws: string, deps: EntityResolverDeps = depsReels,
): Promise<EntityResolutionResult> {
  const raison = String(candidate?.claim?.company || '').trim()
  if (!raison) return { state: 'NOT_RESOLVED' }

  let auto: CompanyLookup
  try { auto = await deps.lookupByName(raison) } catch { return { state: 'REGISTRY_UNAVAILABLE' } }
  const autoSiren = auto?.found === true && auto.resolution === 'resolved' && /^\d{9}$/.test(String(auto.siren || ''))
    ? String(auto.siren)
    : null

  const humain = await effectiveHumanDecision(candidate.id, ws)
  if (humain.kind === 'STORE_UNAVAILABLE') return { state: 'STORE_UNAVAILABLE' }
  // ⚠️ HISTORIQUE HUMAIN CORROMPU ⇒ FAIL CLOSED — jamais un repli silencieux
  // vers une décision plus ancienne NI vers la résolution automatique :
  // corrompre l'histoire n'efface pas un conflit.
  if (humain.kind === 'HISTORY_TAMPERED') return { state: 'HISTORY_TAMPERED' }

  let resolu: EntityResolutionResult | null = null
  if (humain.kind === 'ABSENT') {
    resolu = autoSiren
      ? { state: 'RESOLVED', siren: autoSiren, name: auto.name, website: auto.website, entityAuthority: 'AUTO_EXACT_REGISTRY' }
      : { state: 'NOT_RESOLVED' }
  } else if (humain.kind === 'ACCEPTED') {
    if (autoSiren === humain.siren) {
      resolu = { state: 'RESOLVED', siren: autoSiren, name: auto.name, website: auto.website, entityAuthority: 'AUTO_EXACT_REGISTRY' }
    } else if (autoSiren !== null) {
      return { state: 'IDENTITY_CONFLICT' } // jamais un choix silencieux
    } else {
      // ── REVALIDATION À L'USAGE — via lookupBySiren EXACT, jamais un top-10
      // classé par pertinence (une entité valide peut sortir du classement).
      let officiel: Awaited<ReturnType<typeof lookupBySiren>>
      try { officiel = await deps.lookupBySiren(humain.siren) } catch { return { state: 'REGISTRY_UNAVAILABLE' } }
      if (
        officiel?.found === true && officiel.resolution === 'resolved'
        && officiel.siren === humain.siren && officiel.active === true
      ) {
        resolu = {
          state: 'RESOLVED', siren: humain.siren, name: officiel.name, website: officiel.website,
          entityAuthority: 'HUMAN_SELECTED_REGISTRY_CANDIDATE',
          entityResolutionAdjudicationId: humain.adjudicationId,
        }
      } else {
        return { state: 'NOT_RESOLVED' } // inexistant, inactif OU actif inconnu : fail closed
      }
    }
  } else {
    // Dernier verdict NONE — borné à SA fenêtre observée.
    if (autoSiren === null) return { state: 'NOT_RESOLVED' }
    if (humain.observation.candidates.some((c) => c.siren === autoSiren)) {
      return { state: 'IDENTITY_CONFLICT' } // l'humain a VU et REJETÉ cette entité
    }
    resolu = { state: 'RESOLVED', siren: autoSiren, name: auto.name, website: auto.website, entityAuthority: 'AUTO_EXACT_REGISTRY' }
  }

  if (resolu.state === 'RESOLVED') {
    const propose = candidate.claim?.candidateSiren
    if (propose && propose !== resolu.siren) return { state: 'IDENTITY_CONFLICT' }
  }
  return resolu
}
