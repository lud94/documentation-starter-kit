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
  /**
   * @deprecated LEGACY, NON-AUTORITAIRE. Vaut `0` partout dans le produit
   * actuel : aucun agent ne le calcule.
   *
   * ⚠️ N'EST JAMAIS UNE SOURCE DE FAIT. Ce champ a fabriqué, jusqu'à
   * PROSPECTOR-DOMAIN-ADAPTERS-001, un dossier commercial entier — montant de
   * levée, tranche d'effectif, offre d'emploi, attributions « source Pappers /
   * Unipile / LinkedIn » — à partir de ce seul nombre. Cette branche est
   * supprimée.
   *
   * Conservé pour la compatibilité des données déjà persistées. Ne doit jamais
   * devenir une `EvidenceEvent`, ni alimenter le Decision Kernel, ni justifier
   * un énoncé affiché comme un fait.
   */
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
  researchNotes?: string // notes de recherche externe (collées depuis Claude/ChatGPT/Perplexity)
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

// ── SIGNAL-ACQUISITION-CONTRACT-001 — SÉMANTIQUE STRUCTURÉE DE L'ACQUISITION ─
//
// ⚠️ POURQUOI CES CHAMPS EXISTENT. Un futur adaptateur déterministe doit savoir
// si l'on observe un ÉVÉNEMENT ou un ÉTAT, si l'événement a eu lieu ou est
// seulement annoncé, et à quelle date métier — SANS jamais lire la prose de
// `detail`. Analyser une phrase pour retrouver ces distinctions reviendrait à
// glisser un jugement de langage au cœur d'un moteur qu'on veut déterministe.
//
// L'EXTRACTION a le droit de lire la source : c'est son métier. L'ADAPTATEUR
// n'a le droit de lire que ces champs clos. La frontière est là, et nulle part
// ailleurs.
//
// `UNKNOWN` est une VALEUR PLEINE, jamais un défaut silencieux : « on ne sait
// pas » doit se distinguer de « on n'a pas rempli le champ ».

/**
 * Nature de ce qui est observé.
 *
 * `EVENT` — un fait discret survenu à une date (une levée, une nomination).
 * `STATE` — un état constaté maintenant, de début inconnu (un poste ouvert sur
 *           une page carrière, une politique de présence). Un `STATE` n'a PAS
 *           de date de survenue, et ne doit jamais s'en voir inventer une.
 */
export type SignalClaimNature = 'EVENT' | 'STATE' | 'UNKNOWN'

/** Un `EVENT` a-t-il eu lieu, ou est-il seulement annoncé pour plus tard ? */
export type SignalEventStatus = 'COMPLETED' | 'ANNOUNCED_FUTURE' | 'UNKNOWN'

/** Précision réelle de `eventDate`. Jamais élargie, jamais rétrécie. */
export type SignalDatePrecision = 'DAY' | 'MONTH' | 'UNKNOWN'

export type SignalRoleStatus = 'OPEN' | 'FILLED' | 'UNKNOWN'

/**
 * Fonction du poste. `EXEC_OTHER` couvre une direction NON commerciale (CEO,
 * CFO, CTO) : elle existe précisément pour qu'une nomination de dirigeant ne
 * puisse pas être confondue avec l'arrivée d'un responsable Sales.
 */
export type SignalRoleFunction = 'SALES' | 'TECH' | 'OFFICE_PEOPLE' | 'EXEC_OTHER' | 'UNKNOWN'

/**
 * Provenance de l'EXTRACTION — comment ce résultat a été fabriqué.
 *
 * ⚠️ CE N'EST PAS UNE PREUVE. Savoir quel modèle a extrait une information ne
 * dit rien de sa véracité. Ce bloc sert à rejouer et à auditer une acquisition,
 * jamais à fonder une confiance.
 */
export interface SignalExtraction {
  mode: 'exa+claude' | 'claude-web'
  promptVersion: string
  model?: string
}

