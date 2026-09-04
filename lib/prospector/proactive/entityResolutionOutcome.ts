// ENTITY_RESOLUTION_OUTCOME_PERSISTENCE_002 — REGISTRE APPEND-ONLY DES ISSUES
// DE RÉSOLUTION D'ENTITÉ.
//
// ── POURQUOI CE REGISTRE EXISTE ─────────────────────────────────────────────
// L'audit 001 a prouvé que l'état courant est IRRECONSTRUCTIBLE hors-ligne :
// la route observation répond `AUTO_RESOLVED` sans rien persister, et un ERO
// ne dit pas s'il est né d'une ambiguïté ordinaire ou d'une remédiation de
// conflit. Un ERX enregistre donc CHAQUE passage logique abouti de la route —
// c'est l'ENTRÉE DURABLE ET AUTORITAIRE de la future projection Entity Review.
// Sa persistance est BLOQUANTE côté route : un succès runtime sans ERX
// laisserait la revue hors-ligne reconstruire un état périmé.
//
// ── CE QU'IL NE DIT JAMAIS ──────────────────────────────────────────────────
// 1. L'ABSENCE d'ERX ne signifie RIEN — ni CURRENT, ni AMBIGUOUS, ni RESOLVED,
//    ni NOT_FOUND : seulement « hors couverture de ce registre » (V0 ne couvre
//    que les passages par /api/internal/entity-resolution-observation ; les
//    ERO hérités ne sont JAMAIS reclassés rétroactivement).
// 2. Un ERX est un FAIT DATÉ, jamais une vérité vivante : `AUTO_EXACT` de
//    jeudi ne résout rien vendredi. Le résolveur composite d'entité ne lit NI
//    n'écrit JAMAIS ce registre — pare-feu verrouillé par test structurel :
//    l'autorité de currency reste le registre officiel, interrogé en direct.
// 3. Les pannes (registre muet, magasin muet, historique corrompu, requête
//    invalide) ne sont PAS des issues : aucune connaissance d'entité n'a été
//    acquise, rien n'est enregistré.
import { createHash } from 'node:crypto'

import { getItemStrict, insertItemIfAbsent, listItemsStrict } from '../../supabase/store'
import { canonicalJson } from './acquisitionV2'
import { isStrictInstant } from './types'
import { readEntityResolutionObservation } from './entityResolution'

export const ENTITY_RESOLUTION_OUTCOME_KIND = 'prospector_entity_resolution_outcome'
export const ENTITY_RESOLUTION_OUTCOME_CONTRACT = 'entity-resolution-outcome-v0'

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

/** Vocabulaire CLOS — les pannes n'en font jamais partie. */
export type EntityResolutionOutcomeKind =
  | 'AUTO_EXACT'
  | 'AMBIGUOUS'
  | 'CONFLICT_REMEDIATION'
  | 'NOT_FOUND'
const OUTCOMES: readonly EntityResolutionOutcomeKind[] =
  ['AUTO_EXACT', 'AMBIGUOUS', 'CONFLICT_REMEDIATION', 'NOT_FOUND']

export interface EntityResolutionOutcomeV0 {
  id: string
  workspaceId: string
  contractVersion: 'entity-resolution-outcome-v0'
  /** Le candidat SUJET — l'issue ne vaut que pour lui (cadrage candidat V0). */
  subjectCandidateId: string
  outcome: EntityResolutionOutcomeKind
  /**
   * AUTO_EXACT : le SIREN exact rendu par le registre à cet instant (REQUIS).
   * CONFLICT_REMEDIATION : le SIREN auto-exact EN CONFLIT avec la décision
   * humaine (REQUIS — c'est la matière de décision ; il DOIT figurer dans la
   * fenêtre de l'ERO lié). AMBIGUOUS / NOT_FOUND : ABSENT.
   */
  siren?: string
  /** REQUIS ssi AMBIGUOUS|CONFLICT_REMEDIATION — l'ERO persisté par LE MÊME passage. */
  observationId?: string
  /**
   * Horloge SERVEUR du passage registre. Quand un ERO est lié, c'est
   * EXACTEMENT son `retrievedAt` — un seul instant pour un seul passage,
   * jamais deux horloges pour le même fait.
   */
  observedAt: string
  source: 'entity-resolution-observation-route'
  recordHash: string
}

