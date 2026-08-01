// Point de contrôle UNIQUE des appels LLM — coût maîtrisé.
// 1) Routage par TÂCHE : un modèle bon marché pour le trivial, un modèle fort
//    seulement là où la qualité se voit. (Opus ≈ 19× le prix de Haiku.)
// 2) Prompt caching : le system prompt répété n'est plus repayé plein tarif.
// 3) Garde-fou budget : si le crédit saisi est épuisé, on REFUSE l'appel.
// 4) Cache de résultats : on ne repaie pas deux fois la même question.
import { getKey } from './keystore'
import { withBuild } from '../version'
import { recordAiUsage } from './usage'
import { readUsageDurable } from '../supabase/pappersCache'
import { writeAllowed } from '../env'
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

// ── Garde-fou budget — FAIL-SAFE (lot C1) ─────────────────────────────────────
//
// Défaut corrigé (classé P0). L'ancienne version était fail-open sur toute sa
// longueur : `getUsageAll()` renvoie {} quand la table est inaccessible, donc
// `spent = 0`, donc `blocked = false` ; et le `catch` final renvoyait lui aussi
// un état non bloquant. Une base momentanément indisponible ne dégradait pas le
// contrôle de dépense : elle le supprimait.
//
// Règle retenue : **un budget positif configuré exige une consommation lue de
// façon durable.** À défaut, on refuse l'appel payant. Refuser à tort coûte une
// erreur visible ; autoriser à tort coûte de l'argent réel, silencieusement.
//
// ⚠️ PÉRIMÈTRE C1 — le P0 est fortement mitigé, PAS fermé. Cas résiduel connu :
// une écriture de consommation peut échouer APRÈS un appel alors que les lectures
// suivantes restent disponibles (base en lecture seule, quota d'écriture, droit
// retiré). Le compteur reste obsolète et la fonction ci-dessous lit une valeur
// périmée en toute confiance — pour elle, la lecture a réussi.
//
// Ce lot ne résout pas non plus la concurrence.
// `bumpUsage()` reste un `select` puis `upsert` NON ATOMIQUE : deux
// écritures simultanées écrivent toutes deux `cur + by` et l'une écrase l'autre.
// La lecture reste antérieure à la dépense, sans réservation : N instances
// concurrentes peuvent encore dépasser le plafond. La réservation atomique
// (RPC PostgreSQL `on conflict do update set count = count + excluded.count`,
// pré-charge pessimiste) est le lot **C2**, après A3b — elle exige une migration,
// donc la baseline de migrations. Le multi-tenant de `prospector_usage`
// (absence de workspace_id) reste hors périmètre lui aussi.
export type BudgetState =
  | 'not_configured'    // aucun plafond saisi : aucun garde-fou, comportement explicite
  | 'available'         // plafond saisi, consommation lue, marge restante
  | 'budget_exhausted'  // plafond saisi, consommation lue, plafond atteint
  | 'usage_unavailable' // plafond saisi, consommation NON lisible durablement → refus

export interface BudgetGuard {
  state: BudgetState
  budget: number
  spent: number | null   // null quand la consommation n'a pas pu être lue
  blocked: boolean
  reason?: string        // message destiné à l'utilisateur
}

