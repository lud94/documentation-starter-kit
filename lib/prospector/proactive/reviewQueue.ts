// DOMAIN_REVIEW_PROJECTION_V0_001 — FILE DE REVUE : PROJECTION PURE, JAMAIS UNE VÉRITÉ.
//
// ── CE QUE CE MODULE EST, ET N'EST PAS ──────────────────────────────────────
// Un ReviewItem est un MODÈLE DE LECTURE dérivé, à chaque lecture, des seuls
// enregistrements AUTORITATIFS du domaine :
//   DomainProofObservationV0 (dpo_) + DomainAdjudicationV0 (dad_).
// Il n'est JAMAIS persisté, ne porte AUCUNE décision, et sa « résolution »
// n'existe que parce qu'une adjudication de domaine — le vrai record — existe.
// Deux lectures identiques produisent octet pour octet les mêmes items.
//
// ── LECTURE ≠ REVALIDATION (invariant ABSOLU) ───────────────────────────────
// Ce module ne lit QUE le magasin. Il n'importe ni la primitive d'éligibilité
// de production (qui RECAPTURE et PERSISTE une observation à chaque usage),
// ni la capture SSRF, ni le registre officiel, ni le résolveur d'entité. Un
// test structurel le verrouille. La fraîcheur est le travail du chemin
// d'USAGE (promotion), jamais de la file.
//
// ── L'INVARIANT SÉMANTIQUE DUR ──────────────────────────────────────────────
// Une DPO fraîche SANS nouvelle adjudication N'IMPLIQUE PAS une revue : c'est
// exactement la forme que produit une revalidation RÉUSSIE (la revalidation
// persiste toujours sa recapture, et ne crée jamais de dad — Phase C-bis et le
// Golden Path l'ont prouvé factuellement). Le hash brut du HTML ne participe
// JAMAIS à l'ouverture d'une revue : seule la MATIÈRE adjugée compte
// (targetSirenFound + proofAnchor, égalité STRICTE — même critère que
// l'éligibilité de production depuis DOMAIN_REVALIDATION_STABILITY_001).
import { createHash } from 'node:crypto'

import { listItemsStrict } from '../../supabase/store'
import {
  DOMAIN_ADJUDICATION_KIND,
  DOMAIN_PROOF_OBSERVATION_KIND,
  isDomainAdjudication,
  isDomainProofObservation,
  type DomainAdjudicationV0,
  type DomainProofObservationV0,
} from './domainBinding'
import {
  ENTITY_RESOLUTION_ADJUDICATION_KIND,
  ENTITY_RESOLUTION_OBSERVATION_KIND,
  isEntityResolutionAdjudication,
  isEntityResolutionObservation,
  type EntityResolutionAdjudicationV0,
  type EntityResolutionObservationV0,
} from './entityResolution'
import {
  ENTITY_RESOLUTION_OUTCOME_KIND,
  isEntityResolutionOutcome,
  type EntityResolutionOutcomeV0,
} from './entityResolutionOutcome'

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

// ── CONTRAT ReviewItem V0 — DOMAINE UNIQUEMENT ──────────────────────────────

export type ReviewEpistemicState = 'NEEDS_REVIEW' | 'PROOF_CHANGED' | 'CONFLICT' | 'BLOCKED'
export type ReviewLifecycle = 'OPEN' | 'RESOLVED' | 'SUPERSEDED'
export type DomainReviewAction = 'ACCEPT_FIRST_PARTY' | 'REJECT'
export type DomainReviewReason =
  | 'PROOF_AWAITING_ADJUDICATION'
  | 'TARGET_SIREN_ABSENT_AWAITING_DECISION'
  | 'NEW_PROOF_AFTER_REJECTION'
  | 'PROOF_ANCHOR_CHANGED'
  | 'TARGET_SIREN_ABSENT'

