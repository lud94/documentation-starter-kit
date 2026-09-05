// SIGNAL_CANONICAL_GATE_V0_001 — LA FRONTIÈRE FAIT CANONIQUE → SIGNAL.
//
// ── LA RÈGLE SÉMANTIQUE QUE CE MODULE INSTALLE ──────────────────────────────
//   EvidenceEvent = projection de fait PERSISTÉE (réécrivable par upsert).
//   SignalV0     = une EvidenceEvent EXTERNE qui a PASSÉ ce gate — c'est-à-dire
//                  dont l'histoire canonique IMMUABLE (SourceAssertion +
//                  ancres CanonicalEvent/ExecutiveEvent/StateSnapshot) est
//                  reconstructible et COHÉRENTE avec la projection courante.
// Aucun nouvel objet persisté, aucun champ inverse sur l'Evidence : les liens
// canoniques restent DÉRIVÉS des identités déterministes existantes, comme
// `canonicalFact.ts` l'a voulu. Ce gate ne fait que les REVÉRIFIER en lecture.
//
// ── LECTURE ≠ REVALIDATION (invariant ABSOLU) ───────────────────────────────
// Aucune capture, aucun registre officiel, aucun résolveur, aucun LLM, aucune
// écriture. Uniquement des lectures strictes du magasin et des recalculs
// d'identité purs. Un test structurel le verrouille.
//
// ── DEUX ÉCHECS GLOBAUX, DEUX EXCLUSIONS PAR LIGNE — JAMAIS DE SILENCE ─────
//   STORE_UNAVAILABLE : « je ne sais pas » — jamais une liste vide.
//   CANONICAL_HISTORY_INVALID : une ligne de registre STRUCTURELLEMENT
//     invalide ⇒ tout échoue fermé — on ne calcule pas des Signals sur une
//     histoire illisible, et on n'écarte jamais une ligne corrompue en silence.
//   CANONICAL_HISTORY_MISSING (par evidence) : l'histoire immuable n'existe
//     pas — héritage NON COUVERT, jamais « vieille evidence valide ».
//   CANONICAL_HISTORY_DIVERGENT (par evidence) : la projection courante ne
//     correspond plus à ce que le registre immuable soutient (réécriture
//     d'Evidence, clé incohérente) — bloquée, distinctement de « manquante ».
import { createHash } from 'node:crypto'

import { listItemsStrict } from '../../supabase/store'
import { canonicalClaimKey, EXTERNAL_SIGNAL_PROVIDER, type EvidenceEvent } from './types'
import type { KnownEvidenceEvent } from './catalog'
import { externalEvidenceId } from './signalBridge'
import {
  isSourceAssertion, normalizeSourceUrl, SOURCE_ASSERTION_KIND, type SourceAssertion,
} from './sourceAssertion'
import {
  CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND,
  canonicalEventId, canonicalExecutiveEventId, canonicalSnapshotId, canonicalTypeFor,
  isCanonicalEvent, isCanonicalExecutiveEvent, isCanonicalStateSnapshot,
  type CanonicalEvent, type CanonicalExecutiveEvent, type CanonicalStateSnapshot,
} from './canonicalFact'
import { assertedFactHash, isAcquisitionFactV2, personKeyV2 } from './acquisitionV2'

/**
 * SIGNAL V0 — ALIAS SÉMANTIQUE, PAS UN OBJET NOUVEAU.
 *
 * Physiquement, un Signal EST une `KnownEvidenceEvent` (compatibilité totale,
 * aucun embranchement d'exécution). Sémantiquement, seul ce gate a le droit de
 * conférer ce nom : une evidence externe qui ne l'a pas passé n'est PAS un
 * Signal — c'est une projection en attente de preuve d'histoire.
 */
export type SignalV0 = KnownEvidenceEvent

export type SignalExclusionState = 'CANONICAL_HISTORY_MISSING' | 'CANONICAL_HISTORY_DIVERGENT'
export type SignalExclusionReason =
  | 'NO_SOURCE_ASSERTION'
  | 'NO_CANONICAL_ANCHOR'
  | 'SNAPSHOT_DAY_UNANCHORED'
  | 'UNSUPPORTED_CANONICAL_TYPE'
  | 'EVIDENCE_IDENTITY_INCOHERENT'
  | 'ASSERTION_CLAIM_MISMATCH'
  | 'SEMANTIC_VERSION_UNSUPPORTED'
  | 'ANCHOR_CLAIM_MISMATCH'
  | 'PRIMARY_SOURCE_UNSUPPORTED'

export interface SignalExclusion {
  evidenceId: string
  state: SignalExclusionState
  reason: SignalExclusionReason
}

