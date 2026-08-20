// CERVEAU JARVIS PARTAGÉ — un seul cerveau, plusieurs canaux (extension, Telegram,
// WhatsApp plus tard). Le canal ne fait que transporter du texte : toute la
// compréhension et l'exécution vivent ici, côté serveur, dans l'espace du client.
import { callClaude, parseJson, cacheKey } from './llm'
import type { TenantContext } from './tenant'
import { getKey } from './keystore'
import { lookupByName, fetchCompanyDetail, fetchCompanies } from './datagouv'
import { identifyLead, enrichCompanyWeb } from './identify'
import { resolveLeadEntity, entityLabel } from './entityResolver'
import { resolveTimeExpression } from './timeResolver'
import { resolveReminderPriority } from './reminderPriority'
import {
  upsertLeadChecked,
  listLeads,
  listLeadsStrict,
  type UpsertResult,
} from '../supabase/leads'
import { listItems, upsertItem } from '../supabase/store'
import { isAccountLead } from './leadKind'
import type { Lead, Sequence } from '../../types/prospector'

const newId = () => `ld_${Math.random().toString(36).slice(2, 10)}`

// ⚠️ IL Y AVAIT ICI UNE SECONDE DÉFINITION DE « COMPTE », INCOMPLÈTE :
//     l.kind === 'account' || (!l.firstName?.trim() && !l.lastName?.trim())
// Elle omettait le court-circuit `kind === 'contact'`. Un contact DÉCLARÉ mais
// sans prénom ni nom était donc compté COMPTE ici et CONTACT dans l'UI, sur la
// même ligne. La définition canonique vit désormais dans `./leadKind` — module
// pur, sans état ni réseau, partagé par le serveur et le navigateur.
export const isAccount = (l: Lead): boolean => isAccountLead(l)

const SYSTEM = `Tu es Jarvis, copilote de Prospector (prospection B2B française).
L'utilisateur te donne une directive depuis un canal texte (extension web ou messagerie mobile).
Tu ne pilotes QUE Prospector — jamais LinkedIn directement. Réponds UNIQUEMENT en JSON :
{ "reply": "phrase courte en français", "action": ACTION | null }

ACTION (au plus une) :
- { "type":"source_companies", "sector"?, "location"?, "size"?, "limit"?, "import": true|false } → SOURCER des entreprises sur data.gouv.
  Utilise-la dès que l'utilisateur veut "trouver/sourcer/chercher des entreprises/sociétés/ESN/cabinets" selon des critères.
  sector ∈ [Technology, SaaS B2B, IA / ML, Cybersécurité, Fintech, Finance, Consulting, Marketing, Media, Healthcare, Retail, Logistics, Construction, Education, Manufacturing, Legal, Energy, Real Estate, Hospitality]
  (une ESN / société de conseil IT → sector "Consulting" ; éditeur de logiciel → "Technology")
  size ∈ [1-10, 11-20, 21-50, 51-100, 101-250, 251-500, 501-1000, 1000+]  (50 à 100 salariés → "51-100")
  location = ville ou département (ex: Paris, Lyon, 75). limit ≤ 25.
  "import": true si l'utilisateur veut aussi les AJOUTER au pipe, false s'il veut juste voir la liste.
- { "type":"research_person", "name":"...", "company"? } → ACTUALITÉ & PRESSE d'une personne, HORS LinkedIn (le profil LinkedIn est couvert ailleurs). LECTURE (coûte des tokens).
- { "type":"web_answer", "question":"...", "attachTo"? } → RECHERCHE WEB LIBRE sur une question de prospection B2B
  (marché, concurrents, acteurs d'un secteur, tendances). LECTURE (coûte des tokens). Utilise-la seulement si aucune
  autre action ne convient ET si la question relève du contexte commercial. "attachTo" = nom d'un lead auquel
  rattacher la réponse en note, si l'utilisateur le demande.
- { "type":"stats" } → chiffres du pipe (comptes, contacts, étapes). LECTURE.
- { "type":"find_lead", "query":"..." } → retrouver des leads DÉJÀ dans le pipe. LECTURE.
- { "type":"explain_company", "company":"..." } → fiche + résumé d'une entreprise. LECTURE.
- { "type":"add_company", "company":"...", "withContacts": true|false } → créer le COMPTE (+ dirigeants réels en contacts).
- { "type":"add_person", "name":"...", "url":"..." } → créer un CONTACT.
- { "type":"add_to_list", "company"|"name":"...", "listName":"..." } → ajouter à une liste (créée si absente).
- { "type":"add_to_sequence", "company"|"name":"...", "sequenceName":"..." } → enrôler dans une séquence EXISTANTE.
- { "type":"set_status", "name":"...", "status":"chaud"|"tiede"|"froid"|"converti"|"perdu" } → changer le statut d'un lead.
- { "type":"add_note", "name":"...", "text":"..." } → créer une tâche/rappel rattaché à un lead.
  IMPORTANT : toute directive du type « rappelle-moi », « crée/mets un rappel » ou équivalent DOIT utiliser add_note, même si elle contient une date ou une heure. Prospector sait gérer les rappels côté serveur : ne dis jamais que cette fonction n’est pas disponible.

Si une page web est fournie, déduis l'entreprise/la personne de son titre et de son URL.
Si rien de pertinent, action=null et réponds directement dans "reply".`


