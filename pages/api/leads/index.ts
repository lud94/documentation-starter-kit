import type { NextApiRequest, NextApiResponse } from 'next'
import { listLeads, upsertLead, deleteLead } from '../../../lib/supabase/leads'

// GET → tous les leads · POST { lead } (ou { leads }) → upsert · DELETE { id }.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ leads: await listLeads() })
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (req.method === 'POST') {
    const leads = Array.isArray(body?.leads) ? body.leads : body?.lead ? [body.lead] : []
    let n = 0
    for (const l of leads) { if (l?.id && (await upsertLead(l))) n++ }
    return res.status(200).json({ ok: true, saved: n })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    return res.status(200).json({ ok: await deleteLead(id) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
