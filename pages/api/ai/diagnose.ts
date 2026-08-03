import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { pickModel, anthropicPost } from '../../../lib/prospector/llm'
import { buildTag } from '../../../lib/version'

export const config = { maxDuration: 60 }

// Diagnostic IA — teste CHAQUE capacité séparément, avec de tout petits appels,
// et dit laquelle est refusée. Remplace les allers-retours « ça ne marche pas » /
// « qu'est-ce que ça dit exactement ? » par une réponse unique et lisible.
//
// ⚠️ CONTOURNEMENT CORRIGÉ (lot C2a-0). Cette route émettait ses quatre appels
// avec son propre `fetch` : ils échappaient au garde-fou budgétaire ET n'étaient
// jamais comptés dans prospector_usage. Petits (max_tokens: 64) mais réels, et la
// route est atteignable depuis l'Admin. Tout passe désormais par anthropicPost(),
// la passerelle unique — c'est là que C2a posera la réservation.
// Depuis C2a-2, ces quatre sondes sont réservées et comptées comme n'importe
// quel appel : elles passent par la passerelle, qui pose la réservation. Un refus
// budgétaire est rapporté DISTINCTEMENT d'un échec de capacité — sinon l'écran
// dirait « la clé est en cause » alors que c'est le plafond.
async function probe(key: string, model: string, extra: any): Promise<{ ok: boolean; blocked?: boolean; detail?: string }> {
  try {
    const r = await anthropicPost(key, {
      model, max_tokens: 64, messages: [{ role: 'user', content: 'Réponds juste: OK' }], ...extra,
    }, { agent: 'diagnose', task: 'research' })
    if (r.blocked) return { ok: false, blocked: true, detail: (r.blockedDetail || 'Appel refusé par le garde budgétaire.').slice(0, 220) }
    if (r.ok) return { ok: true }
    return { ok: false, detail: r.text.slice(0, 220) }
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

  // ⚠️ UN REFUS BUDGÉTAIRE N'EST PAS UNE INCAPACITÉ. Sans ce tri, une sonde
  // bloquée par le garde se lisait comme un défaut de la clé, du modèle ou de
  // l'outil — et le cas est loin d'être théorique : la sonde `web_fetch` ne
  // déclare pas `max_content_tokens`, donc en ENFORCE avec un plafond positif
  // elle est refusée pour estimation incomplète. Le verdict aurait annoncé
  // « lecture d'article refusée », c'est-à-dire une conclusion fausse sur la
  // clé Anthropic. La règle est donc : DÈS QU'UNE sonde est bloquée, le verdict
  // parle du budget et de rien d'autre.
  const probes = [
    ['appel simple', base], ['réglage effort', effort],
    ['recherche web', search], ['lecture de page (web_fetch)', fetchTool],
  ] as const
  const blocked = probes.filter(([, p]) => p.blocked)

  const verdict = blocked.length
    ? `Refus du garde budgétaire sur ${blocked.length} sonde(s) : ${blocked.map(([n]) => n).join(', ')}. `
      + 'Ce n\'est PAS un problème de clé, de modèle ni d\'outil — ces capacités n\'ont pas été testées. '
      + 'Vérifier le plafond ET le passif d\'engagements non résolus dans Admin → Usage, '
      + `puis relancer. Motif : ${blocked[0][1].detail || 'non précisé'}`
    : !base.ok
      ? 'La clé ou le modèle sont en cause : rien ne peut fonctionner tant que « appel simple » échoue.'
      : !search.ok
        ? "La recherche web est refusée sur cette clé : la veille par signal ne peut pas fonctionner. Active l'outil de recherche web côté Anthropic, ou branche Exa."
        : fetchTool.ok
          ? 'Tout est disponible : recherche web + lecture des articles.'
          : "Recherche web disponible, lecture d'article refusée : la couverture sera plus faible (l'agent ne lit que les extraits)."

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
    // Vrai dès qu'une sonde a été refusée avant émission : l'écran doit pouvoir
    // distinguer « non testé » de « testé et refusé par Anthropic ».
    budgetBlocked: blocked.length > 0,
    // Ce que ça implique concrètement pour la recherche par signal.
    verdict,
  })
}
