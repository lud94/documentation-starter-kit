// Capacités Prospector — contrat API-first.
// Chaque fonction exportée ici est une capacité appelable par l'UI ET, à terme,
// par Jarvis. Aujourd'hui : mock en mémoire. Demain : appels API vers le back.

import type { Action, Lead, Quota, Stage, LeadDetail, Conversation, Visitor, Sequence, SequenceStep, AgentConfig, KnowledgeBlock, UsageSummary, Diagnostic, Workspace, QualityPassResult, SourcingData, SourcedCompany, ResolvedContact, SignalHit } from '../../types/prospector'
import { ACTION_META, STATUS_META, STAGE_META } from '../../types/prospector'
import { isAccountLead, isContactLead } from './leadKind'
// ⚠️ TYPE CANONIQUE, PAS UNE COPIE. `Resolution` appartient à `datagouv.ts`,
// l'autorité qui PRODUIT ces quatre états. Le littéral était réécrit deux fois
// ici : deux copies d'une union divergent le jour où un cinquième état apparaît
// chez le producteur. Import de TYPE uniquement — effacé à la compilation, donc
// aucun cycle d'exécution possible.
import type { Resolution } from './datagouv'

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
  invitation: { type: 'invitation', used: 0, max: 18 },
  message: { type: 'message', used: 0, max: 25 },
  visit: { type: 'visit', used: 0, max: 80 },
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
export type WriteRejection = { id: string; reason: string }

// Dernier refus d'écriture observé, exposé aux écrans pour affichage. Un refus
// silencieux serait pire que l'ancien défaut : l'utilisateur croirait avoir
// enregistré.
let lastRejections: WriteRejection[] = []
export function takeWriteRejections(): WriteRejection[] { const r = lastRejections; lastRejections = []; return r }
export function rejectionLabel(reason: string): string {
  return reason === 'workspace_conflict' ? "refusé : appartient à un autre espace de travail"
    : reason === 'contention' ? 'écriture concurrente, à réessayer'
    : reason === 'env_blocked' ? "écritures suspendues (configuration d'environnement)"
    : "échec d'enregistrement"
}

async function persistLead(lead: Lead): Promise<boolean> {
  try {
    const r = await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead }) })
    const d = await r.json().catch(() => null)
    if (d?.rejected?.length) { lastRejections = lastRejections.concat(d.rejected); return false }
    return r.ok
  } catch { return false /* hors ligne → mémoire seule */ }
}

// Invalidation EXPLICITE du cache de leads. Aujourd'hui le changement d'espace
// provoque une navigation dure (components/Shell.tsx), qui détruit ce cache par
// effet de bord. On ne s'appuie pas sur cet effet : une navigation côté client
// le supprimerait sans que personne ne s'en aperçoive, et le cache d'un espace
// serait alors présenté dans un autre.
async function persistLeads(leads: Lead[]): Promise<number> {
  try {
    const r = await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leads }) })
    const d = await r.json().catch(() => null)
    if (d?.rejected?.length) lastRejections = lastRejections.concat(d.rejected)
    return d?.saved ?? 0
  } catch { return 0 }
}

export function invalidateLeads(): void {
  for (const k of Object.keys(LEADS)) delete LEADS[k]
  leadsHydrated = null
}
let leadsHydrated: Promise<void> | null = null
async function hydrateLeads(force = false): Promise<void> {
  if (leadsHydrated && !force) return leadsHydrated
  leadsHydrated = (async () => {
    try {
      const d = await fetch('/api/leads').then((r) => r.json())
      // force = re-synchronise avec le serveur (retire les leads supprimés ailleurs).
      if (force) for (const k of Object.keys(LEADS)) delete LEADS[k]
      for (const l of (d.leads || [])) if (l?.id) LEADS[l.id] = l
    } catch { /* garde la mémoire */ }
  })()
  return leadsHydrated
}

// force=true → rappel serveur (nouvel import via l'extension, MAJ ailleurs…).
export async function getLeads(force = false): Promise<Lead[]> {
  await hydrateLeads(force)
  return Object.values(LEADS).map((l) => ({ ...l, persona: personaFromTitle(l.title) }))
}

