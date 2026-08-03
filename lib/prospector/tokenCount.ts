// Précomptage fournisseur — `POST /v1/messages/count_tokens` (lot C2a-2c).
//
// ── POURQUOI CET INSTRUMENT ──────────────────────────────────────────────────
// L'heuristique `bodyBytes / 3` de `money.ts` a été mesurée FAUSSE sur staging :
// corps de 2 400 octets → 800 tokens estimés contre 945 réels (−18 %). Elle
// n'est pas non plus capable de voir l'overhead de déclaration des outils
// serveur, qui est facturé en entrée et représente l'essentiel de l'écart
// observé sur les sondes (≈ +2 750 tokens pour `web_search`, ≈ +4 560 pour
// `web_fetch`, contre ~59 tokens de corps).
//
// Le point de terminaison de comptage voit ces deux choses, parce qu'il accepte
// la même structure que Messages — `model`, `system`, `messages`, `tools` — et
// que la documentation précise que « Server tool token counts only apply to the
// first sampling call ».
//
// ── CE QU'IL N'EST PAS ───────────────────────────────────────────────────────
// ⚠️ CE N'EST PAS UNE BORNE. La documentation le dit explicitement : « The token
// count is an estimate. In some cases, the actual number of input tokens used
// when creating a message might differ by a small amount. » On ne peut donc pas
// s'en servir pour PROUVER qu'un plafond ne sera pas dépassé. C'est un
// instrument de précomptage nettement meilleur que notre heuristique, rien de
// plus, et c'est ainsi qu'il doit être présenté partout.
//
// Deux biais connus, tous deux dans le sens prudent — à connaître, pas à
// exploiter comme garantie :
//   • il compte des tokens ajoutés par Anthropic pour ses optimisations système,
//     qui ne sont PAS facturés ;
//   • il ignore le cache (« token counting provides an estimate without using
//     caching logic »), donc il rend le coût plein d'un préfixe qui sera en
//     pratique facturé à ~10 %.
//
// ── POLITIQUE D'APPEL : AUCUNE DANS CE LOT ───────────────────────────────────
// Ce module n'est appelé par AUCUN chemin de requête. C'est délibéré : le lot
// C2a-2c livre l'instrument, pas sa politique. En particulier il n'est appelé
//   • jamais en OFF,
//   • jamais en OBSERVE (aucune dépendance ajoutée, aucune variable requise),
//   • jamais systématiquement devant un appel Messages,
// et il ne change AUCUNE décision ENFORCE. La règle d'usage — « uniquement
// quand une décision en dépend » — sera arbitrée séparément.
//
// ── GARDE-FOU PASSERELLE ─────────────────────────────────────────────────────
// Ce fichier ne contient AUCUN littéral d'hôte Anthropic : le point de
// terminaison est dérivé de la constante exportée par la passerelle. Le contrôle
// CI `check-anthropic-gateway.mjs` reste donc à deux entrées, et ce module ne
// peut pas servir à émettre une requête FACTURABLE sans introduire ce littéral —
// ce que le contrôle verrait immédiatement.
import { ANTHROPIC_COUNT_TOKENS_ENDPOINT } from './llm'

/** Délai maximal. Le comptage ne génère rien : il doit être bref ou abandonné. */
export const COUNT_TOKENS_TIMEOUT_MS = 10_000

/**
 * Sous-ensemble de la requête Messages qui influe sur le comptage d'entrée.
 *
 * Aligné sur le schéma réel du point de terminaison, qui accepte exactement :
 * `messages`, `model`, `cache_control`, `output_config`, `system`, `thinking`,
 * `tool_choice`, `tools`. `max_tokens` n'y figure pas.
 *
 * `cache_control` (top-level) n'est délibérément pas repris : Prospector ne
 * l'emploie qu'IMBRIQUÉ dans `system[0]`, où il voyage donc déjà avec `system`.
 * Et la documentation précise que le comptage n'applique de toute façon aucune
 * logique de cache. L'ajouter serait un champ sans justification.
 */
export interface CountTokensInput {
  model: string
  messages: any[]
  system?: any
  tools?: any[]
  thinking?: any
  output_config?: any
  tool_choice?: any
}

