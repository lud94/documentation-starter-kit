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
import {
  readBudgetConfig, microsToUsdString, MICROS_PER_CENT,
  estimateBreakdown, settleMicros, DEFAULT_MAX_USES_WHEN_UNSET,
} from './money'
import { listItems, upsertItem } from '../supabase/store'
import { randomUUID } from 'node:crypto'
import { requestFingerprint } from './fingerprint'
import { budgetMode, enforceBudget, observeLimit, warnIfObserveBiased } from './budgetMode'
import { reserve, settle, resolveReservation } from '../supabase/aiBudget'
import { emitGatewayTelemetry, type GatewayTelemetry } from './telemetry'

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
  | 'not_configured'      // ANTHROPIC_BUDGET absente : aucun plafond demandé
  | 'available'           // plafond saisi, consommation lue, marge restante
  | 'budget_exhausted'    // plafond saisi, consommation lue, plafond atteint
  | 'usage_unavailable'   // plafond saisi, consommation NON lisible durablement → refus
  | 'configuration_error' // ANTHROPIC_BUDGET saisie mais illisible → refus, jamais désactivation

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
  // Trois états, jamais deux. `parseFloat` confondait « absente », « 0 » et
  // « 20abc » — et faisait donc PASSER les deux derniers pour « pas de plafond ».
  const cfg = readBudgetConfig(getKey('ANTHROPIC_BUDGET'))

  // Configuration cassée : on FERME. Une saisie qu'on ne comprend pas ne doit
  // jamais valoir autorisation de dépenser.
  if (cfg.kind === 'invalid') {
    return { state: 'configuration_error', budget: 0, spent: null, blocked: true,
      reason: `Budget Anthropic mal configuré — ${cfg.reason} Appels IA bloqués tant que la saisie n'est pas corrigée dans Admin → Usage.` }
  }

  // Absente : aucun plafond n'a été demandé. On n'invente pas une protection que
  // personne n'a configurée, et on le dit explicitement.
  if (cfg.kind === 'absent') return { state: 'not_configured', budget: 0, spent: null, blocked: false }

  // À partir d'ici le plafond est valide — Y COMPRIS zéro, qui signifie « aucune
  // dépense autorisée » et non « dépense illimitée ».
  const budgetMicros = cfg.micros
  const budget = Number(microsToUsdString(budgetMicros, 6))

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

  // Comparaison faite en ENTIERS : le compteur hérité est en cents, converti en
  // µUSD. Les `number` ci-dessous ne servent qu'à l'affichage.
  const spentMicros = BigInt(Math.max(0, Math.trunc(read.value))) * MICROS_PER_CENT
  const spent = Number(microsToUsdString(spentMicros, 6))
  if (spentMicros >= budgetMicros) {
    return { state: 'budget_exhausted', budget, spent, blocked: true,
      reason: budgetMicros === 0n
        ? 'Budget Anthropic fixé à 0 : aucune dépense IA autorisée. Saisir un montant dans Admin → Usage pour réactiver les appels.'
        : `Crédit Anthropic épuisé (${microsToUsdString(spentMicros)} $ / ${microsToUsdString(budgetMicros)} $). Recharge puis mets à jour le montant dans Admin → Usage.` }
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

// Champs de refus OPTIONNELS : aucun appelant existant n'est cassé. Forme plate,
// pas une union — le dépôt compile avec `strict: false`.
export interface GatewayResult {
  ok: boolean
  status: number
  data: any
  text: string
  /** Refus du garde budgétaire C2 : aucune requête n'a été émise. */
  blocked?: boolean
  blockedReason?: 'budget_exhausted' | 'usage_unavailable'
  blockedDetail?: string
}

// ── PASSERELLE UNIQUE vers Anthropic ──────────────────────────────────────────
//
// C'est le SEUL `fetch` vers api.anthropic.com du dépôt, et cette exclusivité est
// vérifiée en CI (scripts/check-anthropic-gateway.mjs). Tout appel facturable doit
// passer ici : c'est le point où le lot C2a posera la réservation budgétaire.
//
// Un appel émis ailleurs échapperait au plafond ET au comptage — c'était le cas de
// pages/api/config/diagnose.ts jusqu'à ce lot.
//
// Exportée pour les sondes de diagnostic, qui ont besoin du statut et du corps
// d'erreur bruts. `callClaude()` reste le chemin nominal.
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'

// Délai maximal d'une requête. Choisi SOUS le `maxDuration = 60` des routes
// lourdes, pour que la résolution comptable ait le temps de s'écrire avant le
// gel de la fonction. Sans lui, la classe « timeout » serait inatteignable et
// une requête pendante bloquerait le budget jusqu'au gel — sans diagnostic.
export const REQUEST_TIMEOUT_MS = 50_000

// Durée de vie d'une réservation. Généreuse par rapport au délai ci-dessus : une
// TTL trop courte ferait balayer en UNRESOLVED des réservations encore vivantes.
const RESERVATION_TTL_SECONDS = 300

export interface GatewayMeta { agent?: string; task?: string }

// ── Lecture des outils déclarés — `web_search` ≠ `web_fetch` ─────────────────
// Voir la correction du modèle de coût dans money.ts. On ne somme PAS les
// `max_uses` : ils ne désignent pas la même facturation.
interface ToolShape {
  webSearchMaxUses: number
  webFetchMaxUses: number
  webFetchDeclared: boolean
  webFetchMaxContentTokens: number | undefined  // undefined ⇒ NON BORNÉ
}

export function readToolShape(body: any): ToolShape {
  const out: ToolShape = {
    webSearchMaxUses: 0, webFetchMaxUses: 0,
    webFetchDeclared: false, webFetchMaxContentTokens: undefined,
  }
  const tools = Array.isArray(body?.tools) ? body.tools : []
  let fetchContentTotal = 0
  let anyFetchUnbounded = false

  for (const t of tools) {
    const type = String(t?.type || '')
    if (!type) continue // outil client (nom + schéma) : aucun coût d'outil serveur
    const uses = Number.isFinite(t?.max_uses) && t.max_uses >= 0
      ? Math.trunc(t.max_uses)
      : Number(DEFAULT_MAX_USES_WHEN_UNSET)

    if (type.startsWith('web_fetch')) {
      out.webFetchDeclared = true
      out.webFetchMaxUses += uses
      // `web_fetch` n'a PAS de coût par usage : seul le contenu récupéré est
      // facturé, en entrée. Il n'est bornable que si max_content_tokens existe.
      if (Number.isFinite(t?.max_content_tokens) && t.max_content_tokens >= 0) {
        fetchContentTotal += Math.trunc(t.max_content_tokens) * uses
      } else {
        anyFetchUnbounded = true
      }
    } else {
      // `web_search` et tout autre outil SERVEUR non répertorié : facturé à
      // l'usage. Appliquer le tarif de la recherche web à un outil inconnu est
      // une borne prudente, pas une approximation — elle majore.
      out.webSearchMaxUses += uses
    }
  }

  if (out.webFetchDeclared && !anyFetchUnbounded) out.webFetchMaxContentTokens = fetchContentTotal
  return out
}

/** Corps sérialisé une seule fois : sert à l'estimation ET à l'émission. */
function serialize(body: any): { payload: string; bytes: number } {
  const payload = JSON.stringify(body)
  return { payload, bytes: Buffer.byteLength(payload) }
}

// ── Émission brute — aucune comptabilité, un seul `fetch` ────────────────────
// Séparée pour que le chemin OFF reste littéralement le comportement historique
// (au délai maximal près, désormais uniforme).
async function rawPost(key: string, payload: string): Promise<GatewayResult> {
  const r = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) return { ok: false, status: r.status, data: null, text: await r.text() }
  return { ok: true, status: r.status, data: await r.json(), text: '' }
}