// Séquences contenant ce lead (pour l'afficher sur la fiche contact).
export async function getSequencesForLead(leadId: string): Promise<Sequence[]> {
  const seqs = await getSequences()
  return seqs.filter((s) => (s.leadIds || []).includes(leadId))
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
    siren: acc.siren, active: acc.active, naf: acc.naf, city: acc.city,
    effectif: acc.effectif, website: acc.website, summary: acc.summary,
    dirigeant: acc.dirigeant, signal: acc.signal, icebreaker: acc.icebreaker,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Corrige une mauvaise détection en 1 clic (gratuit, sans IA).
// Contact → Compte : on garde l'entreprise, on retire la personne.
export async function convertToAccount(id: string): Promise<Lead | undefined> {
  const l = LEADS[id]; if (!l) return undefined
  // Si l'entreprise est vide, on récupère l'ancien nom (nettoyé) comme raison sociale.
  if (!l.company || l.company === '—') {
    const guess = `${l.firstName} ${l.lastName}`.replace(/\b(siren|siret|rcs|tva|naf)\b/gi, '').replace(/\s+/g, ' ').trim()
    if (guess) l.company = guess
  }
  l.kind = 'account'; l.firstName = ''; l.lastName = ''; l.title = ''; l.persona = undefined; l.email = null; l.stage = 'to_invite'
  await persistLead(l); return l
}
// Compte → Contact : on nomme la personne (sinon on ne convertit pas).
export async function convertToContact(id: string, person: { firstName?: string; lastName?: string; title?: string }): Promise<Lead | undefined> {
  const l = LEADS[id]; if (!l) return undefined
  const fn = (person.firstName || '').trim(); const ln = (person.lastName || '').trim()
  if (!fn && !ln) return undefined
  l.kind = 'contact'; l.firstName = fn || ln; l.lastName = fn ? ln : ''; l.title = (person.title || '').trim() || 'À qualifier'
  await persistLead(l); return l
}

// Bascule un COMPTE en CONTACT en place (« C'est un contact »), et supprime donc
// le lead-compte (c'est le même lead qui devient une personne). Le nom vient du
// libellé importé (raison sociale) ou du dirigeant connu.
export async function flipToContact(id: string): Promise<Lead | undefined> {
  const l = LEADS[id]; if (!l) return undefined
  const src = (l.dirigeant || l.company || '').replace(/\b(siren|siret|rcs|tva|naf)\b/gi, '').replace(/\s+/g, ' ').trim()
  if (!src) return undefined
  const [firstName, ...rest] = src.split(/\s+/)
  l.kind = 'contact'; l.firstName = firstName; l.lastName = rest.join(' ')
  l.title = l.title || 'À qualifier'; l.stage = 'to_invite'
  await persistLead(l); return l
}

// Enrichit un compte via l'agent web (Claude seul) : site + résumé secteur/activité
// (ce que data.gouv ne donne pas). Persiste. Rien n'est deviné (champ vide sinon).
export async function enrichCompanyWebsite(accountId: string): Promise<{ website?: string; summary?: string; sector?: string; ca?: string; effectif?: string; mode: string }> {
  const acc = LEADS[accountId]
  if (!acc) return { mode: 'none' }
  const params = new URLSearchParams({ company: acc.company })
  if (acc.city) params.set('city', acc.city)
  if (acc.siren) params.set('siren', acc.siren)
  try {
    const r = await fetch(`/api/enrich/company-web?${params.toString()}`).then((x) => x.json())
    if (r.website) acc.website = r.website
    if (r.summary) acc.summary = r.summary
    if (r.ca && !acc.ca) acc.ca = r.ca
    if (r.effectif && !acc.effectif) acc.effectif = r.effectif
    if (r.website || r.summary || r.ca || r.effectif) await persistLead(acc)
    return { website: r.website, summary: r.summary, sector: r.sector, ca: r.ca, effectif: r.effectif, mode: r.mode }
  } catch { return { mode: 'error' } }
}

// Enregistre des notes de recherche externe (collées depuis Claude/ChatGPT/Perplexity).
export async function saveResearchNotes(leadId: string, text: string): Promise<void> {
  const l = LEADS[leadId]; if (!l) return
  l.researchNotes = (l.researchNotes ? l.researchNotes + '\n\n———\n' : '') + text.trim()
  await persistLead(l)
}

// Recherche web sur la PERSONNE d'un contact (poste, actualité) et persiste.
export async function researchPerson(leadId: string): Promise<{ profile?: string; error?: string }> {
  const l = LEADS[leadId]
  if (!l) return { error: 'Lead introuvable.' }
  const name = `${l.firstName} ${l.lastName}`.trim()
  if (!name) return { error: 'Ce lead n\'a pas de nom de personne.' }
  try {
    const r = await fetch('/api/enrich/person', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, company: l.company, linkedinUrl: l.linkedinUrl }),
    }).then((x) => x.json())
    if (r.profile) { l.webProfile = r.profile; await persistLead(l) }
    return r
  } catch { return { error: 'Recherche indisponible.' } }
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
      sector: lead.naf || '—',
      // ⚠️ CHIFFRE D'AFFAIRES ≠ LEVÉE DE FONDS.
      //
      // Ce champ projetait `lead.ca` — le chiffre d'affaires — dans un emplacement
      // dont la sémantique est le FINANCEMENT. La donnée était pourtant réelle :
      // c'est précisément ce qui rendait le défaut invisible. « 12 M€ » de revenus
      // affiché comme « 12 M€ levés » décrit une entreprise que personne n'a
      // observée — une donnée vraie placée dans le mauvais emplacement produit une
      // information fausse, exactement comme une donnée inventée.
      //
      // Le modèle `Lead` actuel ne porte AUCUN champ de financement faisant
      // autorité. On échoue donc fermé plutôt que d'emprunter le voisin le plus
      // proche. `lead.ca` reste persisté et intact ; il n'est simplement plus
      // projeté ici. Le jour où un financement réel sera collecté, il aura son
      // propre champ.
      funding: '—',
      description: lead.summary
        ? lead.summary
        : lead.siren
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

