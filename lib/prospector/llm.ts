// Point de contrôle UNIQUE des appels LLM — coût maîtrisé.
// 1) Routage par TÂCHE : un modèle bon marché pour le trivial, un modèle fort
//    seulement là où la qualité se voit. (Opus ≈ 19× le prix de Haiku.)
// 2) Prompt caching : le system prompt répété n'est plus repayé plein tarif.
// 3) Garde-fou budget : si le crédit saisi est épuisé, on REFUSE l'appel.
// 4) Cache de résultats : on ne repaie pas deux fois la même question.
import { getKey } from './keystore'
import { withBuild } from '../version'
import { ProviderError } from '../observability/safeError'
import { recordAiUsage } from './usage'
import { readUsageDurable } from '../supabase/pappersCache'
import { writeAllowed } from '../env'
import {
  readBudgetConfig, microsToUsdString, MICROS_PER_CENT,
  estimateBreakdown, settleMicros, DEFAULT_MAX_USES_WHEN_UNSET,
} from './money'
import { getItem, upsertItem } from '../supabase/store'
import { randomUUID, createHash } from 'node:crypto'
import type { TenantContext } from './tenant'
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

// ── Cache de résultats — CLOISONNÉ PAR TENANT (lot MT-0b) ────────────────────
//
// ⚠️ DÉFAUT CORRIGÉ. Le cache vivait dans un pseudo-espace UNIQUE `'_cache'`,
// avec une clé calculée sur le seul contenu. Les clés étant construites sur des
// données utilisateur — `['person-news', name, company]`, `['enrich', siren,
// city]`, `['signal-web', thesis, …]` — deux espaces clients distincts
// partageaient la même entrée.
//
// Deux conséquences, la seconde étant la plus grave :
//   1. le client B recevait la réponse payée par le client A sur une personne
//      nommée ;
//   2. sous budget par tenant, un succès de cache coûte ZÉRO et est OBSERVABLE.
//      Le client B peut donc tester si un concurrent a déjà enrichi tel
//      prospect, en constatant qu'aucun budget n'a bougé. C'est un canal
//      auxiliaire inter-clients que la fonctionnalité budget crée elle-même —
//      raison pour laquelle ce correctif précède MT-1.
//
// NOUVEAU CONTRAT, sur deux plans à la fois :
//   • STOCKAGE réellement partitionné : l'espace de stockage devient
//     `_cache:<tenant>`. Ce n'est pas un préfixe de clé, c'est une autre
//     partition de `prospector_store`, dont la clé primaire est
//     (kind, id, workspace_id).
//   • IDENTITÉ de la clé : SHA-256 sur le tuple {version, tenant, provider,
//     model, clé fonctionnelle}. Un changement de tenant, de fournisseur ou de
//     modèle produit une entrée différente.
//
// Les anciennes entrées de `'_cache'` ne sont PLUS JAMAIS LUES : plus aucun
// chemin ne vise cet espace. Elles ne sont pas supprimées ici — les ignorer
// suffit, et une suppression de masse serait un risque gratuit.
const CACHE_KIND = 'aicache'
const CACHE_NS_PREFIX = '_cache:'
const CACHE_CONTRACT_VERSION = 'v2'
const TTL_MS = 7 * 24 * 3600 * 1000 // 7 jours

/** Partition de stockage d'un tenant. Jamais l'ancien `'_cache'` global. */
function cacheNamespace(tenantId: string): string {
  return `${CACHE_NS_PREFIX}${tenantId}`
}

/**
 * Empreinte de cache. SHA-256 plutôt que l'ancien hachage maison 32 bits, qui
 * n'était pas une identité : ~4 milliards de valeurs possibles, donc des
 * collisions atteignables — et une collision de cache, ici, sert la réponse
 * d'une AUTRE question. Aucun contenu brut n'est conservé : seul le condensé.
 */
function cacheDigest(tenantId: string, provider: string, model: string, functionalKey: string): string {
  return createHash('sha256')
    .update(JSON.stringify([CACHE_CONTRACT_VERSION, tenantId, provider, model, functionalKey]))
    .digest('hex')
    .slice(0, 40)
}

