// Capacités Prospector — contrat API-first.
// Chaque fonction exportée ici est une capacité appelable par l'UI ET, à terme,
// par Jarvis. Aujourd'hui : mock en mémoire. Demain : appels API vers le back.

import type { Action, Lead, Quota, Stage, LeadDetail, Conversation, Visitor, Sequence, AgentConfig, KnowledgeBlock, UsageSummary, Diagnostic, Workspace, QualityPassResult, SourcingData } from '../../types/prospector'
import { ACTION_META } from '../../types/prospector'

export type Period = 'week' | 'month' | 'quarter' | 'year'

export interface DetailItem {
  id: string
  name: string
  company: string
  meta: string
  href: string
}

export interface DashboardData {
  period: Period
  pendingActions: number
  kpis: {
    invitationsSent: number
    acceptanceRate: number // %
    replies: number
    meetings: number
    iaCostWeek: number // $
  }
  details: {
    invitations: DetailItem[]
    acceptance: DetailItem[]
    replies: DetailItem[]
    meetings: DetailItem[]
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

const SECTORS = ['SaaS B2B', 'Fintech', 'IA / ML', 'Cybersécurité', 'MarTech']
const BAND: Record<Lead['temperature'], 'HOT' | 'WARM' | 'COLD'> = { hot: 'HOT', warm: 'WARM', cold: 'COLD' }

function buildDetail(lead: Lead): LeadDetail {
  const seed = lead.id.charCodeAt(1) || 0
  const sector = SECTORS[seed % SECTORS.length]
  const fit = Math.min(40, Math.round(lead.score * 0.45))
  const intent = Math.min(40, Math.round(lead.score * 0.35))
  const timing = Math.max(0, Math.min(20, lead.score - fit - intent))

  return {
    lead,
    headline: `${lead.title} · ${lead.company}`,
    connectionDegree: seed % 2 === 0 ? '2e degré' : '1er degré',
    premium: lead.score > 75,
    openProfile: seed % 3 === 0,
    linkedinUrl: `linkedin.com/in/${lead.firstName.toLowerCase()}-${lead.lastName.toLowerCase()}`,
    scoring: {
      fit,
      intent,
      timing,
      segment: lead.temperature === 'hot' ? 'D1' : 'D2',
      band: BAND[lead.temperature],
      confidence: lead.score > 80 ? 'high' : lead.score > 65 ? 'medium' : 'low',
      edgeCase: lead.score >= 68 && lead.score <= 74,
      rationale: `Offre d'emploi ${sector === 'IA / ML' ? 'ML Engineer' : 'growth/sales'} publiée il y a moins de 7 jours chez ${lead.company} — confirme une phase de croissance active et une fenêtre d'opportunité immédiate.`,
      aiAdjustment: lead.temperature === 'hot' ? 5 : 0,
    },
    company: {
      name: lead.company,
      size: lead.score > 70 ? '51-200' : '11-50',
      location: 'Paris, France',
      website: `www.${lead.company.toLowerCase().replace(/\s/g, '')}.com`,
      sector,
      funding: lead.score > 82 ? 'Série A · 12 M€' : 'N/A',
      description: `${lead.company} construit une solution ${sector} pour les équipes tech. Croissance rapide de l'effectif commercial et marketing sur les 12 derniers mois.`,
    },
    dossier: {
      status: lead.score > 78 ? 'solide' : 'moyen',
      ageLabel: 'il y a 3 j',
      mecanisme: 'Mécanisme 2 — Signal récent vérifié',
      accrochePivot: `Vous scalez vos équipes ${sector === 'MarTech' ? 'marketing' : 'sales'} chez ${lead.company} — pendant ce temps, qui structure le suivi pour que rien ne tombe entre les mailles ?`,
      pourquoiMaintenant: `Recrutement commercial/growth publié récemment — signal 🔥 FRAIS (< 30 jours). Indique une phase de croissance et une charge opérationnelle accrue sur ${lead.firstName}.`,
      preuves: [
        `FAIT — Offre d'emploi publiée récemment (source Unipile)`,
        `FAIT — Effectif ${lead.score > 70 ? '51-200' : '11-50'} en croissance (source Pappers)`,
        `FAIT — ${lead.title} identifié comme décideur (source LinkedIn)`,
      ],
      aIntegrer: [
        `Le signal de recrutement comme point d'entrée concret et daté`,
        `La double charge croissance + structuration qui pèse sur ${lead.firstName} — nommer sans dramatiser`,
      ],
      aEviter: [
        `Flatter une réalisation publique (levée, prix) sans qu'il en ait parlé`,
        `Mentionner des outils concurrents sans qu'il les ait cités`,
        `Promettre un ROI chiffré sans connaître ses métriques réelles`,
      ],
      questionAPoser: `Quand vos équipes ${sector === 'MarTech' ? 'marketing' : 'sales'} grossissent aussi vite, comment vous assurez-vous aujourd'hui que le suivi ne se dégrade pas ?`,
      objectifReponse: `Obtenir une réponse sur leur process actuel — ouvrir une conversation, pas vendre.`,
      canalRecommande: 'linkedin_message',
      canalRationale: `Profil LinkedIn actif. LinkedIn est le canal naturel d'un ${lead.title.toLowerCase()} qui publie et recrute. Invitation d'abord si non connecté.`,
      reserves: [
        lead.temperature !== 'hot' ? `Segment D1 vs D2 non confirmé — dépend de la présence d'une équipe dédiée.` : `Nom du décideur secondaire non disponible.`,
        `Effectif non recoupé Pappers/Unipile — cohérence acceptable, pas d'écart bloquant.`,
        `L'angle suppose ${lead.firstName} impliqué dans l'opérationnel commercial — hypothèse raisonnée, non confirmée.`,
      ],
    },
    notes: '',
    interactions: lead.stage === 'to_invite' || lead.stage === 'invited'
      ? []
      : [
          { id: 'i1', date: 'il y a 2 j', kind: 'invitation', text: 'Invitation acceptée' },
          { id: 'i2', date: 'il y a 1 j', kind: 'message', text: 'Premier message envoyé' },
        ],
  }
}

export function getLeadDetail(id: string): Promise<LeadDetail | undefined> {
  const lead = LEADS[id]
  return delay(lead ? buildDetail(lead) : undefined)
}

export function getConversations(): Promise<Conversation[]> {
  const c = (id: string, leadId: string, unread: boolean, messages: Conversation['messages'], suggestedReply: string): Conversation => ({
    id, lead: LEADS[leadId], unread, channel: 'linkedin', messages, suggestedReply,
  })
  return delay([
    c('c1', 'l7', true, [
      { id: 'm1', from: 'us', text: 'Sarah, félicitations pour la traction de Lago. Vos équipes sales scalent vite — souvent le moment où l\'ops déraille. On outille cette phase, ça vous parle ?', time: 'lun. 09:12' },
      { id: 'm2', from: 'them', text: 'Salut ! Oui c\'est un vrai sujet en ce moment. Vous faites quoi exactement ?', time: 'lun. 14:30' },
    ], 'Bonne question — concrètement on met en place des agents qui qualifient et priorisent vos leads entrants automatiquement, pour que vos commerciaux ne passent que sur les comptes chauds. 15 min cette semaine pour vous montrer un cas concret ?'),
    c('c2', 'l12', true, [
      { id: 'm1', from: 'us', text: 'Romain, vous scalez Dust très vite. Comment vous assurez-vous que le suivi commercial ne se dégrade pas ?', time: 'mar. 10:05' },
      { id: 'm2', from: 'them', text: 'Intéressant. On galère un peu sur le suivi post-démo justement.', time: 'mar. 16:40' },
    ], 'C\'est exactement là qu\'on intervient. On automatise les relances contextualisées post-démo pour qu\'aucune opportunité ne retombe. Je vous envoie un exemple ou on en parle de vive voix ?'),
    c('c3', 'l1', false, [
      { id: 'm1', from: 'us', text: 'Camille, on s\'est connectés la semaine dernière. Vous mentionniez vouloir structurer le suivi post-démo chez Fivory.', time: 'mer. 11:00' },
    ], 'Je reviens vers vous — j\'ai deux approches concrètes en tête pour Fivory. Un échange de 15 min cette semaine ?'),
    c('c4', 'l13', false, [
      { id: 'm1', from: 'us', text: 'Emma, ravi de notre échange. Je vous confirme le créneau de jeudi 14h.', time: 'jeu. 08:20' },
      { id: 'm2', from: 'them', text: 'Parfait, à jeudi !', time: 'jeu. 09:00' },
    ], 'Au plaisir Emma — je vous envoie l\'invitation calendrier avec le lien visio.'),
  ])
}

export function getSequences(): Promise<Sequence[]> {
  return delay([
    {
      id: 's1', name: 'Founders tech · signal recrutement', status: 'active', enrolled: 34, responseRate: 18,
      steps: [
        { id: 'st1', type: 'visit', condition: 'always', delayDays: 0 },
        { id: 'st2', type: 'invitation', condition: 'always', delayDays: 1 },
        { id: 'st3', type: 'message', condition: 'if_connected', delayDays: 2 },
        { id: 'st4', type: 'relance', condition: 'if_no_response', delayDays: 4 },
        { id: 'st5', type: 'relance', condition: 'if_no_response', delayDays: 7 },
      ],
    },
    {
      id: 's2', name: 'VP Sales · scale-up SaaS', status: 'active', enrolled: 21, responseRate: 24,
      steps: [
        { id: 'st1', type: 'invitation', condition: 'always', delayDays: 0 },
        { id: 'st2', type: 'message', condition: 'if_connected', delayDays: 3 },
        { id: 'st3', type: 'relance', condition: 'if_no_response', delayDays: 5 },
      ],
    },
    {
      id: 's3', name: 'Visiteurs profil · réchauffage', status: 'paused', enrolled: 8, responseRate: 31,
      steps: [
        { id: 'st1', type: 'visit', condition: 'always', delayDays: 0 },
        { id: 'st2', type: 'invitation', condition: 'always', delayDays: 2 },
        { id: 'st3', type: 'message', condition: 'if_connected', delayDays: 3 },
      ],
    },
  ])
}

export function generateMessage(leadId: string, variant: 'principal' | 'directe' | 'douce'): Promise<string> {
  const lead = LEADS[leadId]
  if (!lead) return delay('')
  const d = buildDetail(lead).dossier
  const prenom = lead.firstName
  if (variant === 'directe') {
    return delay(`${prenom}, ${d.accrochePivot} On aide des équipes comme ${lead.company} à structurer ça. ${d.questionAPoser}`)
  }
  if (variant === 'douce') {
    return delay(`Bonjour ${prenom}, je suis votre parcours chez ${lead.company} avec intérêt. Sans agenda commercial : ${d.questionAPoser}`)
  }
  return delay(`${prenom}, ${d.accrochePivot}\n\n${d.questionAPoser}`)
}

export function getAgents(): Promise<AgentConfig[]> {
  return delay([
    { id: 'scoring', name: 'Scoring', model: 'claude-haiku-4-5', temperature: 0.3, ragBlocks: ['icp_segments', 'qualification'], prompt: 'Tu es un agent de scoring. À partir des données du lead et des signaux, attribue un score 0-100 décomposé en Fit / Intent / Timing. Ne présente jamais un score comme une prédiction de signature.' },
    { id: 'enrichment', name: 'Enrichissement', model: 'perplexity-sonar-pro', temperature: 0.2, ragBlocks: ['icp_segments'], prompt: 'Tu enrichis un compte : entreprise (taille, secteur, funding), personne (intérêts, posts récents). Ne renvoie que des faits sourcés. Déclare toute donnée absente comme absente.' },
    { id: 'dossier', name: "Dossier d'attaque", model: 'claude-sonnet-5', temperature: 0.5, ragBlocks: ['icp_segments', 'pain_points', 'messaging_angles'], prompt: "Tu produis le Dossier d'attaque : mécanisme, accroche pivot, preuves vérifiables, à intégrer, à éviter, question, canal. Sépare les FAITS des hypothèses. Remplis toujours les réserves." },
    { id: 'redaction', name: 'Rédaction (Stratège)', model: 'claude-sonnet-5', temperature: 0.7, ragBlocks: ['messaging_angles', 'offre_produit'], prompt: 'Tu rédiges le message à partir du Dispositif validé. Sortie en variantes principal/directe/douce. Jamais de pitch direct sur un lead froid.' },
    { id: 'conversational', name: 'Conversationnel', model: 'claude-sonnet-5', temperature: 0.7, ragBlocks: ['pain_points', 'offre_produit', 'qualification'], prompt: 'Tu gères la réponse post-message. Détecte le signal (fort/moyen/faible/no-go), garde-fou HOLD. Ouvre la conversation, ne vends pas.' },
  ])
}

export function getKnowledgeBlocks(): Promise<KnowledgeBlock[]> {
  return delay([
    { id: 'icp_segments', name: 'ICP Segments', sections: 8, description: 'Profils, JTBD, signaux de la cible tech/startup < 250.', agents: ['Scoring', 'Enrichissement', 'Dossier'] },
    { id: 'pain_points', name: 'Pain Points', sections: 5, description: 'Douleurs opérationnelles sales/marketing adressées.', agents: ['Dossier', 'Conversationnel'] },
    { id: 'messaging_angles', name: 'Messaging Angles', sections: 6, description: "Angles d'accroche et formulations validées.", agents: ['Dossier', 'Rédaction'] },
    { id: 'offre_produit', name: 'Offre produit', sections: 4, description: 'One-pagers Smart.AI, preuves, références.', agents: ['Rédaction', 'Conversationnel'] },
    { id: 'qualification', name: 'Qualification', sections: 3, description: 'Critères de qualification et disqualification.', agents: ['Scoring', 'Conversationnel'] },
  ])
}

export function getUsage(): Promise<UsageSummary> {
  return delay({
    calls: 142, tokensIn: 1_620_000, tokensOut: 22_400, cost: 2.1, cached: 67_000,
    byAgent: [
      { agent: 'Enrichissement', calls: 62, tokens: 1_146_000, cost: 1.15 },
      { agent: 'Scoring', calls: 48, tokens: 236_000, cost: 0.32 },
      { agent: "Dossier d'attaque", calls: 18, tokens: 180_000, cost: 0.44 },
      { agent: 'Rédaction', calls: 10, tokens: 62_000, cost: 0.15 },
      { agent: 'Conversationnel', calls: 4, tokens: 18_000, cost: 0.04 },
    ],
    byModel: [
      { model: 'Claude Haiku 4.5', calls: 96, tokens: 472_000, cost: 0.48 },
      { model: 'Claude Sonnet 5', calls: 32, tokens: 260_000, cost: 0.62 },
      { model: 'Perplexity sonar-pro', calls: 14, tokens: 910_000, cost: 1.00 },
    ],
  })
}

export function getDiagnostics(): Promise<Diagnostic[]> {
  return delay([
    { name: 'Supabase', status: 'ok', detail: 'Connecté (264 ms)' },
    { name: 'Unipile', status: 'ok', detail: 'Actif · compte LinkedIn lié' },
    { name: 'LinkedIn', status: 'ok', detail: 'Session valide' },
    { name: 'Clé Claude (Anthropic)', status: 'ok', detail: 'Présente · chiffrée AES-256' },
    { name: 'Clé Perplexity', status: 'ok', detail: 'Présente' },
    { name: 'Clé OpenAI', status: 'warn', detail: 'Présente, non testée' },
    { name: 'CRON_SECRET', status: 'ok', detail: 'Configuré' },
  ])
}

export function getSourcing(): Promise<SourcingData> {
  return delay({
    totalSourced: 214,
    qualificationRate: 32,
    bySector: [
      { sector: 'SaaS B2B', count: 88 },
      { sector: 'Fintech', count: 52 },
      { sector: 'IA / ML', count: 41 },
      { sector: 'MarTech', count: 20 },
      { sector: 'Cybersécurité', count: 13 },
    ],
    runs: [
      { id: 'r1', label: 'SaaS · Paris · série A', found: 62, qualified: 21, when: 'il y a 2 j' },
      { id: 'r2', label: 'Fintech · France · recrute sales', found: 44, qualified: 12, when: 'il y a 5 j' },
      { id: 'r3', label: 'IA/ML · Europe · < 50', found: 38, qualified: 9, when: 'la semaine dernière' },
    ],
    incoming: [
      { id: 'sl1', name: 'Marie Dupuis', title: 'Head of Sales', company: 'Cardo', sector: 'SaaS B2B', score: 84, signals: ['Levée série A', 'Recrute 3 sales'] },
      { id: 'sl2', name: 'Paul Girard', title: 'CEO', company: 'Flowly', sector: 'MarTech', score: 78, signals: ['Croissance effectif +40%'] },
      { id: 'sl3', name: 'Sofia Navarro', title: 'VP Marketing', company: 'Beacon', sector: 'Fintech', score: 71, signals: ['Nouveau VP Marketing', 'Stack HubSpot'] },
      { id: 'sl4', name: 'Yanis Cohen', title: 'Founder', company: 'Vecto', sector: 'IA / ML', score: 88, signals: ['Levée seed', 'Recrute growth'] },
      { id: 'sl5', name: 'Claire Meunier', title: 'Chief Revenue Officer', company: 'Nomia', sector: 'SaaS B2B', score: 66, signals: ['Ouverture bureau Paris'] },
    ],
  })
}

export function getWorkspaces(): Promise<Workspace[]> {
  return delay([
    { id: 'w1', name: 'Acme', leads: 388, users: 2, plan: 'Growth' },
    { id: 'w2', name: 'Fabel', leads: 156, users: 1, plan: 'Starter' },
    { id: 'w3', name: 'Redsen', leads: 92, users: 3, plan: 'Growth' },
  ])
}

export function getVisitors(): Promise<Visitor[]> {
  const v = (leadId: string, viewedAt: string, times: number): Visitor => ({ lead: LEADS[leadId], viewedAt, times })
  return delay([
    v('l4', 'il y a 1 h', 2),
    v('l5', 'il y a 4 h', 1),
    v('l9', 'hier', 1),
    v('l8', 'hier', 3),
  ])
}

export function getDashboard(period: Period = 'week'): Promise<DashboardData> {
  const pendingActions = ACTIONS.filter((a) => a.status === 'pending').length
  const f = period === 'week' ? 1 : period === 'month' ? 4 : period === 'quarter' ? 12 : 52
  return delay({
    period,
    pendingActions,
    kpis: {
      invitationsSent: 34 * f,
      acceptanceRate: period === 'week' ? 41 : period === 'month' ? 38 : period === 'quarter' ? 40 : 39,
      replies: 12 * f,
      meetings: 4 * f,
      iaCostWeek: Math.round(2.1 * f * 100) / 100,
    },
    details: {
      invitations: [
        { id: 'l4', name: 'Hugo Martin', company: 'Kairos AI', meta: 'envoyée hier', href: '/leads/l4' },
        { id: 'l5', name: 'Léa Dubois', company: 'Swan', meta: 'envoyée hier', href: '/leads/l5' },
        { id: 'l9', name: 'Julie Fontaine', company: 'Pennylane', meta: 'il y a 2 j', href: '/leads/l9' },
        { id: 'l10', name: 'Nicolas Laurent', company: 'Alan', meta: 'il y a 2 j', href: '/leads/l10' },
      ],
      acceptance: [
        { id: 'l1', name: 'Camille Roux', company: 'Fivory', meta: 'acceptée', href: '/leads/l1' },
        { id: 'l2', name: 'Thomas Lefèvre', company: 'Nudge', meta: 'acceptée', href: '/leads/l2' },
        { id: 'l7', name: 'Sarah Moreau', company: 'Lago', meta: 'acceptée', href: '/leads/l7' },
      ],
      replies: [
        { id: 'l7', name: 'Sarah Moreau', company: 'Lago', meta: 'il y a 2 h', href: '/inbox' },
        { id: 'l12', name: 'Romain Faure', company: 'Dust', meta: 'hier', href: '/inbox' },
        { id: 'l11', name: 'Chloé Garnier', company: 'Ledger', meta: 'hier', href: '/inbox' },
      ],
      meetings: [
        { id: 'l13', name: 'Emma Rousseau', company: 'Photoroom', meta: 'jeu. 14h', href: '/leads/l13' },
        { id: 'l1', name: 'Camille Roux', company: 'Fivory', meta: 'ven. 10h', href: '/leads/l1' },
        { id: 'l7', name: 'Sarah Moreau', company: 'Lago', meta: 'lun. 15h', href: '/leads/l7' },
        { id: 'l12', name: 'Romain Faure', company: 'Dust', meta: 'mar. 11h', href: '/leads/l12' },
      ],
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

// Passe qualité en masse — mode revue. Jarvis appellera cette même capacité.
export function batchQualityPass(criterion: string): Promise<QualityPassResult> {
  const msgActions = ACTIONS.filter((a) => a.status === 'pending' && ACTION_META[a.type].needsMessage && a.generatedMessage)
  // Mock : on propose une correction sur ~1 message sur 2 (le juge = coach CCR).
  const proposals = msgActions
    .filter((_, i) => i % 2 === 0)
    .map((a) => {
      const lead = LEADS[a.leadId]
      const d = buildDetail(lead).dossier
      const after = `${lead.firstName}, ${d.accrochePivot}\n\n${d.questionAPoser}`
      return { actionId: a.id, leadName: `${lead.firstName} ${lead.lastName}`, before: a.generatedMessage as string, after }
    })
    .filter((p) => p.before !== p.after)
  return delay({ evaluated: msgActions.length, conforming: msgActions.length - proposals.length, proposals })
}

export function regenerateActionMessage(id: string, instruction: string) {
  const a = ACTIONS.find((x) => x.id === id)
  if (!a) return delay(undefined)
  const lead = LEADS[a.leadId]
  const d = buildDetail(lead).dossier
  const p = lead.firstName
  const ins = instruction.toLowerCase()
  let msg: string
  if (ins.includes('court')) msg = `${p}, ${d.questionAPoser}`
  else if (ins.includes('direct')) msg = `${p}, ${d.accrochePivot} ${d.questionAPoser}`
  else if (ins.includes('commercial') || ins.includes('doux') || ins.includes('douce')) msg = `Bonjour ${p}, sans agenda commercial : ${d.questionAPoser}`
  else if (ins.includes('angle')) msg = `${p}, autre angle — ${d.pourquoiMaintenant.split('.')[0]}. ${d.questionAPoser}`
  else if (instruction.trim()) msg = `${p}, ${d.accrochePivot} ${d.questionAPoser}`
  else msg = `${p}, ${d.accrochePivot}\n\n${d.questionAPoser}`
  a.generatedMessage = msg
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
