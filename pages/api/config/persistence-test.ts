import type { NextApiRequest, NextApiResponse } from 'next'
import { supabase, supabaseConfigured } from '../../../lib/supabase/client'

// Diagnostic RÉEL : teste écriture + lecture Supabase et renvoie l'erreur exacte.
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  // Liste les noms de variables Supabase détectés (pour repérer un mauvais nom).
  const seen = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_KEY', 'SERVICE_ROLE_KEY', 'service_role', 'SERVICE_ROLE'].filter((n) => !!process.env[n])
  const out: any = { configured: supabaseConfigured(), varsDetected: seen, writeOk: false, readOk: false, error: null }

  const sb = supabase()
  if (!sb) { out.error = 'Client non initialisé (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant côté serveur).'; return res.status(200).json(out) }

  try {
    const w = await sb.from('prospector_settings').upsert({ key: '__diag__', value: 'ok', updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (w.error) { out.error = `Écriture : ${w.error.message}`; return res.status(200).json(out) }
    out.writeOk = true

    const r = await sb.from('prospector_settings').select('value').eq('key', '__diag__').single()
    if (r.error) { out.error = `Lecture : ${r.error.message}`; return res.status(200).json(out) }
    out.readOk = r.data?.value === 'ok'
  } catch (e: any) {
    out.error = e?.message || String(e)
  }
  res.status(200).json(out)
}
