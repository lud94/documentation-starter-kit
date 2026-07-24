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

export type LeadStatus = 'chaud' | 'tiede' | 'froid' | 'converti' | 'perdu'

export const STATUS_META: Record<LeadStatus, { label: string; color: string; bg: string }> = {
  chaud: { label: 'Chaud', color: '#dc2626', bg: 'bg-red-50 text-red-600' },
  tiede: { label: 'Tiède', color: '#d97706', bg: 'bg-amber-50 text-amber-600' },
  froid: { label: 'Froid', color: '#64748b', bg: 'bg-slate-100 text-slate-500' },
  converti: { label: 'Converti', color: '#059669', bg: 'bg-emerald-50 text-emerald-600' },
  perdu: { label: 'Perdu', color: '#9ca3af', bg: 'bg-gray-100 text-gray-400' },
}

export interface Lead {
  id: string
  firstName: string
  lastName: string
  title: string
  company: string
  score: number // 0-100
  temperature: Temperature
  status: LeadStatus
  stage: Stage
  email: string | null
  phone: string | null
  persona?: string
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

export interface ScoringBreakdown {
  fit: number
  intent: number
  timing: number
  segment: string
  band: 'HOT' | 'WARM' | 'COLD'
  confidence: 'high' | 'medium' | 'low'
  edgeCase: boolean
  rationale: string
  aiAdjustment: number
}

export interface CompanyInfo {
  name: string
  size: string
  location: string
  website: string
  sector: string
  funding: string
  description: string
}

export interface Dossier {
  status: 'solide' | 'moyen' | 'faible'
  ageLabel: string
  ageDays: number
  stale: boolean
  mecanisme: string
  accrochePivot: string
  pourquoiMaintenant: string
  preuves: string[]
  aIntegrer: string[]
  aEviter: string[]
  questionAPoser: string
  objectifReponse: string
  canalRecommande: string
  canalRationale: string
  reserves: string[]
}

export interface Interaction {
  id: string
  date: string
  kind: string
  text: string
}

export interface LeadDetail {
  lead: Lead
  headline: string
  connectionDegree: string
  premium: boolean
  openProfile: boolean
  linkedinUrl: string
  scoring: ScoringBreakdown
  company: CompanyInfo
  dossier: Dossier
  tags: string[]
  nextAction: { label: string; when: string } | null
  notes: string
  interactions: Interaction[]
}

export interface SourcedLead {
  id: string
  name: string
  title: string
  company: string
  sector: string
  score: number
  signals: string[]
}

// Étape 1 : sourcing = ENTREPRISES (data.gouv/SIRENE). Pas de contact ici.
export interface SourcedCompany {
  id: string          // SIREN
  name: string        // raison sociale / nom complet
  naf: string         // code activité principal
  sector: string      // secteur (label UI de la recherche)
  effectif: string    // libellé tranche effectif
  city: string
  dep: string
  dirigeant?: string  // dirigeant SIRENE (best-effort, pas un persona ciblé)
  dateCreation?: string // AAAA-MM-JJ
  young?: boolean     // créée il y a < 3 ans (proxy startup)
  signals: string[]   // ville, effectif… (signaux structurels)
}

// Étape 3 : contact résolu (Pappers dirigeants / Unipile LinkedIn personas).
export interface ResolvedContact {
  name: string
  persona: string     // CEO, Head of Sales, Head of Marketing…
  title: string
  linkedinUrl?: string
  email?: string
  source: 'pappers' | 'unipile' | 'sirene'
}

export interface SourcingRun {
  id: string
  label: string
  found: number
  qualified: number
  when: string
}

export interface SourcingData {
  totalSourced: number
  qualificationRate: number // %
  bySector: { sector: string; count: number }[]
  runs: SourcingRun[]
  incoming: SourcedLead[]
}

export interface SignalSource {
  label: string
  source: string
  feasibility: 'facile' | 'moyen' | 'difficile'
}

export interface QualityProposal {
  actionId: string
  leadName: string
  before: string
  after: string
}

export interface QualityPassResult {
  evaluated: number
  conforming: number
  proposals: QualityProposal[]
}

export interface AgentConfig {
  id: string
  name: string
  model: string
  temperature: number
  prompt: string
  ragBlocks: string[]
}

export interface KnowledgeBlock {
  id: string
  name: string
  sections: number
  description: string
  agents: string[]
}

export interface UsageSummary {
  calls: number
  tokensIn: number
  tokensOut: number
  cost: number
  cached: number
  byAgent: { agent: string; calls: number; tokens: number; cost: number }[]
  byModel: { model: string; calls: number; tokens: number; cost: number }[]
}

export interface Diagnostic {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export interface Workspace {
  id: string
  name: string
  leads: number
  users: number
  plan: string
}

export type StepCondition = 'always' | 'if_connected' | 'if_no_response' | 'if_responded'

export const CONDITION_LABEL: Record<StepCondition, string> = {
  always: 'Toujours',
  if_connected: 'Si connecté',
  if_no_response: 'Si pas de réponse',
  if_responded: 'Si a répondu',
}

export type Channel = 'linkedin' | 'email' | 'whatsapp'

export const CHANNEL_META: Record<Channel, { label: string; color: string; types: ActionType[] }> = {
  linkedin: { label: 'LinkedIn', color: '#0a66c2', types: ['visit', 'invitation', 'message', 'relance'] },
  email: { label: 'Email', color: '#059669', types: ['email', 'relance'] },
  whatsapp: { label: 'WhatsApp', color: '#25d366', types: ['message', 'relance'] },
}

export interface SequenceStep {
  id: string
  channel: Channel
  type: ActionType
  condition: StepCondition
  delayDays: number
}

export interface Sequence {
  id: string
  name: string
  status: 'active' | 'paused'
  enrolled: number
  responseRate: number // %
  steps: SequenceStep[]
}

export interface Message {
  id: string
  from: 'them' | 'us'
  text: string
  time: string
}

export interface Conversation {
  id: string
  lead: Lead
  unread: boolean
  channel: 'linkedin' | 'email' | 'whatsapp'
  messages: Message[]
  suggestedReply: string
}

export interface Visitor {
  lead: Lead
  viewedAt: string
  times: number
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