export type SignalGateResult =
  | {
      ok: true
      /** Les evidences externes DEVENUES SignalV0 + les internes (hors périmètre, inchangées). */
      signals: KnownEvidenceEvent[]
      /** Les externes refusées — typées, jamais avalées. */
      excluded: SignalExclusion[]
    }
  | { ok: false; reason: 'STORE_UNAVAILABLE' | 'CANONICAL_HISTORY_INVALID' }

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')
void sha256 // reserve d'extension — les identites viennent des modules proprietaires

function estExterne(e: EvidenceEvent): boolean {
  return e?.source?.provider === EXTERNAL_SIGNAL_PROVIDER
}

/**
 * Classement d'UNE evidence externe contre l'histoire déjà chargée — PUR.
 * Exporté pour les tests ; la production passe par `canonicalSignalGate`.
 */
export function classifyExternalEvidence(
  e: KnownEvidenceEvent,
  ws: string,
  registres: {
    assertions: readonly SourceAssertion[]
    events: readonly (CanonicalEvent | CanonicalExecutiveEvent)[]
    snapshots: readonly CanonicalStateSnapshot[]
  },
): { state: 'CANONICALLY_GROUNDED'; assertionIds: string[]; anchorIds: string[] } | SignalExclusion {
  // ── 1. COHÉRENCE INTERNE DE LA PROJECTION — la clé se RECALCULE, jamais crue.
  const cle = canonicalClaimKey({
    type: e.type,
    accountId: e.accountId,
    temporality: e.temporality,
    ...(e.temporality === 'dated_event' ? { occurredAt: e.occurredAt } : {}),
  })
  if (externalEvidenceId(cle) !== e.id || (e.acceptance && e.acceptance.canonicalKey !== cle)) {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'EVIDENCE_IDENTITY_INCOHERENT' }
  }

  // ── 2. ASSERTIONS DE SOURCE — découvertes DANS le registre (1 → N), jamais
  // référencées par un champ inverse sur l'Evidence.
  const liees = registres.assertions.filter((a) => a.evidenceId === e.id)
  if (liees.length === 0) {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_SOURCE_ASSERTION' }
  }
  // ── R1-2 : AUCUN REPLI SUR LE SOUS-ENSEMBLE VALIDE. TOUTE assertion liée à
  // cet id mais sémantiquement incompatible (autre revendication, autre compte,
  // autre type, autre temporalité) prouve que la projection a été réécrite sous
  // un identifiant existant — l'histoire ENTIÈRE est divergente. Une assertion
  // compatible à côté n'y change rien : on ne trie pas une histoire corrompue,
  // on la bloque. (Une assertion d'un AUTRE evidenceId, elle, reste simplement
  // étrangère — elle ne corrompt pas cette histoire-ci.)
  const compatible = (a: SourceAssertion) =>
    a.canonicalClaimKey === cle
    && a.accountId === e.accountId
    && a.evidenceType === e.type
    && a.assertionTemporality === e.temporality
  if (liees.some((a) => !compatible(a))) {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ASSERTION_CLAIM_MISMATCH' }
  }
  const soutiens = liees
  // ── 2b. VERSION SÉMANTIQUE (réécriture d'Evidence). Si la projection
  // courante porte un fait V2, AU MOINS UNE assertion durable doit soutenir
  // EXACTEMENT cette version (même condensat sémantique). Un rejeu compatible
  // passe ; une réécriture 10 M€ → 12 M€ sans nouvelle assertion est bloquée.
  // Une evidence V1 héritée (sans fait structuré) n'est pas soumise au test.
  if (e.structuredFact !== undefined) {
    if (!isAcquisitionFactV2(e.structuredFact)) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'SEMANTIC_VERSION_UNSUPPORTED' }
    }
    const hashCourant = assertedFactHash(e.structuredFact, e.accountId)
    if (!soutiens.some((a) => a.assertedFactHash === hashCourant)) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'SEMANTIC_VERSION_UNSUPPORTED' }
    }
  }
  // ── R1-5 : LA SOURCE PRINCIPALE COURANTE DOIT AVOIR UN APPUI AU REGISTRE.
  // `source.url` est une projection MUTABLE : une réécriture peut substituer la
  // source B à la source A en conservant claim et fait sémantique — l'ancienne
  // assertion de A soutiendrait alors une provenance qu'aucune source durable
  // n'a portée (EVIDENCE_PROVENANCE_OVERWRITE_001). Au moins une assertion
  // compatible doit citer EXACTEMENT l'URL principale courante (normalisée par
  // le MÊME normaliseur que le registre). Une recapture légitime de la même
  // page reste possible : ni `retrievedAt` ni la provenance ne sont comparés.
  // URL absente ou inexploitable ⇒ échec fermé, jamais une provenance devinée.
  const urlPrimaire = normalizeSourceUrl(e.source?.url)
  if (urlPrimaire === null || !soutiens.some((a) => a.sourceUrl === urlPrimaire)) {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'PRIMARY_SOURCE_UNSUPPORTED' }
  }

  // ── 3. ANCRES CANONIQUES — cardinalités RESPECTÉES, jamais un singleton forcé.
  const typeCanonique = canonicalTypeFor(e.type)
  if (typeCanonique === null) {
    // Carte d'autorité close : un type sans producteur canonique n'entre pas.
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'UNSUPPORTED_CANONICAL_TYPE' }
  }

  const assertionIds = soutiens.map((a) => a.id).sort()

  if (typeCanonique === 'FUNDING_ROUND') {
    if (e.temporality !== 'dated_event') {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'EVIDENCE_IDENTITY_INCOHERENT' }
    }
    // Identité DÉTERMINISTE recalculée : le compte et le jour, rien d'autre.
    const attendu = canonicalEventId(ws, e.accountId, e.occurredAt)
    const ancre = registres.events.find((c) => c.id === attendu)
    if (!ancre) return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_CANONICAL_ANCHOR' }
    if (ancre.canonicalClaimKey !== cle || ancre.accountId !== e.accountId) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ANCHOR_CLAIM_MISMATCH' }
    }
    return { state: 'CANONICALLY_GROUNDED', assertionIds, anchorIds: [ancre.id] }
  }

  if (typeCanonique === 'EXECUTIVE_APPOINTMENT' || typeCanonique === 'EXECUTIVE_DEPARTURE') {
    if (e.temporality !== 'dated_event') {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'EVIDENCE_IDENTITY_INCOHERENT' }
    }
    // ── R1-4 : L'ANCRE DE DIRECTION EST DÉRIVÉE DU FAIT SÉMANTIQUE, JAMAIS
    // CUEILLIE PAR REVENDICATION. La clé canonique ne contient ni la personne
    // ni la fonction : accepter « n'importe quelle ancre de même revendication »
    // laisserait l'ancre de John fonder l'évidence de Jane. On dérive donc
    // l'identité ATTENDUE depuis le fait V2 de la projection courante (direction,
    // fonction, clé de personne, jour), avec le MÊME producteur d'identité que
    // l'écriture — et c'est CETTE ancre-là qui doit exister.
    const directionAttendue = typeCanonique === 'EXECUTIVE_APPOINTMENT' ? 'APPOINTMENT' : 'DEPARTURE'
    const fait = e.structuredFact
    if (fait === undefined) {
      // Héritage V1 sans matière sémantique : personne et fonction ne sont
      // dérivables de RIEN — non couvert, jamais fondé, jamais fabriqué.
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'SEMANTIC_VERSION_UNSUPPORTED' }
    }
    // `fait` a déjà passé le validateur V2 en 2b ; ici on exige qu'il décrive
    // BIEN la revendication de direction qu'il prétend fonder.
    if (fait.payload.family !== 'EXECUTIVE_CHANGE'
      || fait.payload.direction !== directionAttendue
      || fait.occurredAt !== e.occurredAt) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'SEMANTIC_VERSION_UNSUPPORTED' }
    }
    const personne = personKeyV2(fait.payload.person, e.accountId)
    if (personne === null) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'SEMANTIC_VERSION_UNSUPPORTED' }
    }
    const idAttendu = canonicalExecutiveEventId(
      ws, typeCanonique, e.accountId, fait.payload.roleFunction, personne, e.occurredAt,
    )
    const ancre = registres.events.find((c) => c.id === idAttendu)
    if (!ancre) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_CANONICAL_ANCHOR' }
    }
    if (ancre.canonicalClaimKey !== cle || ancre.accountId !== e.accountId) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ANCHOR_CLAIM_MISMATCH' }
    }
    // 1..N PRÉSERVÉ : les ancres SUPPLÉMENTAIRES réellement dérivées d'une
    // assertion durable (deux personnes distinctes le même jour) coexistent —
    // aucun effondrement singleton, mais aucune ancre arbitraire non plus.
    const anchorsExec = new Set<string>([ancre.id])
    for (const a of soutiens) {
      const f = a.structuredFact
      if (!f || f.payload.family !== 'EXECUTIVE_CHANGE') continue
      if (f.payload.direction !== directionAttendue || f.occurredAt !== e.occurredAt) continue
      const clePersonne = personKeyV2(f.payload.person, e.accountId)
      if (clePersonne === null) continue
      const idDerive = canonicalExecutiveEventId(
        ws, typeCanonique, e.accountId, f.payload.roleFunction, clePersonne, e.occurredAt,
      )
      const autre = registres.events.find((c) => c.id === idDerive)
      if (autre && autre.canonicalClaimKey === cle && autre.accountId === e.accountId) {
        anchorsExec.add(autre.id)
      }
    }
    return { state: 'CANONICALLY_GROUNDED', assertionIds, anchorIds: [...anchorsExec].sort() }
  }

  // HIRING_SNAPSHOT — état non daté : CHAQUE jour d'observation affirmé par
  // une assertion durable doit avoir SON instantané (identité recalculée).
  // Plusieurs jours ⇒ plusieurs ancres ; un jour non ancré ⇒ échec fermé.
  if (e.temporality !== 'undated_state') {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'EVIDENCE_IDENTITY_INCOHERENT' }
  }
  const jours = [...new Set(soutiens
    .map((a) => a.sourceObservedDay)
    .filter((j): j is string => typeof j === 'string' && j !== ''))].sort()
  if (jours.length === 0) {
    return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_CANONICAL_ANCHOR' }
  }
  const anchorIds: string[] = []
  for (const jour of jours) {
    const attendu = canonicalSnapshotId(ws, cle, jour)
    const ancre = registres.snapshots.find((s) => s.id === attendu)
    if (!ancre) return { evidenceId: e.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'SNAPSHOT_DAY_UNANCHORED' }
    if (ancre.canonicalClaimKey !== cle || ancre.accountId !== e.accountId) {
      return { evidenceId: e.id, state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ANCHOR_CLAIM_MISMATCH' }
    }
    anchorIds.push(ancre.id)
  }
  return { state: 'CANONICALLY_GROUNDED', assertionIds, anchorIds }
}

