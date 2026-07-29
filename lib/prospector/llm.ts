// Point de contrôle UNIQUE des appels LLM — coût maîtrisé.
// 1) Routage par TÂCHE : un modèle bon marché pour le trivial, un modèle fort
//    seulement là où la qualité se voit. (Opus ≈ 19× le prix de Haiku.)
// 2) Prompt caching : le system prompt répété n'est plus repayé plein tarif.
// 3) Garde-fou budget : si le crédit saisi est épuisé, on REFUSE l'appel.
// 4) Cache de résultats : on ne repaie pas deux fois la même question.
import { getKey } from './keystore'
import { recordAiUsage } from './usage'
import { getUsageAll } from '../supabase/pappersCache'
import { listItems, upsertItem } from '../supabase/store'

export type LlmTask = 'chat' | 'classify' | 'plan' | 'extract' | 'write' | 'research'

// Défauts ÉCONOMIQUES par tâche. Surchargeables sans toucher au code.
const TASK_MODEL: Record<LlmTask, { model: string; override: string; maxTokens: number }> = {
  // Conversation Jarvis + classification : volume élevé, faible exigence → Haiku.
  chat:     { model: 'claude-haiku-4-5-20251001', override: 'JARVIS_MODEL',  maxTokens: 600 },
  classify: { model: 'claude-haiku-4-5-20251001', override: 'JARVIS_MODEL',  maxTokens: 400 },
  // Planification de mission : raisonnement structuré → Sonnet (5× moins cher qu'Opus).
  plan:     { model: 'claude-sonnet-5',            override: 'PLAN_MODEL',    maxTokens: 1100 },
  // Extraction / enrichissement web : Sonnet suffit largement.
  extract:  { model: 'claude-sonnet-5',            override: 'ENRICH_MODEL',  maxTokens: 900 },
  // Rédaction commerciale : la qualité se voit côté prospect → Sonnet par défaut.
  write:    { model: 'claude-sonnet-5',            override: 'WRITE_MODEL',   maxTokens: 900 },
  // Recherche de signaux (le plus qualitatif) → configurable via SIGNALS_MODEL.
  research: { model: 'claude-sonnet-5',            override: 'SIGNALS_MODEL', maxTokens: 1600 },
}

export function pickModel(task: LlmTask): string {
  const t = TASK_MODEL[task]
  return getKey(t.override) || t.model
}

// ── Garde-fou budget : bloque tout appel si le crédit saisi est consommé. ──
export async function budgetLeft(): Promise<{ budget: number; spent: number; blocked: boolean }> {
  try {
    const all = await getUsageAll()
    const spent = (all['ai:cents'] || 0) / 100
    const budget = parseFloat(getKey('ANTHROPIC_BUDGET') || '') || 0
    return { budget, spent, blocked: budget > 0 && spent >= budget }
  } catch { return { budget: 0, spent: 0, blocked: false } }
}

// ── Cache de résultats (évite de repayer la même question) ──
const CACHE_KIND = 'aicache'
const CACHE_WS = '_cache'
const TTL_MS = 7 * 24 * 3600 * 1000 // 7 jours

async function cacheGet(key: string): Promise<string | null> {
  try {
    const items = await listItems<{ id: string; text: string; at: number }>(CACHE_KIND, CACHE_WS)
    const hit = items.find((x) => x.id === key)
    if (!hit) return null
    if (Date.now() - (hit.at || 0) > TTL_MS) return null
    return hit.text
  } catch { return null }
}
async function cacheSet(key: string, text: string): Promise<void> {
  try { await upsertItem(CACHE_KIND, key, { id: key, text, at: Date.now() }, CACHE_WS) } catch { /* best-effort */ }
}
// Clé de cache courte et stable (hash simple, pas de dépendance).
export function cacheKey(parts: string[]): string {
  const s = parts.join('|').toLowerCase()
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return `c${Math.abs(h).toString(36)}`
}

export interface CallOpts {
  task: LlmTask
  agent: string                 // libellé pour le suivi de conso
  system: string
  messages: any[]
  maxTokens?: number
  tools?: any[]
  cache?: string                // si fourni : réutilise/enregistre le résultat
}

export interface CallResult { text: string; cached?: boolean; blocked?: boolean; error?: string }

// Appel Claude centralisé : budget → cache → API (avec prompt caching) → suivi conso.
export async function callClaude(o: CallOpts): Promise<CallResult> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { text: '', error: 'off' }

  if (o.cache) { const hit = await cacheGet(o.cache); if (hit) return { text: hit, cached: true } }

  const guard = await budgetLeft()
  if (guard.blocked) return { text: '', blocked: true, error: `Crédit Anthropic épuisé (${guard.spent.toFixed(2)} $ / ${guard.budget.toFixed(2)} $). Recharge puis mets à jour le montant dans Admin → Usage.` }

  const model = pickModel(o.task)
  const maxTokens = o.maxTokens || TASK_MODEL[o.task].maxTokens

  const body: any = {
    model,
    max_tokens: maxTokens,
    // Prompt caching : le system prompt (identique d'un appel à l'autre) est mis
    // en cache côté Anthropic → tokens d'entrée répétés facturés ~10%.
    system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    messages: o.messages,
  }
  if (o.tools) body.tools = o.tools

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Anthropic ${r.status} — ${(await r.text()).slice(0, 150)}`)
  const data = await r.json()

  // Les tokens lus depuis le cache sont facturés ~10% → on les compte à part.
  const u = data.usage || {}
  const cachedIn = (u.cache_read_input_tokens || 0)
  await recordAiUsage(o.agent, model, (u.input_tokens || 0) + Math.round(cachedIn * 0.1), u.output_tokens || 0)

  const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  if (o.cache && text) await cacheSet(o.cache, text)
  return { text }
}

// Extrait le premier objet JSON d'une réponse (utilitaire commun).
export function parseJson<T = any>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
