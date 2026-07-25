import type { NextApiRequest, NextApiResponse } from 'next'
import { listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setClientPassword } from '../../../lib/supabase/workspaces'
import { isAdminRequest } from '../../../lib/auth/guard'

// GET → liste · POST création · PATCH maj · DELETE suppr · (mutations = admin only)
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ workspaces: await listWorkspaces() })
  }
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const name = String(body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nom requis.' })
    const ws = await createWorkspace(name, String(body?.plan || 'Starter'))
    return res.status(200).json({ workspace: ws })
  }
  if (req.method === 'PATCH') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    // Définition du mot de passe client (optionnel)
    if (typeof body?.clientPassword === 'string' && body.clientPassword.length >= 8) {
      await setClientPassword(id, body.clientPassword)
    }
    const ws = await updateWorkspace(id, body?.patch || {})
    return res.status(200).json({ workspace: ws })
  }
  if (req.method === 'DELETE') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    const ok = await deleteWorkspace(id)
    return res.status(200).json({ ok })
  }
  res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
