// PFV0-1 — ATTENTION CANDIDATE (PROSPECTOR) — READ MODEL PUR.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// Une PROJECTION de lecture, générique produit, au-dessus de la vérité
// intelligence existante (Situations, évaluations de monitoring). Il ne
// persiste rien, ne lit aucun magasin, n'appelle aucun modèle, ne touche
// aucune UI : PFV0-2+ brancheront la lecture serveur et l'affichage.
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// ⚠️ Un AttentionCandidate PROSPECTOR n'est PAS une « Jarvis Attention ».
// JARVIS possède la Situation Opérationnelle, l'Attention inter-contextes et
// la Final NBA — AUCUN producteur Jarvis Attention n'existe, et cette
// projection ne prétend pas en être un. Ici : matière candidate côté domaine,
// que JARVIS pourra un jour consommer — jamais l'inverse.
//
// ⚠️ AUCUN score, AUCUN rang, AUCUNE priorité globale, AUCUNE action finale.
// `Situation.confidence/relevance/urgency` sont DESCRIPTIFS et ne sont JAMAIS
// convertis en ordre d'attention. L'ordre de sortie est un ordre TECHNIQUE
// déterministe (itemRef), pas un classement métier.
//
// ── SOURCES D'ADMISSION — FERMÉES, ET EXPLICITES ────────────────────────────
//   A. NEW_OR_UPDATED_SITUATION : une Situation DÉJÀ ADMISE EN AMONT comme
//      changement qualifiant (QualifyingSituationChangeV0). Ce module ne
//      décide NI la récence, NI le statut « nouveau/à jour » : PFV0-2
//      possédera la sélection temporelle. Un `Situation[]` brut n'est PAS
//      une entrée acceptable — l'admission est portée par le TYPE.
//   B. MONITORING_MATERIAL_CHANGE : un run de monitoring dont le verdict
//      métier est MATERIAL_CHANGE_FOUND.
// Une Recommendation SEULE ne crée JAMAIS de candidat : elle ne peut que
// S'ATTACHER, comme interprétation domaine (candidatePlay), à une source
// qualifiante via sa relation EXPLICITE `situationId`. Un hit de signal brut
// n'est pas une source : il doit d'abord devenir Situation ou matérialité.
//
// ── WHAT CHANGED ≠ INTERPRÉTATION ───────────────────────────────────────────
// ⚠️ `whatChanged` est le CHANGEMENT OBSERVABLE, canonique, adossé aux
// sources — fourni par la projection serveur de confiance (après résolution
// des faits/évidences canoniques) et PRÉSERVÉ VERBATIM ici. Il n'est JAMAIS
// dérivé de `Situation.rationale` (interprétation domaine) ni du type de
// situation. L'interprétation vit dans ses propres champs : la lecture
// domaine de la situation sous `domainInterpretation`, la lecture de la
// Recommendation attachée sous `whyItMatters`/`candidatePlay`.
import { createHash } from 'crypto'
import type { Recommendation, Situation } from '../proactive/types'
import type { BusinessAssessment } from '../monitoring/accountMonitor'

export const ATTENTION_CANDIDATE_SCHEMA_VERSION = '0.1' as const

/** Enum FERMÉ — exactement les deux sémantiques admises. Pas de kind « RECOMMENDATION ». */
export const ATTENTION_CANDIDATE_KINDS = Object.freeze([
  'NEW_OR_UPDATED_SITUATION',
  'MONITORING_MATERIAL_CHANGE',
] as const)
export type AttentionCandidateKindV0 = (typeof ATTENTION_CANDIDATE_KINDS)[number]

/**
 * CANDIDATE PLAY — interprétation domaine ATTACHÉE, jamais autorité d'action.
 * ⚠️ `recommendedAction` amont est transporté comme TEXTE OPAQUE sous
 * `suggestedApproach` — il ne devient JAMAIS `selectedAction`, ni une action
 * finale, ni un ordre d'exécution. Un Candidate Play ≠ Final NBA.
 */