/**
 * LE GATE. Lit chaque registre UNE fois, strictement ; valide CHAQUE ligne
 * avec les validateurs de production (ligne invalide ⇒ tout échoue fermé) ;
 * classe chaque evidence EXTERNE ; laisse passer les internes (CRM) intactes —
 * elles ne relèvent pas de l'histoire canonique externe.
 */
export async function canonicalSignalGate(
  evidence: readonly KnownEvidenceEvent[], ws: string,
): Promise<SignalGateResult> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'STORE_UNAVAILABLE' }

  const aLus = await listItemsStrict<unknown>(SOURCE_ASSERTION_KIND, ws)
  if (aLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const eLus = await listItemsStrict<unknown>(CANONICAL_EVENT_KIND, ws)
  if (eLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const sLus = await listItemsStrict<unknown>(CANONICAL_STATE_SNAPSHOT_KIND, ws)
  if (sLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }

  const assertions: SourceAssertion[] = []
  for (const v of aLus.values) {
    if (!isSourceAssertion(v)) return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    if ((v as SourceAssertion).workspaceId !== ws) return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    assertions.push(v)
  }
  // Le magasin d'événements porte DEUX formes closes (levée / direction) —
  // toute ligne qui n'est ni l'une ni l'autre est une histoire illisible.
  // ── R1-3 : LE CONTENU DOIT CONFIRMER SON CLOISONNEMENT. La lecture est déjà
  // cloisonnée par `(kind, workspace_id)`, mais une ligne PHYSIQUEMENT rangée
  // sous cet espace dont la charge se déclare d'un AUTRE espace (identité
  // dérivée de B, donc recalculable et « valide ») est une contradiction de
  // cloisonnement — histoire illisible, échec GLOBAL, jamais filtrée en silence.
  const events: (CanonicalEvent | CanonicalExecutiveEvent)[] = []
  for (const v of eLus.values) {
    if (!isCanonicalEvent(v) && !isCanonicalExecutiveEvent(v)) {
      return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    }
    if ((v as CanonicalEvent).workspaceId !== ws) return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    events.push(v as CanonicalEvent | CanonicalExecutiveEvent)
  }
  const snapshots: CanonicalStateSnapshot[] = []
  for (const v of sLus.values) {
    if (!isCanonicalStateSnapshot(v)) return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    if (v.workspaceId !== ws) return { ok: false, reason: 'CANONICAL_HISTORY_INVALID' }
    snapshots.push(v)
  }

  const registres = { assertions, events, snapshots }
  const signals: KnownEvidenceEvent[] = []
  const excluded: SignalExclusion[] = []
  for (const e of evidence) {
    if (!estExterne(e)) { signals.push(e); continue } // CRM/interne : hors périmètre, inchangé
    const verdict = classifyExternalEvidence(e, ws, registres)
    if (verdict.state === 'CANONICALLY_GROUNDED') signals.push(e)
    else excluded.push(verdict)
  }
  return { ok: true, signals, excluded }
}
