// JS-015 B2A — FRONTIÈRE DU MESSAGE ENGINE : CONTRAT ASYNCHRONE.
//
// ── L'INVARIANT ABSOLU ──────────────────────────────────────────────────────
// Le Message Engine décide COMMENT LE DIRE — jamais QUI, POURQUOI, QUAND,
// QUELLE ACTION, QUELLE OFFRE, QUEL CANAL. Sa SEULE entrée MÉTIER admissible
// est un ValidatedMessageReadyContextV0 (marqué par le validateur) : il ne
// reçoit JAMAIS une fiche prospect brute, un dump de compte, un dump de
// recherche, ni une recommandation du moteur proactif. L'architecture interdite
//   RAW DATA → LLM → cible+timing+offre+action → message
// reste INEXPRIMABLE par cette signature. Les dépendances d'EXÉCUTION
// (fournisseur de modèle, tenant d'imputation) sont liées PAR INJECTION à la
// construction du moteur — jamais passées dans compose().
//
// ── B2A : CONTRAT SEUL ICI ──────────────────────────────────────────────────
// Ce fichier ne porte AUCUNE implémentation ni E/S : le rédacteur contraint vit
// dans composeEngine.ts, l'invocation modèle dans modelInvoker.ts.
import type { ValidatedMessageReadyContextV0 } from './messageContext'
import { isValidatedContext } from './messageContext'
import type { ChannelPolicyV0 } from './channelPolicy'
import { resolveChannelPolicy } from './channelPolicy'

/**
 * MÉTADONNÉE D'AUDIT DE MESSAGE — et RIEN d'autre. Ce n'est NI une vérité de
 * compte, NI une évidence, NI une Situation, NI une recommandation, NI un
 * outcome : c'est la traçabilité de CE BROUILLON, jamais persistée dans la
 * vérité canonique.
 */
export interface MessageAssertionAuditV0 {
  /** L'assertion factuelle telle que rendue dans le message. */
  readonly assertion: string
  /** Refs d'évidence qui la soutiennent — jamais vide pour une assertion factuelle. */
  readonly evidenceRefs: readonly string[]
  /** Mode de rendu : DIRECT (certain) ou QUALIFIED (prudent/conditionnel). */
  readonly rendering: 'DIRECT' | 'QUALIFIED'
}

/** Sortie du moteur : la copy + la traçabilité PROUVABLE de chaque claim. */
export interface DraftMessageV0 {
  readonly text: string
  /**
   * Refs d'évidence effectivement MONTRÉES — DÉRIVÉES déterministiquement des
   * assertions validées (jamais une liste libre du modèle), ⊆ showableEvidenceRefs.
   */
  readonly shownEvidenceRefs: readonly string[]
  readonly channelPolicyApplied: ChannelPolicyV0['channel']
  /** Audit borné des assertions — métadonnée de message, pas une vérité. */
  readonly assertionsAudit: readonly MessageAssertionAuditV0[]
}

/**
 * Classes d'échec FERMÉES — fail-closed, sans fuite de diagnostic fournisseur.
 *   PROVIDER_UNAVAILABLE    — fournisseur en erreur/indisponible/inachevé.
 *   PROVIDER_BLOCKED        — refus budgétaire/garde-fou du gateway.
 *   MALFORMED_MODEL_OUTPUT  — sortie modèle non-JSON/hors schéma/vide.
 *   POLICY_VIOLATION        — sortie bien formée mais violant les contraintes
 *                             (budgets, refs, interdits, incertitude, fuite).
 *   UNSUPPORTED_ACTION_CONTEXT — contexte d'action incomplet/non supporté en V0
 *                             (REPLY sans contexte sûr, objectif sans inconnue).
 */
export type ComposeFailureReasonV0 =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BLOCKED'
  | 'MALFORMED_MODEL_OUTPUT'
  | 'POLICY_VIOLATION'
  | 'UNSUPPORTED_ACTION_CONTEXT'

/** Sous-motifs FERMÉS — audit interne, jamais un message fournisseur brut.
 *
 * R2 : DIRECT_RENDERING_ON_COUNTER_SIGNAL_REF est RETIRÉ du contrat actif —
 * un contre-signal ne rend PAS le fait primaire incertain (il contraint les
 * montées interprétatives, côté prompt de confiance). Deux motifs fail-closed
 * de COMPILATION s'ajoutent : montrable hors de l'ensemble consommé par le
 * rédacteur, et FOLLOW_UP sans relation existante. */
export type ComposeFailureDetailV0 =
  | 'REPLY_CONTEXT_UNAVAILABLE_V0'
  | 'HIGH_VALUE_UNKNOWN_MISSING'
  | 'SHOWABLE_OUTSIDE_RENDERER_USED_SET'
  | 'FOLLOW_UP_RELATIONSHIP_REQUIRED_V0'
  | 'NOT_JSON'
  | 'SCHEMA_MISMATCH'
  | 'EMPTY_TEXT'
  | 'ASSERTION_MALFORMED'
  | 'ASSERTION_BUDGET_EXCEEDED'
  | 'UNKNOWN_EVIDENCE_REF'
  | 'NON_SHOWABLE_EVIDENCE_REF'
  | 'SHOWN_BUDGET_EXCEEDED'
  | 'ASSERTION_WITHOUT_EVIDENCE'
  | 'DIRECT_RENDERING_ON_UNCERTAIN_REF'
  | 'FORBIDDEN_CLAIM'
  | 'INTERNAL_REF_LEAKED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_INCOMPLETE'
  | 'PROVIDER_OFF'
  | 'PROVIDER_BUDGET_BLOCKED'
  | 'CONTEXT_NOT_VALIDATED'

export type MessageComposeResultV0 =
  | { ok: true; draft: DraftMessageV0 }
  | { ok: false; reason: ComposeFailureReasonV0; detail: ComposeFailureDetailV0 }

export interface MessageEngineV0 {
  readonly engineId: string
  /**
   * SEULES entrées MÉTIER : le contexte VALIDÉ + la politique du canal DÉJÀ
   * choisi. Asynchrone (B2A) : le rendu passe par un fournisseur injecté à la
   * construction — jamais par un paramètre métier supplémentaire.
   */
  compose(input: ValidatedMessageReadyContextV0, policy: ChannelPolicyV0): Promise<MessageComposeResultV0>
}

export type EngineAdmission =
  | { ok: true; context: ValidatedMessageReadyContextV0; policy: ChannelPolicyV0 }
  | { ok: false; reason: 'CONTEXT_NOT_VALIDATED' | 'UNSUPPORTED_CHANNEL_V0' }

/**
 * Porte d'admission de la frontière : REFUSE tout objet non passé par
 * `validateMessageReadyContext` (objet forgé, fiche brute, contexte brut ne
 * portent pas la marque), puis résout la politique du canal DÉJÀ choisi.
 */
export function admitToEngine(candidate: unknown): EngineAdmission {
  if (!isValidatedContext(candidate)) return { ok: false, reason: 'CONTEXT_NOT_VALIDATED' }
  const policy = resolveChannelPolicy(candidate.context.channel)
  if (policy.ok === false) return { ok: false, reason: 'UNSUPPORTED_CHANNEL_V0' }
  return { ok: true, context: candidate, policy: policy.policy }
}
