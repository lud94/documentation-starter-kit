// Capacités Prospector — contrat API-first.
// Chaque fonction exportée ici est une capacité appelable par l'UI ET, à terme,
// par Jarvis. Aujourd'hui : mock en mémoire. Demain : appels API vers le back.

import type { Action, Lead, Quota, Stage, LeadDetail, Conversation, Visitor, Sequence, SequenceStep, AgentConfig, KnowledgeBlock, UsageSummary, Diagnostic, Workspace, QualityPassResult, SourcingData, SourcedCompany, ResolvedContact, SignalHit } from '../../types/prospector'
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

function email(f: string, l: string, c: string) { return `${f}.${l}@${c.toLowerCase().replace(/[^a-z0-9]/g, '')}.com` }

// Plateforme vierge : aucune fausse donnée. Les leads se créent via
// sourcing / ajout manuel / import CSV.
const LEADS: Record<string, Lead> = {}

let ACTIONS: Action[] = []

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

export const PERSONAS = ['Founder/CEO', 'Sales', 'Marketing', 'Ops', 'Autre']

export function personaFromTitle(title: string): string {
  const t = title.toLowerCase()
  if (/founder|ceo|co-?founder|président|president/.test(t)) return 'Founder/CEO'
  if (/sales|commercial|revenue|cro|account|sdr|business dev/.test(t)) return 'Sales'
  if (/marketing|growth|cmo|demand|brand/.test(t)) return 'Marketing'
  if (/ops|operations|coo|chief of staff/.test(t)) return 'Ops'
  return 'Autre'
}

// Persistance (Supabase via API). Le store mémoire reste la source de travail,
// hydraté depuis le serveur et écrit en write-through à chaque création/màj.
async function persistLead(lead: Lead) {
  try { await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead }) }) } catch { /* offline → mémoire */ }
}
let leadsHydrated: Promise<void> | null = null
async function hydrateLeads(): Promise<void> {
  if (leadsHydrated) return leadsHydrated
  leadsHydrated = (async () => {
    try {
      const d = await fetch('/api/leads').then((r) => r.json())
      for (const l of (d.leads || [])) if (l?.id) LEADS[l.id] = l
    } catch { /* garde la mémoire */ }
  })()
  return leadsHydrated
}

export async function getLeads(): Promise<Lead[]> {
  await hydrateLeads()
  return Object.values(LEADS).map((l) => ({ ...l, persona: personaFromTitle(l.title) }))
}

// Magasin générique cloisonné (séquences, tâches, conversations) via /api/store.
async function storeList<T = any>(kind: string): Promise<T[]> {
  try { const d = await fetch(`/api/store?kind=${kind}`).then((r) => r.json()); return d.items || [] } catch { return [] }
}
async function storeSave(kind: string, item: any) {
  try { await fetch('/api/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, item }) }) } catch { /* mémoire */ }
}
async function storeDelete(kind: string, id: string) {
  try { await fetch('/api/store', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, id }) }) } catch { /* mémoire */ }
}

// Enrichissement (mock — au câblage : Kaspr pour email/tél).
export function enrichEmails(ids?: string[]) {
  const targets = ids ? ids.map((i) => LEADS[i]).filter(Boolean) : Object.values(LEADS)
  targets.forEach((l) => { if (!l.email) { l.email = email(l.firstName.toLowerCase(), l.lastName.toLowerCase(), l.company); void persistLead(l) } })
  return delay(Object.values(LEADS))
}

export function enrichAll(ids?: string[]) {
  const targets = ids ? ids.map((i) => LEADS[i]).filter(Boolean) : Object.values(LEADS)
  targets.forEach((l) => {
    if (!l.email) l.email = email(l.firstName.toLowerCase(), l.lastName.toLowerCase(), l.company)
    if (!l.phone) l.phone = '+33 6 00 00 00 00'
    void persistLead(l)
  })
  return delay(Object.values(LEADS))
}

export function setLeadStatus(id: string, status: Lead['status']) {
  const l = LEADS[id]
  if (l) { l.status = status; void persistLead(l) }
  return delay(l)
}

export function setLeadStage(id: string, stage: Stage) {
  const l = LEADS[id]
  if (l) { l.stage = stage; void persistLead(l) }
  return delay(l)
}

export function enrollInSequence(id: string) {
  const l = LEADS[id]
  if (l && (l.stage === 'to_invite' || l.stage === 'invited' || l.stage === 'connected')) l.stage = 'in_sequence'
  return delay(l)
}

// Enrôle UN contact et persiste (survit au reload).
export async function enrollLead(id: string): Promise<Lead | undefined> {
  const l = LEADS[id]
  if (!l) return undefined
  if (l.stage === 'to_invite' || l.stage === 'invited' || l.stage === 'connected') { l.stage = 'in_sequence'; await persistLead(l) }
  return l
}