// Recherche par SIGNAL : entreprise détectée via une annonce/actu, avec icebreaker.
export interface SignalHit {
  /**
   * Identifiant OPAQUE du candidat émis par le serveur
   * (SIGNAL-PRODUCT-REACHABILITY-001-R1c).
   *
   * ⚠️ RENDU PAR `/api/signals/search`, JAMAIS ACCEPTÉ EN ENTRÉE d'un traitement
   * porteur de vérité. C'est la SEULE chose que le navigateur renvoie pour
   * désigner un candidat à l'adjudication : tous les champs structurés ci-dessous
   * sont alors relus du registre serveur, jamais de la requête.
   */
  candidateId?: string
  company: string
  siren?: string          // rempli SEULEMENT à l'import (vérification data.gouv)
  signalType: 'recrutement' | 'levée' | 'actu' | 'autre'
  detail: string          // "recrute un Head of Sales (cybersécurité)"
  icebreaker: string      // accroche prête à l'emploi
  sourceUrl?: string
  sourceName?: string     // média/site d'où vient le signal (jugement de fiabilité)
  /**
   * @deprecated AMBIGU — « date du signal » : ni le code ni le prompt n'ont
   * jamais tranché entre date de publication et date de survenue. Conservé pour
   * l'affichage existant (`pages/sourcing.tsx`) et pour lui seul.
   *
   * ⚠️ UN ADAPTATEUR NE DOIT JAMAIS EN FAIRE UN `occurredAt`. Les champs
   * `eventDate` / `eventDatePrecision` / `sourcePublishedAt` font autorité.
   */
  date?: string
  amount?: string         // montant de la levée si applicable
  role?: string           // poste ouvert si recrutement
  sector?: string
  city?: string
  verified: boolean       // true seulement après vérification data.gouv (à l'import)

  // ── Contrat sémantique structuré (SIGNAL-ACQUISITION-CONTRACT-001) ────────
  // Toujours présents et toujours explicites : l'absence d'information est
  // portée par `UNKNOWN` / `null`, jamais par un champ manquant.
  claimNature: SignalClaimNature
  eventStatus: SignalEventStatus
  /** Date de l'ÉVÉNEMENT MÉTIER — jamais la date de publication. */
  eventDate: string | null
  eventDatePrecision: SignalDatePrecision
  /** Date de PUBLICATION de la source — jamais promue en date de survenue. */
  sourcePublishedAt: string | null
  roleStatus: SignalRoleStatus
  roleFunction: SignalRoleFunction
  extraction: SignalExtraction

  /**
   * CONTRAT D'ACQUISITION V2 (SIGNAL_ACQUISITION_CONTRACT_002) — ADDITIF.
   *
   * Absent = hit V1 pleinement valide (aucune migration des données
   * existantes). Présent = doit être ENTIER et valide (`isAcquisitionFactV2`) :
   * un bloc à moitié rempli ment, l'absence est silencieuse.
   */
  v2?: AcquisitionFactV2
}

// ── CONTRAT D'ACQUISITION V2 (SIGNAL_ACQUISITION_CONTRACT_002) ──────────────
//
// Principe fondateur : AUCUNE couche aval ne doit analyser de la prose libre
// pour établir une identité factuelle. Tout ce qui alimente identité,
// contradiction, temporalité ou Situation est un champ CLOS et validé ;
// la prose (`rawDetail`) reste un détail d'audit et d'affichage.
//
// Interdit par construction : une « confiance » numérique universelle (la confiance
// source vit dans la provenance, la validité d'extraction dans le schéma,
// la confiance de fait sera DÉRIVÉE du registre d'assertions durables).

export type AcquisitionFamilyV2 = 'FUNDING' | 'EXECUTIVE_CHANGE' | 'HIRING_SNAPSHOT'

export type MoneyCurrency = 'EUR' | 'USD' | 'GBP' | 'CHF'

/**
 * Montant EXACT énoncé par la source. `amountMinor` en centimes.
 * Jamais fabriqué à partir d'une formulation approximative.
 */
export interface MoneyExact {
  amountMinor: number
  currency: MoneyCurrency
  asPublished: string
}

/**
 * Montant APPROXIMATIF (« environ 12 M€ »). L'approximation est portée par le
 * TYPE lui-même — volontairement AUCUNE borne basse/haute : inventer un
 * intervalle serait fabriquer des nombres que la source n'a pas publiés.
 */
export interface MoneyApprox {
  magnitudeMinor: number
  currency: MoneyCurrency
  asPublished: string
}

export type FundingInvestorRole = 'LEAD' | 'PARTICIPANT' | 'UNKNOWN'

/**
 * Investisseur DESCRIPTIF. Pas d'identité d'organisation, pas de graphe, pas
 * de normalisation : `nameRaw` tel que publié. NE PARTICIPE JAMAIS à
 * l'identité d'un FUNDING_ROUND.
 */
export interface FundingInvestor {
  nameRaw: string
  role: FundingInvestorRole
}

