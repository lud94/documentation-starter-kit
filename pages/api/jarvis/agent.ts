import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { callClaude, parseJson } from '../../../lib/prospector/llm'
import { lookupByName, fetchCompanyDetail } from '../../../lib/prospector/datagouv'
import { identifyLead, enrichCompanyWeb } from '../../../lib/prospector/identify'
import { upsertLead } from '../../../lib/supabase/leads'
import { listItems, upsertItem } from '../../../lib/supabase/store'
import { resolveWorkspaceByToken } from '../../../lib/prospector/wstoken'
import type { Lead, Sequence } from '../../../types/prospector'

// Jarvis Phase 2 — agent piloté depuis le WIDGET FLOTTANT de l'extension (hors app).
// Protégé par INGEST_TOKEN (comme /api/ingest/lead), CORS ouvert. Il PLANIFIE avec
// Claude puis EXÉCUTE côté serveur. Écritures = confirmation (2e appel confirm=true).
// Il ne touche JAMAIS à LinkedIn : il ne pilote que Prospector.

const newId = () => `ld_${Math.random().toString(36).slice(2, 10)}`

const SYSTEM = `Tu es Jarvis, copilote de Prospector (prospection B2B). L'utilisateur navigue sur le web
(LinkedIn, fiche Google d'une société…) et te donne une directive. On te fournit l'URL et le titre de la page.
Tu ne fais RIEN sur LinkedIn : tu ne pilotes que Prospector. Réponds UNIQUEMENT en JSON :
{ "reply": "phrase courte en français", "action": ACTION | null }
ACTION (au plus une) :
- { "type":"explain_company", "company":"..." } → expliquer/enrichir une entreprise (lecture).
- { "type":"add_company", "company":"...", "withContacts": true|false } → créer le COMPTE (+ dirigeants en contacts si withContacts).
- { "type":"add_person", "name":"...", "url":"..." } → créer un CONTACT (profil LinkedIn courant).
- { "type":"add_to_list", "company"|"name":"...", "listName":"..." } → ajouter le lead courant à une liste (créée si absente).
- { "type":"add_to_sequence", "company"|"name":"...", "sequenceName":"..." } → enrôler le lead courant dans une séquence EXISTANTE.
Déduis "company"/"name" du message et du titre/URL de la page. Si rien de pertinent, action=null.`

async function planWithClaude(message: string, url: string, title: string) {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { reply: 'Configure la clé Anthropic dans Prospector (Admin → Connexions).', action: null }
  // Tâche de classification/routage → modèle économique (Haiku par défaut).
  const r = await callClaude({
    task: 'classify', agent: 'Jarvis extension', system: SYSTEM,
    messages: [{ role: 'user', content: `Page: ${(title || '').slice(0, 200)} (${(url || '').slice(0, 200)})\nDirective: ${message}` }],
  })
  if (r.blocked) return { reply: r.error, action: null }
  return parseJson(r.text) || { reply: r.text.trim() || '…', action: null }
}

async function accountLeadFrom(company: string): Promise<Lead> {
  const v = await lookupByName(company)
  return {
    id: newId(), kind: 'account', firstName: '', lastName: '', title: '', company: v.name || company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren: v.siren, active: v.active, naf: v.naf, city: v.city, dirigeant: v.dirigeant, effectif: v.effectif, website: v.website,
  }
}

// Construit un lead (contact si /in/ ou nom de personne, sinon compte).
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