export interface CandidatePlayV0 {
  readonly recommendationRef: string
  readonly playType?: string
  readonly rationale: string
  readonly whyNow: string
  readonly suggestedApproach?: string
}

export interface AttentionCandidateV0 {
  readonly schemaVersion: typeof ATTENTION_CANDIDATE_SCHEMA_VERSION
  /** Déterministe, dérivé de la source qualifiante — jamais aléatoire. */
  readonly itemRef: string
  readonly kind: AttentionCandidateKindV0
  /** TOUJOURS l'accountId canonique — jamais un identifiant de fiche lead legacy. */
  readonly organizationRef: string
  readonly organizationName?: string
  /** Référence de la source qualifiante réelle (situation ou run de monitoring). */
  readonly sourceRef: string
  readonly situationRef?: string
  /** Référence du changement admis en amont (voie situation). */
  readonly changeRef?: string
  /** CE QUI A CHANGÉ — observable, canonique, transporté VERBATIM depuis l'admission amont. */
  readonly whatChanged: string
  /** Lecture domaine de la situation (rationale du moteur) — interprétation, jamais un fait. */
  readonly domainInterpretation?: string
  /** POURQUOI C'EST INTÉRESSANT — interprétation domaine, optionnelle, jamais fusionnée avec whatChanged. */
  readonly whyItMatters?: string
  readonly domainAssessment?: string
  readonly candidatePlay?: CandidatePlayV0
  readonly evidenceRefs: readonly string[]
  readonly uncertainties: readonly string[]
  readonly counterSignalRefs: readonly string[]
  readonly occurredAt?: string
  readonly observedAt?: string
  readonly accountHref: string
}

/**
 * Lien de navigation dérivé — pur, déterministe, aucune route implémentée ici.
 * Route produit CANONIQUE du Company Workspace : /companies/[accountId].
 */
export function accountHrefFor(organizationRef: string): string {
  return `/companies/${encodeURIComponent(organizationRef)}`
}

/**
 * Identité déterministe du candidat — composants d'identité JOINTS par `\n`.
 * Voie situation : kind + situationRef + changeRef — le MÊME changement
 * canonique peut légitimement soutenir PLUSIEURS Situations : ce sont des
 * interprétations DISTINCTES, jamais fusionnées sous un même itemRef.
 * Voie monitoring : kind + runId (identité de run déjà unique).
 */
