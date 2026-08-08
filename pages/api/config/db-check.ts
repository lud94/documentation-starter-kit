import type { NextApiRequest, NextApiResponse } from 'next'
import { supabase, supabaseConfigured } from '../../../lib/supabase/client'
import { isAdminRequest } from '../../../lib/auth/guard'

// Vérifie l'existence de chaque table + colonnes clés. Dit précisément ce qui manque.
const CHECKS: { table: string; cols: string }[] = [
  { table: 'prospector_settings', cols: 'key' },
  { table: 'prospector_leads', cols: 'id,workspace_id' },
  { table: 'prospector_workspaces', cols: 'id,client_email,status,permissions,client_password_hash' },
  { table: 'prospector_pappers_cache', cols: 'siren' },
  { table: 'prospector_usage', cols: 'key' },
  { table: 'prospector_store', cols: 'kind,id,workspace_id' },
]

// ⚠️ GARDE AJOUTÉ (lot SEC-0b). Cette route n'en avait aucun, contrairement à sa
// voisine `status.ts`. Le middleware n'exige qu'une session VALIDE : un client
// authentifié obtenait donc l'inventaire technique de la base — noms de tables,
// colonnes attendues, dont l'existence de `client_password_hash` — et, par les
// messages d'erreur PostgREST, l'état réel du schéma.
//
// Le refus précède `supabaseConfigured()` et toute requête : un non-admin
// n'apprend ni si la base est configurée, ni ce qu'elle contient.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
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
