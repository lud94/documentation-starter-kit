// Persistance des espaces clients. Table `prospector_workspaces`
// (id text primary key, name text, leads int, users int, plan text, created_at timestamptz).
// Repli mémoire (globalThis) si Supabase non configuré.
import bcrypt from 'bcryptjs'
import type { Workspace, WorkspacePermissions } from '../../types/prospector'
import { DEFAULT_PERMISSIONS } from '../../types/prospector'
import { supabase, supabaseConfigured } from './client'

const TABLE = 'prospector_workspaces'
const g = globalThis as any
const mem: Workspace[] = g.__prospectorWs || (g.__prospectorWs = [])

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
    hasClientAccess: !!(r.client_email && r.client_password_hash),
  }
}

const g2 = globalThis as any
const memHash: Record<string, string> = g2.__wsClientHash || (g2.__wsClientHash = {})

// Définit/réinitialise le mot de passe d'accès du client au workspace.
export async function setClientPassword(id: string, pw: string): Promise<boolean> {
  const hash = bcrypt.hashSync(pw, 10)
  const sb = supabase()
  if (!sb) { memHash[id] = hash; return true }
  const { error } = await sb.from(TABLE).update({ client_password_hash: hash }).eq('id', id)
  return !error
}

// Authentifie un client par email → renvoie le workspace + permissions si OK.
export async function authClient(email: string, pw: string): Promise<Workspace | null> {
  const e = (email || '').trim().toLowerCase()
  const sb = supabase()
  if (!sb) {
    const w = mem.find((x) => (x.clientEmail || '').toLowerCase() === e)
    if (!w || w.status === 'suspended') return null
    const hash = memHash[w.id]
    return hash && bcrypt.compareSync(pw, hash) ? w : null
  }
  const { data } = await sb.from(TABLE).select('*').ilike('client_email', e).limit(1)
  const r = (data || [])[0]
  if (!r || !r.client_password_hash || r.status === 'suspended') return null
  return bcrypt.compareSync(pw, r.client_password_hash) ? rowToWs(r) : null
}

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const sb = supabase()
  if (!sb) return mem.find((w) => w.id === id) || null
  const { data } = await sb.from(TABLE).select('*').eq('id', id).single()
  return data ? rowToWs(data) : null
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

export async function deleteWorkspace(id: string): Promise<boolean> {
  const sb = supabase()
  if (!sb) { const i = mem.findIndex((w) => w.id === id); if (i >= 0) mem.splice(i, 1); return true }
  const { error } = await sb.from(TABLE).delete().eq('id', id)
  return !error
}

export { supabaseConfigured }
