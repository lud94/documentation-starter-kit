import type { NextApiRequest } from 'next'
import { readSession, SESSION_COOKIE } from './session'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

// Espace courant : admin = espace actif (cookie) ; client = son workspace forcé.
export async function activeWs(req: NextApiRequest): Promise<string> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  const isAdmin = !claims || claims.role === 'admin' || !claims.role
  return isAdmin ? (req.cookies?.[ACTIVE_WS_COOKIE] || 'admin') : (claims?.ws || 'admin')
}
