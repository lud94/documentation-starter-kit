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

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

// ── CONTRAT ReviewItem V0 — DOMAINE UNIQUEMENT ──────────────────────────────

export type ReviewEpistemicState = 'NEEDS_REVIEW' | 'PROOF_CHANGED'
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
  state: ReviewEpistemicState
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
  state: ReviewEpistemicState,
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