async function cacheGet(tenantId: string, id: string): Promise<string | null> {
  try {
    // Lecture CIBLÉE sur la clé primaire (kind, id, workspace_id). L'ancienne
    // version chargeait toute la collection puis filtrait en mémoire.
    const hit = await getItem<{ id: string; text: string; at: number }>(CACHE_KIND, id, cacheNamespace(tenantId))
    if (!hit) return null
    if (Date.now() - (hit.at || 0) > TTL_MS) return null
    return hit.text
  } catch { return null }
}

async function cacheSet(tenantId: string, id: string, text: string): Promise<void> {
  try {
    await upsertItem(CACHE_KIND, id, { id, text, at: Date.now() }, cacheNamespace(tenantId))
  } catch { /* best-effort */ }
}

/**
 * Clé FONCTIONNELLE d'un appel — ce que la question identifie, sans le tenant,
 * le fournisseur ni le modèle, qui sont ajoutés par `cacheDigest`.
 *
 * Rend un condensé, pas les parties en clair : une clé de cache ne doit pas
 * transporter le nom d'un prospect jusque dans un identifiant de ligne.
 */
export function cacheKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('|').toLowerCase()).digest('hex').slice(0, 32)
}

export interface CallOpts {
  /** Espace client imputé. OBLIGATOIRE — voir lib/prospector/tenant.ts. */
  tenant: TenantContext
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

// Point de terminaison de PRÉCOMPTAGE (lot C2a-2c). Il vit ici, dans le seul
// fichier autorisé à porter un littéral d'hôte Anthropic, pour que le contrôle
// CI `check-anthropic-gateway.mjs` reste à deux entrées.
//
// ⚠️ Il n'émet AUCUNE génération et n'est PAS facturé : ce n'est pas une brèche
// dans la passerelle unique, qui existe pour empêcher les appels PAYANTS non
// comptés. Consommé par `lib/prospector/tokenCount.ts`.
export const ANTHROPIC_COUNT_TOKENS_ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens'

// Délai maximal d'une requête — appliqué UNIQUEMENT en OBSERVE et ENFORCE.
//
// Il y est nécessaire : sans lui, la classe « timeout » serait inatteignable et
// une réservation resterait OPEN jusqu'au gel de la fonction, sans que la
// résolution comptable ait pu s'écrire. Choisi SOUS le `maxDuration = 60` des
// routes lourdes pour lui laisser cette marge.
//
// ⚠️ PAS EN OFF. Le poser aussi sur le chemin historique changeait le transport
// hors du périmètre de ce lot — un durcissement peut-être souhaitable, mais qui
// n'a rien à voir avec la comptabilité budgétaire et qui doit être instruit
// séparément. OFF reste le comportement historique, y compris ses défauts.
export const REQUEST_TIMEOUT_MS = 50_000

// Durée de vie d'une réservation. Généreuse par rapport au délai ci-dessus : une
// TTL trop courte ferait balayer en UNRESOLVED des réservations encore vivantes.
const RESERVATION_TTL_SECONDS = 300

/**
 * Contexte d'un appel fournisseur. `tenant` est OBLIGATOIRE (lot MT-0) : le
 * type force chaque site d'appel à le fournir, et `anthropicPost` le revérifie
 * à l'exécution pour les appelants non typés.
 */
export interface GatewayMeta { tenant: TenantContext; agent?: string; task?: string }

// ── Lecture des outils déclarés — `web_search` ≠ `web_fetch` ─────────────────
// Voir la correction du modèle de coût dans money.ts. On ne somme PAS les
// `max_uses` : ils ne désignent pas la même facturation.
interface ToolShape {
  webSearchMaxUses: number
  webFetchMaxUses: number
  webFetchDeclared: boolean
  webFetchMaxContentTokens: number | undefined  // undefined ⇒ NON BORNÉ
  /** Types serveur dont le modèle de coût n'est pas supporté. */
  unknownServerToolTypes: string[]
  /** DÉCLARÉ — tous les types d'outils serveur présents, dédupliqués. */
  serverToolTypes: string[]
  /** `web_search` figure-t-il dans la requête ? */
  webSearchDeclared: boolean
}

export function readToolShape(body: any): ToolShape {
  const out: ToolShape = {
    webSearchMaxUses: 0, webFetchMaxUses: 0,
    webFetchDeclared: false, webFetchMaxContentTokens: undefined,
    unknownServerToolTypes: [], serverToolTypes: [], webSearchDeclared: false,
  }
  const tools = Array.isArray(body?.tools) ? body.tools : []
  let fetchContentTotal = 0
  let anyFetchUnbounded = false

  for (const t of tools) {
    const type = String(t?.type || '')
    if (!type) continue // outil client (nom + schéma) : aucun coût d'outil serveur
    if (!out.serverToolTypes.includes(type)) out.serverToolTypes.push(type)
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
    } else if (type.startsWith('web_search')) {
      out.webSearchDeclared = true
      out.webSearchMaxUses += uses
    } else {
      // Outil serveur dont le modèle de coût n'est PAS supporté. La part est
      // comptée au tarif de la recherche web à titre indicatif, mais ce n'est
      // pas un majorant : un outil inconnu peut se facturer au token, à la
      // seconde ou au volume. L'estimation est donc marquée incomplète —
      // supposer un modèle de prix puis le présenter comme borné serait
      // exactement le faux zéro qu'on s'interdit ailleurs.
      out.webSearchMaxUses += uses
      if (!out.unknownServerToolTypes.includes(type)) out.unknownServerToolTypes.push(type)
    }
  }

