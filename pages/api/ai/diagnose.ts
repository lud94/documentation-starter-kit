import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { pickModel } from '../../../lib/prospector/llm'
import { buildTag } from '../../../lib/version'

export const config = { maxDuration: 60 }

// Diagnostic IA — teste CHAQUE capacité séparément, avec de tout petits appels,
// et dit laquelle est refusée. Remplace les allers-retours « ça ne marche pas » /
// « qu'est-ce que ça dit exactement ? » par une réponse unique et lisible.
async function probe(key: string, model: string, extra: any): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Réponds juste: OK' }], ...extra }),
    })
    if (r.ok) return { ok: true }
    return { ok: false, detail: (await r.text()).slice(0, 220) }
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 220) }
  }
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const key = getKey('ANTHROPIC_API_KEY')
  const model = pickModel('research')
  if (!key) return res.status(200).json({ build: buildTag(), key: false, message: 'Aucune clé ANTHROPIC_API_KEY dans Admin → Connexions.' })

  // Chaque test est indépendant : un échec n'empêche pas les suivants.
  const [base, effort, search, fetchTool] = await Promise.all([
    probe(key, model, {}),
    probe(key, model, { output_config: { effort: 'low' } }),
    probe(key, model, { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }),
    probe(key, model, { tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 }] }),
  ])

  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    build: buildTag(),
    model,
    key: true,
    tests: {
      'appel simple': base,
      'réglage effort': effort,
      'recherche web': search,
      'lecture de page (web_fetch)': fetchTool,
    },
    // Ce que ça implique concrètement pour la recherche par signal.
    verdict: !base.ok
      ? 'La clé ou le modèle sont en cause : rien ne peut fonctionner tant que « appel simple » échoue.'
      : !search.ok
        ? "La recherche web est refusée sur cette clé : la veille par signal ne peut pas fonctionner. Active l'outil de recherche web côté Anthropic, ou branche Exa."
        : fetchTool.ok
          ? 'Tout est disponible : recherche web + lecture des articles.'
          : "Recherche web disponible, lecture d'article refusée : la couverture sera plus faible (l'agent ne lit que les extraits).",
  })
}
