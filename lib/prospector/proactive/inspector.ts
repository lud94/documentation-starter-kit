// FACTUAL_MEMORY_INSPECTOR_V0_001 — LECTURE SEULE de la mémoire factuelle.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// La vue d'inspection : « ce que Prospector sait FACTUELLEMENT d'un compte,
// sous quelle représentation, et quelles assertions de source le soutiennent ».
//
//   SOURCE → SourceAssertion (histoire durable par source)
//          → Fait canonique (ancre d'identité)
//
// La relation ancre ↔ assertions est RECONSTRUITE à la lecture (mêmes clés
// canoniques, même jour d'observation pour un état) — jamais matérialisée dans
// l'ancre : aucun tableau mutable de sources n'entre dans un fait canonique.
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// Aucune écriture, aucune interprétation, aucun score, aucune Situation,
// aucune recommandation, aucune tendance. « 4 postes ouverts le 2026-08-30 »
// est un fait ; « le recrutement accélère » est une conclusion — interdite ici.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────────────
// Toute ligne relue est REVALIDÉE par les gardes de production. Une ligne
// malformée n'est JAMAIS présentée comme un fait : elle est comptée et
// désignée (kind + id), sans exposer son contenu non validé.
import {
  isSourceAssertion, SOURCE_ASSERTION_KIND, type SourceAssertion,
} from './sourceAssertion'
import {
  isCanonicalEvent, isCanonicalExecutiveEvent, isCanonicalStateSnapshot,
  CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND,
  type CanonicalEvent, type CanonicalExecutiveEvent, type CanonicalStateSnapshot,
} from './canonicalFact'
import { candidateId, SIGNAL_CANDIDATE_KIND } from './signalCandidates'
import { personKeyV2 } from './acquisitionV2'
import { listItemsStrict } from '../../supabase/store'

const COMPTE_VERIFIE = /^acc_siren_(\d{9})$/

export type {
  FactualMemoryView, InspectorClaimGroup, InspectorRejectedRow,
} from './inspectorView'
export { supportingAssertions } from './inspectorView'
import type { FactualMemoryView, InspectorClaimGroup, InspectorRejectedRow } from './inspectorView'

export type InspectorRead =
  | { ok: true; view: FactualMemoryView }
  | { ok: false; reason: 'INVALID_ACCOUNT' | 'STORE_UNAVAILABLE' }

const parId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Lit la mémoire factuelle d'UN compte, dans UN espace — via les primitives
 * de lecture STRICTES de production, et elles seules. Aucune mutation.
 */
