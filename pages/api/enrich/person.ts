import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { callClaude, cacheKey } from '../../../lib/prospector/llm'

// Recherche web FACTUELLE sur une personne (contexte professionnel uniquement).
// Mise en cache 7 j : rechercher deux fois la même personne ne coûte rien.
const SYSTEM = `Tu es analyste commercial B2B. Recherche sur le web des informations PUBLIQUES et
PROFESSIONNELLES sur une personne : poste actuel, entreprise, parcours visible, prises de parole,
actualités récentes utiles à une prise de contact.
RÈGLES : n'invente RIEN (si tu ne trouves pas, dis-le clairement) ; aucune donnée de vie privée
(domicile, famille, coordonnées personnelles, opinions) ; cite la source quand tu l'as.
Réponds en français, 5 phrases maximum, ton factuel.`

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  if (!getKey('ANTHROPIC_API_KEY')) return res.status(200).json({ error: 'Clé Anthropic non configurée (Admin → Connexions).' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const name = String(body?.name || '').trim()
  const company = String(body?.company || '').trim()
  const linkedinUrl = String(body?.linkedinUrl || '').trim()
  if (!name) return res.status(400).json({ error: 'name requis' })

  try {
    const r = await callClaude({
      task: 'extract', agent: 'Recherche personne', system: SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: `Personne : ${name}${company ? ` · société ${company}` : ''}${linkedinUrl ? ` · ${linkedinUrl}` : ''}.\nQue sait-on d'elle professionnellement ?` }],
      cache: cacheKey(['person', name, company]),
    })
    if (r.blocked) return res.status(200).json({ error: r.error })
    res.status(200).json({ profile: r.text.trim(), cached: !!r.cached })
  } catch (e: any) {
    res.status(200).json({ error: e?.message || 'Recherche indisponible.' })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