/**
 * Dossier d'un lead — UNIQUEMENT à partir de ce que la fiche porte réellement.
 *
 * ── LE DÉFAUT QUE CE LOT FERME (PROSPECTOR-DOMAIN-ADAPTERS-001) ─────────────
 * Cette fonction possédait une seconde branche, active dès que `lead.score`
 * était non nul, qui FABRIQUAIT un dossier complet à partir de trois proxies
 * sans aucune valeur probante : le score lui-même, `lead.temperature`, et un
 * pseudo-aléa tiré d'un identifiant (`lead.id.charCodeAt(1)`).
 *
 * Elle produisait notamment :
 *
 *     preuves: [
 *       `FAIT — Offre d'emploi publiée récemment (source Unipile)`,
 *       `FAIT — Effectif 51-200 en croissance (source Pappers)`,
 *       `FAIT — ${lead.title} identifié comme décideur (source LinkedIn)`,
 *     ]
 *     funding: 'Série A · 12 M€'
 *     website: `www.${company}.com`
 *     location: 'Paris, France'
 *     pourquoiMaintenant: `… signal 🔥 FRAIS (< 30 jours) …`
 *
 * ⚠️ CE N'ÉTAIENT PAS DES MAQUETTES. C'étaient des énoncés préfixés « FAIT — »,
 * ATTRIBUÉS À DES SOURCES NOMMÉES, portant un montant de levée, une tranche
 * d'effectif et une fraîcheur de signal — tous déduits d'un nombre entre 0 et
 * 100, quand ils n'étaient pas tirés du code ASCII d'un identifiant. Aucune de
 * ces informations n'a jamais été observée.
 *
 * ── POURQUOI C'ÉTAIT UNE BOMBE AMORCÉE, ET NON UNE DETTE DORMANTE ──────────
 * `lead.score` vaut `0` partout aujourd'hui : la branche était donc morte, et
 * seule cette coïncidence protégeait l'utilisateur. La première ligne de code
 * qui aurait renseigné un score — un futur agent de scoring, un import, un
 * test — aurait rallumé l'ensemble, sans qu'aucune revue ne le rattache à ce
 * changement.
 *
 * ── LA RÈGLE, DÉSORMAIS ────────────────────────────────────────────────────
 * Une donnée absente reste absente. `emptyDetail` ne lit que des champs
 * réellement persistés sur le `Lead` (`effectif`, `city`, `website`, `naf`,
 * `ca`, `summary`, `siren`, `dirigeant`) et dit « à enrichir » pour le reste,
 * avec `preuves: []`. Un dossier vide est un dossier honnête ; un dossier
 * inventé est indiscernable d'un dossier vrai, et c'est précisément ce qui le
 * rend dangereux.
 *
 * ⚠️ `lead.score` N'EST PLUS LU ICI, ni nulle part comme source de fait. Il
 * subsiste dans le type pour compatibilité des données persistées, et il est
 * marqué non-autoritaire (cf. `types/prospector.ts`).
 */
function buildDetail(lead: Lead): LeadDetail {
  return emptyDetail(lead)
}


// Supprime un lead (mémoire + Supabase).
export async function deleteLead(id: string): Promise<void> {
  delete LEADS[id]
  try { await fetch('/api/leads', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }) } catch { /* mémoire */ }
  // Cascade : un lead supprimé ne doit plus figurer dans les listes ni les séquences.
  await purgeLeadFromCollections([id])
}