export interface DomainAuthorityReviewItemV0 {
  /** DÉTERMINISTE et borné à l'espace — jamais aléatoire, jamais persisté. */
  id: string
  contractVersion: 'review-item-v0'
  workspaceId: string
  kind: 'DOMAIN_AUTHORITY_REVIEW'
  /** Le domaine ne connaît QUE ces deux états — inchangé depuis la V0 Domain. */
  state: 'NEEDS_REVIEW' | 'PROOF_CHANGED'
  lifecycle: ReviewLifecycle
  reasonCode: DomainReviewReason
  subject: { siren: string; sourceHost: string }
  sourceRefs: {
    /** La DPO À ADJUGER — la décision reste POST /api/internal/domain-adjudication. */
    domainProofObservationId: string
    previousObservationId?: string
    previousAdjudicationId?: string
  }
  /** Instant du RECORD source (proofObservedAt de la cible) — jamais une horloge de lecture. */
  detectedAt: string
  /**
   * ⚠️ CALCULÉES À L'EXÉCUTION depuis la DPO cible : cible sans SIREN trouvé ⇒
   * ACCEPT_FIRST_PARTY ABSENT du tableau (la route le refuserait de toute
   * façon — la file ne propose jamais un geste que l'autorité refusera).
   */
  allowedActions: DomainReviewAction[]
  decisionAuthority: 'HUMAN_REQUIRED'
  title: string
  summary: string
  resolutionRef?: { kind: 'dad'; id: string; at: string; by: string }
}

export function domainReviewItemId(ws: string, targetObservationId: string): string {
  return `rvw_${sha256(`review-item:v0:${ws}\nDOMAIN_AUTHORITY_REVIEW\n${targetObservationId}`).slice(0, 32)}`
}

export type DomainReviewProjection =
  | { ok: true; items: DomainAuthorityReviewItemV0[] }
  /**
   * ⚠️ DEUX ÉCHECS DISTINCTS, TOUS DEUX FERMÉS. Magasin muet ⇒ « je ne sais
   * pas » (jamais une liste vide). Historique corrompu ⇒ on n'IGNORE pas la
   * ligne en silence : une file calculée en écartant des enregistrements
   * invalides affirmerait « rien à revoir » sur une histoire illisible.
   */
  | { ok: false; reason: 'STORE_UNAVAILABLE' | 'HISTORY_INVALID' }

// Tri des DPO : proofObservedAt DESC puis id DESC — même convention de
// départage que le tri de production des adjudications (domainBinding).
function plusRecenteDpo(a: DomainProofObservationV0, b: DomainProofObservationV0): number {
  return a.proofObservedAt === b.proofObservedAt
    ? (a.id < b.id ? 1 : -1)
    : (a.proofObservedAt < b.proofObservedAt ? 1 : -1)
}
// Tri des adjudications : adjudicatedAt DESC puis id DESC — IDENTIQUE au
// comparateur d'éligibilité de production (la file et l'usage doivent
// désigner LA MÊME « dernière adjudication applicable »).
function plusRecenteAdj(a: DomainAdjudicationV0, b: DomainAdjudicationV0): number {
  return a.adjudicatedAt === b.adjudicatedAt
    ? (a.id < b.id ? 1 : -1)
    : (a.adjudicatedAt < b.adjudicatedAt ? 1 : -1)
}

/** La MATIÈRE adjugée est-elle identique ? Jamais le hash brut du corps. */
function memeMatiereSemantique(a: DomainProofObservationV0, b: DomainProofObservationV0): boolean {
  return a.targetSirenFound === b.targetSirenFound && a.proofAnchor === b.proofAnchor
}

function actionsPermises(cible: DomainProofObservationV0): DomainReviewAction[] {
  // ACCEPT est EXCLU À L'EXÉCUTION quand la cible ne contient pas le SIREN —
  // c'est le miroir exact du refus OBSERVATION_NOT_ELIGIBLE de l'autorité.
  return cible.targetSirenFound === true ? ['ACCEPT_FIRST_PARTY', 'REJECT'] : ['REJECT']
}

