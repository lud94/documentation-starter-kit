import type { NextApiRequest, NextApiResponse } from 'next'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'
import { listWorkspaces, getWorkspaceById } from '../../../lib/supabase/workspaces'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

// GET → espace actif + liste des espaces disponibles (admin : tous + « Mon espace »).
// POST { ws } → change l'espace actif (admin uniquement).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  const isAdmin = !claims || claims.role === 'admin' || !claims.role

  if (req.method === 'POST') {
    if (!isAdmin) return res.status(403).json({ error: 'forbidden' })
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const ws = String(body?.ws || 'admin')
    if (ws !== 'admin' && !(await getWorkspaceById(ws))) return res.status(400).json({ error: 'espace inconnu' })
    res.setHeader('Set-Cookie', `${ACTIVE_WS_COOKIE}=${ws}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`)
    return res.status(200).json({ ok: true, current: ws })
  }

  // GET
  if (!isAdmin) {
    const ws = claims?.ws || 'admin'
    const w = await getWorkspaceById(ws)
    return res.status(200).json({ current: ws, canSwitch: false, options: [{ id: ws, name: w?.name || 'Mon espace' }] })
  }
  const current = req.cookies?.[ACTIVE_WS_COOKIE] || 'admin'
  const list = await listWorkspaces()
  const options = [{ id: 'admin', name: 'Mon espace (Smart.AI)' }, ...list.map((w) => ({ id: w.id, name: w.name }))]
  res.status(200).json({ current, canSwitch: true, options })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