// Promeut le dirigeant (data.gouv, réel) d'un compte en CONTACT invitable.
// Ne crée rien s'il n'y a pas de dirigeant renseigné (aucune invention).
export async function promoteDirigeant(accountId: string): Promise<Lead | undefined> {
  const acc = LEADS[accountId]
  if (!acc || !acc.dirigeant) return undefined
  const [firstName, ...rest] = acc.dirigeant.split(' ')
  const lead: Lead = {
    id: newLeadId(), kind: 'contact', firstName: firstName || acc.dirigeant, lastName: rest.join(' '),
    title: 'Dirigeant', company: acc.company, persona: 'Founder/CEO',
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren: acc.siren, signal: acc.signal, icebreaker: acc.icebreaker,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Charge la fiche compte détaillée (dirigeants, CA, effectif) depuis data.gouv.
export interface AccountDetail { found: boolean; dirigeants: { name: string; role?: string; type: string }[]; finances?: { year: string; ca?: number; resultat?: number }; effectif?: string; city?: string; address?: string; website?: string; naf?: string; active?: boolean }
export async function getAccountDetail(siren?: string): Promise<AccountDetail | null> {
  if (!siren) return null
  try { return await fetch(`/api/company/detail?siren=${siren}`).then((r) => r.json()) } catch { return null }
}

// Enrôle TOUT un compte : fan-out en N actions INDIVIDUELLES (une par personne),
// jamais un envoi groupé. C'est le raccourci UI « sélectionner le compte ».
export async function enrollAccount(ids: string[]): Promise<{ enrolled: number }> {
  let enrolled = 0
  for (const id of ids) { const l = await enrollLead(id); if (l) enrolled++ }
  return { enrolled }
}

const LEAD_TAGS: Record<string, string[]> = {
  l1: ['top-active'], l4: ['founder', 'new-role'], l7: ['top-active', 'warm-intro'],
  l10: ['new-role'], l12: ['founder'], l13: ['top-active'],
}
const refreshedDossiers = new Set<string>()

const NEXT_ACTION: Record<Stage, { label: string; when: string } | null> = {
  to_invite: { label: 'Visite de profil', when: 'aujourd\'hui' },
  invited: { label: 'En attente d\'acceptation', when: '—' },
  connected: { label: 'Premier message', when: 'demain' },
  in_sequence: { label: 'Relance', when: 'J+4' },
  responded: { label: 'Réponse à traiter', when: 'maintenant' },
  meeting: { label: 'RDV planifié', when: 'à venir' },
  closed: null,
}

const SECTORS = ['SaaS B2B', 'Fintech', 'IA / ML', 'Cybersécurité', 'MarTech']
const BAND: Record<Lead['temperature'], 'HOT' | 'WARM' | 'COLD'> = { hot: 'HOT', warm: 'WARM', cold: 'COLD' }

// Fiche neutre pour un lead non enrichi : on n'invente RIEN.
function emptyDetail(lead: Lead): LeadDetail {
  return {
    tags: LEAD_TAGS[lead.id] ?? [],
    nextAction: NEXT_ACTION[lead.stage],
    lead,
    headline: `${lead.title} · ${lead.company}`,
    connectionDegree: '—',
    premium: false,
    openProfile: false,
    linkedinUrl: lead.linkedinUrl || '',
    scoring: { fit: 0, intent: 0, timing: 0, segment: '—', band: 'COLD', confidence: 'low', edgeCase: false,
      rationale: 'Lead non encore scoré. Lance l\'enrichissement pour analyser le signal et générer le dossier.', aiAdjustment: 0 },
    company: {
      name: lead.company, size: lead.effectif || '—', location: lead.city || '—',
      website: lead.website || '',
      sector: lead.naf || '—', funding: '—',
      description: lead.siren
        ? `Entreprise vérifiée data.gouv — SIREN ${lead.siren}${lead.active === false ? ' (radiée)' : ' (active)'}${lead.dirigeant ? ` · dirigeant : ${lead.dirigeant}` : ''}.`
        : 'Informations entreprise à enrichir (clique « Vérifier l\'entreprise »).',
    },
    dossier: {
      status: 'faible', ageLabel: 'à enrichir', ageDays: 0, stale: false,
      mecanisme: 'À enrichir',
      accrochePivot: 'À définir après enrichissement.',
      pourquoiMaintenant: 'Aucun signal vérifié pour l\'instant.',
      preuves: [], aIntegrer: [],
      aEviter: ['Promettre un ROI chiffré', 'Flatter une réalisation non mentionnée', 'Citer des outils concurrents non évoqués'],
      questionAPoser: 'À définir selon le contexte du lead.',
      objectifReponse: 'Ouvrir une conversation, pas vendre.',
      canalRecommande: 'linkedin_message',
      canalRationale: 'Canal par défaut. À affiner selon les canaux connectés.',
      reserves: ['Lead saisi manuellement / non enrichi — données à recouper.'],
    },
    notes: '',
    interactions: [],
  }
}

function buildDetail(lead: Lead): LeadDetail {
  if (!lead.score) return emptyDetail(lead)
  const seed = lead.id.charCodeAt(1) || 0
  const sector = SECTORS[seed % SECTORS.length]
  const fit = Math.min(40, Math.round(lead.score * 0.45))
  const intent = Math.min(40, Math.round(lead.score * 0.35))
  const timing = Math.max(0, Math.min(20, lead.score - fit - intent))
  const ageDays = refreshedDossiers.has(lead.id) ? 1 : (seed * 13) % 60
  const stale = ageDays > 30

  return {
    tags: LEAD_TAGS[lead.id] ?? [],
    nextAction: NEXT_ACTION[lead.stage],
    lead,
    headline: `${lead.title} · ${lead.company}`,
    connectionDegree: seed % 2 === 0 ? '2e degré' : '1er degré',
    premium: lead.score > 75,
    openProfile: seed % 3 === 0,
    linkedinUrl: lead.linkedinUrl || '',
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
      ageLabel: ageDays <= 1 ? 'à l\'instant' : `il y a ${ageDays} j`,
      ageDays,
      stale,
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

// Supprime un lead (mémoire + Supabase).
export async function deleteLead(id: string): Promise<void> {
  delete LEADS[id]
  try { await fetch('/api/leads', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }) } catch { /* mémoire */ }
}

// Vérifie l'entreprise du lead via data.gouv → SIREN + actif + dirigeant (gratuit, sans token).
export async function verifyLeadCompany(id: string): Promise<{ found: boolean; active?: boolean; dirigeant?: string } | undefined> {
  const l = LEADS[id]
  if (!l || !l.company || l.company === '—') return { found: false }
  try {
    const v = await fetch(`/api/company/verify?name=${encodeURIComponent(l.company)}`).then((r) => r.json())
    if (v.found) {
      l.company = v.name || l.company; l.siren = v.siren; l.active = v.active; l.naf = v.naf; l.city = v.city; l.dirigeant = v.dirigeant
      if (v.effectif) l.effectif = v.effectif
      if (v.website) l.website = v.website
      // Pour un COMPTE, on NE fabrique PAS de personne : le dirigeant reste une
      // métadonnée. Il devient contact seulement via « + Dirigeant en contact ».
      if (!isAccountLead(l)) {
        const noPerson = !l.firstName || l.firstName === 'Prénom' || l.firstName === l.company
        if (noPerson && v.dirigeant) { const [fn, ...rest] = v.dirigeant.split(' '); l.firstName = fn; l.lastName = rest.join(' '); if (l.title === 'À qualifier') l.title = 'Dirigeant' }
      }
      await persistLead(l)
    }
    return { found: !!v.found, active: v.active, dirigeant: v.dirigeant }
  } catch { return { found: false } }
}

// Met à jour les champs éditables d'un lead (nom, titre, entreprise, email…).
export async function updateLead(id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
  const l = LEADS[id]
  if (!l) return undefined
  Object.assign(l, patch)
  await persistLead(l)
  return l
}

export async function getLeadDetail(id: string): Promise<LeadDetail | undefined> {
  if (!LEADS[id]) await hydrateLeads() // fiche ouverte après reload → recharge
  const lead = LEADS[id]
  return lead ? buildDetail(lead) : undefined
}

export function addLeadTag(id: string, tag: string) {
  const t = tag.trim()
  if (!t) return delay(null)
  const cur = LEAD_TAGS[id] ?? (LEAD_TAGS[id] = [])
  if (!cur.includes(t)) cur.push(t)
  return delay(cur)
}

export function removeLeadTag(id: string, tag: string) {
  LEAD_TAGS[id] = (LEAD_TAGS[id] ?? []).filter((x) => x !== tag)
  return delay(LEAD_TAGS[id])
}

export function refreshDossier(id: string) {
  refreshedDossiers.add(id)
  return delay(true)
}

export function getConversations(): Promise<Conversation[]> {
  return delay([])
}

let SEQUENCES: Sequence[] = []

let seqCounter = 100

export async function getSequences(): Promise<Sequence[]> {
  SEQUENCES = await storeList<Sequence>('sequence')
  return SEQUENCES
}

export function nextSequenceId(): string {
  return 's_' + Math.random().toString(36).slice(2, 9)
}

export async function saveSequence(seq: Sequence) {
  const i = SEQUENCES.findIndex((s) => s.id === seq.id)
  if (i >= 0) SEQUENCES[i] = seq
  else SEQUENCES = [...SEQUENCES, seq]
  await storeSave('sequence', seq)
  return seq
}

export async function deleteSequence(id: string) {
  SEQUENCES = SEQUENCES.filter((s) => s.id !== id)
  await storeDelete('sequence', id)
  return true
}

export async function enrollLeadsInSequence(id: string, count: number) {
  const s = SEQUENCES.find((x) => x.id === id)
  if (s) { s.enrolled += count; await storeSave('sequence', s) }
  return s
}

export interface ChannelConfig {
  // Email (Unipile Mail — Gmail/Outlook/IMAP)
  provider?: string       // 'Gmail' | 'Outlook' | 'IMAP'
  fromEmail?: string
  fromName?: string
  signature?: string
  // WhatsApp (Unipile WhatsApp — via QR sur le mobile)
  phone?: string          // numéro E.164, ex +33 6 12 34 56 78
  displayName?: string
  // LinkedIn
  account?: string
}

export interface Channel {
  key: 'linkedin' | 'email' | 'whatsapp'
  label: string
  connected: boolean
  detail: string
  config: ChannelConfig
}

// Fil de conversation unifié (tous canaux) rattaché à un lead.
export interface ThreadMessage { id: string; from: 'them' | 'us'; text: string; time: string; channel: 'linkedin' | 'email' | 'whatsapp' }
// Conversation persistée par lead : un item store kind=thread, id=leadId, data={ id, messages }.
interface ThreadDoc { id: string; messages: ThreadMessage[] }
const THREADS: Record<string, ThreadMessage[]> = {}
let threadSeq = 100

export async function getLeadThread(leadId: string): Promise<ThreadMessage[]> {
  const docs = await storeList<ThreadDoc>('thread')
  docs.forEach((d) => { THREADS[d.id] = d.messages || [] })
  return THREADS[leadId] ? [...THREADS[leadId]] : []
}

// Envoi d'un message sur un canal (mock → prêt pour Unipile). Persiste le fil.
export async function sendMessage(leadId: string, channel: ThreadMessage['channel'], text: string): Promise<ThreadMessage[]> {
  if (!THREADS[leadId]) THREADS[leadId] = []
  THREADS[leadId].push({ id: `m${++threadSeq}`, from: 'us', text: text.trim(), time: nextSlotLabel(), channel })
  await storeSave('thread', { id: leadId, messages: THREADS[leadId] })
  return [...THREADS[leadId]]
}

const CHANNELS: Channel[] = [
  { key: 'linkedin', label: 'LinkedIn', connected: true, detail: 'Connecté via Unipile', config: { account: 'Ludwig Graham' } },
  { key: 'email', label: 'Email', connected: false, detail: 'À connecter (Unipile Mail)', config: {} },
  { key: 'whatsapp', label: 'WhatsApp', connected: false, detail: 'À connecter (Unipile WhatsApp)', config: {} },
]

export function getChannels(): Promise<Channel[]> {
  return delay(CHANNELS.map((c) => ({ ...c, config: { ...c.config } })))
}

export function toggleChannel(key: Channel['key']) {
  const c = CHANNELS.find((x) => x.key === key)
  if (c) c.connected = !c.connected
  return delay(CHANNELS)
}

// Connecte un canal avec sa config (au câblage : Unipile hosted-auth / QR WhatsApp).
export function connectChannel(key: Channel['key'], config: ChannelConfig) {
  const c = CHANNELS.find((x) => x.key === key)
  if (!c) return delay(CHANNELS)
  c.config = { ...c.config, ...config }
  c.connected = true
  if (key === 'email' && config.fromEmail) c.detail = `Connecté · ${config.fromEmail}`
  if (key === 'whatsapp' && config.phone) c.detail = `Connecté · ${config.phone}`
  if (key === 'linkedin' && config.account) c.detail = `Connecté · ${config.account}`
  return delay(CHANNELS.map((x) => ({ ...x, config: { ...x.config } })))
}

export function disconnectChannel(key: Channel['key']) {
  const c = CHANNELS.find((x) => x.key === key)
  if (c) { c.connected = false; c.detail = `À connecter (Unipile ${c.label})` }
  return delay(CHANNELS.map((x) => ({ ...x, config: { ...x.config } })))
}

export function generateMessage(leadId: string, variant: 'principal' | 'directe' | 'douce'): Promise<string> {
  const lead = LEADS[leadId]
  if (!lead) return delay('')
  const d = buildDetail(lead).dossier
  const prenom = lead.firstName
  // Si un icebreaker issu du signal existe, il sert d'accroche (plus contextuel).
  const accroche = lead.icebreaker || d.accrochePivot
  if (variant === 'directe') {
    return delay(`${prenom}, ${accroche} On aide des équipes comme ${lead.company} à structurer ça. ${d.questionAPoser}`)
  }
  if (variant === 'douce') {
    return delay(`Bonjour ${prenom}, je suis votre parcours chez ${lead.company} avec intérêt. Sans agenda commercial : ${d.questionAPoser}`)
  }
  return delay(`${prenom}, ${accroche}\n\n${d.questionAPoser}`)
}

// Rédige un message à partir de notes en vrac fournies par l'utilisateur.
// MOCK → au câblage, Claude structure les notes en respectant le Référentiel.
export function generateFromNotes(leadId: string, notes: string): Promise<string> {
  const lead = LEADS[leadId]
  const prenom = lead ? lead.firstName : ''
  const n = notes.trim()
  if (!n) return delay('')
  // Ébauche : on repart des notes comme accroche, on garde un ton d'ouverture.
  return delay(`${prenom ? prenom + ', ' : ''}${n.charAt(0).toLowerCase() + n.slice(1)}\n\nSeriez-vous ouvert·e à en échanger quelques minutes cette semaine ?`)
}

export interface Referentiel {
  forbidden: string[]
  preferred: { avoid: string; use: string }[]
  offer: string
}

const REFERENTIEL: Referentiel = {
  forbidden: [
    'copilote IA', 'Replace your SDRs', 'Control Tower', 'Revenue OS',
    "j'espère ne pas vous déranger", 'auriez-vous 2 minutes',
    "dans le cadre d'un appel de prospection", 'licence perpétuelle',
    '10x your pipeline', "70-80% d'échec",
  ],
  preferred: [
    { avoid: 'licence perpétuelle', use: 'licence à durée illimitée tant que Smart.AI exploite le service' },
    { avoid: 'copilote IA', use: 'agent IA sur-mesure' },
  ],
  offer: "Smart.AI — agence d'acquisition IA. Agents IA et automatisations sur-mesure pour équipes sales/marketing. Design partners ESN et cabinets de conseil.",
}

export function getReferentiel(): Promise<Referentiel> {
  return delay(REFERENTIEL)
}

export function addForbiddenTerm(t: string) {
  const v = t.trim()
  if (v && !REFERENTIEL.forbidden.some((f) => f.toLowerCase() === v.toLowerCase())) REFERENTIEL.forbidden.push(v)
  return delay(REFERENTIEL.forbidden)
}

export function removeForbiddenTerm(t: string) {
  REFERENTIEL.forbidden = REFERENTIEL.forbidden.filter((x) => x !== t)
  return delay(REFERENTIEL.forbidden)
}

// Détection synchrone des deal-killers dans un texte (utilisé en direct dans l'UI).
export function detectDealKillers(text: string): string[] {
  const low = (text || '').toLowerCase()
  return REFERENTIEL.forbidden.filter((f) => low.includes(f.toLowerCase()))
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

export function getUsage(period: Period = 'month'): Promise<UsageSummary> {
  const f = period === 'week' ? 0.25 : period === 'month' ? 1 : period === 'quarter' ? 3 : 12
  const r = (n: number) => Math.round(n * f)
  const c = (n: number) => Math.round(n * f * 100) / 100
  return delay({
    calls: r(142), tokensIn: r(1_620_000), tokensOut: r(22_400), cost: c(2.1), cached: r(67_000),
    byAgent: [
      { agent: 'Enrichissement', calls: r(62), tokens: r(1_146_000), cost: c(1.15) },
      { agent: 'Scoring', calls: r(48), tokens: r(236_000), cost: c(0.32) },
      { agent: "Dossier d'attaque", calls: r(18), tokens: r(180_000), cost: c(0.44) },
      { agent: 'Rédaction', calls: r(10), tokens: r(62_000), cost: c(0.15) },
      { agent: 'Conversationnel', calls: r(4), tokens: r(18_000), cost: c(0.04) },
    ],
    byModel: [
      { model: 'Claude Haiku 4.5', calls: r(96), tokens: r(472_000), cost: c(0.48) },
      { model: 'Claude Sonnet 5', calls: r(32), tokens: r(260_000), cost: c(0.62) },
      { model: 'Perplexity sonar-pro', calls: r(14), tokens: r(910_000), cost: c(1.00) },
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

export function getSourcing(_period: Period = 'month'): Promise<SourcingData> {
  return delay({ totalSourced: 0, qualificationRate: 0, bySector: [], runs: [], incoming: [] })
}

const WORKSPACES: Workspace[] = []

export function getWorkspaces(): Promise<Workspace[]> {
  return delay([...WORKSPACES])
}

// ── Notifications ──
export interface Notification { id: string; type: 'reply' | 'meeting' | 'task' | 'system'; text: string; when: string; unread: boolean; href?: string }
const NOTIFS: Notification[] = []
export function getNotifications(): Promise<Notification[]> { return delay([...NOTIFS]) }
export function markNotificationsRead(): Promise<Notification[]> { NOTIFS.forEach((n) => (n.unread = false)); return delay([...NOTIFS]) }

// ── Planificateur de tâches / rappels ──
export interface Task { id: string; title: string; due: string; done: boolean; leadId?: string; leadName?: string; channel?: 'linkedin' | 'email' | 'whatsapp' | null }
let TASKS: Task[] = []
export async function getTasks(): Promise<Task[]> {
  TASKS = await storeList<Task>('task')
  return [...TASKS]
}
export async function addTask(input: { title: string; due: string; leadId?: string; leadName?: string; channel?: Task['channel'] }): Promise<Task> {
  const t: Task = { id: `tk_${Math.random().toString(36).slice(2, 9)}`, title: input.title.trim() || 'Tâche', due: input.due || "Aujourd'hui", done: false, leadId: input.leadId, leadName: input.leadName, channel: input.channel ?? null }
  TASKS.unshift(t)
  await storeSave('task', t)
  return t
}
export async function toggleTask(id: string): Promise<Task[]> {
  const t = TASKS.find((x) => x.id === id); if (t) { t.done = !t.done; await storeSave('task', t) }
  return [...TASKS]
}
export async function deleteTask(id: string): Promise<Task[]> {
  const i = TASKS.findIndex((x) => x.id === id); if (i >= 0) TASKS.splice(i, 1)
  await storeDelete('task', id)
  return [...TASKS]
}

// Logs IA — observabilité par appel LLM (provider, modèle, tokens, coût, prompt).
export interface AiLog {
  id: string; when: string; agent: string; provider: string; model: string
  tokensIn: number; tokensOut: number; cost: number; systemPrompt: string; input: string; output: string
}
export const AI_AGENTS = ['Prospection M1', 'Prospection M2', 'Scoring', 'Enrichissement', 'Rédaction', 'Cockpit IA']
export function getAiLogs(): Promise<AiLog[]> {
  return delay([])
}

// Journal d'activité (admin) — au câblage : events Supabase/cron/connecteurs.
export interface LogEntry { id: string; level: 'info' | 'warn' | 'error'; source: string; message: string; when: string }
export function getLogs(): Promise<LogEntry[]> {
  return delay([])
}

// Crée un espace client avec un ID slugifié stable (ex: "ws_smart_ai").
export function createWorkspace(name: string, plan = 'Starter'): Promise<Workspace> {
  const base = 'ws_' + name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
  let id = base || 'ws_client'
  let n = 2
  while (WORKSPACES.some((w) => w.id === id)) { id = `${base}_${n++}` }
  const ws: Workspace = { id, name: name.trim() || 'Nouveau client', leads: 0, users: 1, plan }
  WORKSPACES.unshift(ws)
  return delay(ws)
}

export function regenerateReply(leadId: string, instruction: string): Promise<string> {
  const lead = LEADS[leadId]
  if (!lead) return delay('')
  const d = buildDetail(lead).dossier
  const p = lead.firstName
  const ins = instruction.toLowerCase()
  if (ins.includes('court')) return delay(`${p}, ${d.questionAPoser}`)
  if (ins.includes('direct')) return delay(`${p}, concrètement : ${d.questionAPoser} On peut caler 15 min ?`)
  if (ins.includes('commercial') || ins.includes('doux') || ins.includes('douce')) return delay(`Sans rien vous vendre ${p} — ${d.questionAPoser}`)
  if (ins.includes('angle')) return delay(`${p}, autre angle : ${d.accrochePivot}`)
  if (instruction.trim()) return delay(`${p}, ${d.questionAPoser}`)
  return delay(`${p}, ${d.accrochePivot} ${d.questionAPoser}`)
}

export function getVisitors(): Promise<Visitor[]> {
  return delay([])
}

export function getDashboard(period: Period = 'week'): Promise<DashboardData> {
  const pendingActions = ACTIONS.filter((a) => a.status === 'pending').length
  const f = period === 'week' ? 1 : period === 'month' ? 4 : period === 'quarter' ? 12 : 52
  return delay({
    period,
    pendingActions,
    kpis: { invitationsSent: 0, acceptanceRate: 0, replies: 0, meetings: 0, iaCostWeek: 0 },
    details: { invitations: [], acceptance: [], replies: [], meetings: [] },
    funnel: [
      { stage: 'to_invite', count: 0 }, { stage: 'invited', count: 0 }, { stage: 'connected', count: 0 },
      { stage: 'in_sequence', count: 0 }, { stage: 'responded', count: 0 }, { stage: 'meeting', count: 0 }, { stage: 'closed', count: 0 },
    ],
    activity: [],
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

// ─────────────────────────────────────────────────────────────────────────
// Sourcing → Pipeline → Résolution de contacts
// Capabilities nommées, appelables par l'UI aujourd'hui et par Jarvis demain.
// Étape 1 (data.gouv) donne des ENTREPRISES. Étape 3 résout les CONTACTS.
// ─────────────────────────────────────────────────────────────────────────

// Personas ciblés à résoudre pour chaque entreprise (ICP Smart.AI).
export const PERSONA_TARGETS = ['Founder/CEO', 'Head of Sales', 'Head of Marketing']

let sourcedSeq = 0
// SIREN → id de la carte « entreprise à enrichir » placeholder dans le pipe.
const importedPlaceholders: Record<string, string> = {}

// Un lead est un COMPTE (entreprise sans personne) si kind='account' OU si aucun
// nom de personne n'est renseigné. Sert de garde-fou même pour d'anciens leads.
export function isAccountLead(l: { kind?: string; firstName?: string; lastName?: string }): boolean {
  if (l.kind === 'account') return true
  if (l.kind === 'contact') return false
  return !(l.firstName || '').trim() && !(l.lastName || '').trim()
}

// Ajoute un CONTACT (personne) rattaché à un compte → il entre, lui, dans « à inviter ».
export interface AccountContactInput { firstName?: string; lastName?: string; title?: string; persona?: string; email?: string; linkedinUrl?: string }
export async function addAccountContact(accountId: string, input: AccountContactInput): Promise<Lead | undefined> {
  const acc = LEADS[accountId]
  if (!acc) return undefined
  const fn = (input.firstName || '').trim()
  const ln = (input.lastName || '').trim()
  if (!fn && !ln) return undefined // pas de personne → on ne crée rien
  const lead: Lead = {
    id: newLeadId(), kind: 'contact', firstName: fn || ln, lastName: fn ? ln : '',
    title: (input.title || '').trim() || input.persona || 'À qualifier',
    company: acc.company, persona: input.persona,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
    email: input.email?.trim() || null, phone: null,
    linkedinUrl: input.linkedinUrl?.trim() || undefined,
    siren: acc.siren, signal: acc.signal, icebreaker: acc.icebreaker,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Importe des entreprises sourcées dans le pipeline comme cartes « à enrichir »
// (aucun contact encore : la résolution se déclenche ensuite, à la demande).
export async function importCompaniesToPipeline(companies: SourcedCompany[]) {
  const created: Lead[] = []
  companies.forEach((c) => {
    if (importedPlaceholders[c.id]) return
    const id = newLeadId()
    importedPlaceholders[c.id] = id
    // Un import = un COMPTE (entreprise), PAS un contact. Aucun nom de personne
    // n'est fabriqué : le compte reste hors « à inviter » tant qu'aucune personne
    // n'est résolue. Auto-remplissage data.gouv : uniquement les champs réels.
    const siren = /^\d{9}$/.test(c.id) ? c.id : undefined
    const lead: Lead = {
      id, kind: 'account', firstName: '', lastName: '',
      title: '', company: c.name,
      score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
      siren,
      active: true,
      naf: c.naf || undefined,
      city: c.city || undefined,
      dirigeant: c.dirigeant || undefined,
      effectif: c.effectif || undefined,
      website: c.website || undefined,
    }
    LEADS[id] = lead; created.push(lead)
  })
  if (created.length) { try { await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leads: created }) }) } catch { /* mémoire */ } }
  return { added: created.length, skipped: companies.length - created.length }
}

// Importe une entreprise détectée par SIGNAL, en attachant le signal + l'icebreaker
// au lead → l'accroche devient actionnable (fiche + pré-remplissage 1er message).
export async function importSignalToPipeline(hit: SignalHit) {
  const siren = hit.siren || `sig-${hit.company}`
  if (importedPlaceholders[siren]) return { added: 0, id: importedPlaceholders[siren] }
  const id = newLeadId()
  importedPlaceholders[siren] = id
  const lead: Lead = {
    id, kind: 'account', firstName: '', lastName: '', title: '', company: hit.company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren: hit.siren, city: hit.city, active: hit.verified ? true : undefined,
    signal: hit.detail, icebreaker: hit.icebreaker,
  }
  LEADS[id] = lead
  await persistLead(lead)
  return { added: 1, id }
}

// Ajout manuel d'un lead (saisie ou depuis une URL LinkedIn).
export interface NewLeadInput { firstName?: string; lastName?: string; title?: string; company?: string; email?: string; phone?: string; linkedinUrl?: string }
// Id unique et stable (survit aux rechargements — pas de collision de compteur).
function newLeadId(): string { return `ld_${Math.random().toString(36).slice(2, 10)}` }

export async function addLead(input: NewLeadInput): Promise<Lead> {
  const fn = (input.firstName || '').trim()
  const ln = (input.lastName || '').trim()
  // Aucune personne nommée → c'est un COMPTE (reste hors « à inviter »).
  const asAccount = !fn && !ln
  const lead: Lead = {
    id: newLeadId(), kind: asAccount ? 'account' : 'contact',
    firstName: asAccount ? '' : (fn || 'Prénom'),
    lastName: ln,
    title: asAccount ? '' : ((input.title || '').trim() || 'À qualifier'),
    company: (input.company || '').trim() || '—',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    linkedinUrl: (input as any).linkedinUrl?.trim() || undefined,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Import CSV : lignes "prénom,nom,titre,entreprise,email" (en-tête optionnel).
export async function addLeadsFromCsv(csv: string): Promise<{ added: number }> {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const created: Lead[] = []
  lines.forEach((line, i) => {
    const cols = line.split(/[;,\t]/).map((c) => c.trim())
    if (i === 0 && /pr[ée]nom|first|nom|email|entreprise|company/i.test(line)) return // en-tête
    if (!cols[0] && !cols[3]) return
    const lead: Lead = {
      id: newLeadId(), kind: 'contact', firstName: cols[0] || 'Prénom', lastName: cols[1] || '', title: cols[2] || 'À qualifier',
      company: cols[3] || '—', score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
      email: cols[4] || null, phone: cols[5] || null,
    }
    LEADS[lead.id] = lead; created.push(lead)
  })
  if (created.length) {
    try { await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leads: created }) }) } catch { /* mémoire */ }
  }
  return { added: created.length }
}

// SIREN déjà présents dans le pipe (placeholders) → l'UI peut les exclure du sourcing.
export function getImportedSirens(): Promise<string[]> {
  return delay(Object.keys(importedPlaceholders))
}

// Transforme des contacts résolus en vraies cartes contact dans le pipe.
// Remplace la carte placeholder « à enrichir » de l'entreprise si elle existe.
export async function addContactsToPipeline(company: SourcedCompany, contacts: ResolvedContact[]) {
  // Le COMPTE (placeholder) est CONSERVÉ : il porte les métadonnées entreprise.
  // Les contacts s'y rattachent (même `company`) et entrent, eux, dans « à inviter ».
  const placeholder = importedPlaceholders[company.id]
  const inheritedSignal = placeholder ? LEADS[placeholder]?.signal : undefined
  const inheritedIce = placeholder ? LEADS[placeholder]?.icebreaker : undefined

  const created: Lead[] = []
  contacts.forEach((ct) => {
    const [firstName, ...rest] = ct.name.split(' ')
    const lead: Lead = {
      id: newLeadId(), kind: 'contact', firstName: firstName || ct.name, lastName: rest.join(' '),
      title: ct.title || ct.persona, company: company.name, persona: ct.persona,
      score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
      email: ct.email || null, phone: null, linkedinUrl: ct.linkedinUrl, signal: inheritedSignal, icebreaker: inheritedIce,
    }
    LEADS[lead.id] = lead; created.push(lead)
  })
  if (created.length) { try { await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leads: created }) }) } catch { /* mémoire */ } }
  return { added: created.length }
}

// Orchestration : compte → personas (Unipile/mock) → contacts créés → séquence + enrôlement.
// C'est le workflow « je charge un compte, je récupère mes personas et je lance la séquence ».
const ACCOUNT_SEQ_TEMPLATE = (): SequenceStep[] => [
  { id: 'st1', channel: 'linkedin', type: 'visit', condition: 'always', delayDays: 0 },
  { id: 'st2', channel: 'linkedin', type: 'invitation', condition: 'always', delayDays: 1 },
  { id: 'st3', channel: 'linkedin', type: 'message', condition: 'if_connected', delayDays: 2 },
  { id: 'st4', channel: 'linkedin', type: 'relance', condition: 'if_no_response', delayDays: 4 },
  { id: 'st5', channel: 'email', type: 'relance', condition: 'if_no_response', delayDays: 7 },
]

export async function generateAccountSequence(
  company: { name: string; siren?: string; city?: string },
  personas: string[] = PERSONA_TARGETS,
): Promise<{ sequenceId: string; contacts: number; mockPersonas: boolean; connected: boolean }> {
  const comp: SourcedCompany = {
    id: company.siren || `acc-${company.name}`, name: company.name, naf: '', sector: '',
    effectif: '', city: company.city || '', dep: '', dirigeant: (company as any).dirigeant, signals: [],
  }
  // 1) Personas via Unipile si connecté — sinon SEUL le dirigeant réel (data.gouv). Aucun contact inventé.
  const res = await resolveOne(comp, personas)
  // 2) Crée les contacts dans le pipe (persistés + cloisonnés)
  await addContactsToPipeline(comp, res.contacts)
  // 3) Crée la séquence + enrôle
  const seq: Sequence = {
    id: nextSequenceId(),
    name: `Compte ${company.name} · personas`,
    status: 'active',
    enrolled: res.contacts.length,
    responseRate: 0,
    steps: ACCOUNT_SEQ_TEMPLATE(),
  }
  await saveSequence(seq)
  return { sequenceId: seq.id, contacts: res.contacts.length, mockPersonas: res.mock, connected: res.connected }
}

// Recherche de PERSONNES sur LinkedIn (Unipile, mock fallback).
export interface PersonHit { id: string; name: string; title: string; company: string; location: string; sector: string; linkedinUrl: string }
export async function searchPeople(filters: { role?: string; sector?: string; location?: string }): Promise<{ people: PersonHit[]; mock: boolean }> {
  const p = new URLSearchParams()
  if (filters.role) p.set('role', filters.role)
  if (filters.sector) p.set('sector', filters.sector)
  if (filters.location) p.set('location', filters.location)
  try { const d = await fetch(`/api/sourcing/people?${p.toString()}`).then((r) => r.json()); return { people: d.people || [], mock: d.connected === false } }
  catch { return { people: [], mock: true } }
}

export async function importPerson(hit: PersonHit): Promise<Lead> {
  const [firstName, ...rest] = hit.name.split(' ')
  const lead: Lead = {
    id: newLeadId(), kind: 'contact', firstName, lastName: rest.join(' '), title: hit.title, company: hit.company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    linkedinUrl: hit.linkedinUrl, city: hit.location,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Plafond du lot de résolution (garde-fou coût, comme l'enrichissement Kaspr).
export const CONTACT_BATCH_CAP = 20

export interface ContactResult { company: SourcedCompany; contacts: ResolvedContact[]; mock: boolean; connected: boolean }

// Résout les contacts d'UNE entreprise pour les personas demandés.
// Passe par /api/enrich/contacts → Pappers (dirigeants) + Unipile (personas),
// avec fallback mock tant que les clés ne sont pas configurées.
export async function findContactsForCompany(
  company: SourcedCompany,
  personas: string[] = PERSONA_TARGETS,
): Promise<ResolvedContact[]> {
  const r = await resolveOne(company, personas)
  return r.contacts
}

async function resolveOne(company: SourcedCompany, personas: string[]): Promise<ContactResult> {
  const params = new URLSearchParams({
    siren: company.id, company: company.name, personas: personas.join(','),
  })
  if (company.dirigeant) params.set('dirigeant', company.dirigeant)
  try {
    const res = await fetch(`/api/enrich/contacts?${params.toString()}`)
    const d = await res.json()
    return { company, contacts: d.contacts || [], mock: !!d.mock, connected: d.connected !== false }
  } catch {
    return { company, contacts: [], mock: false, connected: false }
  }
}

// Résout un LOT d'entreprises, plafonné à CONTACT_BATCH_CAP (défaut par l'UI :
// unité ; le lot est explicite et borné pour maîtriser le coût connecteur).
export async function findContactsForCompanies(
  companies: SourcedCompany[],
  personas: string[] = PERSONA_TARGETS,
): Promise<{ results: ContactResult[]; capped: boolean }> {
  const capped = companies.length > CONTACT_BATCH_CAP
  const batch = companies.slice(0, CONTACT_BATCH_CAP)
  const results = await Promise.all(batch.map((c) => resolveOne(c, personas)))
  return { results, capped }
}
