import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { callClaude, cacheKey } from '../../../lib/prospector/llm'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// ACTUALITÉ & PRESSE sur une personne — volontairement COMPLÉMENTAIRE de LinkedIn
// (qui sera couvert par Unipile). LinkedIn est bloqué au niveau de l'outil : on ne
// veut que ce que LinkedIn NE dit PAS. Mise en cache 7 j.
const SYSTEM = `Tu es analyste de veille commerciale B2B (France). On te donne une personne et son entreprise.
Ton rôle : trouver ce que LinkedIn NE dit PAS — l'actualité et les traces publiques hors réseau social.

CHERCHE EN PRIORITÉ (et rien d'autre) :
• presse économique et sectorielle (Les Échos, JDN, Journal des Entreprises, Maddyness, Usine Digitale, presse régionale) ;
• communiqués, levées de fonds, rachats, nominations, changements de direction ;
• interviews, tribunes, podcasts, interventions en conférence ou salon ;
• site officiel de l'entreprise (page équipe/dirigeants), annuaires professionnels.

N'UTILISE PAS LinkedIn ni les réseaux sociaux comme source : ils sont couverts ailleurs.

RÈGLES STRICTES :
1. ANTI-HOMONYME : ne retiens une information que si elle est reliée à CETTE personne DANS CETTE entreprise
   (ou une entreprise de son parcours clairement identifiée). Dans le doute, écarte l'information et dis-le.
2. N'INVENTE RIEN. Si tu ne trouves rien de pertinent, réponds exactement :
   "Aucune actualité publique trouvée hors LinkedIn."
3. Privilégie les 18 derniers mois et DATE chaque élément.
4. Aucune donnée de vie privée (domicile, famille, coordonnées personnelles, opinions politiques).
5. Cite la source (média + date) pour chaque élément.

FORMAT : français, 5 phrases maximum, ton factuel, sans formule commerciale. Termine si possible par
une ligne « Angle d'accroche : … » qui exploite l'actualité trouvée.`

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })

  if (!getKey('ANTHROPIC_API_KEY')) return res.status(200).json({ error: 'Clé Anthropic non configurée (Admin → Connexions).' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const name = String(body?.name || '').trim()
  const company = String(body?.company || '').trim()
  if (!name) return res.status(400).json({ error: 'name requis' })

  try {
    const r = await callClaude({
      tenant,
      task: 'extract', agent: 'Recherche personne', system: SYSTEM,
      // LinkedIn bloqué à la SOURCE : une simple consigne texte ne suffit pas.
      tools: [{
        type: 'web_search_20250305', name: 'web_search', max_uses: 3,
        blocked_domains: ['linkedin.com', 'www.linkedin.com', 'fr.linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com'],
        user_location: { type: 'approximate', country: 'FR' },
      }],
      messages: [{ role: 'user', content: `Personne : ${name}${company ? ` · société ${company}` : ''}.\nCherche son actualité et ses traces publiques HORS LinkedIn (presse, communiqués, interviews, conférences).` }],
      cache: cacheKey(['person-news', name, company]),
    })
    if (r.blocked) return res.status(200).json({ error: r.error })
    res.status(200).json({ profile: r.text.trim(), cached: !!r.cached })
  } catch (e: any) {
    res.status(200).json({ error: e?.message || 'Recherche indisponible.' })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