// ── IDENTITÉ — TOUS les discriminants sémantiques, y compris le SIREN ───────
export function entityOutcomeId(
  ws: string, subjectCandidateId: string, outcome: string,
  siren: string | undefined, observationId: string | undefined, observedAt: string,
): string {
  return `erx_${sha256(
    `entity-resolution-outcome:v0:${ws}\n${subjectCandidateId}\n${outcome}\n${siren ?? ''}\n${observationId ?? ''}\n${observedAt}`,
  ).slice(0, 32)}`
}
export function outcomeRecordHash(o: Omit<EntityResolutionOutcomeV0, 'id' | 'recordHash'>): string {
  return sha256(canonicalJson({ ...o }))
}

// ── VALIDATION STRICTE — SÉMANTIQUE, JAMAIS recordHash SEUL ─────────────────
const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const clesCloses = (obj: Record<string, unknown>, requises: readonly string[], optionnelles: readonly string[]): boolean => {
  const admises = new Set([...requises, ...optionnelles])
  return requises.every((c) => c in obj) && Object.keys(obj).every((c) => admises.has(c))
}

export function isEntityResolutionOutcome(v: unknown, ws: string): v is EntityResolutionOutcomeV0 {
  if (!objet(v)) return false
  if (!clesCloses(v,
    ['id', 'workspaceId', 'contractVersion', 'subjectCandidateId', 'outcome', 'observedAt', 'source', 'recordHash'],
    ['siren', 'observationId'])) return false
  if (v.workspaceId !== ws) return false
  if (v.contractVersion !== ENTITY_RESOLUTION_OUTCOME_CONTRACT) return false
  if (typeof v.subjectCandidateId !== 'string' || v.subjectCandidateId.trim() === '') return false
  if (!(OUTCOMES as readonly unknown[]).includes(v.outcome)) return false
  if (v.source !== 'entity-resolution-observation-route') return false
  if (typeof v.observedAt !== 'string' || !isStrictInstant(v.observedAt)) return false
  // Cohérence outcome ↔ champs — le vocabulaire DIT ce que chaque forme exige.
  const siren = v.siren
  const observationId = v.observationId
  if (v.outcome === 'AUTO_EXACT') {
    if (typeof siren !== 'string' || !/^\d{9}$/.test(siren)) return false
    if (observationId !== undefined) return false
  } else if (v.outcome === 'AMBIGUOUS') {
    if (siren !== undefined) return false
    if (typeof observationId !== 'string' || !/^ero_[0-9a-f]{32}$/.test(observationId)) return false
  } else if (v.outcome === 'CONFLICT_REMEDIATION') {
    if (typeof siren !== 'string' || !/^\d{9}$/.test(siren)) return false
    if (typeof observationId !== 'string' || !/^ero_[0-9a-f]{32}$/.test(observationId)) return false
  } else {
    // NOT_FOUND — aucune identité, aucune fenêtre.
    if (siren !== undefined || observationId !== undefined) return false
  }
  // Identité et intégrité RECALCULÉES — jamais crues.
  if (v.id !== entityOutcomeId(ws, v.subjectCandidateId, v.outcome as string,
    siren as string | undefined, observationId as string | undefined, v.observedAt)) return false
  const { id: _id, recordHash: _rh, ...sans } = v as unknown as EntityResolutionOutcomeV0
  if (v.recordHash !== outcomeRecordHash(sans)) return false
  return true
}

// ── ENREGISTREMENT (APPEND-ONLY, BLOQUANT POUR L'APPELANT) ──────────────────

export interface OutcomeInput {
  subjectCandidateId: string
  outcome: EntityResolutionOutcomeKind
  siren?: string
  observationId?: string
  observedAt: string
}
export type OutcomeRecordResult =
  | { ok: true; outcome: EntityResolutionOutcomeV0; created: boolean }
  | { ok: false; reason: 'INVALID_INPUT' | 'OBSERVATION_INVALID' | 'STORE_UNAVAILABLE' | 'WRITE_FAILED' }

