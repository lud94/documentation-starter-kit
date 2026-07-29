// CERVEAU JARVIS PARTAGÉ — un seul cerveau, plusieurs canaux (extension, Telegram,
// WhatsApp plus tard). Le canal ne fait que transporter du texte : toute la
// compréhension et l'exécution vivent ici, côté serveur, dans l'espace du client.
import { callClaude, parseJson, cacheKey } from './llm'
import { getKey } from './keystore'
import { lookupByName, fetchCompanyDetail, fetchCompanies } from './datagouv'
import { identifyLead, enrichCompanyWeb } from './identify'
import { upsertLead, listLeads } from '../supabase/leads'
import { listItems, upsertItem } from '../supabase/store'
import type { Lead, Sequence } from '../../types/prospector'

const newId = () => `ld_${Math.random().toString(36).slice(2, 10)}`
export const isAccount = (l: Lead) => l.kind === 'account' || (!l.firstName?.trim() && !l.lastName?.trim())

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
- { "type":"stats" } → chiffres du pipe (comptes, contacts, étapes). LECTURE.
- { "type":"find_lead", "query":"..." } → retrouver des leads DÉJÀ dans le pipe. LECTURE.
- { "type":"explain_company", "company":"..." } → fiche + résumé d'une entreprise. LECTURE.
- { "type":"add_company", "company":"...", "withContacts": true|false } → créer le COMPTE (+ dirigeants réels en contacts).
- { "type":"add_person", "name":"...", "url":"..." } → créer un CONTACT.
- { "type":"add_to_list", "company"|"name":"...", "listName":"..." } → ajouter à une liste (créée si absente).
- { "type":"add_to_sequence", "company"|"name":"...", "sequenceName":"..." } → enrôler dans une séquence EXISTANTE.
- { "type":"set_status", "name":"...", "status":"chaud"|"tiede"|"froid"|"converti"|"perdu" } → changer le statut d'un lead.
- { "type":"add_note", "name":"...", "text":"..." } → créer une tâche/rappel rattaché à un lead.

