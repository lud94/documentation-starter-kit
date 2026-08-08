import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import type { Mission } from '../../../types/prospector'

// CRUD des missions, cloisonné par espace.
//
// SEC-0b — l'espace vient du résolveur MT-0. Aucun repli sur « admin » : une
// session absente, un client sans espace ou un espace admin invalide ferment.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })
  const ws = tenant.id
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

  if (req.method === 'GET') {
    const items = await listItems<Mission>('mission', ws)
    return res.status(200).json({ missions: items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
  }
  if (req.method === 'POST') {
    const m = body?.mission as Mission
    if (!m?.id) return res.status(400).json({ error: 'mission invalide' })
    const ok = await upsertItem('mission', m.id, m, ws)
    return res.status(200).json({ ok })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    return res.status(200).json({ ok: await deleteItem('mission', id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
