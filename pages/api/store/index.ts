import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'

const ACTIVE_WS_COOKIE = 'ps_active_ws'
const KINDS = ['sequence', 'task', 'thread', 'list', 'mission'] // whitelist

// Espace courant (admin = espace actif via cookie ; client = son workspace forcé).
async function activeWs(req: NextApiRequest): Promise<string> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  const isAdmin = !claims || claims.role === 'admin' || !claims.role
  return isAdmin ? (req.cookies?.[ACTIVE_WS_COOKIE] || 'admin') : (claims?.ws || 'admin')
}

const str = (v: any) => (Array.isArray(v) ? v[0] : v) || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ws = await activeWs(req)
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const kind = String((req.method === 'GET' ? str(req.query.kind) : body?.kind) || '')
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })

  if (req.method === 'GET') return res.status(200).json({ items: await listItems(kind, ws) })

  if (req.method === 'POST') {
    const items = Array.isArray(body?.items) ? body.items : body?.item ? [body.item] : []
    let n = 0
    for (const it of items) { if (it?.id && (await upsertItem(kind, String(it.id), it, ws))) n++ }
    return res.status(200).json({ ok: true, saved: n })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    return res.status(200).json({ ok: await deleteItem(kind, id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
