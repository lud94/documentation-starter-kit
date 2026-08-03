// Télémétrie de calibration budgétaire (lot C2a-2) — journaux structurés.
//
// POURQUOI DES JOURNAUX ET NON UNE TABLE. La table financière
// `prospector_ai_reservations` ne porte ni `max_tokens`, ni les `max_uses`, ni
// les tokens réels, ni `would_have_blocked` — et C2a-2 n'ouvre AUCUNE nouvelle
// migration. Les mesures nécessaires à la calibration sont donc émises en
// journaux, corrélées à la comptabilité par `reservation_id`.
//
// ── Ce que ce module N'EST PAS ───────────────────────────────────────────────
// Ce n'est pas une source de vérité comptable. Un journal est faillible et non
// durable : une ligne perdue par la plateforme fausse une moyenne, elle ne
// fausse pas un solde. C'est précisément pourquoi `reservation_id` y figure —
// tout agrégat tiré d'ici doit pouvoir être RECOUPÉ avec
// `sum(settled_micros)` de la table. Un écart significatif invalide les
// journaux, jamais la comptabilité.
//
// ── Interdits absolus ────────────────────────────────────────────────────────
// AUCUN contenu de prompt, AUCUN texte de réponse, AUCUNE clé, AUCUNE donnée
// métier. Uniquement des scalaires, des identifiants et l'empreinte SHA-256,
// qui est opaque par construction.
//
// Les `bigint` sont sérialisés en CHAÎNES DÉCIMALES : `JSON.stringify` lève sur
// un `bigint`, et un `Number()` implicite réintroduirait du flottant dans un
// journal censé servir à calibrer un plafond.

/** Marqueur stable, pour extraire les lignes d'un `vercel logs` sans parseur. */
export const TELEMETRY_MARKER = 'c2a2.telemetry'

export interface GatewayTelemetry {
  reservation_id: string
  fingerprint: string
  mode: 'OBSERVE' | 'ENFORCE'
  agent: string
  model: string
  task?: string

  // Estimation et ses composantes
  estimate_micros: bigint
  est_input_micros: bigint
  est_output_micros: bigint
  est_tool_micros: bigint
  est_fetch_content_micros: bigint
  /** Faux ⇔ une composante du coût maximal n'est pas bornable. */
  estimate_complete: boolean
  /** Composantes non estimables, nommées. */
  estimate_incomplete: string[]

  // Entrées de l'estimation, telles que lues dans le corps envoyé
  max_tokens: number
  body_bytes: number
  web_search_max_uses: number
  web_fetch_max_uses: number
  /** `null` ⇔ non déclaré ⇒ contenu non borné (cause d'`estimate_complete:false`). */
  web_fetch_max_content_tokens: number | null

  // Réalité mesurée après réponse
  input_tokens: number | null
  cache_read_input_tokens: number | null
  output_tokens: number | null
  web_searches: number | null
  settled_micros: bigint | null

  // Décision hypothétique (OBSERVE) ou réelle (ENFORCE)
  observe_limit_micros: bigint | null
  engaged_micros_at_reserve: bigint | null
  /**
   * `null` = INDÉTERMINÉ, jamais `false`. Vaut `null` dès que la décision
   * dépendrait d'un coût non borné, ou qu'aucun seuil exploitable n'existe.
   */
  would_have_blocked: boolean | null

  // Issue
  state: 'SETTLED' | 'RELEASED' | 'UNRESOLVED' | 'NOT_RESERVED'
  outcome_code: string
  http_status: number | null
  duration_ms: number
}

function wire(v: any): any {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(wire)
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) out[k] = wire(v[k])
    return out
  }
  return v
}

/**
 * Émet une ligne. Étanche par construction : un échec de journalisation ne doit
 * ni faire échouer l'appel métier, ni empêcher une résolution comptable. C'est
 * de la télémétrie, pas de la comptabilité.
 */
export function emitGatewayTelemetry(t: GatewayTelemetry): void {
  try {
    console.log(`${TELEMETRY_MARKER} ${JSON.stringify(wire(t))}`)
  } catch { /* jamais bloquant */ }
}
