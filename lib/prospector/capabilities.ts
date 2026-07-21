// Capacités Prospector — contrat API-first.
// Chaque fonction exportée ici est une capacité appelable par l'UI ET, à terme,
// par Jarvis. Aujourd'hui : mock en mémoire. Demain : appels API vers le back.

import type { Action, Lead, Quota, Stage } from '../../types/prospector'
import { ACTION_META } from '../../types/prospector'

export interface DashboardData {
  pendingActions: number
  kpis: {
    invitationsSent: number
    acceptanceRate: number // %
    replies: number
    meetings: number
    iaCostWeek: number // $
  }
  funnel: { stage: Stage; count: number }[]
  activity: {
    id: string
    kind: 'reply' | 'accepted' | 'invitation' | 'message' | 'meeting'
    text: string
    when: string
    hot?: boolean
  }[]
}

const LEADS: Record<string, Lead> = {
  l1: { id: 'l1', firstName: 'Camille', lastName: 'Roux', title: 'VP Sales', company: 'Fivory', score: 82, temperature: 'hot', stage: 'connected' },
  l2: { id: 'l2', firstName: 'Thomas', lastName: 'Lefèvre', title: 'Head of Growth', company: 'Nudge', score: 74, temperature: 'warm', stage: 'connected' },
  l3: { id: 'l3', firstName: 'Inès', lastName: 'Bernard', title: 'CMO', company: 'Payflow', score: 68, temperature: 'warm', stage: 'in_sequence' },
  l4: { id: 'l4', firstName: 'Hugo', lastName: 'Martin', title: 'CEO & Co-founder', company: 'Kairos AI', score: 91, temperature: 'hot', stage: 'to_invite' },
  l5: { id: 'l5', firstName: 'Léa', lastName: 'Dubois', title: 'Head of Sales Ops', company: 'Swan', score: 59, temperature: 'warm', stage: 'to_invite' },
  l6: { id: 'l6', firstName: 'Antoine', lastName: 'Girard', title: 'Directeur Commercial', company: 'Spendesk', score: 71, temperature: 'warm', stage: 'in_sequence' },
  l7: { id: 'l7', firstName: 'Sarah', lastName: 'Moreau', title: 'Founder', company: 'Lago', score: 88, temperature: 'hot', stage: 'connected' },
  l8: { id: 'l8', firstName: 'Maxime', lastName: 'Petit', title: 'Head of Marketing', company: 'Qonto', score: 63, temperature: 'warm', stage: 'to_invite' },
  l9: { id: 'l9', firstName: 'Julie', lastName: 'Fontaine', title: 'VP Marketing', company: 'Pennylane', score: 66, temperature: 'warm', stage: 'invited' },
  l10: { id: 'l10', firstName: 'Nicolas', lastName: 'Laurent', title: 'Chief Revenue Officer', company: 'Alan', score: 79, temperature: 'hot', stage: 'invited' },
  l11: { id: 'l11', firstName: 'Chloé', lastName: 'Garnier', title: 'Head of Sales', company: 'Ledger', score: 72, temperature: 'warm', stage: 'responded' },
  l12: { id: 'l12', firstName: 'Romain', lastName: 'Faure', title: 'CEO', company: 'Dust', score: 85, temperature: 'hot', stage: 'responded' },
  l13: { id: 'l13', firstName: 'Emma', lastName: 'Rousseau', title: 'Founder & CEO', company: 'Photoroom', score: 90, temperature: 'hot', stage: 'meeting' },
  l14: { id: 'l14', firstName: 'Lucas', lastName: 'Mercier', title: 'Head of Growth', company: 'Aircall', score: 77, temperature: 'hot', stage: 'closed' },
}

