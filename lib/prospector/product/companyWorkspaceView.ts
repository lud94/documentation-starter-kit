// PFV0-1 — COMPANY WORKSPACE VIEW (PROSPECTOR) — READ MODEL PUR.
//
// Projection de lecture d'UN compte, clé = accountId CANONIQUE
// (`organizationRef`). PFV0-1 ne construit PAS l'adaptateur Lead : les
// entrées sont fournies par l'appelant sous formes ÉTROITES (§25), déjà
// tenant-résolues par les couches serveur futures (PFV0-2).
//
// ── HONNÊTETÉ DES SECTIONS ──────────────────────────────────────────────────
// Chaque section reflète UNIQUEMENT ce que les sources fournissent :
//   - absente/vide ⇒ « rien d'observé » — jamais fabriquée ;
//   - la timeline est un HISTORIQUE OBSERVÉ (observedHistory) — AUCUN champ
//     prédictif (pas de likelyNextDecisions, predictedState, futureTrajectory) ;
//   - PAS de PhysicalSite, PAS de « High-Value Unknown » générique : aucun
//     producteur n'existe, la vue n'invente pas de section pour eux ;
//   - people = résumés bornés adossés à personKey — pas un registre, pas un
//     graphe social, pas un état de résolution ;
//   - businessContext / rationales playbook = charge OPAQUE sous rubriques
//     génériques — aucune sémantique immobilière (ni aucune autre verticale)
//     dans ce contrat.
import type { AttentionCandidateV0 } from './attentionCandidate'
import { accountHrefFor } from './attentionCandidate'
import type { BusinessAssessment } from '../monitoring/accountMonitor'

export const COMPANY_WORKSPACE_VIEW_SCHEMA_VERSION = '0.1' as const

// ── ENTRÉES ÉTROITES ────────────────────────────────────────────────────────

export interface WorkspaceSituationSummaryV0 {
  readonly situationRef: string
  /** Type OPAQUE du moteur — transporté tel quel, jamais interprété ici. */
  readonly situationType: string
  readonly rationale: string
  readonly evidenceRefs: readonly string[]
  readonly observedAt: string
}

export interface WorkspaceEvidenceItemV0 {
  readonly evidenceRef: string
  readonly label?: string
  readonly observedAt?: string
}

/** Résumé borné adossé à personKey — identité canonique de personne, rien de plus. */
export interface WorkspacePersonSummaryV0 {
  readonly personKey: string
  readonly displayName?: string
  readonly role?: string
}

/** Verdict métier d'un run de monitoring — transporté, jamais recalculé. */
export interface WorkspaceDomainAssessmentV0 {
  readonly runRef: string
  readonly businessAssessment: BusinessAssessment
  readonly observedAt: string
}

/** Charge playbook OPAQUE sous rubrique générique — le produit n'en lit pas l'intérieur. */
export interface WorkspaceBusinessContextV0 {
  readonly contextId: string
  readonly contextVersion: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export interface WorkspaceMissionSummaryV0 {
  readonly missionRef: string
  readonly label?: string
}

/** Entrée d'HISTORIQUE OBSERVÉ — chaque entrée est adossée à une source réelle. */
export interface ObservedHistoryEntryV0 {
  readonly observedAt: string
  readonly sourceRef: string
  readonly label: string
}

export interface CompanyWorkspaceViewInputV0 {
  /** Identité CANONIQUE — accountId. Jamais un identifiant de fiche lead legacy. */
  readonly organizationRef: string
  readonly organizationName?: string
  readonly currentSituations?: readonly WorkspaceSituationSummaryV0[]
  /** Changements récents = AttentionCandidates déjà projetés (mêmes règles d'admission). */
  readonly recentChanges?: readonly AttentionCandidateV0[]
  readonly evidence?: readonly WorkspaceEvidenceItemV0[]
  readonly counterSignalRefs?: readonly string[]
  readonly people?: readonly WorkspacePersonSummaryV0[]
  readonly businessContext?: WorkspaceBusinessContextV0
  readonly domainAssessments?: readonly WorkspaceDomainAssessmentV0[]
  readonly missions?: readonly WorkspaceMissionSummaryV0[]
}

export interface CompanyWorkspaceViewV0 {
  readonly schemaVersion: typeof COMPANY_WORKSPACE_VIEW_SCHEMA_VERSION
  readonly identity: {
    readonly organizationRef: string
    readonly organizationName?: string
    readonly accountHref: string
  }
  readonly currentSituations: readonly WorkspaceSituationSummaryV0[]
  readonly recentChanges: readonly AttentionCandidateV0[]
  /** HISTORIQUE OBSERVÉ uniquement — aucune trajectoire prédite. */
  readonly observedHistory: readonly ObservedHistoryEntryV0[]
  readonly evidence: readonly WorkspaceEvidenceItemV0[]
  readonly counterSignalRefs: readonly string[]
  readonly people: readonly WorkspacePersonSummaryV0[]
  readonly businessContext?: WorkspaceBusinessContextV0
  readonly domainAssessments: readonly WorkspaceDomainAssessmentV0[]
  readonly missions: readonly WorkspaceMissionSummaryV0[]
}

function frozen<T>(values: readonly T[] | undefined): readonly T[] {
  return Object.freeze(values ? [...values] : [])
}

/**
 * Timeline = FUSION DÉTERMINISTE des entrées datées ADOSSÉES à une source :
 * situations observées + verdicts de monitoring. Tri par (observedAt,
 * sourceRef) — un ordre chronologique de transport, pas une priorité.
 * Aucune entrée n'est inventée : pas de source datée ⇒ timeline vide.
 */
function buildObservedHistory(input: CompanyWorkspaceViewInputV0): readonly ObservedHistoryEntryV0[] {
  const entrees: ObservedHistoryEntryV0[] = []
  for (const s of input.currentSituations ?? []) {
    entrees.push(Object.freeze({
      observedAt: s.observedAt,
      sourceRef: s.situationRef,
      label: `[${s.situationType}] ${s.rationale}`,
    }))
  }
  for (const a of input.domainAssessments ?? []) {
    entrees.push(Object.freeze({
      observedAt: a.observedAt,
      sourceRef: a.runRef,
      label: a.businessAssessment,
    }))
  }
  entrees.sort((x, y) => {
    if (x.observedAt !== y.observedAt) return x.observedAt < y.observedAt ? -1 : 1
    return x.sourceRef < y.sourceRef ? -1 : x.sourceRef > y.sourceRef ? 1 : 0
  })
  return Object.freeze(entrees)
}

/** Assemblage PUR — aucune E/S, aucune horloge, aucune fabrication de section. */
export function buildCompanyWorkspaceViewV0(input: CompanyWorkspaceViewInputV0): CompanyWorkspaceViewV0 {
  return Object.freeze({
    schemaVersion: COMPANY_WORKSPACE_VIEW_SCHEMA_VERSION,
    identity: Object.freeze({
      organizationRef: input.organizationRef,
      ...(input.organizationName !== undefined ? { organizationName: input.organizationName } : {}),
      accountHref: accountHrefFor(input.organizationRef),
    }),
    currentSituations: frozen(input.currentSituations),
    recentChanges: frozen(input.recentChanges),
    observedHistory: buildObservedHistory(input),
    evidence: frozen(input.evidence),
    counterSignalRefs: frozen(input.counterSignalRefs),
    people: frozen(input.people),
    ...(input.businessContext !== undefined ? { businessContext: input.businessContext } : {}),
    domainAssessments: frozen(input.domainAssessments),
    missions: frozen(input.missions),
  })
}
