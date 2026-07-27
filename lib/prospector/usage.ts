// Traçage RÉEL de la consommation IA (aucune donnée simulée).
// Chaque appel Claude enregistre : nb d'appels, tokens in/out, coût estimé (cents),
// avec des buckets journaliers (ai:*:AAAA-MM-JJ) et par modèle (ai:model:*).
// Le coût est calculé à partir des tokens réellement renvoyés par l'API.
import { bumpUsage } from '../supabase/pappersCache'

// Prix indicatifs USD par 1M tokens [entrée, sortie]. Ajustable si besoin.
const PRICE: Record<string, [number, number]> = {
  'claude-opus-4-8': [15, 75],
  'claude-opus-5': [15, 75],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5-20251001': [0.8, 4],
}
function priceFor(model: string): [number, number] {
  if (PRICE[model]) return PRICE[model]
  if (/haiku/i.test(model)) return [0.8, 4]
  if (/sonnet/i.test(model)) return [3, 15]
  return [15, 75] // défaut opus
}

// Enregistre un appel IA. `day` est fourni par l'appelant (Date dispo côté serveur).
export async function recordAiUsage(agent: string, model: string, inTok = 0, outTok = 0): Promise<void> {
  const [pin, pout] = priceFor(model)
  const cents = Math.round(((inTok / 1e6) * pin + (outTok / 1e6) * pout) * 100)
  const day = new Date().toISOString().slice(0, 10)
  try {
    await Promise.all([
      bumpUsage('ai:calls'), bumpUsage('ai:in', inTok), bumpUsage('ai:out', outTok), bumpUsage('ai:cents', cents),
      bumpUsage(`ai:calls:${day}`), bumpUsage(`ai:cents:${day}`),
      bumpUsage(`ai:model:${model}:calls`), bumpUsage(`ai:model:${model}:cents`), bumpUsage(`ai:model:${model}:tok`, inTok + outTok),
      bumpUsage(`ai:agent:${agent}:calls`), bumpUsage(`ai:agent:${agent}:cents`), bumpUsage(`ai:agent:${agent}:tok`, inTok + outTok),
    ])
  } catch { /* best-effort : ne jamais casser l'appel métier */ }
}
