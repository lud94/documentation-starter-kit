// Persistance des leads. Table `prospector_leads (id text pk, data jsonb, created_at timestamptz)`.
// Repli mémoire (globalThis) si Supabase non configuré.
import type { Lead } from '../../types/prospector'
import { supabase } from './client'

const TABLE = 'prospector_leads'
const g = globalThis as any
const mem: Map<string, Lead> = g.__prospectorLeads || (g.__prospectorLeads = new Map())

export async function listLeads(): Promise<Lead[]> {
  const sb = supabase()
  if (!sb) return Array.from(mem.values())
  try {
    const { data, error } = await sb.from(TABLE).select('data').order('created_at', { ascending: false })
    if (error || !data) return Array.from(mem.values())
    return data.map((r: any) => r.data as Lead)
  } catch { return Array.from(mem.values()) }
}

export async function upsertLead(lead: Lead): Promise<boolean> {
  const sb = supabase()
  if (!sb) { mem.set(lead.id, lead); return true }
  try {
    const { error } = await sb.from(TABLE).upsert({ id: lead.id, data: lead, created_at: new Date().toISOString() }, { onConflict: 'id' })
    return !error
  } catch { return false }
}

export async function deleteLead(id: string): Promise<boolean> {
  const sb = supabase()
  if (!sb) { mem.delete(id); return true }
  try { const { error } = await sb.from(TABLE).delete().eq('id', id); return !error } catch { return false }
}