// Classification d'une exception de transport.
//
// ⚠️ CORRECTION par rapport au plan initial : un `TypeError` générique de `fetch`
// n'est PAS une preuve que la requête n'est jamais partie. `fetch` lève
// indifféremment pour une URL malformée, un échec DNS, un refus TLS, une
// connexion refusée ET une connexion établie puis coupée. Les quatre premiers ne
// sont pas facturés ; le cinquième peut l'être, et rien ne les distingue depuis
// le runtime. `RELEASED` n'est donc JAMAIS accordé sur la foi d'une exception de
// transport. La cause précise est journalisée pour le diagnostic — elle ne
// pilote pas la décision comptable.
function transportOutcome(e: any): string {
  const name = String(e?.name || '')
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'aborted'
  return 'network'
}

export async function anthropicPost(key: string, body: any, meta?: GatewayMeta): Promise<GatewayResult> {
  const mode = budgetMode()
  const { payload, bytes } = serialize(body)

  // OFF : aucune RPC, aucune télémétrie, aucun état. Chemin historique.
  if (mode === 'OFF') return rawPost(key, payload)

  warnIfObserveBiased(mode)

  const started = Date.now()
  const model = String(body?.model || '')
  const agent = meta?.agent || 'gateway'
  const maxTokens = Number.isFinite(body?.max_tokens) ? Math.trunc(body.max_tokens) : 0
  const shape = readToolShape(body)

  const est = estimateBreakdown({
    model, maxTokens, bodyBytes: bytes,
    webSearchMaxUses: shape.webSearchMaxUses,
    webFetchDeclared: shape.webFetchDeclared,
    webFetchMaxContentTokens: shape.webFetchMaxContentTokens,
  })

  const enforce = mode === 'ENFORCE'
  const budget = enforceBudget()
  const limit = observeLimit()

  // Squelette de télémétrie : complété au fil de l'eau, émis exactement une fois.
  const t: GatewayTelemetry = {
    reservation_id: '', fingerprint: '', mode, agent, model, task: meta?.task,
    estimate_micros: est.totalMicros,
    est_input_micros: est.inputMicros,
    est_output_micros: est.outputMicros,
    est_tool_micros: est.toolMicros,
    est_fetch_content_micros: est.fetchContentMicros,
    estimate_complete: est.complete,
    estimate_incomplete: est.incomplete,
    max_tokens: maxTokens, body_bytes: bytes,
    web_search_max_uses: shape.webSearchMaxUses,
    web_fetch_max_uses: shape.webFetchMaxUses,
    web_fetch_max_content_tokens: shape.webFetchMaxContentTokens ?? null,
    input_tokens: null, cache_read_input_tokens: null, output_tokens: null,
    web_searches: null, settled_micros: null,
    observe_limit_micros: limit.ok ? limit.micros : null,
    engaged_micros_at_reserve: null,
    would_have_blocked: null,
    state: 'NOT_RESERVED', outcome_code: '', http_status: null, duration_ms: 0,
  }
  const done = (state: GatewayTelemetry['state'], outcome: string) => {
    t.state = state; t.outcome_code = outcome; t.duration_ms = Date.now() - started
    emitGatewayTelemetry(t)
  }

  // ── ENFORCE : une saisie de budget cassée FERME ────────────────────────────
  // Cohérent avec `budgetLeft()` : une configuration qu'on ne comprend pas ne
  // vaut jamais autorisation de dépenser.
  if (enforce && !budget.ok) {
    done('NOT_RESERVED', 'budget_config_invalid')
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'usage_unavailable',
      blockedDetail: `Budget Anthropic mal configuré — ${budget.invalidReason}` }
  }

  // ── ENFORCE : un coût maximal non bornable n'est pas « correctement estimé » ─
  // On refuse UNIQUEMENT si la décision dépend réellement de ce coût, c'est-à-dire
  // si un plafond positif est demandé. Sans plafond, aucune décision ne s'appuie
  // sur l'estimation : la laisser passer n'est pas un contournement.
  // Le comportement final d'activation sera arrêté après les mesures OBSERVE et
  // la définition des bornes `web_fetch` — ce refus est la position fail-safe
  // par défaut, pas une décision produit définitive.
  if (enforce && !est.complete && budget.configured) {
    done('NOT_RESERVED', 'estimate_incomplete')
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'usage_unavailable',
      blockedDetail: `Coût maximal non bornable (${est.incomplete.join(', ')}) : `
        + 'un plafond ne peut pas être arbitré sur une estimation incomplète. '
        + 'Déclarer max_content_tokens sur les outils web_fetch.' }
  }

  const id = randomUUID()
  const fingerprint = requestFingerprint(ANTHROPIC_ENDPOINT, body)
  t.reservation_id = id
  t.fingerprint = fingerprint

  // OBSERVE neutralise le plafond DANS le RPC lui-même : `prospector_ai_reserve`
  // ne teste le budget que `if p_budget_micros > 0` (migration gelée, ligne 68).
  // Avec 0, `budget_exhausted` est inatteignable par construction — ce n'est pas
  // un contournement, c'est le comportement déjà prévu et testé pour « aucun
  // plafond configuré ».
  const budgetForRpc = enforce ? budget.micros : 0n

  const res = await reserve({
    id, fingerprint, budgetMicros: budgetForRpc, estimateMicros: est.totalMicros,
    agent, model, ttlSeconds: RESERVATION_TTL_SECONDS,
  })

  // ── Échec technique de la réservation → FAIL-SAFE, aucun appel ─────────────
  if (!res.ok) {
    done('NOT_RESERVED', `reserve_failed:${res.reason}`)
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'usage_unavailable',
      blockedDetail: `Réservation budgétaire impossible (${res.reason}). Appel IA refusé par sécurité.` }
  }

  t.engaged_micros_at_reserve = res.engagedMicros ?? null

  // Décision hypothétique, calculée en OBSERVE à partir de ce que le RPC rend
  // déjà. `null` = INDÉTERMINÉ, jamais `false` :
  //   • estimation incomplète ⇒ la comparaison porterait sur un total qui n'est
  //     pas un majorant ;
  //   • seuil candidat absent ou illisible ⇒ il n'y a rien à comparer.
  if (!enforce) {
    t.would_have_blocked = (!est.complete || !limit.ok || limit.micros <= 0n)
      ? null
      : (res.engagedMicros ?? 0n) + est.totalMicros > limit.micros
  }

  if (res.state === 'budget_exhausted') {
    // Inatteignable en OBSERVE (budgetForRpc = 0n) ; le vérifier ici plutôt que
    // de le supposer coûte une comparaison et ferme le mode par construction.
    done('NOT_RESERVED', 'budget_exhausted')
    if (!enforce) console.error('[c2a2] INVARIANT ROMPU : budget_exhausted rendu en OBSERVE.')
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'budget_exhausted',
      blockedDetail: 'Plafond IA atteint (consommation + engagements en cours). '
        + 'Vérifier aussi le passif non résolu avant de recharger.' }
  }
  if (res.state !== 'reserved') {
    // `integrity_error` ou `already_*` : ne devrait pas être atteignable, chaque
    // requête portant un identifiant neuf. On refuse plutôt que de deviner.
    done('NOT_RESERVED', `reserve_state:${res.state}`)
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'usage_unavailable',
      blockedDetail: `Réservation en état inattendu (${res.state}). Appel IA refusé par sécurité.` }
  }

  // ── Émission ───────────────────────────────────────────────────────────────
  let r: Response
  try {
    r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e: any) {
    const outcome = transportOutcome(e)
    await closeUnresolved(id, outcome)
    done('UNRESOLVED', outcome)
    throw e
  }

  t.http_status = r.status

  // 4xx (429 compris) : Anthropic a RÉPONDU et a rejeté à l'admission. C'est la
  // seule preuve positive de non-facturation qui subsiste après la correction
  // ci-dessus — donc le seul cas qui donne encore RELEASED.
  if (!r.ok) {
    let text = ''
    try { text = await r.text() } catch { /* le statut suffit à classer */ }
    if (r.status < 500) {
      await closeReleased(id, `http_${r.status}`)
      done('RELEASED', `http_${r.status}`)
    } else {
      await closeUnresolved(id, `http_${r.status}`)
      done('UNRESOLVED', `http_${r.status}`)
    }
    return { ok: false, status: r.status, data: null, text }
  }

  let data: any
  try {
    data = await r.json()
  } catch {
    // 2xx dont le corps est illisible : facturé, montant INCONNU.
    await closeUnresolved(id, 'ok_unparseable')
    done('UNRESOLVED', 'ok_unparseable')
    return { ok: false, status: r.status, data: null, text: '' }
  }

  const u = data?.usage
  if (!u) {
    await closeUnresolved(id, 'usage_missing')
    done('UNRESOLVED', 'usage_missing')
    return { ok: true, status: r.status, data, text: '' }
  }

  const searches = Number(u?.server_tool_use?.web_search_requests || 0)
  const settledMicros = settleMicros({
    model,
    inputTokens: Number(u.input_tokens || 0),
    cachedInputTokens: Number(u.cache_read_input_tokens || 0),
    outputTokens: Number(u.output_tokens || 0),
    webSearches: searches,
  })
  t.input_tokens = Number(u.input_tokens || 0)
  t.cache_read_input_tokens = Number(u.cache_read_input_tokens || 0)
  t.output_tokens = Number(u.output_tokens || 0)
  t.web_searches = searches
  t.settled_micros = settledMicros

  // ── Le règlement échoue : la réponse est rendue QUAND MÊME ─────────────────
  // On ne détruit jamais un résultat déjà payé parce qu'un compteur n'a pas pu
  // s'écrire. Un seul repli est tenté ; s'il échoue aussi, la réservation reste
  // OPEN et sera balayée en UNRESOLVED. Le budget reste engagé dans l'intervalle
  // — l'estimation majore le coût réel, donc l'engagement est conservateur.
  const s = await settle(id, settledMicros, `http_${r.status}`)
  if (s.ok) {
    done('SETTLED', `http_${r.status}`)
  } else {
    const fallback = await resolveReservation(id, 'UNRESOLVED', 'settle_failed')
    console.error(`[c2a2] règlement impossible id=${id} fp=${fingerprint} micros=${settledMicros}`
      + ` — ${s.reason}${fallback.ok ? ' (basculé UNRESOLVED)' : ` ; repli échoué : ${fallback.reason} — réservation laissée OPEN`}`)
    done('UNRESOLVED', 'settle_failed')
  }
  return { ok: true, status: r.status, data, text: '' }
}

