import type { NextApiRequest, NextApiResponse } from 'next'
import { listLeads, upsertLead, deleteLead } from '../../../lib/supabase/leads'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

// Espace courant : admin → espace actif choisi (cookie), défaut 'admin' (son propre espace).
// Client → toujours SON workspace (le cookie est ignoré → pas de triche possible).
async function activeWorkspace(req: NextApiRequest): Promise<string> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  const isAdmin = !claims || claims.role === 'admin' || !claims.role
  if (!isAdmin) return claims?.ws || 'admin'
  return req.cookies?.[ACTIVE_WS_COOKIE] || 'admin'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ws = await activeWorkspace(req)

  if (req.method === 'GET') {
    return res.status(200).json({ leads: await listLeads(ws), workspace: ws })
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (req.method === 'POST') {
    const leads = Array.isArray(body?.leads) ? body.leads : body?.lead ? [body.lead] : []
    let n = 0
    for (const l of leads) { if (l?.id && (await upsertLead(l, ws))) n++ }
    return res.status(200).json({ ok: true, saved: n })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    return res.status(200).json({ ok: await deleteLead(id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