let ACTIONS: Action[] = [
  { id: 'a1', leadId: 'l4', type: 'invitation', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Hugo, votre post sur l'agent d'onboarding de Kairos m'a marqué — surtout le passage sur le temps commercial récupéré. On aide justement des équipes tech à industrialiser ça. Curieux d'échanger ?" },
  { id: 'a2', leadId: 'l1', type: 'message', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Camille, on s'est connectés la semaine dernière. Vous mentionniez vouloir structurer le suivi post-démo chez Fivory. J'ai deux approches concrètes en tête — je vous envoie ça ou on en parle 15 min ?" },
  { id: 'a3', leadId: 'l7', type: 'message', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Sarah, félicitations pour la traction de Lago sur le métered billing. Vos équipes sales scalent vite — souvent le moment où l'ops déraille. On outille exactement cette phase, ça vous parle ?" },
  { id: 'a4', leadId: 'l2', type: 'relance', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Thomas, je reviens vers vous sans insister — j'ai pensé à Nudge en voyant une étude sur l'automatisation du nurturing B2B. Je vous la partage, sans agenda commercial derrière." },
  { id: 'a5', leadId: 'l5', type: 'invitation', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Léa, votre parcours sur l'ops sales chez Swan est exactement le genre de profil dont j'apprends beaucoup. Ravi de me connecter." },
  { id: 'a6', leadId: 'l8', type: 'visit', status: 'pending', scheduledLabel: null, createdAt: '06:00', generatedMessage: null },
  { id: 'a7', leadId: 'l3', type: 'message', status: 'pending', scheduledLabel: null, createdAt: '06:00',
    generatedMessage: "Inès, chez Payflow vous gérez sûrement un mix de canaux d'acquisition costaud. On voit beaucoup de CMO tech récupérer un temps fou en automatisant le scoring des leads entrants. Un angle qui vous intéresse ?" },
  { id: 'a8', leadId: 'l6', type: 'visit', status: 'pending', scheduledLabel: null, createdAt: '06:00', generatedMessage: null },
]

const QUOTAS: Record<Quota['type'], Quota> = {
  invitation: { type: 'invitation', used: 6, max: 18 },
  message: { type: 'message', used: 9, max: 25 },
  visit: { type: 'visit', used: 34, max: 80 },
}

function delay<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

function nextSlotLabel(): string {
  // Mock d'un créneau anti-détection (le vrai back appliquera les délais réels).
  const base = 9 * 60 + 40 + Math.floor((QUOTAS.invitation.used + QUOTAS.message.used) * 7)
  const h = Math.min(18, Math.floor(base / 60))
  const m = base % 60
  return `Aujourd'hui ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// --- Lecture ---

export function getTodayActions() {
  return delay({
    actions: ACTIONS.filter((a) => a.status !== 'cancelled'),
    leads: LEADS,
    quotas: Object.values(QUOTAS),
  })
}

export function getLead(id: string): Lead | undefined {
  return LEADS[id]
}

export function getLeads(): Promise<Lead[]> {
  return delay(Object.values(LEADS))
}

export function getDashboard(): Promise<DashboardData> {
  const pendingActions = ACTIONS.filter((a) => a.status === 'pending').length
  return delay({
    pendingActions,
    kpis: {
      invitationsSent: 34,
      acceptanceRate: 41,
      replies: 12,
      meetings: 4,
      iaCostWeek: 2.1,
    },
    funnel: [
      { stage: 'to_invite', count: 42 },
      { stage: 'invited', count: 28 },
      { stage: 'connected', count: 63 },
      { stage: 'in_sequence', count: 31 },
      { stage: 'responded', count: 12 },
      { stage: 'meeting', count: 4 },
      { stage: 'closed', count: 2 },
    ],
    activity: [
      { id: 'e1', kind: 'reply', text: 'Sarah Moreau (Lago) a répondu à votre message', when: 'il y a 2 h', hot: true },
      { id: 'e2', kind: 'invitation', text: 'Invitation envoyée à Hugo Martin (Kairos AI)', when: 'il y a 3 h' },
      { id: 'e3', kind: 'meeting', text: 'RDV planifié avec Camille Roux (Fivory)', when: 'hier' },
      { id: 'e4', kind: 'accepted', text: 'Thomas Lefèvre (Nudge) a accepté votre invitation', when: 'hier' },
      { id: 'e5', kind: 'message', text: 'Message envoyé à Inès Bernard (Payflow)', when: 'hier' },
    ],
  })
}

// --- Mutations (capacités Jarvis) ---

export function validateAction(id: string) {
  const a = ACTIONS.find((x) => x.id === id)
  if (a && a.status === 'pending') {
    a.status = 'validated'
    a.scheduledLabel = nextSlotLabel()
    QUOTAS[ACTION_META[a.type].quota].used += 1
  }
  return delay(a)
}

export function validateAll() {
  ACTIONS.filter((a) => a.status === 'pending').forEach((a) => {
    a.status = 'validated'
    a.scheduledLabel = nextSlotLabel()
    QUOTAS[ACTION_META[a.type].quota].used += 1
  })
  return delay(ACTIONS)
}

export function cancelAction(id: string) {
  const a = ACTIONS.find((x) => x.id === id)
  if (a) a.status = 'cancelled'
  return delay(a)
}

export function updateActionMessage(id: string, message: string) {
  const a = ACTIONS.find((x) => x.id === id)
  if (a) a.generatedMessage = message
  return delay(a)
}
