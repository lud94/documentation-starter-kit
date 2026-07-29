import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { callClaude, parseJson } from '../../../lib/prospector/llm'

// Jarvis (copilote in-app) — Phase 1. Claude « planificateur » : à partir du message
// et d'un CONTEXTE compact (compté côté client), il répond ET propose AU PLUS une
// action. L'EXÉCUTION se fait côté client, avec confirmation pour toute écriture.
const SYSTEM = `Tu es Jarvis, le copilote de Prospector (prospection B2B pour une agence).
Tu aides l'utilisateur à piloter SA plateforme : répondre à ses questions sur ses données
et proposer UNE action à exécuter. Tu ne fais JAMAIS d'action sur LinkedIn directement.

On te donne un CONTEXTE (compteurs, listes, séquences). Sers-t'en, n'invente rien.
Réponds UNIQUEMENT en JSON valide, sans texte autour :
{ "reply": "phrase courte en français", "action": ACTION | null }

ACTION possible (au plus une) :
- { "type":"search_leads", "persona"?, "status"?, "stage"?, "query"? } → filtrer/afficher des contacts.
- { "type":"create_list", "name", "filter"?:{ "persona"?, "status"?, "stage"? } } → créer une liste (éventuellement depuis un filtre).
- { "type":"add_to_sequence", "sequenceName", "filter"?:{ "persona"?, "status"?, "stage"? } } → enrôler des contacts dans une séquence EXISTANTE (nom exact du contexte).
- { "type":"enrich_company", "company" } → vérifier + enrichir une entreprise via data.gouv/web.

Valeurs : persona ∈ [Founder/CEO, Sales, Marketing, Ops] ; status ∈ [chaud,tiede,froid,converti,perdu] ;
stage ∈ [to_invite,invited,connected,in_sequence,responded,meeting,closed].
Si aucune action n'est pertinente, mets action=null et réponds directement dans reply.
Pour une écriture (create_list/add_to_sequence/enrich_company), reply doit décrire ce qui sera fait (l'utilisateur confirmera).`

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return res.status(200).json({ reply: 'Configure ta clé Anthropic (Admin → Connexions) pour activer Jarvis.', action: null, off: true })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  // Économie : 4 derniers messages (au lieu de 8) — le contexte utile reste le même.
  const history = Array.isArray(body?.messages) ? body.messages.slice(-4) : []
  const context = body?.context || {}

  const messages = [
    { role: 'user', content: `CONTEXTE (données de l'utilisateur):\n${JSON.stringify(context)}` },
    ...history.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1500) })),
  ]

  try {
    const r = await callClaude({ task: 'chat', agent: 'Jarvis', system: SYSTEM, messages })
    if (r.blocked) return res.status(200).json({ reply: r.error, action: null })
    const parsed: any = parseJson(r.text) || { reply: r.text.trim() || '…', action: null }
    res.status(200).json({ reply: parsed.reply || '…', action: parsed.action || null })
  } catch (e: any) {
    res.status(200).json({ reply: 'Jarvis est momentanément indisponible (' + (e?.message || 'erreur') + ').', action: null })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
