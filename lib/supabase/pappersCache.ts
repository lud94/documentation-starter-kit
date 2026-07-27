// Cache Pappers par SIREN + compteur d'appels — pour maîtriser le budget.
// Tables :
//   prospector_pappers_cache (siren text pk, data jsonb, created_at timestamptz)
//   prospector_usage (key text pk, count int, updated_at timestamptz)
// Repli mémoire (globalThis) si Supabase non configuré.
import type { ResolvedContact } from '../../types/prospector'
import { supabase } from './client'

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
  const sb = supabase()
  if (!sb) { memCache.set(siren, contacts); return }
  try { await sb.from(CACHE).upsert({ siren, data: contacts, created_at: new Date().toISOString() }, { onConflict: 'siren' }) } catch { /* noop */ }
}

// Incrémente un compteur d'usage (ex. appels Pappers réels) et renvoie le total.
export async function bumpUsage(key: string, by = 1): Promise<number> {
  const sb = supabase()
  if (!sb) { memUsage[key] = (memUsage[key] || 0) + by; return memUsage[key] }
  try {
    const cur = await sb.from(USAGE).select('count').eq('key', key).single()
    const next = ((cur.data?.count as number) || 0) + by
    await sb.from(USAGE).upsert({ key, count: next, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    return next
  } catch { memUsage[key] = (memUsage[key] || 0) + by; return memUsage[key] }
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
