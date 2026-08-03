// Accès aux RPC financières de réservation budgétaire (lot C2a-2).
//
// SEUL module autorisé à appeler `prospector_ai_*`. Le garde CI
// `scripts/check-supabase-mutations.mjs` le référence explicitement : toute
// autre `.rpc()` financière est une violation, pas une variante de style.
//
// ── Trois règles de conception, toutes issues de défauts déjà rencontrés ─────
//
// 1. FORMES PLATES, jamais d'unions discriminées. Le dépôt compile avec
//    `strict: false`, où TypeScript ne rétrécit pas une union sur `!x.ok`
//    (défaut C2a-1b). L'appelant vérifie `ok` avant de lire le reste.
//
// 2. AUCUNE EXCEPTION NE S'ÉCHAPPE. supabase-js ne lève pas sur erreur
//    applicative, il rend `{ data: null, error }` — c'est ce détail qui rendait
//    `getUsageAll()` silencieusement permissif (audit budget, chemin (a)). Ici
//    `error` est testé explicitement ET le tout est enveloppé : un échec rend
//    `ok:false`, jamais une valeur qui ressemble à un succès.
//
// 3. `bigint` AUX FRONTIÈRES. `JSON.stringify` LÈVE sur un `bigint` : la
//    conversion doit être explicite, sinon un `Number()` implicite réintroduit
//    du flottant dans le chemin financier.
//
//    Choix de transmission ASSUMÉ : les montants partent en `number`, après
//    contrôle explicite qu'ils tiennent dans l'entier exact de JavaScript
//    (`Number.MAX_SAFE_INTEGER` = 9 007 199 254 740 991 µUSD, soit ~9 milliards
//    de dollars — jamais atteint). Au-delà, on REFUSE plutôt que de tronquer.
//    Un entier exact sous 2^53 n'est pas un flottant lossy ; c'est aussi la
//    forme déjà éprouvée par les 26 tests d'intégration C2a-1, alors qu'une
//    transmission en chaîne reposerait sur un transtypage PostgREST non vérifié
//    dans ce dépôt. Les valeurs RELUES repassent par `toBigInt()`, qui refuse
//    tout ce qui n'est pas un entier exact.
import { supabase } from './client'
import { writeAllowed } from '../env'

const RESERVATIONS = 'prospector_ai_reservations'
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Sérialisation d'un montant vers PostgREST. Lève plutôt que de tronquer. */
export function microsToWire(micros: bigint): number {
  if (micros < 0n) throw new Error(`montant négatif interdit dans le chemin financier : ${micros}`)
  if (micros > MAX_SAFE) throw new Error(`montant hors de l'entier exact JavaScript : ${micros}`)
  return Number(micros)
}

/** Lecture d'un montant venu de PostgREST. Refuse tout non-entier. */
export function toBigInt(v: any): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`entier non exact reçu de la base : ${v}`)
    return BigInt(v)
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  throw new Error(`montant illisible reçu de la base : ${JSON.stringify(v)}`)
}

function firstRow(data: any): any {
  return Array.isArray(data) ? data[0] : data
}

// ── Réservation ──────────────────────────────────────────────────────────────

export type ReserveState =
  | 'reserved' | 'budget_exhausted' | 'integrity_error'
  | 'already_SETTLED' | 'already_RELEASED' | 'already_UNRESOLVED'

export interface ReserveResult {
  /** L'appel RPC a abouti — indépendamment de son verdict métier. */
  ok: boolean
  /** Verdict métier, renseigné si `ok`. */
  state?: ReserveState
  engagedMicros?: bigint
  budgetMicros?: bigint
  /** Motif technique, renseigné si `!ok`. */
  reason?: string
}

export interface ReserveInput {
  id: string
  fingerprint: string
  budgetMicros: bigint     // 0n ⇒ aucun plafond ⇒ `budget_exhausted` inatteignable
  estimateMicros: bigint
  agent: string
  model: string
  ttlSeconds: number
}

export async function reserve(o: ReserveInput): Promise<ReserveResult> {
  // Le contrat d'environnement d'abord : si l'écriture est suspendue, la
  // réservation ne pourrait pas être posée et l'appel serait facturé sans
  // jamais être décompté. On refuse AVANT d'interroger la base.
  if (!writeAllowed(RESERVATIONS)) {
    return { ok: false, reason: 'writes_suspended' }
  }
  const sb = supabase()
  if (!sb) return { ok: false, reason: 'no_client' }
  try {
    const { data, error } = await sb.rpc('prospector_ai_reserve', {
      p_id: o.id,
      p_fingerprint: o.fingerprint,
      p_budget_micros: microsToWire(o.budgetMicros),
      p_estimate_micros: microsToWire(o.estimateMicros),
      p_agent: o.agent,
      p_model: o.model,
      p_ttl_seconds: Math.max(1, Math.trunc(o.ttlSeconds)),
    })
    if (error) return { ok: false, reason: error.code ? `${error.code}: ${error.message}` : error.message }
    const row = firstRow(data)
    if (!row) return { ok: false, reason: 'empty_result' }
    // `result_state` et non `state` : dans un RETURNS TABLE PL/pgSQL un OUT
    // nommé `state` entre en collision avec la colonne homonyme (défaut C2a-1d).
    return {
      ok: true,
      state: row.result_state as ReserveState,
      engagedMicros: toBigInt(row.engaged_micros),
      budgetMicros: toBigInt(row.budget_micros),
    }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) }
  }
}

// ── Résolution ───────────────────────────────────────────────────────────────

export interface ResolveResult { ok: boolean; reason?: string }

/** Règlement d'un montant CONNU. Réservé au seul cas prouvé : 2xx exploitable. */
export async function settle(id: string, micros: bigint, outcome: string): Promise<ResolveResult> {
  const sb = supabase()
  if (!sb) return { ok: false, reason: 'no_client' }
  try {
    const { error } = await sb.rpc('prospector_ai_settle', {
      p_id: id, p_settled_micros: microsToWire(micros), p_outcome: outcome,
    })
    return error ? { ok: false, reason: error.message } : { ok: true }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) }
  }
}

/**
 * Clôture sans montant. `RELEASED` exige une preuve de non-facturation ;
 * `UNRESOLVED` n'exige rien et reste le défaut de toute la classification.
 */
export async function resolveReservation(
  id: string, state: 'RELEASED' | 'UNRESOLVED', outcome: string,
): Promise<ResolveResult> {
  const sb = supabase()
  if (!sb) return { ok: false, reason: 'no_client' }
  try {
    const { error } = await sb.rpc('prospector_ai_resolve', {
      p_id: id, p_state: state, p_outcome: outcome,
    })
    return error ? { ok: false, reason: error.message } : { ok: true }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) }
  }
}

// ── Lecture de l'engagement (diagnostic, Admin) ──────────────────────────────

export interface EngagedResult {
  ok: boolean
  consumedMicros?: bigint
  openMicros?: bigint
  unresolvedMicros?: bigint
  reason?: string
}

export async function engaged(): Promise<EngagedResult> {
  const sb = supabase()
  if (!sb) return { ok: false, reason: 'no_client' }
  try {
    const { data, error } = await sb.rpc('prospector_ai_engaged')
    if (error) return { ok: false, reason: error.message }
    const row = firstRow(data)
    if (!row) return { ok: false, reason: 'empty_result' }
    return {
      ok: true,
      consumedMicros: toBigInt(row.consumed_micros),
      openMicros: toBigInt(row.open_micros),
      unresolvedMicros: toBigInt(row.unresolved_micros),
    }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) }
  }
}
