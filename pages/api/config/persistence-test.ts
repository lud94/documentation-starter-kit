import type { NextApiRequest, NextApiResponse } from 'next'
import { supabase, supabaseConfigured } from '../../../lib/supabase/client'
import { canWrite, envSummary } from '../../../lib/env'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'

// Diagnostic RÉEL : teste écriture + lecture Supabase et renvoie l'erreur exacte.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Diagnostic réservé aux administrateurs : il révèle les noms de variables
  // d'environnement détectés et les messages d'erreur bruts de la base.
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  if (claims && claims.role && claims.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs.' })

  // Cette route écrit RÉELLEMENT dans prospector_settings : c'est le seul point
  // d'écriture du dépôt qui contourne les modules de persistance. Il doit donc
  // porter le même garde-fou, sans quoi un environnement incohérent pourrait
  // écrire dans la base de production par le simple fait d'ouvrir un diagnostic.
  const perm = canWrite()
  if (!perm.allowed) {
    return res.status(200).json({
      configured: supabaseConfigured(), varsDetected: [], writeOk: false, readOk: false,
      error: `Écriture bloquée par le contrat d'environnement (${perm.code}) : ${perm.reason}`,
      env: envSummary(),
    })
  }
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
