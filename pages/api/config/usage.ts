import type { NextApiRequest, NextApiResponse } from 'next'
import { getUsageAll } from '../../../lib/supabase/pappersCache'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { budgetLeft } from '../../../lib/prospector/llm'
import { isAdminRequest } from '../../../lib/auth/guard'

/**
 * Conso RÉELLE (aucune simulation) : Pappers + IA, agrégée depuis les
 * compteurs — ADMINISTRATEUR UNIQUEMENT (lot SEC-AUTH-2).
 *
 * ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
 * La signature était `handler(_req, res)` : l'identité était ignorée, et le
 * middleware n'exige qu'une session VALIDE. Un CLIENT recevait donc la
 * consommation GLOBALE de la plateforme — appels, jetons, coûts par modèle, par
 * agent et par jour — ainsi que le budget Anthropic restant. C'est-à-dire
 * l'activité agrégée de TOUS les espaces, y compris ceux de ses concurrents,
 * et le train de dépense de Smart.AI.
 *
 * Ces compteurs ne sont PAS cloisonnés par espace : il n'y a donc rien à
 * projeter pour un client ici. La vue par tenant relève de MT-1, pas de ce lot.
 *
 * La garde est la première opération : ni hydratation, ni lecture de compteurs,
 * ni `budgetLeft()` avant elle.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Réservé aux administrateurs.' })
  await hydrateKeystore()
  const all = await getUsageAll()
  const g = (k: string) => all[k] || 0

  // Détail par modèle / agent / jour à partir des clés préfixées.
  const byModel: { model: string; calls: number; tokens: number; cost: number }[] = []
  const byAgent: { agent: string; calls: number; tokens: number; cost: number }[] = []
  const byDay: Record<string, { calls: number; cost: number }> = {}
  for (const key of Object.keys(all)) {
    let m = key.match(/^ai:model:(.+):calls$/)
    if (m) { byModel.push({ model: m[1], calls: all[key], tokens: g(`ai:model:${m[1]}:tok`), cost: g(`ai:model:${m[1]}:cents`) / 100 }); continue }
    m = key.match(/^ai:agent:(.+):calls$/)
    if (m) { byAgent.push({ agent: m[1], calls: all[key], tokens: g(`ai:agent:${m[1]}:tok`), cost: g(`ai:agent:${m[1]}:cents`) / 100 }); continue }
    m = key.match(/^ai:calls:(\d{4}-\d{2}-\d{2})$/)
    if (m) { byDay[m[1]] = { calls: all[key], cost: g(`ai:cents:${m[1]}`) / 100 } }
  }
  const days = Object.keys(byDay).sort().reverse().slice(0, 14).map((d) => ({ day: d, ...byDay[d] }))

  // Le garde-fou est interrogé par la MÊME fonction que le chemin d'appel, et non
  // recalculé ici : deux calculs parallèles finiraient par diverger, et l'Admin
  // afficherait « budget disponible » pendant que les appels sont refusés.
  const guard = await budgetLeft()
  const budget = guard.budget
  // Le détail chiffré ci-dessous vient de getUsageAll(), qui se replie en mémoire :
  // il est indicatif. `guard.state` est la seule source d'autorité sur l'état réel.
  const spent = guard.spent ?? g('ai:cents') / 100

  res.status(200).json({
    pappersCalls: g('pappers_calls'),
    budget: {
      anthropic: budget,                         // montant chargé (saisi manuellement)
      spent,                                      // coût IA réel cumulé
      remaining: budget > 0 && guard.spent !== null ? Math.max(0, budget - guard.spent) : null,
      // 'not_configured' | 'available' | 'budget_exhausted' | 'usage_unavailable'
      state: guard.state,
      blocked: guard.blocked,
      reason: guard.reason || null,
      // Vrai quand le chiffre affiché ne provient PAS d'une lecture durable.
      degraded: guard.state === 'usage_unavailable',
    },
    ai: {
      calls: g('ai:calls'),
      tokensIn: g('ai:in'),
      tokensOut: g('ai:out'),
      cost: spent,
      byModel: byModel.sort((a, b) => b.cost - a.cost),
      byAgent: byAgent.sort((a, b) => b.cost - a.cost),
      byDay: days,
    },
  })
}
