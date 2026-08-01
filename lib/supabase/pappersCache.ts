// Cache Pappers par SIREN + compteur d'appels — pour maîtriser le budget.
// Tables :
//   prospector_pappers_cache (siren text pk, data jsonb, created_at timestamptz)
//   prospector_usage (key text pk, count int, updated_at timestamptz)
// Repli mémoire (globalThis) si Supabase non configuré.
import type { ResolvedContact } from '../../types/prospector'
import { supabase } from './client'
import { writeAllowed } from '../env'

const CACHE = 'prospector_pappers_cache'
const USAGE = 'prospector_usage'
const g = globalThis as any
const memCache: Map<string, ResolvedContact[]> = g.__pappersCache || (g.__pappersCache = new Map())
const memUsage: Record<string, number> = g.__pappersUsage || (g.__pappersUsage = {})

export async function getCachedDirigeants(siren: string): Promise<ResolvedContact[] | null> {
  const sb = supabase()
  if (!sb) return memCache.has(siren) ? memCache.get(siren)! : null
  try {
    const { data, error } = await sb.from(CACHE).select('data').eq('siren', siren).single()
    if (error || !data) return null
    return (data.data as ResolvedContact[]) ?? null
  } catch { return null }
}

export async function setCachedDirigeants(siren: string, contacts: ResolvedContact[]): Promise<void> {
  if (!writeAllowed('prospector_pappers_cache')) return
  const sb = supabase()
  if (!sb) { memCache.set(siren, contacts); return }
  try { await sb.from(CACHE).upsert({ siren, data: contacts, created_at: new Date().toISOString() }, { onConflict: 'siren' }) } catch { /* noop */ }
}

// Incrémente un compteur d'usage (ex. appels Pappers réels) et renvoie le total.
export async function bumpUsage(key: string, by = 1): Promise<number> {
  // Compteur d'usage : en cas de blocage, on retombe sur le compteur mémoire
  // plutôt que de perdre l'information ou de faire échouer l'appelant.
  if (!writeAllowed('prospector_usage')) { memUsage[key] = (memUsage[key] || 0) + by; return memUsage[key] }
  const sb = supabase()
  if (!sb) { memUsage[key] = (memUsage[key] || 0) + by; return memUsage[key] }
  try {
    const cur = await sb.from(USAGE).select('count').eq('key', key).single()
    const next = ((cur.data?.count as number) || 0) + by
    await sb.from(USAGE).upsert({ key, count: next, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    return next
  } catch { memUsage[key] = (memUsage[key] || 0) + by; return memUsage[key] }
}

// ── Lecture DURABLE d'un compteur — réservée au garde-fou budgétaire (lot C1) ──
//
// Différence essentielle avec getUsage()/getUsageAll() : cette fonction ne se
// replie JAMAIS sur la mémoire et ne convertit JAMAIS une erreur en zéro. Le
// repli mémoire est par instance et disparaît au démarrage à froid : l'utiliser
// comme source d'un plafond de dépense revient à relever ce plafond à chaque
// instance neuve. Un compteur qui ment est pire qu'un compteur absent.
//
// `error` est testé EXPLICITEMENT : supabase-js ne lève pas sur erreur
// applicative, il renvoie { data: null, error }. C'est ce détail qui rendait
// getUsageAll() silencieusement permissif (audit budget, chemin (a)).
// Forme PLATE volontairement, pas une union discriminée : le dépôt compile avec
// `strict: false`, où TypeScript ne rétrécit pas une union sur `!read.ok`.
// `value` n'a de sens que si `ok` est vrai — c'est à l'appelant de le vérifier.
export interface DurableRead {
  ok: boolean
  value: number
  reason?: 'no_client' | 'db_error'
}

export async function readUsageDurable(key: string): Promise<DurableRead> {
  const sb = supabase()
  if (!sb) return { ok: false, value: 0, reason: 'no_client' }
  try {
    // `maybeSingle` plutôt que `single` : l'absence de ligne est un compteur à
    // zéro légitime (aucun appel encore facturé), pas une indisponibilité.
    const { data, error } = await sb.from(USAGE).select('count').eq('key', key).maybeSingle()
    if (error) return { ok: false, value: 0, reason: 'db_error' }
    return { ok: true, value: (data?.count as number) || 0 }
  } catch { return { ok: false, value: 0, reason: 'db_error' } }
}

export async function getUsage(key: string): Promise<number> {
  const sb = supabase()
  if (!sb) return memUsage[key] || 0
  try {
    const { data } = await sb.from(USAGE).select('count').eq('key', key).single()
    return (data?.count as number) || 0
  } catch { return memUsage[key] || 0 }
}

// Renvoie TOUS les compteurs d'usage (clé → total) pour agréger côté endpoint.
export async function getUsageAll(): Promise<Record<string, number>> {
  const sb = supabase()
  if (!sb) return { ...memUsage }
  try {
    const { data } = await sb.from(USAGE).select('key,count')
    const m: Record<string, number> = {}
    ;(data || []).forEach((r: any) => { m[r.key] = r.count })
    return m
  } catch { return { ...memUsage } }
}
