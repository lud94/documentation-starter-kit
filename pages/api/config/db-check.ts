import type { NextApiRequest, NextApiResponse } from 'next'
import { supabase, supabaseConfigured } from '../../../lib/supabase/client'

// Vérifie l'existence de chaque table + colonnes clés. Dit précisément ce qui manque.
const CHECKS: { table: string; cols: string }[] = [
  { table: 'prospector_settings', cols: 'key' },
  { table: 'prospector_leads', cols: 'id,workspace_id' },
  { table: 'prospector_workspaces', cols: 'id,client_email,status,permissions,client_password_hash' },
  { table: 'prospector_pappers_cache', cols: 'siren' },
  { table: 'prospector_usage', cols: 'key' },
  { table: 'prospector_store', cols: 'kind,id,workspace_id' },
]

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!supabaseConfigured()) return res.status(200).json({ configured: false, results: [] })
  const sb = supabase()!
  const results = await Promise.all(CHECKS.map(async (c) => {
    try {
      const { error } = await sb.from(c.table).select(c.cols).limit(1)
      return { table: c.table, ok: !error, error: error?.message || null }
    } catch (e: any) {
      return { table: c.table, ok: false, error: e?.message || 'exception' }
    }
  }))
  res.status(200).json({ configured: true, results })
}