// Résumé texte lisible d'une entreprise (data.gouv + web).
async function explainCompany(company: string): Promise<string> {
  const v = await lookupByName(company)
  if (!v.found) return `Je n'ai pas trouvé « ${company} » sur data.gouv. Précise le nom exact.`
  const web = await enrichCompanyWeb(v.name || company, v.city, v.siren)
  const lines = [
    `${v.name} — SIREN ${v.siren}${v.active === false ? ' (radiée)' : ' (active)'}`,
    v.naf && `NAF ${v.naf}`, v.city && `Ville : ${v.city}`, v.effectif && `Effectif : ${v.effectif}`,
    v.dirigeant && `Dirigeant : ${v.dirigeant}`, web.ca && `CA : ${web.ca}`, web.website && `Site : ${web.website}`,
    web.summary && `\n${web.summary}`,
  ].filter(Boolean)
  return lines.join(' · ').replace(' · \n', '\n')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ingest-token')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  await hydrateKeystore()
  const ref = getKey('INGEST_TOKEN')
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const token = String(req.headers['x-ingest-token'] || body?.token || '')
  if (!ref) return res.status(401).json({ error: 'Aucun jeton configuré côté Prospector.' })
  // Multi-tenant : le jeton détermine l'espace (admin ou client) où tout est écrit.
  const ws = await resolveWorkspaceByToken(token)
  if (!ws) return res.status(401).json({ error: 'Jeton invalide.' })

  const message = String(body?.message || '')
  const url = String(body?.url || '')
  const title = String(body?.title || '')
  const confirm = !!body?.confirm
  let action = body?.action || null

  try {
    if (!confirm) {
      const plan = await planWithClaude(message, url, title)
      action = plan.action
      // Lecture → on exécute et on renvoie le résumé. Écriture → on demande confirmation.
      if (action?.type === 'explain_company') {
        return res.status(200).json({ reply: plan.reply, result: await explainCompany(action.company) })
      }
      const writes = ['add_company', 'add_person', 'add_to_list', 'add_to_sequence']
      if (action && writes.includes(action.type)) {
        return res.status(200).json({ reply: plan.reply, action, needsConfirm: true })
      }
      return res.status(200).json({ reply: plan.reply || 'Je n\'ai pas d\'action à proposer ici.', action: null })
    }

    // Exécution confirmée (écriture) — tout est écrit dans l'espace `ws`.
    if (action?.type === 'add_company') {
      const acc = await accountLeadFrom(action.company)
      await upsertLead(acc, ws)
      let extra = ''
      if (action.withContacts && acc.siren) {
        const detail = await fetchCompanyDetail(acc.siren)
        const dirs = detail.dirigeants.filter((d) => d.type === 'physique')
        for (const d of dirs) {
          const [firstName, ...rest] = d.name.split(/\s+/)
          const c: Lead = { id: newId(), kind: 'contact', firstName, lastName: rest.join(' '), title: 'Dirigeant', persona: 'Founder/CEO', company: acc.company, score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null, siren: acc.siren, naf: acc.naf, city: acc.city, effectif: acc.effectif, website: acc.website }
          await upsertLead(c, ws)
        }
        extra = ` + ${dirs.length} dirigeant(s) en contacts`
      }
      return res.status(200).json({ reply: `Compte « ${acc.company} » ajouté à Prospector${extra}.`, done: true })
    }
    if (action?.type === 'add_person') {
      const lead = await personOrAccountLead(action.name, action.url || url)
      await upsertLead(lead, ws)
      return res.status(200).json({ reply: `${lead.kind === 'contact' ? 'Contact' : 'Compte'} « ${action.name} » ajouté à Prospector.`, done: true })
    }
    if (action?.type === 'add_to_list') {
      const target = action.company ? await accountLeadFrom(action.company) : await personOrAccountLead(action.name, url)
      await upsertLead(target, ws)
      const lists = await listItems<any>('list', ws)
      let list = lists.find((l) => (l.name || '').toLowerCase() === String(action.listName || '').toLowerCase())
      if (!list) list = { id: `ls_${Math.random().toString(36).slice(2, 9)}`, name: action.listName || 'Liste', leadIds: [], source: 'via Jarvis' }
      if (!list.leadIds.includes(target.id)) list.leadIds.push(target.id)
      await upsertItem('list', list.id, list, ws)
      return res.status(200).json({ reply: `Ajouté à la liste « ${list.name} ».`, done: true })
    }
    if (action?.type === 'add_to_sequence') {
      const target = action.company ? await accountLeadFrom(action.company) : await personOrAccountLead(action.name, url)
      const seqs = await listItems<Sequence>('sequence', ws)
      const seq = seqs.find((s) => (s.name || '').toLowerCase().includes(String(action.sequenceName || '').toLowerCase()))
      if (!seq) return res.status(200).json({ reply: `Séquence « ${action.sequenceName} » introuvable.`, done: true })
      if (target.kind !== 'account') { target.stage = 'in_sequence' }
      await upsertLead(target, ws)
      seq.leadIds = Array.from(new Set([...(seq.leadIds || []), target.id]))
      seq.enrolled = seq.leadIds.length
      await upsertItem('sequence', seq.id, seq, ws)
      return res.status(200).json({ reply: `Enrôlé dans « ${seq.name} ».`, done: true })
    }
    return res.status(200).json({ reply: 'Rien à exécuter.', done: true })
  } catch (e: any) {
    return res.status(200).json({ reply: 'Erreur : ' + (e?.message || 'agent indisponible'), action: null })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