function deterministicItemRef(kind: AttentionCandidateKindV0, identityParts: readonly string[]): string {
  const charge = `attention-candidate:v1:${kind}\n${identityParts.join('\n')}`
  return `att_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

// ── ENTRÉES ÉTROITES (§25) — découplées de la persistance ───────────────────

/** Projection étroite d'une Situation source — champs réellement utilisés. */
export type SituationSourceV0 = Pick<
  Situation,
  'id' | 'accountId' | 'type' | 'evidenceIds' | 'rationale' | 'lastEvaluatedAt'
>

/** Projection étroite d'une Recommendation — relation EXPLICITE `situationId` seule autorité de lien. */
export type RecommendationSourceV0 = Pick<
  Recommendation,
  'id' | 'situationId' | 'decision' | 'reason' | 'whyNow' | 'play' | 'recommendedAction'
>

/**
 * CHANGEMENT DE SITUATION QUALIFIANT — l'ADMISSION EST EXPLICITE ET AMONT.
 *
 * Le nom du type est le contrat : cette Situation a DÉJÀ été admise en amont
 * comme source NEW_OR_UPDATED_SITUATION par la projection serveur de
 * confiance (PFV0-2+). Ce module ne peut pas transformer un listSituations()
 * brut en « Today » : il exige cette enveloppe, et ne décide rien.
 *
 *   - `changeRef`   : référence du changement admis — entre dans l'itemRef ;
 *   - `whatChanged` : le changement OBSERVABLE, résolu côté serveur contre
 *     les faits/évidences canoniques — PRÉSERVÉ VERBATIM, jamais inventé ici,
 *     jamais dérivé du rationale ni du type ;
 *   - `observedAt?` : horloge SOURCE de l'observation du changement — aucune
 *     horloge courante, aucun seuil de fraîcheur, aucun lastViewedAt.
 */
export interface QualifyingSituationChangeV0 {
  readonly situation: SituationSourceV0
  readonly changeRef: string
  readonly whatChanged: string
  readonly observedAt?: string
  readonly organizationName?: string
  /** Transport verbatim — jamais fabriqué ici. */
  readonly uncertainties?: readonly string[]
  readonly counterSignalRefs?: readonly string[]
}

/** Projection étroite d'un résultat de run de monitoring. */
export interface MonitoringRunSourceV0 {
  readonly runId: string
  readonly businessAssessment: BusinessAssessment
  readonly canonicalRefsMaterial: readonly string[]
  readonly finishedAt: string
}

export interface MonitoringCandidateInputV0 {
  readonly run: MonitoringRunSourceV0
  /**
   * Le run ne porte pas l'accountRef : il vient du moniteur. Cette enveloppe
   * est une MÉTADONNÉE DE PROJECTION SERVEUR — fournie par la couche serveur
   * de confiance qui a résolu le moniteur, JAMAIS une autorité cliente.
   * TOUJOURS l'identité canonique de compte — jamais un identifiant de fiche
   * lead legacy.
   */
  readonly accountRef: string
  /**
   * CE QUI A CHANGÉ — factuel, adossé aux sources, RÉSOLU EN AMONT par la
   * projection serveur de confiance (PFV0-2+), PRÉSERVÉ VERBATIM ici.
   * `businessAssessment` est la PORTE D'ADMISSION, jamais cette description :
   * si l'amont ne peut pas résoudre un changement factuel, il ne construit
   * PAS cette entrée. Jamais dérivé du verdict, d'un rationale ou d'un LLM.
   */
  readonly whatChanged: string
  readonly organizationName?: string
  readonly uncertainties?: readonly string[]
  readonly counterSignalRefs?: readonly string[]
}

export interface AttentionProjectionInputV0 {
  /**
   * ADMISSION EXPLICITE : pas de champ `situations` — un tableau brut de
   * Situations n'est pas une entrée. Chaque élément atteste, par son type,
   * une admission amont comme changement qualifiant.
   */
  readonly qualifyingSituationChanges: readonly QualifyingSituationChangeV0[]
  /**
   * Les Recommendations ne sont PAS une source : elles ne peuvent que
   * s'attacher à une Situation qualifiante fournie, via `situationId`. Une
   * Recommendation dont la Situation n'est pas dans l'entrée ne produit RIEN.
   */
  readonly recommendations: readonly RecommendationSourceV0[]
  readonly monitoring: readonly MonitoringCandidateInputV0[]
}

const EMPTY: readonly string[] = Object.freeze([])

function frozenList(values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0) return EMPTY
  return Object.freeze([...values])
}

/**
 * Attachement DÉTERMINISTE d'une Recommendation à SA situation :
 *   - relation EXPLICITE `situationId` uniquement — aucun rapprochement flou ;
 *   - seules les décisions `recommend` portent une interprétation à attacher ;
 *   - PLUSIEURS recommandations `recommend` liées à la même situation :
 *     AMBIGU — on n'en choisit PAS une (ni la première du tableau, ni « la
 *     meilleure ») : on OMET l'attachement plutôt que deviner (§21/§22).
 */
function attachRecommendation(
  situationId: string,
  recommendations: readonly RecommendationSourceV0[],
): CandidatePlayV0 | undefined {
  const liees = recommendations.filter((r) => r.situationId === situationId && r.decision === 'recommend')
  if (liees.length !== 1) return undefined
  const rec = liees[0]
  return Object.freeze({
    recommendationRef: rec.id,
    ...(rec.play !== undefined ? { playType: rec.play } : {}),
    rationale: rec.reason,
    whyNow: rec.whyNow,
    ...(rec.recommendedAction !== undefined ? { suggestedApproach: rec.recommendedAction } : {}),
  })
}

function candidateFromQualifyingChange(
  input: QualifyingSituationChangeV0,
  recommendations: readonly RecommendationSourceV0[],
): AttentionCandidateV0 {
  const s = input.situation
  const candidatePlay = attachRecommendation(s.id, recommendations)
  // WHAT CHANGED = la valeur admise en amont, VERBATIM — jamais le rationale
  // (interprétation domaine, transporté sous domainInterpretation), jamais
  // une synthèse dérivée du type.
  return Object.freeze({
    schemaVersion: ATTENTION_CANDIDATE_SCHEMA_VERSION,
    itemRef: deterministicItemRef('NEW_OR_UPDATED_SITUATION', [s.id, input.changeRef]),
    kind: 'NEW_OR_UPDATED_SITUATION' as const,
    organizationRef: s.accountId,
    ...(input.organizationName !== undefined ? { organizationName: input.organizationName } : {}),
    sourceRef: s.id,
    situationRef: s.id,
    changeRef: input.changeRef,
    whatChanged: input.whatChanged,
    domainInterpretation: s.rationale,
    ...(candidatePlay !== undefined ? { whyItMatters: candidatePlay.rationale } : {}),
    ...(candidatePlay !== undefined ? { candidatePlay } : {}),
    evidenceRefs: frozenList(s.evidenceIds),
    uncertainties: frozenList(input.uncertainties),
    counterSignalRefs: frozenList(input.counterSignalRefs),
    observedAt: input.observedAt ?? s.lastEvaluatedAt,
    accountHref: accountHrefFor(s.accountId),
  })
}

function candidateFromMonitoring(input: MonitoringCandidateInputV0): AttentionCandidateV0 | undefined {
  // Admission STRICTE : seul le verdict métier MATERIAL_CHANGE_FOUND admet.
  // NEEDS_REVIEW / NOT_EVALUATED / NO_MATERIAL_CHANGE ne produisent RIEN —
  // fail closed, pas de candidat « au cas où ».
  if (input.run.businessAssessment !== 'MATERIAL_CHANGE_FOUND') return undefined
  return Object.freeze({
    schemaVersion: ATTENTION_CANDIDATE_SCHEMA_VERSION,
    itemRef: deterministicItemRef('MONITORING_MATERIAL_CHANGE', [input.run.runId]),
    kind: 'MONITORING_MATERIAL_CHANGE' as const,
    organizationRef: input.accountRef,
    ...(input.organizationName !== undefined ? { organizationName: input.organizationName } : {}),
    sourceRef: input.run.runId,
    whatChanged: input.whatChanged,
    domainAssessment: input.run.businessAssessment,
    evidenceRefs: frozenList(input.run.canonicalRefsMaterial),
    uncertainties: frozenList(input.uncertainties),
    counterSignalRefs: frozenList(input.counterSignalRefs),
    observedAt: input.run.finishedAt,
    accountHref: accountHrefFor(input.accountRef),
  })
}

/**
 * L'UNIQUE POINT D'ENTRÉE de projection. Déterministe :
 *   - même ensemble d'entrées ⇒ même ensemble de sortie, quel que soit
 *     l'ordre des tableaux d'entrée (tri TECHNIQUE final par itemRef —
 *     un ordre stable de transport, PAS une priorité métier) ;
 *   - un changement qualifiant + sa Recommendation liée ⇒ UN candidat,
 *     pas deux ;
 *   - une Recommendation sans Situation qualifiante fournie ⇒ RIEN ;
 *   - aucune horloge : tous les temps viennent des sources.
 */
export function projectAttentionCandidatesV0(
  input: AttentionProjectionInputV0,
): readonly AttentionCandidateV0[] {
  const sorties: AttentionCandidateV0[] = []
  for (const q of input.qualifyingSituationChanges) {
    sorties.push(candidateFromQualifyingChange(q, input.recommendations))
  }
  for (const m of input.monitoring) {
    const c = candidateFromMonitoring(m)
    if (c !== undefined) sorties.push(c)
  }
  sorties.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0))
  return Object.freeze(sorties)
}
