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

/**
 * RÉCLAMATION ATOMIQUE — supprime et REND la ligne supprimée, ou `null`.
 *
 * ── POURQUOI (lot SEC-0d) ────────────────────────────────────────────────────
 * `listItems` → `find` → `deleteItem` est un check-then-act : deux requêtes
 * concurrentes lisent la même ligne avant que l'une ne la supprime, et toutes
 * deux croient l'avoir obtenue. Sur du serverless multi-instance, ce n'est pas
 * une hypothèse d'école : les instances sont réellement parallèles.
 *
 * Ici, un SEUL `DELETE … RETURNING` : PostgreSQL verrouille la ligne pour la
 * durée de l'instruction, la première transaction l'emporte, et la seconde ne
 * trouve plus rien à supprimer. Le gagnant est celui qui reçoit une ligne —
 * pas celui qui l'a lue. C'est la primitive « au plus un » qu'exige un secret à
 * usage unique, et elle ne demande AUCUNE migration : la table et sa clé
 * primaire `(kind, id, workspace_id)` existent déjà.
 */
export async function claimItem<T = any>(kind: string, id: string, ws: string): Promise<T | null> {
  if (!writeAllowed('prospector_store')) return null
  const sb = supabase()
  if (!sb) {
    // Repli mémoire : `Map.delete` rend `true` une seule fois, et JavaScript
    // n'interrompt pas entre la lecture et la suppression. Même garantie.
    const k = key(kind, ws, id)
    const v = mem.get(k)
    return mem.delete(k) ? ((v as T) ?? null) : null
  }
  try {
    const { data, error } = await sb.from(TABLE).delete()
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws).select('data')
    if (error || !data || data.length === 0) return null
    return (data[0] as any).data as T
  } catch { return null }
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
