// Point de contrôle UNIQUE des appels LLM — coût maîtrisé.
// 1) Routage par TÂCHE : un modèle bon marché pour le trivial, un modèle fort
//    seulement là où la qualité se voit. (Opus ≈ 19× le prix de Haiku.)
// 2) Prompt caching : le system prompt répété n'est plus repayé plein tarif.
// 3) Garde-fou budget : si le crédit saisi est épuisé, on REFUSE l'appel.
// 4) Cache de résultats : on ne repaie pas deux fois la même question.
import { getKey } from './keystore'
import { withBuild } from '../version'
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
  // ⚠️ maxTokens borne la RÉFLEXION + le texte : sur claude-sonnet-5 la réflexion
  // adaptative est active par défaut, donc un plafond serré tronque le JSON en
  // silence (parseHits renvoie alors [] → « aucun résultat » sans erreur).
  research: { model: 'claude-sonnet-5',            override: 'SIGNALS_MODEL', maxTokens: 8000 },
}

// L'option `effort` n'existe pas sur Haiku : on ne l'envoie que si le modèle la
// supporte, sinon l'API renvoie 400 (et donc zéro résultat).
function supportsEffort(model: string): boolean { return !/haiku/i.test(model) }

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

export interface CallResult { text: string; cached?: boolean; blocked?: boolean; error?: string; truncated?: boolean }

// Appel Claude centralisé : budget → cache → API (avec prompt caching) → suivi conso.
export async function callClaude(o: CallOpts): Promise<CallResult> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { text: '', error: 'off' }

  const model = pickModel(o.task)
  // La clé de cache inclut le MODÈLE : changer de modèle doit invalider le cache,
  // sinon on ressert indéfiniment la réponse d'un modèle qu'on n'utilise plus.
  const cacheId = o.cache ? `${o.cache}-${model.replace(/[^a-z0-9]/gi, '')}` : ''
  if (cacheId) { const hit = await cacheGet(cacheId); if (hit) return { text: hit, cached: true } }

  const guard = await budgetLeft()
  if (guard.blocked) return { text: '', blocked: true, error: `Crédit Anthropic épuisé (${guard.spent.toFixed(2)} $ / ${guard.budget.toFixed(2)} $). Recharge puis mets à jour le montant dans Admin → Usage.` }

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
  // Effort modéré : suffisant pour ces tâches, et borne la réflexion (donc le coût).
  if (supportsEffort(model)) body.output_config = { effort: o.task === 'research' ? 'medium' : 'low' }

  let messages = o.messages
  let text = ''
  let truncated = false
  let inTokens = 0
  let outTokens = 0

  // Les outils serveur (recherche web) tournent dans une boucle côté Anthropic.
  // Quand elle atteint sa limite, la réponse s'arrête avec stop_reason
  // « pause_turn » : il faut RENVOYER la conversation pour qu'elle reprenne.
  // Sans ça, on récupérait une réponse tronquée — donc zéro entreprise, sans erreur.
  for (let turn = 0; turn < 4; turn++) {
    body.messages = messages
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(withBuild(`Anthropic ${r.status} — ${(await r.text()).slice(0, 150)}`))
    const data = await r.json()

    const u = data.usage || {}
    inTokens += (u.input_tokens || 0) + Math.round((u.cache_read_input_tokens || 0) * 0.1)
    outTokens += u.output_tokens || 0

    text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    truncated = data.stop_reason === 'max_tokens'

    if (data.stop_reason !== 'pause_turn') break
    // Reprise : on rejoue la question + la réponse partielle, l'API continue seule.
    messages = [...o.messages, { role: 'assistant', content: data.content }]
  }

  await recordAiUsage(o.agent, model, inTokens, outTokens)

  // Une réponse tronquée n'est PAS mise en cache : sinon on resservirait un
  // résultat inexploitable pendant 7 jours, sans moyen de l'invalider depuis l'UI.
  if (cacheId && text && !truncated) await cacheSet(cacheId, text)
  return { text, truncated }
}

// Extrait le premier objet JSON d'une réponse (utilitaire commun).
export function parseJson<T = any>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
