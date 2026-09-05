import type { NextApiRequest, NextApiResponse } from 'next'
import { listLeads, upsertLeadChecked, deleteLead, type UpsertFailure } from '../../../lib/supabase/leads'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'

// SEC-0b — le résolveur local est supprimé au profit de la doctrine MT-0. Il
// traitait `!claims` comme un administrateur et repliait un client sans espace
// sur « admin » : un client mal provisionné lisait et écrivait les leads de
// l'espace administrateur.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })
  const ws = tenant.id

  if (req.method === 'GET') {
    return res.status(200).json({ leads: await listLeads(ws), workspace: ws })
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (req.method === 'POST') {
    const leads = Array.isArray(body?.leads) ? body.leads : body?.lead ? [body.lead] : []
    let saved = 0
    const rejected: Array<{ id: string; reason: UpsertFailure }> = []
    for (const l of leads) {
      if (!l?.id) continue
      const r = await upsertLeadChecked(l, ws)
      if (r.ok) saved++
      else rejected.push({ id: l.id, reason: r.reason || 'db_error' })
    }
    // Trois issues distinctes, jamais confondues :
    //   succès total          → 200
    //   refus MÉTIER partiel  → 200 avec le détail (le client doit l'afficher)
    //   échec TECHNIQUE       → 503 si transitoire, 500 sinon
    const technical = rejected.filter((r) => r.reason !== 'workspace_conflict')
    const transient = technical.some((r) => r.reason === 'contention' || r.reason === 'env_blocked')
    const status = technical.length === 0 ? 200 : transient ? 503 : 500
    return res.status(status).json({
      ok: rejected.length === 0,
      saved,
      rejected,
      partial: saved > 0 && rejected.length > 0,
    })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    return res.status(200).json({ ok: await deleteLead(id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
