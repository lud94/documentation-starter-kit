import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'
import { activeWs } from '../../../lib/auth/ws'
import type { Mission } from '../../../types/prospector'

// CRUD des missions, cloisonné par espace.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ws = await activeWs(req)
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