  if (out.webFetchDeclared && !anyFetchUnbounded) out.webFetchMaxContentTokens = fetchContentTotal
  return out
}

// ── Observabilité des outils serveur (lot C2a-2c) ────────────────────────────
//
// Quatre faits DISTINCTS, qu'il ne faut jamais confondre — la sonde de
// diagnostic staging l'a montré : `web_fetch` déclaré, 4 619 tokens d'entrée
// facturés, et pourtant AUCUNE page récupérée (le prompt ne contenait aucune
// URL, et `web_fetch` ne peut fetcher qu'une URL déjà présente).
//
//   DECLARED  — l'outil figure dans `body.tools`            (source : requête)
//   REPORTED  — `usage.server_tool_use.*_requests`          (source : FOURNISSEUR)
//   SUCCESS   — bloc `*_tool_result` sans erreur            (source : réponse)
//   ERROR     — bloc `*_tool_result` portant un `error_code` (source : réponse)
//
// La source PRIMAIRE de l'usage effectif est le compteur fournisseur. Les blocs
// sont des compléments : eux seuls distinguent succès et erreur, et eux seuls
// révèlent un contenu binaire. Raison supplémentaire de ne pas en faire la
// source primaire : `response_inclusion: "excluded"` (versions 20260318+)
// SUPPRIME ces blocs de la réponse — un comptage qui n'en dépendrait que
// deviendrait aveugle à la première montée de version.
export interface ServerToolUsage {
  /** Compteurs FOURNISSEUR. `null` = champ absent, jamais confondu avec 0. */
  webSearchRequests: number | null
  webFetchRequests: number | null
  /** Blocs de résultat observés dans CETTE réponse. */
  webSearchResults: number
  webSearchErrors: number
  webFetchResults: number
  webFetchErrors: number
  /** Codes d'erreur rencontrés, dédupliqués. Aucun contenu, aucune URL. */
  errorCodes: string[]
  /** Blocs `server_tool_use` observés, par nom d'outil. */
  invocations: number
  /**
   * Un résultat `web_fetch` a rapporté du contenu BINAIRE (PDF).
   * C'est l'exposition que `max_content_tokens` ne borne pas.
   */
  webFetchBinaryResults: number
}