export type FundingRoundStage =
  | 'SEED'
  | 'SERIES_A'
  | 'SERIES_B'
  | 'SERIES_C_PLUS'
  | 'DEBT'
  | 'UNKNOWN'

export interface FundingPayloadV2 {
  family: 'FUNDING'
  /** Exclusifs : un fait est exact OU approximatif, jamais les deux. */
  amount?: MoneyExact
  amountApprox?: MoneyApprox
  roundStage: FundingRoundStage
  investors?: FundingInvestor[]
}

export type PersonVerification = 'VERIFIED_EXTERNAL_REF' | 'NAME_ONLY'
export type PersonExternalRefKind = 'LINKEDIN_URL' | 'PAPPERS_DIRIGEANT_ID'

/**
 * Identité de personne MINIMALE — refus explicite du graphe de personnes.
 *
 * `NAME_ONLY` est admis dans une identité factuelle V2, mais cette identité
 * est TOUJOURS scopée au compte (deux « Jean Dupont » dans deux entreprises ne
 * fusionnent jamais). Pas de fuzzy matching : la fausse scission (« Jean
 * Dupont » / « Jean P. Dupont » = deux clés) est ACCEPTÉE, car visible et
 * corrigeable ; la fausse fusion empoisonne en silence.
 */
export interface PersonRef {
  fullNameRaw: string
  /** DOIT être exactement `normalizePersonName(fullNameRaw)` — recalculée à la validation. */
  normalizedName: string
  externalRef?: { kind: PersonExternalRefKind; value: string }
  verification: PersonVerification
}

export type ExecutiveChangeDirection = 'APPOINTMENT' | 'DEPARTURE' | 'UNKNOWN'
export type ExecutiveRoleSeniority = 'C_LEVEL' | 'VP_DIRECTOR' | 'OTHER' | 'UNKNOWN'

export interface ExecutivePayloadV2 {
  family: 'EXECUTIVE_CHANGE'
  /** `UNKNOWN` reste représentable (audit) mais BLOQUERA tout ancrage canonique futur. */
  direction: ExecutiveChangeDirection
  roleFunction: SignalRoleFunction
  roleSeniority: ExecutiveRoleSeniority
  person: PersonRef
  roleTitleRaw?: string
}

export type HiringCountMethod = 'SOURCE_DECLARED' | 'ENUMERATED_POSTINGS'

/**
 * Décompte OBSERVÉ d'ouvertures. Zéro est une valeur PLEINE (une source
 * déterministe peut confirmer zéro poste ouvert). Jamais estimé depuis la
 * prose (« recrute massivement » ⇒ champ absent, pas un nombre inventé).
 * Attribut d'ÉTAT descriptif : n'entre dans AUCUNE identité.
 */
export interface HiringCount {
  value: number
  method: HiringCountMethod
  asPublished?: string
}

export interface HiringPayloadV2 {
  family: 'HIRING_SNAPSHOT'
  roleFunction: SignalRoleFunction
  roleStatus: SignalRoleStatus
  openingsObserved?: HiringCount
}

export type AcquisitionPayloadV2 = FundingPayloadV2 | ExecutivePayloadV2 | HiringPayloadV2

/** Prose d'audit et d'affichage UNIQUEMENT — jamais lue par identité/mapping. */
export interface AcquisitionRawDetail {
  detail: string
  icebreaker: string
  sourceExcerpt?: string
}

/**
 * Enveloppe commune V2. Double discriminant (`family` sur l'enveloppe ET sur
 * le payload) : une incohérence entre les deux est un rejet, pas une devinette.
 *
 * Cohérence temporelle imposée par la validation :
 *   FUNDING / EXECUTIVE_CHANGE → claimNature EVENT
 *   HIRING_SNAPSHOT            → claimNature STATE (occurredAt null, précision UNKNOWN)
 */
export interface AcquisitionFactV2 {
  contractVersion: 'v2'
  family: AcquisitionFamilyV2
  claimNature: SignalClaimNature
  eventStatus: SignalEventStatus
  occurredAt: string | null
  occurredAtPrecision: SignalDatePrecision
  sourcePublishedAt: string | null
  rawDetail: AcquisitionRawDetail
  extraction: SignalExtraction
  payload: AcquisitionPayloadV2
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
  externalAI?: boolean // autoriser l'envoi de contexte vers une IA externe (Claude/ChatGPT/Perplexity)
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

export const DEFAULT_PERMISSIONS: WorkspacePermissions = { messaging: true, leads: true, sequences: true, validate: true, externalAI: true }

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
