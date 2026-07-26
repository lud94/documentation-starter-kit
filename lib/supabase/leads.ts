// Persistance des leads, cloisonnée par workspace.
// Table `prospector_leads (id text pk, data jsonb, workspace_id text, created_at timestamptz)`.
// Le workspace est injecté par le serveur depuis la session (jamais par le client).
import type { Lead } from '../../types/prospector'
import { supabase } from './client'

const TABLE = 'prospector_leads'
const g = globalThis as any
// mémoire : id → { lead, ws }
const mem: Map<string, { lead: Lead; ws: string }> = g.__prospectorLeads2 || (g.__prospectorLeads2 = new Map())

export interface Scope { isAdmin: boolean; ws: string } // ws = workspace du client, ou 'admin'

// L'admin voit tout ; un client ne voit que son workspace.
export async function listLeads(scope: Scope): Promise<Lead[]> {
  const sb = supabase()
  if (!sb) {
    const rows = Array.from(mem.values())
    return (scope.isAdmin ? rows : rows.filter((r) => r.ws === scope.ws)).map((r) => r.lead)
  }
  try {
    let q = sb.from(TABLE).select('data, workspace_id').order('created_at', { ascending: false })
    if (!scope.isAdmin) q = q.eq('workspace_id', scope.ws)
    const { data, error } = await q
    if (error || !data) return []
    return data.map((r: any) => r.data as Lead)
  } catch { return [] }
}

export async function upsertLead(lead: Lead, scope: Scope): Promise<boolean> {
  const ws = scope.isAdmin ? 'admin' : scope.ws
  const sb = supabase()
  if (!sb) { mem.set(lead.id, { lead, ws }); return true }
  try {
    const { error } = await sb.from(TABLE).upsert({ id: lead.id, data: lead, workspace_id: ws, created_at: new Date().toISOString() }, { onConflict: 'id' })
    return !error
  } catch { return false }
}

// Suppression scoped : un client ne peut supprimer qu'un lead de son workspace.
export async function deleteLead(id: string, scope: Scope): Promise<boolean> {
  const sb = supabase()
  if (!sb) {
    const row = mem.get(id)
    if (row && !scope.isAdmin && row.ws !== scope.ws) return false
    mem.delete(id); return true
  }
  try {
    let q = sb.from(TABLE).delete().eq('id', id)
    if (!scope.isAdmin) q = q.eq('workspace_id', scope.ws)
    const { error } = await q
    return !error
  } catch { return false }
}