// Auto-réparation : resynchronise les leads avec le serveur puis retire des listes
// et séquences tout id qui ne correspond plus à un lead existant (fantômes).
export async function reconcileCollections(): Promise<void> {
  await hydrateLeads(true)
  const existing = new Set(Object.keys(LEADS))
  try {
    const lists = await getLists()
    for (const l of lists) {
      const kept = l.leadIds.filter((x) => existing.has(x))
      if (kept.length !== l.leadIds.length) { l.leadIds = kept; await storeSave('list', l) }
    }
  } catch { /* best-effort */ }
  try {
    const seqs = await getSequences()
    for (const s of seqs) {
      if (!s.leadIds?.length) continue
      const kept = s.leadIds.filter((x) => existing.has(x))
      if (kept.length !== s.leadIds.length) { s.leadIds = kept; s.enrolled = kept.length; await storeSave('sequence', s) }
    }
  } catch { /* best-effort */ }
}

// Retire des ids supprimés de TOUTES les listes et séquences (+ recale les compteurs).
export async function purgeLeadFromCollections(ids: string[]): Promise<void> {
  const set = new Set(ids)
  try {
    const lists = await getLists()
    for (const l of lists) {
      const kept = l.leadIds.filter((x) => !set.has(x))
      if (kept.length !== l.leadIds.length) { l.leadIds = kept; await storeSave('list', l) }
    }
  } catch { /* best-effort */ }
  try {
    const seqs = await getSequences()
    for (const s of seqs) {
      if (!s.leadIds?.length) continue
      const kept = s.leadIds.filter((x) => !set.has(x))
      if (kept.length !== s.leadIds.length) { s.leadIds = kept; s.enrolled = kept.length; await storeSave('sequence', s) }
    }
  } catch { /* best-effort */ }
}

