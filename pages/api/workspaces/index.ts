import type { NextApiRequest, NextApiResponse } from 'next'
import { listWorkspaces, createWorkspace } from '../../../lib/supabase/workspaces'

// GET → liste des espaces · POST { name, plan } → création (Supabase ou mémoire).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ workspaces: await listWorkspaces() })
  }
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const name = String(body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nom requis.' })
    const ws = await createWorkspace(name, String(body?.plan || 'Starter'))
    return res.status(200).json({ workspace: ws })
  }
  res.status(405).json({ error: 'GET/POST only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
