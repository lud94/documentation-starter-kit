// JARVIS-PROACTIVE V0
// Eligibility Engine.
//
// Une Situation peut être vraie sans qu'il soit pertinent d'agir.
// Ce moteur décide uniquement si Jarvis est autorisé à produire
// une recommandation active ou s'il doit rester en NO_ACTION.
//
// Fonction pure et déterministe : aucun LLM, aucun accès réseau,
// aucune mutation de données.

import type { Situation } from './types'

export const DEFAULT_CONTACT_COOLDOWN_HOURS = 72

export type EligibilityReason =
  | 'eligible'
  | 'situation_expired'
  | 'opt_out'
  | 'meeting_already_scheduled'
  | 'action_already_scheduled'
  | 'active_recommendation_exists'
  | 'recent_contact'
  | 'invalid_context'

export interface EligibilityContext {
  // Injecté pour rendre le moteur totalement testable.
  now: Date

  // Garde-fous relationnels / commerciaux.
  optedOut?: boolean
  meetingScheduled?: boolean
  actionScheduled?: boolean
  activeRecommendationExists?: boolean

  // Dernière interaction sortante ou significative avec le contact/compte.
  lastContactAt?: string

  // Configurable plus tard par rôle / play / entreprise.
  contactCooldownHours?: number
}

export interface EligibilityDecision {
  eligible: boolean
  reason: EligibilityReason

  // Utilisé lorsque le blocage est temporaire.
  blockedUntil?: string
}

function validDateMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function eligibilityDecision(
  situation: Situation,
  context: EligibilityContext,
): EligibilityDecision {
  const nowMs = context.now.getTime()

  if (!Number.isFinite(nowMs)) {
    return {
      eligible: false,
      reason: 'invalid_context',
    }
  }

  // 1. Une situation expirée ne doit jamais produire une nouvelle action.
  if (situation.expiresAt) {
    const expiresMs = validDateMs(situation.expiresAt)

    if (expiresMs === null) {
      return {
        eligible: false,
        reason: 'invalid_context',
      }
    }

    if (nowMs >= expiresMs) {
      return {
        eligible: false,
        reason: 'situation_expired',
      }
    }
  }

  // 2. Opt-out = veto absolu.
  if (context.optedOut) {
    return {
      eligible: false,
      reason: 'opt_out',
    }
  }

  // 3. Ne pas recommander une action qui entre en collision
  //    avec un engagement déjà prévu.
  if (context.meetingScheduled) {
    return {
      eligible: false,
      reason: 'meeting_already_scheduled',
    }
  }

  if (context.actionScheduled) {
    return {
      eligible: false,
      reason: 'action_already_scheduled',
    }
  }

  // 4. Anti-spam / anti-duplication.
  if (context.activeRecommendationExists) {
    return {
      eligible: false,
      reason: 'active_recommendation_exists',
    }
  }

  // 5. Cooldown relationnel.
  if (context.lastContactAt) {
    const lastContactMs = validDateMs(context.lastContactAt)
    const cooldownHours =
      context.contactCooldownHours ?? DEFAULT_CONTACT_COOLDOWN_HOURS

    if (
      lastContactMs === null ||
      !Number.isFinite(cooldownHours) ||
      cooldownHours < 0 ||
      lastContactMs > nowMs
    ) {
      return {
        eligible: false,
        reason: 'invalid_context',
      }
    }

    const cooldownMs = cooldownHours * 60 * 60 * 1000
    const blockedUntilMs = lastContactMs + cooldownMs

    if (nowMs < blockedUntilMs) {
      return {
        eligible: false,
        reason: 'recent_contact',
        blockedUntil: new Date(blockedUntilMs).toISOString(),
      }
    }
  }

  return {
    eligible: true,
    reason: 'eligible',
  }
}