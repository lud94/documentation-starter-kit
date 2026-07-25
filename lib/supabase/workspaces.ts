// Persistance des espaces clients. Table `prospector_workspaces`
// (id text primary key, name text, leads int, users int, plan text, created_at timestamptz).
// Repli mémoire (globalThis) si Supabase non configuré.
import type { Workspace, WorkspacePermissions } from '../../types/prospector'
import { DEFAULT_PERMISSIONS } from '../../types/prospector'
import { supabase, supabaseConfigured } from './client'

const TABLE = 'prospector_workspaces'
const g = globalThis as any
const mem: Workspace[] = g.__prospectorWs || (g.__prospectorWs = [
  { id: 'ws_acme', name: 'Acme', leads: 388, users: 2, plan: 'Growth', status: 'active', permissions: { ...DEFAULT_PERMISSIONS } },
  { id: 'ws_fabel', name: 'Fabel', leads: 156, users: 1, plan: 'Starter', status: 'active', permissions: { ...DEFAULT_PERMISSIONS } },
  { id: 'ws_redsen', name: 'Redsen', leads: 92, users: 3, plan: 'Growth', status: 'active', permissions: { ...DEFAULT_PERMISSIONS } },
])

function slugId(name: string, taken: (id: string) => boolean): string {
  const base = 'ws_' + name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
  let id = base || 'ws_client', n = 2
  while (taken(id)) id = `${base}_${n++}`
  return id
}

function rowToWs(r: any): Workspace {
  return {
    id: r.id, name: r.name, leads: r.leads ?? 0, users: r.users ?? 1, plan: r.plan ?? 'Starter',
    clientEmail: r.client_email || undefined, status: r.status || 'active',
    permissions: r.permissions || { ...DEFAULT_PERMISSIONS },
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const sb = supabase()
  if (!sb) return [...mem]
  try {
    const { data, error } = await sb.from(TABLE).select('*').order('created_at', { ascending: false })
    if (error || !data) return [...mem]
    return data.map(rowToWs)
  } catch { return [...mem] }
}

export async function createWorkspace(name: string, plan: string): Promise<Workspace> {
  const base: Workspace = { id: '', name: name.trim() || 'Nouveau client', leads: 0, users: 1, plan, status: 'active', permissions: { ...DEFAULT_PERMISSIONS } }
  const sb = supabase()
  if (!sb) {
    base.id = slugId(base.name, (id) => mem.some((w) => w.id === id)); mem.unshift(base); return base
  }
  const { data: existing } = await sb.from(TABLE).select('id')
  const taken = new Set((existing || []).map((r: any) => r.id))
  base.id = slugId(base.name, (id) => taken.has(id))
  await sb.from(TABLE).insert({ id: base.id, name: base.name, leads: 0, users: 1, plan, status: 'active', permissions: base.permissions, created_at: new Date().toISOString() })
  return base
}

export async function updateWorkspace(id: string, patch: { name?: string; plan?: string; clientEmail?: string; status?: string; permissions?: WorkspacePermissions }): Promise<Workspace | null> {
  const sb = supabase()
  const dbPatch: any = {}
  if (patch.name !== undefined) dbPatch.name = patch.name
  if (patch.plan !== undefined) dbPatch.plan = patch.plan
  if (patch.clientEmail !== undefined) dbPatch.client_email = patch.clientEmail
  if (patch.status !== undefined) dbPatch.status = patch.status
  if (patch.permissions !== undefined) dbPatch.permissions = patch.permissions
  if (!sb) {
    const w = mem.find((x) => x.id === id); if (!w) return null
    if (patch.name !== undefined) w.name = patch.name
    if (patch.plan !== undefined) w.plan = patch.plan
    if (patch.clientEmail !== undefined) w.clientEmail = patch.clientEmail
    if (patch.status !== undefined) w.status = patch.status as any
    if (patch.permissions !== undefined) w.permissions = patch.permissions
    return w
  }
  const { data } = await sb.from(TABLE).update(dbPatch).eq('id', id).select('*').single()
  return data ? rowToWs(data) : null
}

export { supabaseConfigured }