Si une page web est fournie, déduis l'entreprise/la personne de son titre et de son URL.
Si rien de pertinent, action=null et réponds directement dans "reply".`

export interface PlanResult { reply: string; action: any | null }

// 1) COMPRENDRE — modèle économique (classification), aucun effet de bord.
export async function planJarvis(message: string, ctx: { url?: string; title?: string; channel?: string } = {}): Promise<PlanResult> {
  if (!getKey('ANTHROPIC_API_KEY')) return { reply: 'Clé Anthropic non configurée (Admin → Connexions).', action: null }
  const page = ctx.url || ctx.title ? `Page: ${(ctx.title || '').slice(0, 200)} (${(ctx.url || '').slice(0, 200)})\n` : ''
  const r = await callClaude({
    task: 'classify', agent: `Jarvis ${ctx.channel || 'web'}`, system: SYSTEM,
    messages: [{ role: 'user', content: `${page}Directive: ${message}` }],
  })
  if (r.blocked) return { reply: r.error || 'Budget IA épuisé.', action: null }
  return (parseJson<PlanResult>(r.text)) || { reply: r.text.trim() || '…', action: null }
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

async function personOrAccountLead(name: string, url: string): Promise<Lead> {
  const id = await identifyLead({ name, url })
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

// 2) EXÉCUTER — dans l'espace `ws`. Renvoie un texte lisible (canal-agnostique).
export async function executeJarvis(action: any, ws: string, ctxUrl = ''): Promise<string> {
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
      for (const c of list) {
        await upsertLead({
          id: newId(), kind: 'account', firstName: '', lastName: '', title: '', company: c.name,
          score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
          siren: /^\d{9}$/.test(c.id) ? c.id : undefined, active: true,
          naf: c.naf || undefined, city: c.city || undefined, dirigeant: c.dirigeant || undefined,
          effectif: c.effectif || undefined, website: c.website || undefined,
        }, ws)
        n++
      }
      return `✅ ${n} compte(s) importé(s) dans le pipe :\n${lines.join('\n')}${list.length > 10 ? `\n… +${list.length - 10} autres` : ''}`
    }

    // Recherche web sur une PERSONNE (poste, actualité) — coûte des tokens.
    case 'research_person': {
      const who = [action.name, action.company].filter(Boolean).join(' · ')
      if (!action.name) return 'Précise le nom de la personne.'
      const r = await callClaude({
        task: 'extract', agent: 'Jarvis · actualité personne',
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
      const web = await enrichCompanyWeb(v.name || action.company, v.city, v.siren)
      return [
        `${v.name} — SIREN ${v.siren}${v.active === false ? ' (radiée)' : ' (active)'}`,
        [v.naf && `NAF ${v.naf}`, v.city, v.effectif && `${v.effectif} sal.`, v.dirigeant && `dir. ${v.dirigeant}`].filter(Boolean).join(' · '),
        web.ca && `CA : ${web.ca}`, web.website && `Site : ${web.website}`,
        web.summary && `\n${web.summary}`,
      ].filter(Boolean).join('\n')
    }

    case 'add_company': {
      const acc = await accountLeadFrom(action.company)
      await upsertLead(acc, ws)
      let extra = ''
      if (action.withContacts && acc.siren) {
        const detail = await fetchCompanyDetail(acc.siren)
        const dirs = detail.dirigeants.filter((d) => d.type === 'physique')
        for (const d of dirs) {
          const [firstName, ...rest] = d.name.split(/\s+/)
          await upsertLead({
            id: newId(), kind: 'contact', firstName, lastName: rest.join(' '), title: 'Dirigeant', persona: 'Founder/CEO',
            company: acc.company, score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
            siren: acc.siren, naf: acc.naf, city: acc.city, effectif: acc.effectif, website: acc.website,
          }, ws)
        }
        extra = ` + ${dirs.length} dirigeant(s) en contacts`
      }
      return `✅ Compte « ${acc.company} » ajouté${extra}.`
    }

    case 'add_person': {
      const lead = await personOrAccountLead(action.name, action.url || ctxUrl)
      await upsertLead(lead, ws)
      return `✅ ${isAccount(lead) ? 'Compte' : 'Contact'} « ${action.name} » ajouté.`
    }

    case 'add_to_list': {
      const q = action.name || action.company || ''
      const hits = await findExisting(ws, q)
      let target = hits[0]
      if (!target) { target = action.company ? await accountLeadFrom(action.company) : await personOrAccountLead(action.name, ctxUrl); await upsertLead(target, ws) }
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
      if (!isAccount(target)) { target.stage = 'in_sequence'; await upsertLead(target, ws) }
      seq.leadIds = Array.from(new Set([...(seq.leadIds || []), target.id]))
      seq.enrolled = seq.leadIds.length
      await upsertItem('sequence', seq.id, seq, ws)
      return `✅ ${target.firstName} ${target.lastName} enrôlé dans « ${seq.name} ».`
    }

    case 'set_status': {
      const hits = await findExisting(ws, action.name || '')
      const target = hits.find((l) => !isAccount(l)) || hits[0]
      if (!target) return `Lead « ${action.name} » introuvable.`
      const valid = ['chaud', 'tiede', 'froid', 'converti', 'perdu']
      if (!valid.includes(action.status)) return `Statut invalide.`
      target.status = action.status
      await upsertLead(target, ws)
      return `✅ ${target.firstName || target.company} → statut « ${action.status} ».`
    }

    case 'add_note': {
      const hits = await findExisting(ws, action.name || '')
      const target = hits[0]
      const t = {
        id: `tk_${Math.random().toString(36).slice(2, 9)}`,
        title: String(action.text || 'Note').slice(0, 200), due: "Aujourd'hui", done: false,
        leadId: target?.id, leadName: target ? `${target.firstName} ${target.lastName}`.trim() || target.company : undefined,
      }
      await upsertItem('task', t.id, t, ws)
      return `✅ Note/tâche créée${target ? ` pour ${t.leadName}` : ''}.`
    }

    default:
      return `Action « ${action.type} » non reconnue.`
  }
}
