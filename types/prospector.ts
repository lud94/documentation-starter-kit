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
  signal?: string       // signal détecté (ex: "recrute un Head of Sales")
  icebreaker?: string   // accroche prête, issue de la recherche par signal
  linkedinUrl?: string  // profil LinkedIn (ex: ajouté via l'extension)
  siren?: string        // vérifié via data.gouv
  active?: boolean      // entreprise active (etat_administratif)
  naf?: string          // code activité principal (data.gouv)
  city?: string         // ville du siège (data.gouv)
  dirigeant?: string    // dirigeant officiel (data.gouv)
  effectif?: string     // tranche d'effectif (data.gouv)
  ca?: string           // chiffre d'affaires (data.gouv finances, ou web/Pappers public)
  website?: string      // site web déclaré (data.gouv, si présent)
  summary?: string      // résumé secteur/activité issu du web (agent Claude), hors data.gouv
  webProfile?: string   // recherche web sur la PERSONNE (poste, actualité) — factuel
  kind?: 'account' | 'contact' // 'account' = entreprise sans personne (reste hors « à inviter »)
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
  website?: string    // site web déclaré (data.gouv, si présent — sinon absent)
  dateCreation?: string // AAAA-MM-JJ
  young?: boolean     // créée il y a < 3 ans (proxy startup)
  signals: string[]   // ville, effectif… (signaux structurels)
}

// Recherche par SIGNAL : entreprise détectée via une annonce/actu, avec icebreaker.
export interface SignalHit {
  company: string
  siren?: string          // réconcilié sur data.gouv (undefined si non trouvé)
  signalType: 'recrutement' | 'levée' | 'actu' | 'autre'
  detail: string          // "recrute un Head of Sales (cybersécurité)"
  icebreaker: string      // accroche prête à l'emploi
  sourceUrl?: string
  sector?: string
  city?: string
  verified: boolean       // true si réconcilié à un SIREN (existe vraiment)
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
  byDay?: { day: string; calls: number; cost: number }[]
}

export interface Diagnostic {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export interface WorkspacePermissions {
  messaging: boolean   // répondre / envoyer des messages
  leads: boolean       // gérer ses leads (statut, tags, import, sourcing)
  sequences: boolean   // créer / éditer ses séquences
  validate: boolean    // valider les actions du jour (mode revue)
}
export interface Workspace {
  id: string
  name: string
  leads: number
  users: number
  plan: string
  clientEmail?: string
  status?: 'active' | 'suspended'
  permissions?: WorkspacePermissions
  hasClientAccess?: boolean
}

export const DEFAULT_PERMISSIONS: WorkspacePermissions = { messaging: true, leads: true, sequences: true, validate: true }

// ── Missions (agentique) : contrat structuré → plan validé → exécution pas-à-pas ──
export type MissionStatus = 'draft' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export type MissionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
// Outils autorisés : périmètre FERMÉ (l'IA ne peut rien exécuter d'autre).
export type MissionTool =
  | 'source_companies'    // chercher des entreprises (data.gouv)
  | 'import_companies'    // créer les comptes dans le pipe
  | 'resolve_dirigeants'  // ajouter les dirigeants réels en contacts
  | 'enrich_companies'    // enrichissement web (site/CA/résumé) — coûte des tokens
  | 'create_list'         // regrouper en liste
  | 'create_sequence'     // créer la séquence + enrôler les contacts

export const MISSION_TOOL_META: Record<MissionTool, { label: string; write: boolean; costly?: boolean }> = {
  source_companies: { label: 'Sourcer des entreprises', write: false },
  import_companies: { label: 'Importer les comptes', write: true },
  resolve_dirigeants: { label: 'Résoudre les dirigeants', write: true },
  enrich_companies: { label: 'Enrichir via le web', write: true, costly: true },
  create_list: { label: 'Créer la liste', write: true },
  create_sequence: { label: 'Créer la séquence', write: true },
}

export interface MissionStep {
  id: string
  tool: MissionTool
  label: string
  params: Record<string, any>
  status: MissionStepStatus
  result?: string           // preuve lisible de ce qui a été fait
  needsApproval?: boolean   // pause avant exécution (action sensible/coûteuse)
  endedAt?: number
}

export interface Mission {
  id: string
  title: string
  request: string                 // la demande libre d'origine
  objective: string
  status: MissionStatus
  autonomy: 'read_only' | 'create'
  steps: MissionStep[]
  assumptions: string[]           // hypothèses prises par le planificateur
  missing: string[]               // informations manquantes
  context: Record<string, any>    // état partagé entre étapes (companies, leadIds…)
  log: { at: number; text: string }[]
  cursor: number                  // index de l'étape courante
  createdAt: number
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
  leadIds?: string[] // leads réellement enrôlés (pour afficher qui est dans la séquence)
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
