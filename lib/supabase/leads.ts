// Persistance des leads, cloisonnée par espace (workspace).
// Table `prospector_leads (id text pk, data jsonb, workspace_id text, created_at timestamptz)`.
// Règle : chacun opère dans UN espace. 'admin' = l'espace propre de l'admin.
// Le workspace est déterminé par le serveur (session + espace actif), jamais par le client.
import type { Lead } from '../../types/prospector'
import { supabase } from './client'
import { writeAllowed } from '../env'

const TABLE = 'prospector_leads'
const g = globalThis as any
const mem: Map<string, { lead: Lead; ws: string }> = g.__prospectorLeads3 || (g.__prospectorLeads3 = new Map())

export async function listLeads(ws: string): Promise<Lead[]> {
  const sb = supabase()
  if (!sb) return Array.from(mem.values()).filter((r) => r.ws === ws).map((r) => r.lead)
  try {
    const { data, error } = await sb.from(TABLE).select('data').eq('workspace_id', ws).order('created_at', { ascending: false })
    if (error || !data) return []
    return data.map((r: any) => r.data as Lead)
  } catch { return [] }
}

export async function upsertLead(lead: Lead, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_leads')) return false
  const sb = supabase()
  if (!sb) { mem.set(lead.id, { lead, ws }); return true }
  try {
    const { error } = await sb.from(TABLE).upsert({ id: lead.id, data: lead, workspace_id: ws, created_at: new Date().toISOString() }, { onConflict: 'id' })
    return !error
  } catch { return false }
}

// Suppression cloisonnée : on ne supprime que dans l'espace courant.
export async function deleteLead(id: string, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_leads')) return false
  const sb = supabase()
  if (!sb) { const r = mem.get(id); if (r && r.ws !== ws) return false; mem.delete(id); return true }
  try {
    const { error } = await sb.from(TABLE).delete().eq('id', id).eq('workspace_id', ws)
    return !error
  } catch { return false }
}
