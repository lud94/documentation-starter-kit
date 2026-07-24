// Persistance des espaces clients. Table `prospector_workspaces`
// (id text primary key, name text, leads int, users int, plan text, created_at timestamptz).
// Repli mémoire (globalThis) si Supabase non configuré.
import type { Workspace } from '../../types/prospector'
import { supabase, supabaseConfigured } from './client'

const TABLE = 'prospector_workspaces'
const g = globalThis as any
const mem: Workspace[] = g.__prospectorWs || (g.__prospectorWs = [
  { id: 'ws_acme', name: 'Acme', leads: 388, users: 2, plan: 'Growth' },
  { id: 'ws_fabel', name: 'Fabel', leads: 156, users: 1, plan: 'Starter' },
  { id: 'ws_redsen', name: 'Redsen', leads: 92, users: 3, plan: 'Growth' },
])

function slugId(name: string, taken: (id: string) => boolean): string {
  const base = 'ws_' + name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
  let id = base || 'ws_client', n = 2
  while (taken(id)) id = `${base}_${n++}`
  return id
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const sb = supabase()
  if (!sb) return [...mem]
  try {
    const { data, error } = await sb.from(TABLE).select('*').order('created_at', { ascending: false })
    if (error || !data) return [...mem]
    return data.map((r: any) => ({ id: r.id, name: r.name, leads: r.leads ?? 0, users: r.users ?? 1, plan: r.plan ?? 'Starter' }))
  } catch { return [...mem] }
}

export async function createWorkspace(name: string, plan: string): Promise<Workspace> {
  const sb = supabase()
  if (!sb) {
    const ws: Workspace = { id: slugId(name, (id) => mem.some((w) => w.id === id)), name: name.trim() || 'Nouveau client', leads: 0, users: 1, plan }
    mem.unshift(ws)
    return ws
  }
  const { data: existing } = await sb.from(TABLE).select('id')
  const taken = new Set((existing || []).map((r: any) => r.id))
  const ws: Workspace = { id: slugId(name, (id) => taken.has(id)), name: name.trim() || 'Nouveau client', leads: 0, users: 1, plan }
  await sb.from(TABLE).insert({ ...ws, created_at: new Date().toISOString() })
  return ws
}

export { supabaseConfigured }