// Forme PLATE, pas une union discriminée : le dépôt compile avec
// `strict: false`, où TypeScript ne rétrécit pas une union sur `!x.ok`.
export interface CountTokensResult {
  ok: boolean
  /** N'a de sens que si `ok`. Jamais négatif. */
  inputTokens: number
  /** Statut HTTP quand une réponse est parvenue. */
  status?: number
  /** Motif technique quand `!ok`. Jamais un montant. */
  reason?: string
}

/**
 * Extrait d'un corps Messages les champs qui influent sur le comptage d'entrée.
 *
 * ⚠️ DÉFAUT DE CONTRAT CORRIGÉ (lot C2a-2c-1). La version initiale excluait
 * `output_config` en affirmant qu'il « ne modifie pas l'entrée ». C'était faux
 * deux fois : le point de terminaison l'accepte, et `callClaude()` en envoie un
 * réellement — `output_config = { effort: task === 'research' ? 'medium' : 'low' }`
 * sur tout modèle qui supporte `effort`. La requête précomptée pouvait donc
 * différer de la requête réellement émise, ce qui vide de son sens un instrument
 * dont le seul objet est de précompter la vraie requête.
 *
 * `max_tokens` reste EXCLU, et c'est correct : il borne la SORTIE, et le schéma
 * du point de terminaison ne l'accepte pas.
 *
 * Rien d'autre n'est ajouté. Le seul champ accepté qui manque encore est
 * `cache_control` top-level, que Prospector n'emploie pas à ce niveau.
 */
export function countTokensInputFromBody(body: any): CountTokensInput {
  const out: CountTokensInput = {
    model: String(body?.model || ''),
    messages: Array.isArray(body?.messages) ? body.messages : [],
  }
  if (body?.system !== undefined) out.system = body.system
  if (Array.isArray(body?.tools) && body.tools.length) out.tools = body.tools
  if (body?.thinking !== undefined) out.thinking = body.thinking
  if (body?.output_config !== undefined) out.output_config = body.output_config
  if (body?.tool_choice !== undefined) out.tool_choice = body.tool_choice
  return out
}

/**
 * Appelle le point de terminaison de comptage. Gratuit, aucune génération,
 * pool de limites de débit indépendant de Messages.
 *
 * AUCUNE exception ne s'en échappe : un échec rend `ok: false` avec un motif.
 * L'appelant décide quoi en faire — ce module ne bloque jamais rien de lui-même.
 */
export async function countTokens(
  key: string,
  input: CountTokensInput,
  timeoutMs = COUNT_TOKENS_TIMEOUT_MS,
): Promise<CountTokensResult> {
  if (!key) return { ok: false, inputTokens: 0, reason: 'no_key' }
  if (!input?.model) return { ok: false, inputTokens: 0, reason: 'no_model' }

  let payload: string
  try {
    payload = JSON.stringify(input)
  } catch (e: any) {
    return { ok: false, inputTokens: 0, reason: `serialize: ${String(e?.message || e).slice(0, 120)}` }
  }

  let r: Response
  try {
    r = await fetch(ANTHROPIC_COUNT_TOKENS_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e: any) {
    return { ok: false, inputTokens: 0, reason: `transport:${String(e?.name || 'error')}` }
  }

  if (!r.ok) {
    let text = ''
    try { text = await r.text() } catch { /* le statut suffit */ }
    return { ok: false, inputTokens: 0, status: r.status, reason: text.slice(0, 160) || `http_${r.status}` }
  }

  let data: any
  try {
    data = await r.json()
  } catch {
    return { ok: false, inputTokens: 0, status: r.status, reason: 'unparseable' }
  }

  // `input_tokens` doit être un entier exact. Tout le reste est refusé plutôt
  // que converti : un comptage approximatif silencieux serait pire qu'un échec.
  const v = data?.input_tokens
  if (!Number.isSafeInteger(v) || v < 0) {
    return { ok: false, inputTokens: 0, status: r.status, reason: `bad_input_tokens:${JSON.stringify(v)}` }
  }
  return { ok: true, inputTokens: v, status: r.status }
}
