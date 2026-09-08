// JS-015 B1 — FRONTIÈRE DU FUTUR MESSAGE ENGINE. AUCUNE IMPLÉMENTATION.
//
// ── L'INVARIANT ABSOLU ──────────────────────────────────────────────────────
// Le Message Engine décide COMMENT LE DIRE — jamais QUI, POURQUOI, QUAND,
// QUELLE ACTION, QUELLE OFFRE, QUEL CANAL. Sa SEULE entrée admissible est un
// ValidatedMessageReadyContextV0 (marqué par le validateur) : il ne reçoit
// JAMAIS une fiche prospect brute, un dump de compte, un dump de recherche,
// ni une recommandation du moteur proactif. L'architecture interdite
//   RAW DATA → LLM → cible+timing+offre+action → message
// est rendue INEXPRIMABLE par cette signature.
//
// ── B1 : FRONTIÈRE SEULE ────────────────────────────────────────────────────
// AUCUN LLM connecté. AUCUNE copy de production générée. Le rédacteur réel
// (déterministe ou LLM contraint) arrive en B2, derrière messaging:prepare.
import type { ValidatedMessageReadyContextV0 } from './messageContext'
import { isValidatedContext } from './messageContext'
import type { ChannelPolicyV0 } from './channelPolicy'
import { resolveChannelPolicy } from './channelPolicy'

/** Sortie du futur moteur : la copy + la traçabilité de CHAQUE claim. */
export interface DraftMessageV0 {
  readonly text: string
  /** Refs d'évidence effectivement MONTRÉES — prouvables ⊆ showableEvidenceRefs. */
  readonly shownEvidenceRefs: readonly string[]
  readonly channelPolicyApplied: ChannelPolicyV0['channel']
}

export interface MessageEngineV0 {
  readonly engineId: string
  /** SEULE entrée : le contexte VALIDÉ. Le moteur n'a accès à rien d'autre. */
  compose(input: ValidatedMessageReadyContextV0, policy: ChannelPolicyV0): DraftMessageV0
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