export async function inspectFactualMemory(
  accountId: unknown, ws: string,
): Promise<InspectorRead> {
  const m = COMPTE_VERIFIE.exec(String(accountId ?? ''))
  if (!m) return { ok: false, reason: 'INVALID_ACCOUNT' }
  const compte = String(accountId)
  const siren = m[1]

  const [assertionsLues, evenementsLus, instantanesLus, candidatsLus] = await Promise.all([
    listItemsStrict<any>(SOURCE_ASSERTION_KIND, ws),
    listItemsStrict<any>(CANONICAL_EVENT_KIND, ws),
    listItemsStrict<any>(CANONICAL_STATE_SNAPSHOT_KIND, ws),
    listItemsStrict<any>(SIGNAL_CANDIDATE_KIND, ws),
  ])
  // « vide » et « injoignable » restent DEUX réponses : une panne ne doit pas
  // se lire « ce compte n'a aucun fait ».
  if (
    assertionsLues.ok === false || evenementsLus.ok === false
    || instantanesLus.ok === false || candidatsLus.ok === false
  ) {
    return { ok: false, reason: 'STORE_UNAVAILABLE' }
  }

  const rejected: InspectorRejectedRow[] = []
  const rejeter = (kind: string, ligne: any) => {
    // ⚠️ IDENTIFIANT SEUL — jamais le contenu d'une ligne non validée.
    rejected.push({ kind, id: String(ligne?.id ?? '(sans id)'), reason: 'MALFORMED_ROW' })
  }

  const assertions: SourceAssertion[] = []
  for (const ligne of assertionsLues.values) {
    if (String(ligne?.accountId ?? '') !== compte) continue
    if (isSourceAssertion(ligne) && ligne.workspaceId === ws) assertions.push(ligne)
    else rejeter(SOURCE_ASSERTION_KIND, ligne)
  }

  const events: Array<CanonicalEvent | CanonicalExecutiveEvent> = []
  for (const ligne of evenementsLus.values) {
    if (String(ligne?.accountId ?? '') !== compte) continue
    if ((isCanonicalEvent(ligne) || isCanonicalExecutiveEvent(ligne)) && ligne.workspaceId === ws) {
      events.push(ligne)
    } else rejeter(CANONICAL_EVENT_KIND, ligne)
  }

  const snapshots: CanonicalStateSnapshot[] = []
  for (const ligne of instantanesLus.values) {
    if (String(ligne?.accountId ?? '') !== compte) continue
    if (isCanonicalStateSnapshot(ligne) && ligne.workspaceId === ws) snapshots.push(ligne)
    else rejeter(CANONICAL_STATE_SNAPSHOT_KIND, ligne)
  }

  // Nom d'entreprise : depuis un CANDIDAT dont l'identité se recalcule (une
  // ligne substituée ne peut pas nommer un compte) et dont le SIREN correspond.
  let company: string | null = null
  for (const ligne of candidatsLus.values) {
    const claim = ligne?.claim
    if (!claim || typeof claim !== 'object') continue
    if (String(claim.candidateSiren ?? '') !== siren) continue
    const normalise = { ...claim, v2: claim.v2 ?? null }
    try {
      if (candidateId(normalise, ws) === String(ligne.id)) {
        company = String(claim.company)
        break
      }
    } catch { /* ligne illisible ⇒ ignorée, jamais promue en nom */ }
  }

  const parCle = new Map<string, SourceAssertion[]>()
  for (const a of assertions) {
    const existant = parCle.get(a.canonicalClaimKey)
    if (existant) existant.push(a)
    else parCle.set(a.canonicalClaimKey, [a])
  }
  const claims: InspectorClaimGroup[] = [...parCle.entries()]
    .map(([canonicalClaimKey, liste]) => ({
      canonicalClaimKey,
      assertions: [...liste].sort(parId),
      uniqueSourceUrls: new Set(liste.map((a) => a.sourceUrl)).size,
    }))
    .sort((x, y) => (x.canonicalClaimKey < y.canonicalClaimKey ? -1 : 1))

  // ── SOUTIEN EXACT ancre → assertions (TRACEABILITY_FIX_001) ──────────────
  // ⚠️ LA CLÉ CANONIQUE NE SUFFIT PAS POUR UNE ANCRE EXÉCUTIVE. Son identité
  // canonique inclut aussi direction, fonction, clé de personne et jour :
  // deux personnes distinctes partagent LÉGITIMEMENT la même clé de
  // revendication. Le soutien est donc recalculé ici avec les règles de
  // PRODUCTION — `personKeyV2` incluse, jamais réimplémentée.
  const support: Record<string, string[]> = {}
  const soutient = (ancre: CanonicalEvent | CanonicalExecutiveEvent, a: SourceAssertion): boolean => {
    if (a.canonicalClaimKey !== ancre.canonicalClaimKey) return false
    if (ancre.type === 'FUNDING_ROUND') return true // identité = compte + jour, déjà dans la clé
    // EXECUTIVE_* : les SEPT conditions, toutes.
    const fait = a.structuredFact
    if (!fait || fait.payload.family !== 'EXECUTIVE_CHANGE') return false
    if (fait.occurredAt !== ancre.occurredAt) return false
    const p = fait.payload
    if (p.roleFunction !== (ancre as CanonicalExecutiveEvent).roleFunction) return false
    const attendu = ancre.type === 'EXECUTIVE_APPOINTMENT' ? 'APPOINTMENT' : 'DEPARTURE'
    if (p.direction !== attendu) return false
    return personKeyV2(p.person, ancre.accountId) === (ancre as CanonicalExecutiveEvent).personKey
  }
  for (const e of events) {
    support[e.id] = assertions.filter((a) => soutient(e, a)).map((a) => a.id).sort()
  }
  for (const sn of snapshots) {
    support[sn.id] = assertions
      .filter((a) => a.canonicalClaimKey === sn.canonicalClaimKey && a.sourceObservedDay === sn.stateObservedDay)
      .map((a) => a.id).sort()
  }

  return {
    ok: true,
    view: {
      accountId: compte, siren, company,
      events: events.sort(parId),
      snapshots: snapshots.sort(parId),
      claims,
      rejected,
      support,
    },
  }
}

// Optimisation de lecture par compte (index/scan côté base) : suivie
// séparément sous INSPECTOR_ACCOUNT_SCOPED_READ_OPTIMIZATION_001 (P2) —
// hors du périmètre de ce correctif.
