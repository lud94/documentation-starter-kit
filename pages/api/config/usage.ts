import type { NextApiRequest, NextApiResponse } from 'next'
import { getUsageAll } from '../../../lib/supabase/pappersCache'

// Conso RÉELLE (aucune simulation) : Pappers + IA (appels/tokens/coût), agrégée
// depuis les compteurs, avec un détail par modèle, par agent et par jour.
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
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

  res.status(200).json({
    pappersCalls: g('pappers_calls'),
    ai: {
      calls: g('ai:calls'),
      tokensIn: g('ai:in'),
      tokensOut: g('ai:out'),
      cost: g('ai:cents') / 100,
      byModel: byModel.sort((a, b) => b.cost - a.cost),
      byAgent: byAgent.sort((a, b) => b.cost - a.cost),
      byDay: days,
    },
  })
}