export async function recordEntityResolutionOutcome(
  input: OutcomeInput, ws: string,
): Promise<OutcomeRecordResult> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  const sansIntegrite: Omit<EntityResolutionOutcomeV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: ENTITY_RESOLUTION_OUTCOME_CONTRACT,
    subjectCandidateId: String(input?.subjectCandidateId ?? ''),
    outcome: input?.outcome,
    ...(input?.siren !== undefined ? { siren: input.siren } : {}),
    ...(input?.observationId !== undefined ? { observationId: input.observationId } : {}),
    observedAt: String(input?.observedAt ?? ''),
    source: 'entity-resolution-observation-route',
  }
  const id = entityOutcomeId(ws, sansIntegrite.subjectCandidateId, String(sansIntegrite.outcome),
    sansIntegrite.siren, sansIntegrite.observationId, sansIntegrite.observedAt)
  const record: EntityResolutionOutcomeV0 = { id, ...sansIntegrite, recordHash: outcomeRecordHash(sansIntegrite) }
  // Le validateur porte TOUTE la sémantique de forme — une seule définition.
  if (!isEntityResolutionOutcome(record, ws)) return { ok: false, reason: 'INVALID_INPUT' }

  // ── L'ERO LIÉ DOIT EXISTER, ÊTRE VALIDE, DU MÊME ESPACE ET DU MÊME SUJET,
  // et porter le MÊME instant (un passage = une horloge). Pour une
  // remédiation, le SIREN en conflit DOIT figurer dans la fenêtre observée.
  if (record.observationId !== undefined) {
    const lu = await readEntityResolutionObservation(record.observationId, ws)
    if (lu.ok === false) {
      return lu.reason === 'STORE_UNAVAILABLE'
        ? { ok: false, reason: 'STORE_UNAVAILABLE' }
        : { ok: false, reason: 'OBSERVATION_INVALID' }
    }
    const o = lu.observation
    if (o.subjectCandidateId !== record.subjectCandidateId) return { ok: false, reason: 'OBSERVATION_INVALID' }
    if (o.retrievedAt !== record.observedAt) return { ok: false, reason: 'OBSERVATION_INVALID' }
    if (record.outcome === 'CONFLICT_REMEDIATION'
      && !o.candidates.some((c) => c.siren === record.siren)) {
      return { ok: false, reason: 'OBSERVATION_INVALID' }
    }
  }

  if (await insertItemIfAbsent(ENTITY_RESOLUTION_OUTCOME_KIND, id, record, ws)) {
    return { ok: true, outcome: record, created: true }
  }
  // `false` est AMBIGU (déjà présent OU panne) : la relecture stricte tranche.
  const relu = await getItemStrict<EntityResolutionOutcomeV0>(ENTITY_RESOLUTION_OUTCOME_KIND, id, ws)
  if (relu.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  if (relu.value && canonicalJson(relu.value as any) === canonicalJson(record as any)) {
    return { ok: true, outcome: relu.value, created: false } // rejeu strictement identique
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

// ── LECTURES STRICTES (futur socle de la projection Entity Review) ──────────

export type OutcomesRead =
  | { ok: true; values: EntityResolutionOutcomeV0[] }
  | { ok: false; reason: 'STORE_UNAVAILABLE' | 'HISTORY_INVALID' }

/**
 * TOUS les ERX valides d'un candidat. Ligne corrompue ⇒ ÉCHEC FERMÉ, jamais un
 * filtrage silencieux. Liste VIDE = « hors couverture de ce registre » — cela
 * n'autorise AUCUNE inférence (ni CURRENT, ni AMBIGUOUS, ni quoi que ce soit) :
 * les ERO hérités sans ERX ne sont JAMAIS reclassés.
 */
export async function listOutcomesForCandidateStrict(
  subjectCandidateId: string, ws: string,
): Promise<OutcomesRead> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const lus = await listItemsStrict<unknown>(ENTITY_RESOLUTION_OUTCOME_KIND, ws)
  if (lus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const values: EntityResolutionOutcomeV0[] = []
  for (const v of lus.values) {
    if (!isEntityResolutionOutcome(v, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    if (v.subjectCandidateId === subjectCandidateId) values.push(v)
  }
  return { ok: true, values }
}