export function readServerToolUsage(data: any): ServerToolUsage {
  const out: ServerToolUsage = {
    webSearchRequests: null, webFetchRequests: null,
    webSearchResults: 0, webSearchErrors: 0,
    webFetchResults: 0, webFetchErrors: 0,
    errorCodes: [], invocations: 0, webFetchBinaryResults: 0,
  }

  const stu = data?.usage?.server_tool_use
  if (stu && typeof stu === 'object') {
    if (Number.isFinite(stu.web_search_requests)) out.webSearchRequests = Math.trunc(stu.web_search_requests)
    if (Number.isFinite(stu.web_fetch_requests)) out.webFetchRequests = Math.trunc(stu.web_fetch_requests)
  }

  const blocks = Array.isArray(data?.content) ? data.content : []
  for (const b of blocks) {
    const type = String(b?.type || '')
    if (type === 'server_tool_use') { out.invocations++; continue }

    const isSearch = type === 'web_search_tool_result'
    const isFetch = type === 'web_fetch_tool_result'
    if (!isSearch && !isFetch) continue

    // Sur erreur, `content` est un OBJET d'erreur ; sur succès c'est une liste
    // (recherche) ou un objet `web_fetch_result` (fetch). On teste le type
    // d'erreur explicitement plutôt que de deviner d'après la forme.
    const c = b?.content
    const errCode = !Array.isArray(c) && typeof c?.error_code === 'string' ? c.error_code : ''
    if (errCode) {
      if (isSearch) out.webSearchErrors++; else out.webFetchErrors++
      if (!out.errorCodes.includes(errCode)) out.errorCodes.push(errCode)
      continue
    }

    if (isSearch) { out.webSearchResults++; continue }

    out.webFetchResults++
    // `content.content.source.type === 'base64'` ⇒ PDF. C'est le seul signal
    // direct de l'exposition non bornable par `max_content_tokens`.
    if (String(c?.content?.source?.type || '') === 'base64') out.webFetchBinaryResults++
  }

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
  // ⚠️ SEC-LOG-01 — le mode OFF emprunte CE chemin, et lui seul. Sans cette
  // conversion, l'exception brute de `fetch` remontait jusqu'aux routes, qui
  // journalisaient son message. Fermer la fuite uniquement dans le chemin
  // comptable aurait laissé la porte ouverte là où il y a le moins de garde-fous.
  let r: Response
  try {
    r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: payload,
    })
  } catch (e: any) {
    const name = typeof e?.name === 'string' ? e.name : ''
    throw new ProviderError({
      code: name === 'TimeoutError' || name === 'AbortError' ? 'provider_timeout' : 'provider_network',
      provider: 'anthropic',
      operation: 'messages',
      errorName: name || undefined,
    })
  }
  if (!r.ok) return { ok: false, status: r.status, data: null, text: await r.text() }
  return { ok: true, status: r.status, data: await r.json(), text: '' }
}

// ── Statuts 4xx dont la NON-FACTURATION est raisonnablement établie ──────────
//
// Ce sont des rejets à l'admission : requête malformée, clé invalide, droit
// manquant, route inconnue, charge trop grosse, entité non traitable, quota
// refusé avant traitement. Aucun calcul n'a eu lieu.
//
// ⚠️ LISTE, PAS INTERVALLE. Un `status < 500 ⇒ RELEASED` universel accorderait
// la libération à des statuts dont on ne sait rien — un 402, un 451, un code
// propriétaire futur, ou un intermédiaire réseau répondant 4xx après que la
// requête a atteint Anthropic. `RELEASED` exige une preuve ; un statut non
// reconnu n'en est pas une et tombe donc en UNRESOLVED, comme le reste.
const RELEASABLE_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429])

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