// Vérifie l'entreprise du lead via data.gouv → SIREN + actif + dirigeant (gratuit, sans token).
export async function verifyLeadCompany(id: string): Promise<{
  found: boolean
  active?: boolean
  dirigeant?: string
  ambiguous?: boolean
  resolution?: Resolution
  candidates?: CompanyCandidate[]
} | undefined> {
  const l = LEADS[id]
  if (!l || !l.company || l.company === '—') return { found: false, resolution: 'not_found' }
  try {
    const v = await fetch(`/api/company/verify?name=${encodeURIComponent(l.company)}`).then((r) => r.json())
    // Panne fournisseur : aucun champ n'est écrit, et surtout on ne dit pas
    // « introuvable ». La fiche reste exactement dans l'état où elle était.
    if (v.resolution === 'provider_error') {
      return { found: false, resolution: 'provider_error' }
    }
    // ⚠️ AMBIGUÏTÉ : AUCUN champ du lead n'est touché. Écrire le SIREN d'une
    // société choisie au hasard serait pire que ne rien écrire — la fiche
    // paraîtrait vérifiée.
    if (v.ambiguous) {
      return { found: false, ambiguous: true, resolution: 'ambiguous', candidates: v.candidates || [] }
    }
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
    return { found: !!v.found, resolution: v.found ? 'resolved' : 'not_found', active: v.active, dirigeant: v.dirigeant }
  } catch {
    // La route est injoignable : panne, pas absence.
    return { found: false, resolution: 'provider_error' }
  }
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

export async function enrollLeadsInSequence(id: string, count: number, leadIds?: string[]) {
  const s = SEQUENCES.find((x) => x.id === id)
  if (s) {
    if (leadIds?.length) { s.leadIds = Array.from(new Set([...(s.leadIds || []), ...leadIds])); s.enrolled = s.leadIds.length }
    else s.enrolled += count
    await storeSave('sequence', s)
  }
  return s
}

// Leads réellement enrôlés dans une séquence (résolus depuis leadIds).
export async function getSequenceLeads(seq: Sequence): Promise<Lead[]> {
  await hydrateLeads()
  return (seq.leadIds || []).map((id) => LEADS[id]).filter(Boolean)
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

// Usage RÉEL (aucune simulation) : agrégé côté serveur depuis les compteurs.
// Zéro tant qu'aucun appel IA réel n'a eu lieu ; se met à jour à chaque action.
export async function getUsage(_period: Period = 'month'): Promise<UsageSummary> {
  const empty: UsageSummary = { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, cached: 0, byAgent: [], byModel: [], byDay: [] }
  try {
    const d = await fetch('/api/config/usage').then((r) => r.json())
    const ai = d.ai || {}
    return {
      calls: ai.calls || 0,
      tokensIn: ai.tokensIn || 0,
      tokensOut: ai.tokensOut || 0,
      cost: ai.cost || 0,
      cached: 0,
      byAgent: ai.byAgent || [],
      byModel: ai.byModel || [],
      byDay: ai.byDay || [],
    }
  } catch { return empty }
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
export interface Notification {
  id: string
  type: 'reply' | 'meeting' | 'task' | 'system'
  text: string
  when: string
  unread: boolean
  href?: string
  createdAt?: number
  taskId?: string
  leadId?: string
  priority?: 'normal' | 'important'
}

export async function getNotifications(): Promise<Notification[]> {
  return storeList<Notification>('notification')
}

export async function markNotificationsRead(): Promise<Notification[]> {
  const notifications = await getNotifications()

  const updated = notifications.map((notification) => ({
    ...notification,
    unread: false,
  }))

  for (const notification of updated) {
    if (
      notifications.find(
        (current) =>
          current.id === notification.id &&
          current.unread,
      )
    ) {
      await storeSave(
        'notification',
        notification,
      )
    }
  }

  return updated
}

// ── Listes (export CSV paramétrable + déploiement en séquence) ─────────────────
export interface LeadList { id: string; name: string; leadIds: string[]; source?: string; createdAt: number }

export async function getLists(): Promise<LeadList[]> {
  const l = await storeList<LeadList>('list')
  return l.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}
export async function createList(name: string, leadIds: string[] = [], source?: string): Promise<LeadList> {
  const list: LeadList = { id: `ls_${Math.random().toString(36).slice(2, 9)}`, name: name.trim() || 'Liste', leadIds: Array.from(new Set(leadIds)), source, createdAt: Date.now() }
  await storeSave('list', list)
  return list
}
export async function addToList(listId: string, leadIds: string[]): Promise<LeadList | undefined> {
  const lists = await getLists(); const list = lists.find((l) => l.id === listId)
  if (!list) return undefined
  list.leadIds = Array.from(new Set([...list.leadIds, ...leadIds]))
  await storeSave('list', list); return list
}
export async function removeFromList(listId: string, leadId: string): Promise<void> {
  const lists = await getLists(); const list = lists.find((l) => l.id === listId)
  if (!list) return
  list.leadIds = list.leadIds.filter((id) => id !== leadId)
  await storeSave('list', list)
}
export async function renameList(listId: string, name: string): Promise<void> {
  const lists = await getLists(); const list = lists.find((l) => l.id === listId)
  if (list) { list.name = name.trim() || list.name; await storeSave('list', list) }
}
export async function deleteList(listId: string): Promise<void> { await storeDelete('list', listId) }

// Résout les leads d'une liste (contacts + comptes), dans l'ordre de la liste.
export async function getListLeads(list: LeadList): Promise<Lead[]> {
  await hydrateLeads()
  return list.leadIds.map((id) => LEADS[id]).filter(Boolean)
}

// Formats CSV paramétrables. Chaque preset = un jeu de colonnes (en-tête + champ).
export type CsvField = keyof Lead | 'fullName' | 'statusLabel' | 'stageLabel'
export interface CsvColumn { header: string; field: CsvField }
export const CSV_PRESETS: { key: string; label: string; desc: string; columns: CsvColumn[] }[] = [
  { key: 'crm', label: 'CRM générique', desc: 'Colonnes standard pour import CRM (HubSpot, Pipedrive…)', columns: [
    { header: 'Prénom', field: 'firstName' }, { header: 'Nom', field: 'lastName' }, { header: 'Email', field: 'email' },
    { header: 'Téléphone', field: 'phone' }, { header: 'Société', field: 'company' }, { header: 'Titre', field: 'title' },
    { header: 'LinkedIn', field: 'linkedinUrl' }, { header: 'Ville', field: 'city' }, { header: 'SIREN', field: 'siren' }, { header: 'Statut', field: 'statusLabel' },
  ] },
  { key: 'outreach', label: 'Outreach (Lemlist/La Growth)', desc: 'En-têtes anglais + icebreaker pour outils de séquence', columns: [
    { header: 'firstName', field: 'firstName' }, { header: 'lastName', field: 'lastName' }, { header: 'email', field: 'email' },
    { header: 'companyName', field: 'company' }, { header: 'linkedinUrl', field: 'linkedinUrl' }, { header: 'jobTitle', field: 'title' }, { header: 'icebreaker', field: 'icebreaker' },
  ] },
  { key: 'complet', label: 'Complet', desc: 'Toutes les données disponibles', columns: [
    { header: 'Prénom', field: 'firstName' }, { header: 'Nom', field: 'lastName' }, { header: 'Société', field: 'company' },
    { header: 'Titre', field: 'title' }, { header: 'Persona', field: 'persona' }, { header: 'Email', field: 'email' }, { header: 'Téléphone', field: 'phone' },
    { header: 'LinkedIn', field: 'linkedinUrl' }, { header: 'SIREN', field: 'siren' }, { header: 'NAF', field: 'naf' }, { header: 'Ville', field: 'city' },
    { header: 'Effectif', field: 'effectif' }, { header: 'CA', field: 'ca' }, { header: 'Site', field: 'website' }, { header: 'Signal', field: 'signal' },
    { header: 'Icebreaker', field: 'icebreaker' }, { header: 'Statut', field: 'statusLabel' }, { header: 'Étape', field: 'stageLabel' },
  ] },
]

function csvValue(lead: Lead, field: CsvField): string {
  if (field === 'fullName') return `${lead.firstName} ${lead.lastName}`.trim()
  if (field === 'statusLabel') return STATUS_META[lead.status]?.label || lead.status
  if (field === 'stageLabel') return STAGE_META[lead.stage]?.label || lead.stage
  const v = (lead as any)[field]
  return v === null || v === undefined ? '' : String(v)
}

// Génère le CSV (BOM Excel + échappement) à partir de colonnes choisies.
export function buildCsv(leads: Lead[], columns: CsvColumn[]): string {
  const rows = [columns.map((c) => c.header), ...leads.map((l) => columns.map((c) => csvValue(l, c.field)))]
  return '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

// Déploie une liste dans une séquence : enrôle chaque CONTACT individuellement.
export async function deployListToSequence(list: LeadList, sequenceId: string): Promise<{ enrolled: number }> {
  const leads = await getListLeads(list)
  const contacts = leads.filter((l) => !isAccountLead(l))
  const enrolledIds: string[] = []
  for (const c of contacts) { const l = await enrollLead(c.id); if (l) enrolledIds.push(c.id) }
  if (enrolledIds.length) await enrollLeadsInSequence(sequenceId, enrolledIds.length, enrolledIds)
  return { enrolled: enrolledIds.length }
}

// ── Planificateur de tâches / rappels ──
export interface Task { id: string; title: string; due: string; done: boolean; leadId?: string; leadName?: string; channel?: 'linkedin' | 'email' | 'whatsapp' | null; priority?: 'normal' | 'important' }
let TASKS: Task[] = []
export async function getTasks(): Promise<Task[]> {
  TASKS = await storeList<Task>('task')
  return [...TASKS]
}
export async function addTask(input: { title: string; due: string; leadId?: string; leadName?: string; channel?: Task['channel']; priority?: Task['priority'] }): Promise<Task> {
  const t: Task = { id: `tk_${Math.random().toString(36).slice(2, 9)}`, title: input.title.trim() || 'Tâche', due: input.due || "Aujourd'hui", done: false, leadId: input.leadId, leadName: input.leadName, channel: input.channel ?? null, priority: input.priority === 'important' ? 'important' : 'normal' }
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

// La définition de « compte » vit dans `lib/prospector/leadKind.ts` — un module
// pur, partagé avec le cerveau serveur (jarvisAgent). Réexporté ici pour que les
// écrans qui importaient déjà `isAccountLead` de ce module continuent de
// fonctionner, SANS qu'une seconde implémentation puisse réapparaître.
export { isAccountLead, isContactLead }

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
    // Le contact HÉRITE des infos du compte (fiche contact complète d'office).
    siren: acc.siren, active: acc.active, naf: acc.naf, city: acc.city,
    effectif: acc.effectif, website: acc.website, summary: acc.summary,
    dirigeant: acc.dirigeant, signal: acc.signal, icebreaker: acc.icebreaker,
  }
  LEADS[lead.id] = lead
  await persistLead(lead)
  return lead
}

// Charge un ou plusieurs dirigeants identifiés (data.gouv) comme CONTACTS.
export async function addDirigeantsAsContacts(accountId: string, names: string[]): Promise<{ added: number }> {
  const acc = LEADS[accountId]
  // Dédoublonnage : on n'ajoute pas un dirigeant déjà présent comme contact.
  const existing = new Set(
    Object.values(LEADS).filter((x) => !isAccountLead(x) && acc && x.company === acc.company)
      .map((x) => `${x.firstName} ${x.lastName}`.toLowerCase().trim()),
  )
  let added = 0
  for (const name of names) {
    const clean = (name || '').trim()
    if (!clean || existing.has(clean.toLowerCase())) continue
    const [firstName, ...rest] = clean.split(/\s+/)
    const l = await addAccountContact(accountId, { firstName, lastName: rest.join(' '), title: 'Dirigeant', persona: 'Founder/CEO' })
    if (l) { added++; existing.add(clean.toLowerCase()) }
  }
  return { added }
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
  if (created.length) await persistLeads(created)
  return { added: created.length, skipped: companies.length - created.length }
}

// Importe une entreprise détectée par SIGNAL, en attachant le signal + l'icebreaker
// au lead → l'accroche devient actionnable (fiche + pré-remplissage 1er message).
// La vérification data.gouv se fait ICI (à l'ajout), pas pendant la recherche :
// un seul appel, uniquement pour les entreprises réellement retenues.
/**
 * Résultat d'un import de signal.
 *
 * ⚠️ `ambiguous` EST UN TROISIÈME ÉTAT, pas une variante d'échec. « Plusieurs
 * sociétés portent ce nom » et « aucune société ne porte ce nom » appellent des
 * décisions opposées : la première demande à l'utilisateur de trancher, la
 * seconde constate une absence. Les confondre — comme le faisait l'appelant qui
 * n'avait que `found` — affichait « entreprise introuvable » alors que le
 * problème était l'inverse : il y en avait trop.
 */
export interface SignalImportResult {
  added: number
  id?: string
  verified?: boolean
  siren?: string
  ambiguous?: boolean
  /** `provider_error` = data.gouv injoignable. RIEN n'a été écrit. */
  resolution?: Resolution
  company?: string
  candidates?: CompanyCandidate[]
}

export interface CompanyCandidate { siren: string; name: string; city?: string }

/**
 * Libellé commun d'une résolution ambiguë, partagé par les écrans.
 *
 * ⚠️ Il ne dit JAMAIS « introuvable ». Il nomme le vrai problème — il y a
 * plusieurs sociétés — et il dit explicitement ce qui n'a PAS été écrit.
 * Une ambiguïté silencieuse laisserait croire à un import réussi.
 */
export function ambiguityLabel(
  company: string,
  candidates: CompanyCandidate[] = [],
  consequence = "Aucun compte n'a été créé.",
): string {
  const listees = candidates.slice(0, 5).map(
    (c) => `${c.name} (SIREN ${c.siren}${c.city ? ` · ${c.city}` : ''})`,
  )
  const reste = candidates.length > 5 ? ` … et ${candidates.length - 5} autre(s).` : ''
  return [
    `« ${company} » correspond à plusieurs entreprises sur data.gouv.`,
    consequence,
    listees.length ? `${listees.join(' · ')}${reste}` : '',
    'Sélectionne la bonne société ou renseigne son SIREN.',
  ].filter(Boolean).join(' ')
}

/**
 * Libellé d'indisponibilité fournisseur.
 *
 * ⚠️ IL NE DIT JAMAIS « INTROUVABLE ». C'est le cœur d'OBS-DATAGOUV-001 : une
 * panne annoncée comme une absence fait corriger une saisie qui était juste, et
 * abandonner une entreprise qui existe.
 */
export const PROVIDER_UNAVAILABLE = 'Data.gouv est temporairement indisponible. Réessaie dans un instant.'

export async function importSignalToPipeline(hit: SignalHit): Promise<SignalImportResult> {
  // ⚠️ CLÉ PROVISOIRE, JAMAIS LE SIREN DU SIGNAL.
  //
  // `hit.siren` vient d'un signal produit par un LLM : c'est un CANDIDAT, pas
  // une identité. L'ancienne clé `hit.siren || \`sig-${hit.company}\`` en
  // faisait la clé canonique de déduplication AVANT toute vérification — un
  // SIREN halluciné devenait donc l'identité d'un compte, et bloquait ensuite
  // l'import de la vraie entreprise portant ce SIREN.
  //
  // Avant vérification, on ne dédoublonne que sur le NOM. Le SIREN ne devient
  // une clé qu'une fois confirmé par data.gouv.
  const cleProvisoire = `sig-${hit.company}`
  if (importedPlaceholders[cleProvisoire]) return { added: 0, id: importedPlaceholders[cleProvisoire] }

  // Vérification SIREN + enrichissement (dirigeant, effectif, site, NAF, ville).
  // Aucun champ n'est prérempli si data.gouv ne renvoie rien.
  //
  // ⚠️ LE SIREN PRIME SUR LE NOM (ENTITY-RESOLUTION-001). Un SIREN est un
  // identifiant : il désigne UNE entité, sans ambiguïté possible. Résoudre par
  // nom alors qu'on tient déjà un identifiant, c'est remplacer une certitude
  // par un classement de pertinence — et rouvrir la collision qu'on ferme.
  let dg: any = null
  let ambigu: any = null
  let panne = false
  try {
    const url = hit.siren
      ? `/api/company/verify?siren=${encodeURIComponent(hit.siren)}`
      : `/api/company/verify?name=${encodeURIComponent(hit.company)}`
    const r = await fetch(url)
    const j = await r.json()
    if (j?.found) dg = j
    else if (j?.ambiguous) ambigu = j
    else if (j?.resolution === 'provider_error') panne = true
  } catch {
    // ⚠️ La route elle-même est injoignable : c'est une panne, pas un « non
    // trouvé ». L'ancien commentaire disait « on importe sans vérification » —
    // c'était précisément le fail-open que ce lot ferme.
    panne = true
  }

  // ⚠️ PANNE FOURNISSEUR : AUCUNE ÉCRITURE, AUCUN ENRICHISSEMENT, AUCUN
  // REPLI IDENTITAIRE. Importer « sans métadonnées » reviendrait à créer un
  // compte inerte sur la foi d'une indisponibilité, et à poser un placeholder
  // qui empêcherait tout réessai.
  if (panne) {
    return { added: 0, resolution: 'provider_error', company: hit.company }
  }

  // ⚠️ RETOUR AVANT TOUTE ÉCRITURE. Aucun identifiant n'est tiré, aucune entrée
  // n'est posée dans LEADS ni dans importedPlaceholders, aucun persistLead.
  // Un compte créé sur une identité indéterminée serait un faux compte, et il
  // porterait le tampon « vérifié data.gouv ».
  if (ambigu) {
    return {
      added: 0,
      ambiguous: true,
      resolution: 'ambiguous',
      company: hit.company,
      candidates: ambigu.candidates || [],
    }
  }

  // ⚠️ SIREN CANDIDAT ≠ SIREN CANONIQUE. `dg?.siren || hit.siren` recopiait le
  // SIREN du signal quand data.gouv ne le confirmait PAS : un échec de
  // vérification se muait alors en validation implicite, et le lead portait un
  // SIREN non vérifié indiscernable d'un SIREN officiel.
  //
  // Seul data.gouv fait autorité. Non confirmé — introuvable, ou vérification
  // en échec — ⇒ AUCUN SIREN. Le compte reste importable (comportement
  // NOT_FOUND inchangé pour ce lot), simplement sans identité canonique ni
  // métadonnées officielles.
  const siren: string | undefined = dg?.siren || undefined
  if (siren && importedPlaceholders[siren]) return { added: 0, id: importedPlaceholders[siren] }
  const id = newLeadId()
  importedPlaceholders[cleProvisoire] = id
  // Seul un SIREN VÉRIFIÉ devient une clé de déduplication canonique.
  if (siren) importedPlaceholders[siren] = id
  const lead: Lead = {
    id, kind: 'account', firstName: '', lastName: '', title: '',
    company: dg?.name || hit.company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren, city: dg?.city || hit.city, active: dg ? dg.active : undefined,
    naf: dg?.naf || undefined, dirigeant: dg?.dirigeant || undefined,
    effectif: dg?.effectif || undefined, website: dg?.website || undefined,
    signal: hit.detail, icebreaker: hit.icebreaker,
  }
  LEADS[id] = lead
  await persistLead(lead)
  return { added: 1, id, verified: !!dg, siren, resolution: dg ? 'resolved' : 'not_found' }
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
    await persistLeads(created)
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
  if (created.length) await persistLeads(created)
  return { added: created.length, ids: created.map((l) => l.id) }
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
  const { ids } = await addContactsToPipeline(comp, res.contacts)
  // 3) Crée la séquence + enrôle (on garde la liste des leads enrôlés)
  const seq: Sequence = {
    id: nextSequenceId(),
    name: `Compte ${company.name} · personas`,
    status: 'active',
    enrolled: res.contacts.length,
    responseRate: 0,
    steps: ACCOUNT_SEQ_TEMPLATE(),
    leadIds: ids,
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
