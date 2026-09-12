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
  /**
   * ARCH-HORIZON-001 — la fenêtre d'action n'est pas encore ouverte.
   *
   * Blocage TEMPORAIRE et daté : `blockedUntil` porte `actionWindowOpensAt`.
   */
  | 'anticipated_window_not_open'
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

  // 3. ARCH-HORIZON-001 — LA FENÊTRE D'ACTION N'EST PAS ENCORE OUVERTE.
  //
  // ⚠️ CE GARDE-FOU EST INDISPENSABLE, ET IL APPARTIENT AU CŒUR.
  // `urgency` vaut `max(urgenceEvidence, urgenceHorizon)`. Une evidence très
  // récente peut donc porter une urgence de 1 alors que `now` précède encore
  // `actionWindowOpensAt`. Sans ce blocage, Jarvis produirait une
  // recommandation ACTIVE avant l'ouverture de la fenêtre — en contradiction
  // directe avec le champ qui la déclare. Le laisser à la discipline du Rule
  // Pack reviendrait à espérer que chaque pack y pense.
  //
  // Placé APRÈS l'opt-out : celui-ci est un veto absolu, et répondre « revenez
  // à telle date » à un compte qui a demandé à ne plus être sollicité serait
  // faux. Placé AVANT les collisions d'agenda : inutile d'invoquer un
  // rendez-vous déjà pris pour une action qui n'est de toute façon pas encore
  // permise.
  //
  // Le cas `now >= anticipated.at` n'est PAS traité ici : le clamp d'`expiresAt`
  // dans `buildSituation` le fait déjà tomber en `situation_expired` au
  // contrôle n°1. Le dupliquer créerait deux définitions de la même règle.
  if (situation.anticipated) {
    const horizon = situation.anticipated
    const opensMs = validDateMs(horizon.actionWindowOpensAt)
    const atMs = validDateMs(horizon.at)

    // Dates illisibles ou fenêtre dégénérée : refus structurel, jamais une
    // interprétation « au mieux ».
    if (opensMs === null || atMs === null || opensMs >= atMs) {
      return {
        eligible: false,
        reason: 'invalid_context',
      }
    }

    if (nowMs < opensMs) {
      return {
        eligible: false,
        reason: 'anticipated_window_not_open',
        blockedUntil: new Date(opensMs).toISOString(),
      }
    }

    // ── BORNE DROITE, PORTÉE DIRECTEMENT ICI (ARCH-HORIZON-001a) ────────────
    //
    // ⚠️ DÉFENSE EN PROFONDEUR, ET ELLE N'EST PAS REDONDANTE. Le clamp de
    // `buildSituation` garantit `expiresAt ≤ anticipated.at` pour tout objet
    // que NOUS fabriquons. Mais une Situation relue depuis la persistance est
    // une ENTRÉE, pas une valeur de confiance : elle a pu être écrite par une
    // version antérieure du code, corrompue, ou forgée à la main.
    //
    // Le cas reproduit avant correction :
    //     anticipated.at = 2026-01-01   (passé)
    //     expiresAt      = 2027-01-01   (encore futur)
    //     now            = 2026-08-23
    // passait le contrôle d'expiration n°1 — puisque `expiresAt` est futur —
    // et produisait une recommandation ACTIVE sur une échéance périmée depuis
    // huit mois.
    //
    // Le Decision Kernel ne doit jamais supposer que tout objet entrant a été
    // fabriqué par la version courante de `buildSituation()`.
    if (nowMs >= atMs) {
      return {
        eligible: false,
        reason: 'situation_expired',
      }
    }
  }

  // 4. Ne pas recommander une action qui entre en collision
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

  // 5. Anti-spam / anti-duplication.
  if (context.activeRecommendationExists) {
    return {
      eligible: false,
      reason: 'active_recommendation_exists',
    }
  }

  // 6. Cooldown relationnel.
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