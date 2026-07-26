import type { NextApiRequest, NextApiResponse } from 'next'
import { listLeads, upsertLead, deleteLead, type Scope } from '../../../lib/supabase/leads'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'

// Déduit le périmètre (admin = tout, client = son workspace) depuis la session.
async function scopeOf(req: NextApiRequest): Promise<Scope> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  const isAdmin = !claims || claims.role === 'admin' || !claims.role
  return { isAdmin, ws: claims?.ws || 'admin' }
}

// GET → leads du périmètre · POST { lead|leads } → upsert (workspace injecté) · DELETE { id }.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await scopeOf(req)

  if (req.method === 'GET') {
    return res.status(200).json({ leads: await listLeads(scope) })
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (req.method === 'POST') {
    const leads = Array.isArray(body?.leads) ? body.leads : body?.lead ? [body.lead] : []
    let n = 0
    for (const l of leads) { if (l?.id && (await upsertLead(l, scope))) n++ }
    return res.status(200).json({ ok: true, saved: n })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    return res.status(200).json({ ok: await deleteLead(id, scope) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