function item(
  ws: string,
  state: 'NEEDS_REVIEW' | 'PROOF_CHANGED',
  reasonCode: DomainReviewReason,
  cible: DomainProofObservationV0,
  refs: { previousObservationId?: string; previousAdjudicationId?: string } = {},
): DomainAuthorityReviewItemV0 {
  const libelles: Record<DomainReviewReason, { title: string; summary: string }> = {
    PROOF_AWAITING_ADJUDICATION: {
      title: `Preuve de domaine à adjuger — ${cible.domainHost}`,
      summary: `Une preuve légale capturée pour ${cible.domainHost} (SIREN ${cible.siren}) attend une décision première-partie.`,
    },
    TARGET_SIREN_ABSENT_AWAITING_DECISION: {
      title: `Preuve sans SIREN cible — ${cible.domainHost}`,
      summary: `La preuve capturée pour ${cible.domainHost} ne contient pas le SIREN ${cible.siren} : seule un rejet est possible.`,
    },
    NEW_PROOF_AFTER_REJECTION: {
      title: `Nouvelle matière après rejet — ${cible.domainHost}`,
      summary: `Une preuve sémantiquement nouvelle existe pour ${cible.domainHost} depuis le dernier rejet : une nouvelle décision est possible.`,
    },
    PROOF_ANCHOR_CHANGED: {
      title: `Matière de preuve modifiée — ${cible.domainHost}`,
      summary: `Le voisinage légal du SIREN ${cible.siren} sur ${cible.domainHost} a changé depuis l'adjudication : l'autorité n'est plus utilisable sans nouvelle décision.`,
    },
    TARGET_SIREN_ABSENT: {
      title: `SIREN disparu de la preuve — ${cible.domainHost}`,
      summary: `Le SIREN ${cible.siren} n'apparaît plus dans la preuve capturée pour ${cible.domainHost} : l'autorité n'est plus utilisable sans nouvelle décision.`,
    },
  }
  return {
    id: domainReviewItemId(ws, cible.id),
    contractVersion: 'review-item-v0',
    workspaceId: ws,
    kind: 'DOMAIN_AUTHORITY_REVIEW',
    state,
    lifecycle: 'OPEN',
    reasonCode,
    subject: { siren: cible.siren, sourceHost: cible.domainHost },
    sourceRefs: { domainProofObservationId: cible.id, ...refs },
    detectedAt: cible.proofObservedAt,
    allowedActions: actionsPermises(cible),
    decisionAuthority: 'HUMAN_REQUIRED',
    ...libelles[reasonCode],
  }
}

/**
 * Projette les revues d'autorité de domaine OUVERTES d'un espace.
 *
 * PURE : deux lectures strictes du magasin, zéro écriture, zéro réseau. La
 * machine d'état par couple (SIREN, hôte) :
 *   A. aucune adjudication applicable ⇒ NEEDS_REVIEW (REJECT seul si la
 *      dernière preuve ne contient pas le SIREN) ;
 *   B. dernière = REJECTED ⇒ rien par défaut (le rejet humain EST l'état) ;
 *      une DPO STRICTEMENT postérieure et sémantiquement NOUVELLE par rapport
 *      à la matière rejetée rouvre (NEW_PROOF_AFTER_REJECTION) ;
 *   C. dernière = ACCEPTED ⇒ rien tant que la DPO la plus récente porte la
 *      MÊME matière que l'observation adjugée (SIREN présent + ancre
 *      identique) — sinon PROOF_CHANGED. Une divergence suivie d'une
 *      restauration exacte ne rouvre rien : seule la plus récente compte.
 */