// Clôtures : jamais bloquantes, jamais silencieuses.
async function closeReleased(id: string, outcome: string): Promise<void> {
  const r = await resolveReservation(id, 'RELEASED', outcome)
  if (!r.ok) console.error(`[c2a2] libération impossible id=${id} — ${r.reason} ; réservation laissée OPEN`)
}
async function closeUnresolved(id: string, outcome: string): Promise<void> {
  const r = await resolveReservation(id, 'UNRESOLVED', outcome)
  if (!r.ok) console.error(`[c2a2] résolution impossible id=${id} — ${r.reason} ; réservation laissée OPEN`)
}

// Résultat d'une émission, refus budgétaire compris. Forme PLATE (`strict: false`).
interface SendResult {
  data: any
  blocked?: boolean
  blockedReason?: Extract<BudgetState, 'budget_exhausted' | 'usage_unavailable'>
  error?: string
}

async function send(key: string, body: any, meta?: GatewayMeta): Promise<SendResult> {
  let attempt = await anthropicPost(key, body, meta)
  // Un refus budgétaire n'est PAS une requête invalide : le dégrader puis le
  // rejouer trois fois produirait trois refus et trois lignes de télémétrie.
  if (attempt.blocked) {
    return { data: null, blocked: true,
      blockedReason: (attempt.blockedReason as any) || 'usage_unavailable',
      error: attempt.blockedDetail }
  }
  if (attempt.ok) return { data: attempt.data }
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
    // Chaque réémission est une NOUVELLE requête HTTP, donc une nouvelle
    // réservation, un nouvel identifiant et une nouvelle empreinte — le corps a
    // été muté. Deux tentatives sont deux dépenses distinctes, pas un rejeu.
    attempt = await anthropicPost(key, body, meta)
    if (attempt.blocked) {
      return { data: null, blocked: true,
        blockedReason: (attempt.blockedReason as any) || 'usage_unavailable',
        error: attempt.blockedDetail }
    }
  }

  if (!attempt.ok) throw new Error(withBuild(`Anthropic ${attempt.status} — ${attempt.text.slice(0, 150)}`))
  return { data: attempt.data }
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
    const sent = await send(key, body, { agent: o.agent, task: o.task })
    // Refus budgétaire du garde C2 : converti dans le contrat `CallResult`
    // existant, donc l'interface et l'Admin n'ont rien à changer.
    if (sent.blocked) {
      return { text: '', blocked: true, blockedReason: sent.blockedReason, error: sent.error }
    }
    const data = sent.data

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