const REMINDER_FALLBACK_SYSTEM = `Tu es le classifieur spécialisé des rappels de Prospector.
Réponds UNIQUEMENT en JSON :
{ "reply": "phrase courte en français", "action": { "type":"add_note", "name":"...", "text":"..." } | null }

Si la directive demande explicitement un rappel ou demande à Jarvis de rappeler quelque chose concernant un lead, retourne TOUJOURS add_note.
"name" = nom du lead mentionné par l'utilisateur.
"text" = action concise à rappeler.
Ne calcule PAS la date, l'heure ni la priorité : le serveur les calcule depuis la directive originale.
Ne prétends jamais que Prospector ne sait pas programmer de rappel.`

function looksLikeReminderDirective(message: string): boolean {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return (
    /\brappelle moi\b/.test(normalized) ||
    /\b(?:cree|creer|mets|mettre|programme|programmer)\s+(?:moi\s+)?(?:un\s+)?rappel\b/.test(normalized) ||
    /\b(?:rappel|notification de rappel)\s+(?:pour|a|demain|aujourd hui)\b/.test(normalized)
  )
}
export interface PlanResult { reply: string; action: any | null }

// 1) COMPRENDRE — modèle économique (classification), aucun effet de bord.
export async function planJarvis(tenant: TenantContext, message: string, ctx: { url?: string; title?: string; channel?: string } = {}): Promise<PlanResult> {
  if (!getKey('ANTHROPIC_API_KEY')) return { reply: 'Clé Anthropic non configurée (Admin → Connexions).', action: null }
  const page = ctx.url || ctx.title ? `Page: ${(ctx.title || '').slice(0, 200)} (${(ctx.url || '').slice(0, 200)})\n` : ''
  const r = await callClaude({
    tenant, task: 'classify', agent: `Jarvis ${ctx.channel || 'web'}`, system: SYSTEM,
    messages: [{ role: 'user', content: `${page}Directive: ${message}` }],
  })
if (r.blocked) {
  return {
    reply: r.error || 'Budget IA épuisé.',
    action: null,
  }
}

let plan =
  parseJson<PlanResult>(r.text) || {
    reply: r.text.trim() || '…',
    action: null,
  }

if (
  looksLikeReminderDirective(message) &&
  plan.action?.type !== 'add_note'
) {
  const reminderRetry = await callClaude({
    tenant,
    task: 'classify',
    agent: `Jarvis reminder ${ctx.channel || 'web'}`,
    system: REMINDER_FALLBACK_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Directive: ${message}`,
      },
    ],
  })

  if (!reminderRetry.blocked) {
    const retryPlan =
      parseJson<PlanResult>(reminderRetry.text)

    if (retryPlan?.action?.type === 'add_note') {
      plan = retryPlan
    }
  }
}

if (!plan.action) {
  return plan
}

// ENTITY-01B — les mutations visant un lead sont résolues côté serveur
// AVANT de produire la demande de confirmation.
if (
  plan.action.type === 'set_status' ||
  plan.action.type === 'add_note'
) {
  const query = String(plan.action.name || '').trim()

  const target = await resolveExistingTarget(
    tenant.id,
    query,
  )

  if (target.kind === 'storage_error') {
    return {
      reply:
        'Je ne peux pas lire le pipeline pour le moment. Rien ne sera modifié.',
      action: null,
    }
  }

  if (target.kind === 'not_found') {
    return {
      reply: `Lead « ${query} » introuvable dans ce pipeline.`,
      action: null,
    }
  }

  if (target.kind === 'ambiguous') {
    return {
      reply:
        `J’ai trouvé plusieurs correspondances proches :\n` +
        target.leads
          .slice(0, 5)
          .map(
            (lead, index) =>
              `${index + 1}. ${entityLabel(lead)}`,
          )
          .join('\n') +
        `\nPrécise laquelle tu veux utiliser.`,
      action: null,
    }
  }

  const lead = target.lead
  const label = entityLabel(lead)

  const action = {
    ...plan.action,

    // Autorité métier réelle.
    leadId: lead.id,

    // Le texte devient seulement informatif.
    name:
      `${lead.firstName || ''} ${lead.lastName || ''}`.trim() ||
      lead.company,
  }

// JARVIS-TIME-01 — la date est calculée côté serveur à partir de
// la directive originale, jamais confiée à l'interprétation du LLM.
if (action.type === 'add_note') {
  const time = resolveTimeExpression(message)

  action.due = time.due
  action.dueDate = time.dueDate
  action.dueTime = time.dueTime
  action.timeZone = time.timeZone
  action.priority = resolveReminderPriority(message)
}

  const probable = target.kind === 'probable'

if (action.type === 'set_status') {
  return {
    reply: probable
      ? `J’ai trouvé un lead proche : ${label}. Confirme qu’il s’agit bien de cette personne et que je dois passer son statut à « ${action.status} ».`
      : `Je vais passer ${label} en statut « ${action.status} ».`,
    action,
  }
}

const dueLabel =
  action.due ? ` pour ${action.due}` : ''

const reminderLabel =
  action.priority === 'important'
    ? 'ce rappel important'
    : 'cette note/tâche'

return {
  reply: probable
    ? `J’ai trouvé un lead proche : ${label}. Confirme qu’il s’agit bien de cette personne et que je dois créer ${reminderLabel}${dueLabel}.`
    : `Je vais créer ${reminderLabel} pour ${label}${dueLabel}.`,
  action,
}
}

return plan
}

// Les actions de LECTURE s'exécutent sans confirmation ; les ÉCRITURES en demandent une.
export const WRITE_ACTIONS = ['add_company', 'add_person', 'add_to_list', 'add_to_sequence', 'set_status', 'add_note']
// Le sourcing n'est une écriture QUE s'il importe les résultats.
export const isWrite = (a: any) => !!a && (WRITE_ACTIONS.includes(a.type) || (a.type === 'source_companies' && a.import))

async function accountLeadFrom(company: string): Promise<Lead> {
  const v = await lookupByName(company)
  return {
    id: newId(), kind: 'account', firstName: '', lastName: '', title: '', company: v.name || company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren: v.siren, active: v.active, naf: v.naf, city: v.city, dirigeant: v.dirigeant, effectif: v.effectif, website: v.website,
  }
}

async function personOrAccountLead(tenant: TenantContext, name: string, url: string): Promise<Lead> {
  const id = await identifyLead(tenant, { name, url })
  const isPerson = id.kind === 'person'
  const [firstName, ...rest] = String(name || '').split(/\s+/)
  return {
    id: newId(), kind: isPerson ? 'contact' : 'account',
    firstName: isPerson ? (id.firstName || firstName || '') : '', lastName: isPerson ? (id.lastName || rest.join(' ')) : '',
    title: isPerson ? 'À qualifier' : '', company: id.company || '—',
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    linkedinUrl: /linkedin\.com\/in\//i.test(url || '') ? url : undefined,
  }
}

// Retrouve un lead existant dans l'espace (par nom ou société).
async function findExisting(ws: string, q: string): Promise<Lead[]> {
  const all = await listLeads(ws)
  const needle = (q || '').toLowerCase().trim()
  if (!needle) return []
  return all.filter((l) => `${l.firstName} ${l.lastName} ${l.company}`.toLowerCase().includes(needle))
}
type ExistingTarget =
  | { kind: 'exact'; lead: Lead }
  | { kind: 'probable'; lead: Lead }
  | { kind: 'ambiguous'; leads: Lead[] }
  | { kind: 'not_found' }
  | { kind: 'storage_error' }

async function resolveExistingTarget(
  ws: string,
  query: string,
): Promise<ExistingTarget> {
  const read = await listLeadsStrict(ws)

  if (!read.ok) {
    return { kind: 'storage_error' }
  }

  const resolved = resolveLeadEntity(
    read.leads,
    query,
    'any',
  )

  if (resolved.kind === 'exact') {
    return {
      kind: 'exact',
      lead: resolved.candidate.lead,
    }
  }

  if (resolved.kind === 'probable') {
    return {
      kind: 'probable',
      lead: resolved.candidate.lead,
    }
  }

  if (resolved.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      leads: resolved.candidates.map(
        (candidate) => candidate.lead,
      ),
    }
  }

  return { kind: 'not_found' }
}

async function targetForExecution(
  ws: string,
  action: any,
): Promise<
  | { ok: true; lead: Lead | null }
  | { ok: false }
> {
  const read = await listLeadsStrict(ws)

  if (!read.ok) {
    return { ok: false }
  }

  // Une action déjà résolue doit s'exécuter par ID, jamais en refaisant
  // confiance au texte généré par le LLM.
  if (action?.leadId) {
    return {
      ok: true,
      lead:
        read.leads.find(
          (lead) => lead.id === action.leadId,
        ) || null,
    }
  }

  // Compatibilité temporaire avec les anciens appels :
  // on accepte uniquement une correspondance EXACTE normalisée.
  // Jamais de fuzzy mutation sans confirmation préalable.
  const resolved = resolveLeadEntity(
    read.leads,
    String(action?.name || ''),
    'any',
  )

  return {
    ok: true,
    lead:
      resolved.kind === 'exact'
        ? resolved.candidate.lead
        : null,
  }
}

// 2) EXÉCUTER — dans l'espace `ws`. Renvoie un texte lisible (canal-agnostique).

// Un refus d'écriture ne doit JAMAIS être annoncé comme un succès. Ce message est
// rendu tel quel à l'utilisateur, sur les trois canaux (web, extension, Telegram).
function writeFailure(r: UpsertResult, what: string): string {
  switch (r.reason) {
    case 'workspace_conflict':
      return `❌ ${what} : refusé. Cet identifiant appartient déjà à un autre espace de travail.`
    case 'contention':
      return `⚠️ ${what} : écriture concurrente en cours, réessaie dans un instant.`
    case 'env_blocked':
      return `⚠️ ${what} : écritures suspendues (incohérence de configuration d'environnement). Rien n'a été enregistré.`
    default:
      return `❌ ${what} : échec d'enregistrement. Rien n'a été enregistré.`
  }
}

export async function executeJarvis(tenant: TenantContext, action: any, ws: string, ctxUrl = ''): Promise<string> {
  if (!action?.type) return 'Rien à exécuter.'

  switch (action.type) {
    // SOURCING : cherche sur data.gouv, avec import optionnel dans le pipe.
    case 'source_companies': {
      const limit = Math.min(Number(action.limit) || 15, 25)
      const found: any[] = []
      let page = 1
      while (found.length < limit && page <= 3) {
        const r = await fetchCompanies({ sector: action.sector, location: action.location, size: action.size, page, activeOnly: true })
        if (!r.results.length) break
        found.push(...r.results)
        if (page >= (r.totalPages || 1)) break
        page++
      }
      const list = found.slice(0, limit)
      if (!list.length) return `Aucune entreprise trouvée pour ces critères${action.sector ? ` (${action.sector}` : ''}${action.location ? ` · ${action.location}` : ''}${action.size ? ` · ${action.size} sal.` : ''}${action.sector ? ')' : ''}. Élargis le secteur, la taille ou la ville.`

      const lines = list.slice(0, 10).map((c: any) => `🏢 ${c.name}${c.city ? ` · ${c.city}` : ''}${c.effectif ? ` · ${c.effectif} sal.` : ''}${c.dirigeant ? ` · ${c.dirigeant}` : ''}`)
      if (!action.import) {
        return `${list.length} entreprise(s) trouvée(s) :\n${lines.join('\n')}${list.length > 10 ? `\n… +${list.length - 10} autres` : ''}\n\nDis-moi « importe-les » pour les ajouter au pipe.`
      }
      let n = 0
      let refused = 0
      for (const c of list) {
        const r = await upsertLeadChecked({
          id: newId(), kind: 'account', firstName: '', lastName: '', title: '', company: c.name,
          score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
          siren: /^\d{9}$/.test(c.id) ? c.id : undefined, active: true,
          naf: c.naf || undefined, city: c.city || undefined, dirigeant: c.dirigeant || undefined,
          effectif: c.effectif || undefined, website: c.website || undefined,
        }, ws)
        if (r.ok) n++; else refused++
      }
      // On annonce ce qui a été enregistré, jamais ce qui a été tenté.
      if (n === 0) return writeFailure({ ok: false, reason: 'db_error' }, `Import de ${list.length} compte(s)`)
      const note = refused ? `\n⚠️ ${refused} refusé(s) — rien n'a été écrasé.` : ''
      return `✅ ${n} compte(s) importé(s) dans le pipe :\n${lines.join('\n')}${list.length > 10 ? `\n… +${list.length - 10} autres` : ''}${note}`
    }

    // Recherche web sur une PERSONNE (poste, actualité) — coûte des tokens.
    case 'research_person': {
      const who = [action.name, action.company].filter(Boolean).join(' · ')
      if (!action.name) return 'Précise le nom de la personne.'
      const r = await callClaude({
        tenant, task: 'extract', agent: 'Jarvis · actualité personne',
        system: `Tu es analyste de veille commerciale B2B (France). Trouve ce que LinkedIn NE dit PAS :
presse économique/sectorielle, communiqués, levées, nominations, interviews, podcasts, conférences, site officiel.
N'utilise PAS LinkedIn ni les réseaux sociaux comme source.
ANTI-HOMONYME : ne retiens que ce qui est relié à CETTE personne DANS CETTE entreprise ; dans le doute, écarte et dis-le.
N'invente RIEN : si rien de pertinent, réponds "Aucune actualité publique trouvée hors LinkedIn."
Privilégie les 18 derniers mois, DATE chaque élément, cite la source. Aucune donnée de vie privée.
Français, 4 phrases maximum, ton factuel.`,
        tools: [{
          type: 'web_search_20250305', name: 'web_search', max_uses: 3,
          blocked_domains: ['linkedin.com', 'www.linkedin.com', 'fr.linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com'],
          user_location: { type: 'approximate', country: 'FR' },
        }],
        messages: [{ role: 'user', content: `Personne : ${who}. Cherche son actualité publique HORS LinkedIn.` }],
        cache: cacheKey(['person-news', action.name, action.company || '']),
      })
      if (r.blocked) return r.error || 'Budget IA épuisé.'
      return r.text.trim() || `Aucune information publique trouvée sur ${who}.`
    }

    // Recherche web LIBRE, mais cadrée métier (pas un chatbot généraliste).
    case 'web_answer': {
      const question = String(action.question || '').trim()
      if (!question) return 'Précise ta question.'
      const r = await callClaude({
        tenant, task: 'extract', agent: 'Jarvis · recherche web',
        system: `Tu es analyste de marché B2B pour une agence de prospection française.
Tu réponds UNIQUEMENT à des questions utiles à la prospection : marchés, secteurs, concurrents,
acteurs, tendances, appels d'offres, actualité économique, organisation d'une entreprise.
Si la question sort de ce cadre professionnel, réponds : "Question hors du cadre prospection."

RÈGLES : appuie-toi sur des sources web récentes ; DATE et CITE tes sources ;
n'invente aucun chiffre ni nom d'entreprise ; dis clairement ce que tu n'as pas trouvé.
Contexte : marché français. Réponds en français, 6 phrases maximum, ton factuel et dense.
Si des ENTREPRISES pertinentes ressortent, liste-les en fin de réponse sous la forme :
"Pistes : Nom1, Nom2, Nom3" (uniquement des entreprises réellement citées par les sources).`,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'FR' } }],
        messages: [{ role: 'user', content: question }],
        cache: cacheKey(['web-answer', question]),
      })
      if (r.blocked) return r.error || 'Budget IA épuisé.'
      const answer = r.text.trim() || 'Aucune information trouvée.'

      // Capitalisation : on peut rattacher la réponse à un lead (note persistée).
      if (action.attachTo) {
        const hits = await findExisting(ws, String(action.attachTo))
        const target = hits[0]
        if (target) {
          const t = {
            id: `tk_${Math.random().toString(36).slice(2, 9)}`,
            title: `Veille : ${question}`.slice(0, 200), due: "Aujourd'hui", done: false,
            leadId: target.id, leadName: `${target.firstName} ${target.lastName}`.trim() || target.company,
            note: answer.slice(0, 2000),
          }
          await upsertItem('task', t.id, t, ws)
          return `${answer}\n\n📌 Rattaché à ${t.leadName}.`
        }
      }
      return answer
    }

    case 'stats': {
      const all = await listLeads(ws)
      const contacts = all.filter((l) => !isAccount(l))
      const accounts = all.filter(isAccount)
      const byStage: Record<string, number> = {}
      contacts.forEach((c) => { byStage[c.stage] = (byStage[c.stage] || 0) + 1 })
      const seqs = await listItems<Sequence>('sequence', ws)
      const lists = await listItems<any>('list', ws)
      return [
        `${accounts.length} compte(s) · ${contacts.length} contact(s)`,
        `À inviter : ${byStage.to_invite || 0} · En séquence : ${byStage.in_sequence || 0} · A répondu : ${byStage.responded || 0}`,
        `${lists.length} liste(s) · ${seqs.length} séquence(s)`,
      ].join('\n')
    }

    case 'find_lead': {
      const hits = await findExisting(ws, action.query || '')
      if (!hits.length) return `Aucun lead ne correspond à « ${action.query} ».`
      return hits.slice(0, 8).map((l) => isAccount(l)
        ? `🏢 ${l.company}${l.siren ? ` (SIREN ${l.siren})` : ''}`
        : `👤 ${l.firstName} ${l.lastName} — ${l.title} · ${l.company} [${l.status}]`).join('\n')
    }

    case 'explain_company': {
      const v = await lookupByName(action.company)
      if (!v.found) return `Je n'ai pas trouvé « ${action.company} » sur data.gouv.`
      const web = await enrichCompanyWeb(tenant, v.name || action.company, v.city, v.siren)
      return [
        `${v.name} — SIREN ${v.siren}${v.active === false ? ' (radiée)' : ' (active)'}`,
        [v.naf && `NAF ${v.naf}`, v.city, v.effectif && `${v.effectif} sal.`, v.dirigeant && `dir. ${v.dirigeant}`].filter(Boolean).join(' · '),
        web.ca && `CA : ${web.ca}`, web.website && `Site : ${web.website}`,
        web.summary && `\n${web.summary}`,
      ].filter(Boolean).join('\n')
    }

    case 'add_company': {
      const acc = await accountLeadFrom(action.company)
      const saved = await upsertLeadChecked(acc, ws)
      // Si le compte n'a pas été enregistré, on ne crée AUCUN contact rattaché :
      // ils pointeraient vers un compte inexistant.
      if (!saved.ok) return writeFailure(saved, `Ajout du compte « ${acc.company} »`)
      let extra = ''
      if (action.withContacts && acc.siren) {
        const detail = await fetchCompanyDetail(acc.siren)
        const dirs = detail.dirigeants.filter((d) => d.type === 'physique')
        let okCount = 0
        for (const d of dirs) {
          const [firstName, ...rest] = d.name.split(/\s+/)
          const c = await upsertLeadChecked({
            id: newId(), kind: 'contact', firstName, lastName: rest.join(' '), title: 'Dirigeant', persona: 'Founder/CEO',
            company: acc.company, score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
            siren: acc.siren, naf: acc.naf, city: acc.city, effectif: acc.effectif, website: acc.website,
          }, ws)
          if (c.ok) okCount++
        }
        // On annonce le nombre RÉELLEMENT enregistré, pas le nombre tenté.
        extra = okCount === dirs.length
          ? ` + ${okCount} dirigeant(s) en contacts`
          : ` + ${okCount}/${dirs.length} dirigeant(s) en contacts (le reste a été refusé)`
      }
      return `✅ Compte « ${acc.company} » ajouté${extra}.`
    }

    case 'add_person': {
      const lead = await personOrAccountLead(tenant, action.name, action.url || ctxUrl)
      const saved = await upsertLeadChecked(lead, ws)
      if (!saved.ok) return writeFailure(saved, `Ajout de « ${action.name} »`)
      return `✅ ${isAccount(lead) ? 'Compte' : 'Contact'} « ${action.name} » ajouté.`
    }

    case 'add_to_list': {
      const q = action.name || action.company || ''
      const hits = await findExisting(ws, q)
      let target = hits[0]
      if (!target) {
        target = action.company ? await accountLeadFrom(action.company) : await personOrAccountLead(tenant, action.name, ctxUrl)
        const created = await upsertLeadChecked(target, ws)
        if (!created.ok) return writeFailure(created, `Création de « ${q} »`)
      }
      const lists = await listItems<any>('list', ws)
      let list = lists.find((l) => (l.name || '').toLowerCase() === String(action.listName || '').toLowerCase())
      if (!list) list = { id: `ls_${Math.random().toString(36).slice(2, 9)}`, name: action.listName || 'Liste', leadIds: [], source: 'Jarvis', createdAt: Date.now() }
      if (!list.leadIds.includes(target.id)) list.leadIds.push(target.id)
      await upsertItem('list', list.id, list, ws)
      return `✅ Ajouté à la liste « ${list.name} » (${list.leadIds.length} lead(s)).`
    }

    case 'add_to_sequence': {
      const q = action.name || action.company || ''
      const hits = await findExisting(ws, q)
      const target = hits.find((l) => !isAccount(l)) || hits[0]
      if (!target) return `Lead « ${q} » introuvable — ajoute-le d'abord.`
      const seqs = await listItems<Sequence>('sequence', ws)
      const seq = seqs.find((s) => (s.name || '').toLowerCase().includes(String(action.sequenceName || '').toLowerCase()))
      if (!seq) return `Séquence « ${action.sequenceName} » introuvable.`
      if (!isAccount(target)) {
        target.stage = 'in_sequence'
        const moved = await upsertLeadChecked(target, ws)
        if (!moved.ok) return writeFailure(moved, `Enrôlement de « ${target.firstName} ${target.lastName} »`)
      }
      seq.leadIds = Array.from(new Set([...(seq.leadIds || []), target.id]))
      seq.enrolled = seq.leadIds.length
      await upsertItem('sequence', seq.id, seq, ws)
      return `✅ ${target.firstName} ${target.lastName} enrôlé dans « ${seq.name} ».`
    }

    case 'set_status': {
const resolvedTarget =
  await targetForExecution(ws, action)

if (!resolvedTarget.ok) {
  return '⚠️ Impossible de vérifier le pipeline pour le moment. Rien n’a été modifié.'
}

const target = resolvedTarget.lead

if (!target) {
  return `Lead « ${action.name} » introuvable.`
}
      const valid = ['chaud', 'tiede', 'froid', 'converti', 'perdu']
      if (!valid.includes(action.status)) return `Statut invalide.`
      target.status = action.status
      const updated = await upsertLeadChecked(target, ws)
      if (!updated.ok) return writeFailure(updated, `Changement de statut de « ${target.firstName || target.company} »`)
      return `✅ ${target.firstName || target.company} → statut « ${action.status} ».`
    }

    case 'add_note': {
      const resolvedTarget =
  await targetForExecution(ws, action)

if (!resolvedTarget.ok) {
  return '⚠️ Impossible de vérifier le pipeline pour le moment. Rien n’a été créé.'
}

const target = resolvedTarget.lead
if (!target) {
  return `Lead « ${action.name} » introuvable. Rien n’a été créé.`
}
 const t = {
  id: `tk_${Math.random().toString(36).slice(2, 9)}`,
  title: String(action.text || 'Note').slice(0, 200),
  due: String(action.due || "Aujourd'hui"),
  dueDate:
    typeof action.dueDate === 'string'
      ? action.dueDate
      : undefined,
  dueTime:
    typeof action.dueTime === 'string'
      ? action.dueTime
      : null,
  timeZone:
    typeof action.timeZone === 'string'
      ? action.timeZone
      : undefined,
  priority:
    action.priority === 'important'
      ? 'important'
      : 'normal',
  done: false,
  leadId: target.id,
  leadName:
    `${target.firstName} ${target.lastName}`.trim() ||
    target.company,
}
      await upsertItem('task', t.id, t, ws)
      return `✅ Note/tâche créée${target ? ` pour ${t.leadName}` : ''}.`
    }

    default:
      return `Action « ${action.type} » non reconnue.`
  }
}
