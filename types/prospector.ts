// Modèle d'entités Prospector — socle partagé UI / API / Jarvis (API-first).

export type ActionType =
  | 'visit'
  | 'invitation'
  | 'message'
  | 'relance'
  | 'inmail'
  | 'email'

export type ActionStatus =
  | 'pending'
  | 'validated'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled'

export type Temperature = 'cold' | 'warm' | 'hot'

export type Stage =
  | 'to_invite'
  | 'invited'
  | 'connected'
  | 'in_sequence'
  | 'responded'
  | 'meeting'
  | 'closed'

export interface Lead {
  id: string
  firstName: string
  lastName: string
  title: string
  company: string
  score: number // 0-100
  temperature: Temperature
  stage: Stage
}

export interface Action {
  id: string
  leadId: string
  type: ActionType
  generatedMessage: string | null // null pour une visite
  status: ActionStatus
  scheduledLabel: string | null // ex: "Aujourd'hui 14:32"
  createdAt: string
}

export interface Quota {
  type: 'invitation' | 'message' | 'visit'
  used: number
  max: number
}

export const STAGE_META: Record<Stage, { label: string; color: string }> = {
  to_invite: { label: 'À inviter', color: '#94a3b8' },
  invited: { label: 'Invité', color: '#818cf8' },
  connected: { label: 'Connecté', color: '#667eea' },
  in_sequence: { label: 'En séquence', color: '#8b5cf6' },
  responded: { label: 'A répondu', color: '#a855f7' },
  meeting: { label: 'RDV', color: '#c026d3' },
  closed: { label: 'Signé', color: '#059669' },
}

export const ACTION_META: Record<
  ActionType,
  { label: string; quota: Quota['type']; needsMessage: boolean }
> = {
  visit: { label: 'Visite de profil', quota: 'visit', needsMessage: false },
  invitation: { label: 'Invitation', quota: 'invitation', needsMessage: true },
  message: { label: 'Message', quota: 'message', needsMessage: true },
  relance: { label: 'Relance', quota: 'message', needsMessage: true },
  inmail: { label: 'InMail', quota: 'message', needsMessage: true },
  email: { label: 'Email', quota: 'message', needsMessage: true },
}