export async function projectDomainReviews(ws: string): Promise<DomainReviewProjection> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'STORE_UNAVAILABLE' }

  const obsLues = await listItemsStrict<unknown>(DOMAIN_PROOF_OBSERVATION_KIND, ws)
  if (obsLues.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const adjLues = await listItemsStrict<unknown>(DOMAIN_ADJUDICATION_KIND, ws)
  if (adjLues.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }

  // ── ÉCHEC FERMÉ SUR HISTOIRE CORROMPUE — jamais un filtrage silencieux.
  const observations: DomainProofObservationV0[] = []
  for (const o of obsLues.values) {
    if (!isDomainProofObservation(o, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    observations.push(o)
  }
  const adjudications: DomainAdjudicationV0[] = []
  for (const a of adjLues.values) {
    if (!isDomainAdjudication(a, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    adjudications.push(a)
  }
  // Une adjudication qui ne désigne AUCUNE observation de l'espace est une
  // histoire incohérente — fermée, pas ignorée.
  const parId = new Map(observations.map((o) => [o.id, o]))
  for (const a of adjudications) {
    if (!parId.has(a.observationId)) return { ok: false, reason: 'HISTORY_INVALID' }
  }

  // ── GROUPEMENT PAR COUPLE (SIREN, hôte) ───────────────────────────────────
  const couples = new Map<string, DomainProofObservationV0[]>()
  for (const o of observations) {
    const cle = `${o.siren}\n${o.domainHost}`
    const liste = couples.get(cle)
    if (liste) liste.push(o)
    else couples.set(cle, [o])
  }

  const items: DomainAuthorityReviewItemV0[] = []
  for (const [, groupe] of [...couples.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const dpos = [...groupe].sort(plusRecenteDpo)
    const derniereDpo = dpos[0]
    const idsDuCouple = new Set(dpos.map((o) => o.id))
    const applicables = adjudications
      .filter((a) => idsDuCouple.has(a.observationId))
      .sort(plusRecenteAdj)
    const derniereAdj = applicables[0]

    if (!derniereAdj) {
      // ── CAS A — aucune adjudication applicable.
      items.push(item(
        ws,
        'NEEDS_REVIEW',
        derniereDpo.targetSirenFound === true
          ? 'PROOF_AWAITING_ADJUDICATION'
          : 'TARGET_SIREN_ABSENT_AWAITING_DECISION',
        derniereDpo,
      ))
      continue
    }

    const obsAdjugee = parId.get(derniereAdj.observationId) as DomainProofObservationV0

    if (derniereAdj.verdict === 'REJECTED') {
      // ── CAS B — le rejet humain reste autoritatif. Réouverture UNIQUEMENT
      // sur matière STRICTEMENT postérieure ET sémantiquement nouvelle.
      const posterieure = derniereDpo.proofObservedAt > obsAdjugee.proofObservedAt
        || (derniereDpo.proofObservedAt === obsAdjugee.proofObservedAt && derniereDpo.id > obsAdjugee.id)
      if (posterieure && !memeMatiereSemantique(derniereDpo, obsAdjugee)) {
        items.push(item(ws, 'NEEDS_REVIEW', 'NEW_PROOF_AFTER_REJECTION', derniereDpo, {
          previousObservationId: obsAdjugee.id,
          previousAdjudicationId: derniereAdj.id,
        }))
      }
      continue
    }

    // ── CAS C — ACCEPTED : la matière la plus récente doit être CELLE adjugée.
    // Hash brut du corps : JAMAIS un critère. N revalidations identiques,
    // divergence puis restauration exacte, cible == adjugée : aucun item.
    if (derniereDpo.targetSirenFound === true && derniereDpo.proofAnchor === obsAdjugee.proofAnchor) {
      continue
    }
    items.push(item(
      ws,
      'PROOF_CHANGED',
      derniereDpo.targetSirenFound === true ? 'PROOF_ANCHOR_CHANGED' : 'TARGET_SIREN_ABSENT',
      derniereDpo,
      { previousObservationId: obsAdjugee.id, previousAdjudicationId: derniereAdj.id },
    ))
  }

  return { ok: true, items }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTITY_REVIEW_PROJECTION_V0_001 — REVUE D'IDENTITÉ D'ENTITÉ, HORS-LIGNE.
//
// Dérivée UNIQUEMENT des trois registres autoritatifs déjà persistés :
//   ERX (issue d'un passage de la route d'observation),
//   ERO (fenêtre de candidats registre observée à ce passage),
//   ERA (adjudication humaine d'UNE fenêtre).
// AUCUN appel registre, AUCUN résolveur, AUCUNE écriture : la « currency »
// vivante reste le travail du chemin d'usage. Un ERX est un fait DATÉ.
//
// ── COUVERTURE, GRAVÉE ──────────────────────────────────────────────────────
// L'ABSENCE d'ERX signifie UNIQUEMENT « hors couverture Entity Review V0 » —
// jamais CURRENT, ni RESOLVED, ni AMBIGUOUS, ni NOT_FOUND, ni « rien à
// revoir ». Les ERO/ERA hérités sans ERX ne sont JAMAIS reclassés : aucun
// item n'est émis pour eux, et aucune conclusion n'en est tirée.
//
// ── DEUX ÉCHECS QUI NE SE CONFONDENT JAMAIS ────────────────────────────────
// HISTORY_INVALID : une ligne STRUCTURELLEMENT invalide (forme, intégrité,
//   référence orpheline, invariant croisé ERX↔ERO) ⇒ TOUTE la projection
//   échoue fermée — on ne calcule pas une file sur une histoire illisible.
// ENTITY_HISTORY_BLOCKED : lignes structurellement VALIDES mais histoire
//   humaine sémantiquement impossible pour UN candidat (ACCEPTED désignant un
//   SIREN hors de sa propre fenêtre) ⇒ item BLOQUÉ pour CE candidat — visible,
//   jamais un repli silencieux vers une décision plus ancienne.
// ═══════════════════════════════════════════════════════════════════════════

export type EntityReviewReason =
  | 'AMBIGUOUS_REGISTRY_MATCH'
  | 'IDENTITY_CONFLICT_REMEDIATION'
  | 'AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION'

export interface EntityIdentityReviewItemV0 {
  id: string
  contractVersion: 'review-item-v0'
  workspaceId: string
  kind: 'ENTITY_IDENTITY_REVIEW'
  state: 'NEEDS_REVIEW' | 'CONFLICT'
  lifecycle: 'OPEN'
  reasonCode: EntityReviewReason
  subject: { candidateId: string }
  sourceRefs: {
    entityResolutionOutcomeId: string
    entityResolutionObservationId?: string
    previousEntityResolutionAdjudicationId?: string
  }
  detectedAt: string
  /**
   * ⚠️ Un conflit AUTO_EXACT n'a PAS de fenêtre fraîche attachée : on ne
   * prétend jamais qu'une adjudication immédiate est possible — le seul geste
   * honnête est une RÉ-OBSERVATION (route d'observation existante), qui
   * produira une nouvelle paire fenêtre+issue à adjuger.
   */
  requiredDecision: 'ADJUDICATE_ENTITY' | 'REOBSERVE_ENTITY'
  allowedActions: ['ACCEPT_CANDIDATE', 'REJECT_ALL'] | ['REOBSERVE_ENTITY']
  decisionAuthority: 'HUMAN_REQUIRED'
  title: string
  summary: string
}

export interface EntityHistoryBlockedItemV0 {
  id: string
  contractVersion: 'review-item-v0'
  workspaceId: string
  kind: 'ENTITY_HISTORY_BLOCKED'
  state: 'BLOCKED'
  lifecycle: 'OPEN'
  reasonCode: 'HISTORY_TAMPERED'
  subject: { candidateId: string }
  sourceRefs: {}
  detectedAt: string
  requiredDecision: 'NONE_AVAILABLE'
  allowedActions: []
  decisionAuthority: 'MACHINE_BLOCKED'
  title: string
  summary: string
}

export type ReviewItemV0 =
  | DomainAuthorityReviewItemV0
  | EntityIdentityReviewItemV0
  | EntityHistoryBlockedItemV0

export function entityReviewItemId(ws: string, targetOutcomeId: string): string {
  // Un ERX plus récent change la cible ⇒ l'item précédent est naturellement
  // supersédé (il n'est simplement plus dérivé).
  return `rvw_${sha256(`review-item:v0:${ws}\nENTITY_IDENTITY_REVIEW\n${targetOutcomeId}`).slice(0, 32)}`
}
export function entityBlockedItemId(ws: string, adjudicationId: string): string {
  return `rvw_${sha256(`review-item:v0:${ws}\nENTITY_HISTORY_BLOCKED\n${adjudicationId}`).slice(0, 32)}`
}

export type EntityReviewProjection =
  | { ok: true; items: (EntityIdentityReviewItemV0 | EntityHistoryBlockedItemV0)[] }
  | { ok: false; reason: 'STORE_UNAVAILABLE' | 'HISTORY_INVALID' }

// Tri ERX : observedAt DESC puis id DESC. Tri ERA : adjudicatedAt DESC puis
// id DESC — mêmes conventions de départage que partout ailleurs.
function plusRecentErx(a: EntityResolutionOutcomeV0, b: EntityResolutionOutcomeV0): number {
  return a.observedAt === b.observedAt ? (a.id < b.id ? 1 : -1) : (a.observedAt < b.observedAt ? 1 : -1)
}
function plusRecenteEra(a: EntityResolutionAdjudicationV0, b: EntityResolutionAdjudicationV0): number {
  return a.adjudicatedAt === b.adjudicatedAt ? (a.id < b.id ? 1 : -1) : (a.adjudicatedAt < b.adjudicatedAt ? 1 : -1)
}

function itemEntite(
  ws: string,
  state: 'NEEDS_REVIEW' | 'CONFLICT',
  reasonCode: EntityReviewReason,
  erx: EntityResolutionOutcomeV0,
  refs: { entityResolutionObservationId?: string; previousEntityResolutionAdjudicationId?: string },
): EntityIdentityReviewItemV0 {
  const libelles: Record<EntityReviewReason, { title: string; summary: string }> = {
    AMBIGUOUS_REGISTRY_MATCH: {
      title: 'Identité d’entreprise à trancher',
      summary: 'Le registre officiel a rendu plusieurs candidats plausibles pour ce signal : une sélection humaine (ou un rejet de toute la fenêtre) est requise.',
    },
    IDENTITY_CONFLICT_REMEDIATION: {
      title: 'Conflit d’identité — nouvelle fenêtre à adjuger',
      summary: 'Le registre résout automatiquement une entité qui contredit la décision humaine en vigueur : la fenêtre de remédiation observée attend une nouvelle adjudication.',
    },
    AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION: {
      title: 'Conflit d’identité — ré-observation requise',
      summary: 'La dernière issue automatique exacte contredit la décision humaine en vigueur, sans fenêtre fraîche attachée : une ré-observation est nécessaire avant toute nouvelle adjudication.',
    },
  }
  const reobs = reasonCode === 'AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION'
  return {
    id: entityReviewItemId(ws, erx.id),
    contractVersion: 'review-item-v0',
    workspaceId: ws,
    kind: 'ENTITY_IDENTITY_REVIEW',
    state,
    lifecycle: 'OPEN',
    reasonCode,
    subject: { candidateId: erx.subjectCandidateId },
    sourceRefs: { entityResolutionOutcomeId: erx.id, ...refs },
    detectedAt: erx.observedAt,
    requiredDecision: reobs ? 'REOBSERVE_ENTITY' : 'ADJUDICATE_ENTITY',
    allowedActions: reobs ? ['REOBSERVE_ENTITY'] : ['ACCEPT_CANDIDATE', 'REJECT_ALL'],
    decisionAuthority: 'HUMAN_REQUIRED',
    ...libelles[reasonCode],
  }
}

/**
 * Projette les revues d'identité d'entité OUVERTES d'un espace — PURE.
 *
 * Machine d'état par candidat COUVERT (≥ 1 ERX), sur sa DERNIÈRE issue :
 *   AMBIGUOUS : fenêtre sans adjudication ⇒ NEEDS_REVIEW ; adjugée (ACCEPTED
 *     ou NONE) ⇒ rien — la décision humaine a couvert CETTE fenêtre ; un
 *     changement d'état du registre entre par un NOUVEL ERX, jamais d'ici.
 *   CONFLICT_REMEDIATION(B, O) : SEULE une ACCEPTED(B) SUR O ferme le
 *     conflit. ACCEPTED(≠B) sur O le laisse ouvert, et NONE sur O AUSSI —
 *     l'entité B a été VUE ET REJETÉE : le résolveur refuserait toujours.
 *   AUTO_EXACT(S) : humain ABSENT ou ACCEPTED(S) ⇒ courant ; ACCEPTED(A≠S),
 *     ou NONE dont la fenêtre contenait S ⇒ CONFLIT avec RÉ-OBSERVATION pour
 *     seul geste (aucune fenêtre fraîche n'existe) ; NONE sans S ⇒ courant.
 *   NOT_FOUND : issue datée, aucune décision humaine bornée à demander.
 */
export async function projectEntityReviews(ws: string): Promise<EntityReviewProjection> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'STORE_UNAVAILABLE' }

  const erxLus = await listItemsStrict<unknown>(ENTITY_RESOLUTION_OUTCOME_KIND, ws)
  if (erxLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const eroLus = await listItemsStrict<unknown>(ENTITY_RESOLUTION_OBSERVATION_KIND, ws)
  if (eroLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  const eraLus = await listItemsStrict<unknown>(ENTITY_RESOLUTION_ADJUDICATION_KIND, ws)
  if (eraLus.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }

  // ── VALIDATION STRICTE — jamais de filtrage silencieux ──────────────────
  const outcomes: EntityResolutionOutcomeV0[] = []
  for (const v of erxLus.values) {
    if (!isEntityResolutionOutcome(v, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    outcomes.push(v)
  }
  const observations: EntityResolutionObservationV0[] = []
  for (const v of eroLus.values) {
    if (!isEntityResolutionObservation(v, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    observations.push(v)
  }
  const adjudications: EntityResolutionAdjudicationV0[] = []
  for (const v of eraLus.values) {
    if (!isEntityResolutionAdjudication(v, ws)) return { ok: false, reason: 'HISTORY_INVALID' }
    adjudications.push(v)
  }
  const eroParId = new Map(observations.map((o) => [o.id, o]))
  for (const a of adjudications) {
    if (!eroParId.has(a.observationId)) return { ok: false, reason: 'HISTORY_INVALID' } // ERA orpheline
  }
  // Invariants croisés ERX↔ERO : mêmes vérités qu'à l'écriture, revérifiées.
  for (const x of outcomes) {
    if (x.observationId === undefined) continue
    const o = eroParId.get(x.observationId)
    if (!o) return { ok: false, reason: 'HISTORY_INVALID' }
    if (o.subjectCandidateId !== x.subjectCandidateId) return { ok: false, reason: 'HISTORY_INVALID' }
    if (o.retrievedAt !== x.observedAt) return { ok: false, reason: 'HISTORY_INVALID' }
    if (x.outcome === 'CONFLICT_REMEDIATION' && !o.candidates.some((c) => c.siren === x.siren)) {
      return { ok: false, reason: 'HISTORY_INVALID' }
    }
  }

  // ── GROUPEMENT — seuls les candidats COUVERTS (≥ 1 ERX) sont projetés. ───
  const parCandidat = new Map<string, EntityResolutionOutcomeV0[]>()
  for (const x of outcomes) {
    const liste = parCandidat.get(x.subjectCandidateId)
    if (liste) liste.push(x)
    else parCandidat.set(x.subjectCandidateId, [x])
  }

  const items: (EntityIdentityReviewItemV0 | EntityHistoryBlockedItemV0)[] = []
  for (const [candidateId, groupe] of [...parCandidat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const dernier = [...groupe].sort(plusRecentErx)[0]

    // ── DÉCISION HUMAINE — dérivée des SEULES lignes déjà chargées. ────────
    const applicables = adjudications
      .filter((a) => eroParId.get(a.observationId)!.subjectCandidateId === candidateId)
      .sort(plusRecenteEra)
    // ── CORRUPTION SÉMANTIQUE : TOUTES les adjudications applicables sont
    // inspectées, pas seulement la dernière — parité avec le fail-closed de
    // production (`effectiveHumanDecision`) : corrompre l'histoire n'est
    // JAMAIS effacé par une décision valide plus récente. Plusieurs lignes
    // invalides ⇒ la plus récente (tri existant) sert de discriminant.
    const invalide = applicables.find((a) =>
      a.verdict === 'ACCEPTED_CANDIDATE'
      && !eroParId.get(a.observationId)!.candidates.some((c) => c.siren === a.selectedSiren))
    if (invalide) {
      items.push({
        id: entityBlockedItemId(ws, invalide.id),
        contractVersion: 'review-item-v0',
        workspaceId: ws,
        kind: 'ENTITY_HISTORY_BLOCKED',
        state: 'BLOCKED',
        lifecycle: 'OPEN',
        reasonCode: 'HISTORY_TAMPERED',
        subject: { candidateId },
        sourceRefs: {},
        detectedAt: invalide.adjudicatedAt,
        requiredDecision: 'NONE_AVAILABLE',
        allowedActions: [],
        decisionAuthority: 'MACHINE_BLOCKED',
        title: 'Historique d’adjudication d’entité incohérent',
        summary: 'Une décision humaine désigne une entité absente de la fenêtre qu’elle référence : aucune dérivation sûre n’est possible pour ce candidat.',
      })
      continue
    }
    const derniereEra = applicables[0]
    let humain:
      | { kind: 'ABSENT' }
      | { kind: 'ACCEPTED'; siren: string; era: EntityResolutionAdjudicationV0 }
      | { kind: 'NONE'; era: EntityResolutionAdjudicationV0; fenetre: EntityResolutionObservationV0 }
    if (!derniereEra) {
      humain = { kind: 'ABSENT' }
    } else if (derniereEra.verdict === 'ACCEPTED_CANDIDATE') {
      humain = { kind: 'ACCEPTED', siren: String(derniereEra.selectedSiren), era: derniereEra }
    } else {
      humain = { kind: 'NONE', era: derniereEra, fenetre: eroParId.get(derniereEra.observationId)! }
    }

    // ── MACHINE D'ÉTAT SUR LA DERNIÈRE ISSUE ───────────────────────────────
    if (dernier.outcome === 'NOT_FOUND') continue

    if (dernier.outcome === 'AMBIGUOUS') {
      const surFenetre = adjudications.filter((a) => a.observationId === dernier.observationId)
      if (surFenetre.length > 0) continue // la fenêtre observée a SA décision
      items.push(itemEntite(ws, 'NEEDS_REVIEW', 'AMBIGUOUS_REGISTRY_MATCH', dernier,
        { entityResolutionObservationId: dernier.observationId }))
      continue
    }

    if (dernier.outcome === 'CONFLICT_REMEDIATION') {
      const surFenetre = adjudications
        .filter((a) => a.observationId === dernier.observationId)
        .sort(plusRecenteEra)
      const decision = surFenetre[0]
      // SEULE une ACCEPTED du SIREN en conflit ferme ce conflit. Un NONE le
      // laisse OUVERT : l'entité a été vue et rejetée — rien n'est tranché.
      if (decision && decision.verdict === 'ACCEPTED_CANDIDATE' && decision.selectedSiren === dernier.siren) {
        continue
      }
      items.push(itemEntite(ws, 'CONFLICT', 'IDENTITY_CONFLICT_REMEDIATION', dernier, {
        entityResolutionObservationId: dernier.observationId,
        ...(humain.kind !== 'ABSENT' ? { previousEntityResolutionAdjudicationId: humain.era.id } : {}),
      }))
      continue
    }

    // AUTO_EXACT(S)
    const s = String(dernier.siren)
    if (humain.kind === 'ABSENT') continue
    if (humain.kind === 'ACCEPTED') {
      if (humain.siren === s) continue
      items.push(itemEntite(ws, 'CONFLICT', 'AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION', dernier,
        { previousEntityResolutionAdjudicationId: humain.era.id }))
      continue
    }
    // NONE : borné à SA fenêtre — S vu-et-rejeté ⇒ conflit ; jamais vu ⇒ courant.
    if (humain.fenetre.candidates.some((c) => c.siren === s)) {
      items.push(itemEntite(ws, 'CONFLICT', 'AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION', dernier,
        { previousEntityResolutionAdjudicationId: humain.era.id }))
    }
  }

  return { ok: true, items }
}
