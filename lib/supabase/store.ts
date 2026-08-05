// Magasin générique cloisonné par espace : séquences, tâches, conversations…
// Table `prospector_store (kind text, id text, workspace_id text, data jsonb, updated_at)`
// clé primaire (kind, id, workspace_id). Repli mémoire (globalThis) sans Supabase.
import { supabase } from './client'
import { writeAllowed } from '../env'

const TABLE = 'prospector_store'
const g = globalThis as any
// mem: `${kind}|${ws}|${id}` -> data
const mem: Map<string, any> = g.__prospectorStore || (g.__prospectorStore = new Map())
const key = (kind: string, ws: string, id: string) => `${kind}|${ws}|${id}`

export async function listItems<T = any>(kind: string, ws: string): Promise<T[]> {
  const sb = supabase()
  if (!sb) {
    const out: T[] = []
    Array.from(mem.entries()).forEach(([k, v]) => { if (k.startsWith(`${kind}|${ws}|`)) out.push(v) })
    return out
  }
  try {
    const { data, error } = await sb.from(TABLE).select('data').eq('kind', kind).eq('workspace_id', ws).order('updated_at', { ascending: false })
    if (error || !data) return []
    return data.map((r: any) => r.data as T)
  } catch { return [] }
}

// Lecture CIBLÉE d'un élément par sa clé primaire (kind, id, workspace_id).
//
// POURQUOI (lot MT-0b). `listItems()` charge toute la collection puis
// l'appelant filtre en mémoire — acceptable pour quelques dizaines de lignes,
// pas pour un cache de résultats IA à mesure que les clients se multiplient.
// La clé primaire de `prospector_store` est exactement (kind, id,
// workspace_id) : cette lecture est un accès par index, pas un balayage.
export async function getItem<T = any>(kind: string, id: string, ws: string): Promise<T | null> {
  const sb = supabase()
  if (!sb) return (mem.get(key(kind, ws, id)) as T) ?? null
  try {
    const { data, error } = await sb.from(TABLE).select('data')
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws).maybeSingle()
    if (error || !data) return null
    return (data as any).data as T
  } catch { return null }
}

export async function upsertItem(kind: string, id: string, data: any, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) { mem.set(key(kind, ws, id), data); return true }
  try {
    const { error } = await sb.from(TABLE).upsert({ kind, id, workspace_id: ws, data, updated_at: new Date().toISOString() }, { onConflict: 'kind,id,workspace_id' })
    return !error
  } catch { return false }
}

export async function deleteItem(kind: string, id: string, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) { mem.delete(key(kind, ws, id)); return true }
  try {
    const { error } = await sb.from(TABLE).delete().eq('kind', kind).eq('id', id).eq('workspace_id', ws)
    return !error
  } catch { return false }
}
