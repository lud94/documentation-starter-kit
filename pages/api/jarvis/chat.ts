import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { recordAiUsage } from '../../../lib/prospector/usage'

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
  const history = Array.isArray(body?.messages) ? body.messages.slice(-8) : []
  const context = body?.context || {}
  const model = getKey('SIGNALS_MODEL') || 'claude-opus-4-8'

  const messages = [
    { role: 'user', content: `CONTEXTE (données de l'utilisateur):\n${JSON.stringify(context)}` },
    ...history.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
  ]

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 700, system: SYSTEM, messages }),
    })
    if (!r.ok) throw new Error(`Anthropic ${r.status}`)
    const data = await r.json()
    await recordAiUsage('Jarvis', model, data.usage?.input_tokens, data.usage?.output_tokens)
    const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    const m = text.match(/\{[\s\S]*\}/)
    let parsed: any = { reply: text.trim() || '…', action: null }
    if (m) { try { parsed = JSON.parse(m[0]) } catch { /* garde le texte */ } }
    res.status(200).json({ reply: parsed.reply || '…', action: parsed.action || null })
  } catch (e: any) {
    res.status(200).json({ reply: 'Jarvis est momentanément indisponible (' + (e?.message || 'erreur') + ').', action: null })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
