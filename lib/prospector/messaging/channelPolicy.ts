// JS-015 B1 — POLITIQUE DE CANAL V0 — DÉTERMINISTE, QUALITATIVE, AUCUNE COPY.
//
// R2-C5 : B1 ne gèle QUE des différences QUALITATIVES de posture — AUCUN
// plafond numérique inventé (pas de longueur en caractères, pas de compte
// d'items). Les QUANTITÉS par message appartiennent aux budgets du
// MessageReadyContext ; la politique de canal décrit la POSTURE du canal.
// Le canal est une DÉCISION AMONT (il arrive déjà choisi dans le contexte).
// WhatsApp : hors contrat V0 — rejeté ici, sans supprimer le transport hérité.
import type { MessageChannelV0 } from './messageContext'
import { MESSAGE_CHANNELS_V0 } from './messageContext'

export interface ChannelPolicyV0 {
  readonly channel: MessageChannelV0
  /** LinkedIn : posture courte ; email : posture étendue. */
  readonly lengthPosture: 'SHORT' | 'EXTENDED'
  /** Registre : LinkedIn conversationnel, email plus business/explicite. */
  readonly register: 'CONVERSATIONAL' | 'BUSINESS_EXPLICIT'
  /** Exposition de recherche : LinkedIn minimale, email plus élevée (dans les budgets). */
  readonly researchExposurePosture: 'MINIMAL' | 'HIGHER'
  /** LinkedIn : tolérance basse à la spécificité « surveillance ». */
  readonly surveillanceTolerance: 'LOW' | 'MEDIUM'
  /** LinkedIn : demande douce. Email : CTA explicite autorisé. */
  readonly ctaStyle: 'SOFT_ASK' | 'EXPLICIT_ALLOWED'
  /** Email : davantage de contexte autorisé. */
  readonly contextDepth: 'SHALLOW' | 'EXTENDED'
}

export const CHANNEL_POLICIES_V0: Readonly<Record<MessageChannelV0, ChannelPolicyV0>> = Object.freeze({
  linkedin: Object.freeze({
    channel: 'linkedin' as const,
    lengthPosture: 'SHORT' as const,
    register: 'CONVERSATIONAL' as const,
    researchExposurePosture: 'MINIMAL' as const,
    surveillanceTolerance: 'LOW' as const,
    ctaStyle: 'SOFT_ASK' as const,
    contextDepth: 'SHALLOW' as const,
  }),
  email: Object.freeze({
    channel: 'email' as const,
    lengthPosture: 'EXTENDED' as const,
    register: 'BUSINESS_EXPLICIT' as const,
    researchExposurePosture: 'HIGHER' as const,
    surveillanceTolerance: 'MEDIUM' as const,
    ctaStyle: 'EXPLICIT_ALLOWED' as const,
    contextDepth: 'EXTENDED' as const,
  }),
})

export type ChannelPolicyResolution =
  | { ok: true; policy: ChannelPolicyV0 }
  | { ok: false; reason: 'UNSUPPORTED_CHANNEL_V0' }

/** WhatsApp (et tout canal hors registre V0) : NON DÉCIDÉ ⇒ fermé. */
export function resolveChannelPolicy(channel: string): ChannelPolicyResolution {
  if (!(MESSAGE_CHANNELS_V0 as readonly string[]).includes(channel)) {
    return { ok: false, reason: 'UNSUPPORTED_CHANNEL_V0' }
  }
  return { ok: true, policy: CHANNEL_POLICIES_V0[channel as MessageChannelV0] }
}