// Un seul identifiant machine pour l'état « suivi indisponible » :
// `usage_unavailable`. L'interface le rend par un libellé distinct de celui du
// budget épuisé, mais introduire un second code (`usage_tracking_unavailable`)
// pour la même condition créerait deux vérités à maintenir en parallèle.
export async function budgetLeft(): Promise<BudgetGuard> {
  const budget = parseFloat(getKey('ANTHROPIC_BUDGET') || '') || 0

  // Budget absent ou nul : aucun plafond n'a été demandé. On n'invente pas une
  // protection que personne n'a configurée, et on le dit explicitement.
  if (!(budget > 0)) return { state: 'not_configured', budget: 0, spent: null, blocked: false }

  // Le compteur doit pouvoir être ÉCRIT, pas seulement lu : si le contrat
  // d'environnement (lot A2) interdit d'écrire `prospector_usage`, l'appel serait
  // facturé sans jamais être décompté. On bloque AVANT Anthropic.
  if (!writeAllowed('prospector_usage')) {
    return { state: 'usage_unavailable', budget, spent: null, blocked: true,
      reason: 'Suivi de consommation indisponible : écritures sur le compteur d\'usage suspendues par la configuration d\'environnement. Appels IA bloqués tant qu\'un budget est configuré.' }
  }

  const read = await readUsageDurable('ai:cents')
  if (!read.ok) {
    return { state: 'usage_unavailable', budget, spent: null, blocked: true,
      reason: read.reason === 'no_client'
        ? 'Suivi de consommation indisponible : aucune base durable configurée. Le compteur mémoire ne peut pas servir de garde budgétaire (il repart à zéro à chaque instance).'
        : 'Suivi de consommation indisponible : le compteur d\'usage est illisible. Appels IA bloqués par sécurité.' }
  }

  const spent = read.value / 100
  if (spent >= budget) {
    return { state: 'budget_exhausted', budget, spent, blocked: true,
      reason: `Crédit Anthropic épuisé (${spent.toFixed(2)} $ / ${budget.toFixed(2)} $). Recharge puis mets à jour le montant dans Admin → Usage.` }
  }
  return { state: 'available', budget, spent, blocked: false }
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

export interface CallResult {
  text: string
  cached?: boolean
  blocked?: boolean
  // Motif du refus, exploitable par l'interface et l'Admin : un crédit épuisé se
  // corrige en rechargeant, un suivi indisponible se corrige en réparant la base
  // ou la configuration. Les confondre enverrait l'utilisateur au mauvais endroit.
  blockedReason?: Extract<BudgetState, 'budget_exhausted' | 'usage_unavailable'>
  error?: string
  truncated?: boolean
}

// ── Envoi TOLÉRANT AUX OPTIONS ────────────────────────────────────────────────
// Leçon apprise à la dure (deux fois) : une option refusée par l'API — un domaine
// que le crawler n'atteint pas, un outil non activé sur la clé, un réglage
// inconnu du modèle — faisait échouer TOUTE la requête, donc zéro résultat à
// l'écran. Désormais une option refusée est RETIRÉE et l'appel est rejoué.
// Le service rend un résultat dégradé plutôt qu'une page d'erreur.
const OPTIONAL_KEYS = ['output_config', 'thinking']

async function post(key: string, body: any): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return { ok: false, status: r.status, data: null, text: await r.text() }
  return { ok: true, status: r.status, data: await r.json(), text: '' }
}

async function send(key: string, body: any): Promise<any> {
  let attempt = await post(key, body)
  if (attempt.ok) return attempt.data
  // Seul un 400 (requête invalide) est dégradable : un 401/429/500 n'est pas un
  // problème d'option et doit remonter tel quel.
  if (attempt.status !== 400) throw new Error(withBuild(`Anthropic ${attempt.status} — ${attempt.text.slice(0, 150)}`))

  for (let i = 0; i < 3 && !attempt.ok; i++) {
    const msg = attempt.text
    const before = JSON.stringify(body)

    // 1) L'API nomme un type d'outil qu'elle ne connaît pas → on retire cet outil.
    if (Array.isArray(body.tools)) {
      const rejected = body.tools.filter((t: any) => t?.type && msg.includes(t.type))
      if (rejected.length && rejected.length < body.tools.length) {
        body.tools = body.tools.filter((t: any) => !rejected.includes(t))
      }
    }
    // 2) Un réglage optionnel est mis en cause → on l'enlève.
    for (const k of OPTIONAL_KEYS) {
      if (k in body && (msg.includes(k) || msg.includes('effort'))) delete body[k]
    }
    // 3) Rien d'identifiable : on retire tout ce qui est facultatif d'un coup.
    if (JSON.stringify(body) === before) {
      OPTIONAL_KEYS.forEach((k) => delete body[k])
      if (Array.isArray(body.tools) && body.tools.length > 1) body.tools = [body.tools[0]]
      else if (JSON.stringify(body) === before) break // plus rien à retirer
    }
    attempt = await post(key, body)
  }

  if (!attempt.ok) throw new Error(withBuild(`Anthropic ${attempt.status} — ${attempt.text.slice(0, 150)}`))
  return attempt.data
}

// Appel Claude centralisé : budget → cache → API (avec prompt caching) → suivi conso.
export async function callClaude(o: CallOpts): Promise<CallResult> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { text: '', error: 'off' }

  const model = pickModel(o.task)
  // La clé de cache inclut le MODÈLE : changer de modèle doit invalider le cache,
  // sinon on ressert indéfiniment la réponse d'un modèle qu'on n'utilise plus.
  const cacheId = o.cache ? `${o.cache}-${model.replace(/[^a-z0-9]/gi, '')}` : ''
  if (cacheId) { const hit = await cacheGet(cacheId); if (hit) return { text: hit, cached: true } }

  // Le cache est consulté AVANT le garde-fou (plus haut) : un résultat déjà payé
  // ne coûte rien, le refuser n'économiserait rien et dégraderait le service.
  const guard = await budgetLeft()
  if (guard.blocked) {
    return { text: '', blocked: true,
      blockedReason: guard.state === 'budget_exhausted' ? 'budget_exhausted' : 'usage_unavailable',
      error: guard.reason }
  }

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
    const data = await send(key, body)

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