export async function anthropicPost(key: string, body: any, meta: GatewayMeta): Promise<GatewayResult> {
  // ── DERNIÈRE BARRIÈRE (lot MT-0) ───────────────────────────────────────────
  // Même si une route oublie de résoudre son espace client, l'appel fournisseur
  // ne part pas. Le contrôle est AVANT le branchement de mode : il vaut donc
  // aussi en OFF, parce qu'une dépense non imputable reste non imputable quel
  // que soit l'état du garde budgétaire.
  const tenantId = (meta?.tenant?.id || '').trim()
  if (!tenantId) {
    console.error('[mt0] appel Anthropic refusé : aucun espace client résolu.')
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'usage_unavailable',
      blockedDetail: 'Appel IA refusé : aucun espace client n\'a pu être déterminé pour cette requête.' }
  }

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
    webSearchDeclared: shape.webSearchDeclared,
    webFetchDeclared: shape.webFetchDeclared,
    webFetchMaxContentTokens: shape.webFetchMaxContentTokens,
    unknownServerToolTypes: shape.unknownServerToolTypes,
  })

  const enforce = mode === 'ENFORCE'
  const budget = enforceBudget()
  const limit = observeLimit()

  // Squelette de télémétrie : complété au fil de l'eau, émis exactement une fois.
  const t: GatewayTelemetry = {
    reservation_id: '', fingerprint: '', mode, agent, model, task: meta?.task,
    tenant_id: tenantId, tenant_kind: meta.tenant.kind,
    estimate_micros: est.totalMicros,
    est_input_micros: est.inputMicros,
    est_output_micros: est.outputMicros,
    est_tool_micros: est.toolMicros,
    est_fetch_content_micros: est.fetchContentMicros,
    estimate_complete: est.complete,
    estimate_incomplete: est.incomplete,
    estimate_unbounded: est.unbounded,
    max_tokens: maxTokens, body_bytes: bytes,
    web_search_max_uses: shape.webSearchMaxUses,
    web_fetch_max_uses: shape.webFetchMaxUses,
    web_fetch_max_content_tokens: shape.webFetchMaxContentTokens ?? null,
    input_tokens: null, cache_read_input_tokens: null, output_tokens: null,
    web_searches: null, settled_micros: null,
    server_tools_declared: shape.serverToolTypes,
    web_search_requests: null, web_fetch_requests: null,
    web_search_results_observed: null, web_fetch_results_observed: null,
    web_search_errors_observed: null, web_fetch_errors_observed: null,
    server_tool_error_codes: [], server_tool_invocations: null,
    web_fetch_binary_results: null,
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
  // ── ENFORCE : un plafond SAISI À ZÉRO est un refus, pas une absence ────────
  // `readBudgetConfig` distingue « absent » de « 0 », et le contrat de C1 dit
  // qu'un 0 saisi signifie « aucune dépense autorisée ». Le RPC, lui, lit
  // `p_budget_micros = 0` comme « aucun plafond » : lui déléguer ce cas
  // inverserait la sémantique et transformerait un hard stop en autorisation
  // illimitée. On tranche donc ICI, avant toute RPC et avant tout `fetch`.
  // C'est ce qui ferme le contournement des appelants directs d'anthropicPost
  // (dont /api/ai/diagnose), que C1 ne couvrait pas.
  if (enforce && budget.zero) {
    done('NOT_RESERVED', 'budget_zero')
    return { ok: false, status: 0, data: null, text: '', blocked: true,
      blockedReason: 'budget_exhausted',
      blockedDetail: 'Budget Anthropic fixé à 0 : aucune dépense IA autorisée. '
        + 'Saisir un montant dans Admin → Usage pour réactiver les appels.' }
  }

  if (enforce && !est.complete && budget.positive) {
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
    agent, model, ttlSeconds: RESERVATION_TTL_SECONDS, tenantId,
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
    // ⚠️ SEC-LOG-01 — l'exception de transport N'EST PAS RELANCÉE TELLE QUELLE.
    // Le message d'un échec `fetch` est écrit par le runtime : il peut citer
    // l'hôte, l'URL, et selon l'implémentation un fragment de la requête. Le
    // relancer intact rouvrait la fuite juste en aval de l'endroit où on venait
    // de la fermer. Seule la CLASSE de l'exception est conservée — elle suffit à
    // distinguer un délai dépassé d'une coupure, et c'est déjà ce dont
    // `transportOutcome` se sert pour la décision comptable.
    throw new ProviderError({
      code: outcome === 'timeout' ? 'provider_timeout' : 'provider_network',
      provider: 'anthropic',
      operation: 'messages',
      errorName: typeof e?.name === 'string' ? e.name : undefined,
    })
  }

  t.http_status = r.status

  // 4xx (429 compris) : Anthropic a RÉPONDU et a rejeté à l'admission. C'est la
  // seule preuve positive de non-facturation qui subsiste après la correction
  // ci-dessus — donc le seul cas qui donne encore RELEASED.
  if (!r.ok) {
    let text = ''
    try { text = await r.text() } catch { /* le statut suffit à classer */ }
    if (RELEASABLE_STATUSES.has(r.status)) {
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

  // Observabilité des outils serveur : lue même quand `usage` manque, pour que
  // les blocs restent exploitables dans ce cas de diagnostic.
  const stu = readServerToolUsage(data)
  t.web_search_requests = stu.webSearchRequests
  t.web_fetch_requests = stu.webFetchRequests
  t.web_search_results_observed = stu.webSearchResults
  t.web_fetch_results_observed = stu.webFetchResults
  t.web_search_errors_observed = stu.webSearchErrors
  t.web_fetch_errors_observed = stu.webFetchErrors
  t.server_tool_error_codes = stu.errorCodes
  t.server_tool_invocations = stu.invocations
  t.web_fetch_binary_results = stu.webFetchBinaryResults

  const u = data?.usage
  if (!u) {
    await closeUnresolved(id, 'usage_missing')
    done('UNRESOLVED', 'usage_missing')
    return { ok: true, status: r.status, data, text: '' }
  }

  // Le compteur FOURNISSEUR reste la source du règlement. `null` (champ absent)
  // vaut 0 recherche facturée — c'est le seul repli disponible, et il est
  // cohérent avec le comportement d'avant ce lot.
  //
  // ⚠️ ÉCART DE MESURE CONNU, non corrigé ici : la documentation dit qu'une
  // recherche en ERREUR n'est pas facturée, mais ne dit pas si le compteur
  // l'inclut. Si c'est le cas, on sur-règle. Le sens est conservateur
  // (sur-blocage, jamais sous-comptage), et la télémétrie porte désormais de
  // quoi trancher : comparer `web_search_requests` à
  // `web_search_results_observed + web_search_errors_observed`.
  const searches = stu.webSearchRequests ?? 0
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
  // OPEN et sera balayée en UNRESOLVED. Le budget reste engagé dans l'intervalle,
  // à hauteur de l'ESTIMATION — qui n'est pas un majorant (voir money.ts). Le
  // sens de l'écart n'est donc pas garanti : sur un appel à outils, l'engagement
  // laissé en place peut être inférieur au coût réel.
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

async function send(key: string, body: any, meta: GatewayMeta): Promise<SendResult> {
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
  // ⚠️ SEC-LOG-01 — le corps de réponse N'ENTRE PAS dans l'erreur. Il reste
  // disponible localement (`attempt.text`) pour la dégradation du 400 ci-dessous,
  // mais rien de ce que le fournisseur a écrit ne franchit cette frontière : une
  // API cite volontiers le champ fautif ET sa valeur, donc un fragment de prompt.
  if (attempt.status !== 400) {
    throw new ProviderError({
      code: 'provider_http', provider: 'anthropic', operation: 'messages',
      status: attempt.status,
    })
  }

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

  if (!attempt.ok) {
    // Dégradation épuisée : même règle, le corps reste hors du message.
    throw new ProviderError({
      code: 'provider_http', provider: 'anthropic', operation: 'messages',
      status: attempt.status,
    })
  }
  return { data: attempt.data }
}

// Appel Claude centralisé : budget → cache → API (avec prompt caching) → suivi conso.
export async function callClaude(o: CallOpts): Promise<CallResult> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { text: '', error: 'off' }

  const model = pickModel(o.task)
  // La clé de cache inclut le MODÈLE : changer de modèle doit invalider le cache,
  // sinon on ressert indéfiniment la réponse d'un modèle qu'on n'utilise plus.
  // Cache CLOISONNÉ : l'identité inclut tenant, fournisseur et modèle, et le
  // stockage vit dans la partition du tenant. Voir le bloc MT-0b plus haut.
  const cacheId = o.cache ? cacheDigest(o.tenant.id, 'anthropic', model, o.cache) : ''
  if (cacheId) { const hit = await cacheGet(o.tenant.id, cacheId); if (hit) return { text: hit, cached: true } }

  // Le cache est consulté AVANT le garde-fou (plus haut) : un résultat déjà payé
  // ne coûte rien, le refuser n'économiserait rien et dégraderait le service.
  //
  // ⚠️ OBSERVE NEUTRALISE C1 — et c'est la condition d'une mesure honnête.
  // Sans cela, un `ANTHROPIC_BUDGET` oublié ferait refuser des appels ICI, avant
  // même que la passerelle soit atteinte : la fenêtre d'observation mesurerait
  // un trafic déjà écrêté, donc un `would_have_blocked` sous-estimé — l'erreur
  // dans le sens le plus dangereux pour une calibration. L'avertissement de
  // configuration incohérente est émis à la place du refus.
  // OFF et ENFORCE conservent C1 tel quel : aucune régression du garde-fou.
  const mode = budgetMode()
  if (mode === 'OBSERVE') {
    warnIfObserveBiased(mode)
  } else {
    const guard = await budgetLeft()
    if (guard.blocked) {
      return { text: '', blocked: true,
        blockedReason: guard.state === 'budget_exhausted' ? 'budget_exhausted' : 'usage_unavailable',
        error: guard.reason }
    }
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
    const sent = await send(key, body, { tenant: o.tenant, agent: o.agent, task: o.task })
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
  if (cacheId && text && !truncated) await cacheSet(o.tenant.id, cacheId, text)
  return { text, truncated }
}

// Extrait le premier objet JSON d'une réponse (utilitaire commun).
export function parseJson<T = any>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
