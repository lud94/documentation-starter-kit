import type { NextApiRequest, NextApiResponse } from 'next'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'
import { listWorkspaces, getWorkspaceById } from '../../../lib/supabase/workspaces'
import { workspaceOption } from '../../../lib/prospector/workspaceView'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

// GET → espace actif + liste des espaces disponibles (admin : tous + « Mon espace »).
// POST { ws } → change l'espace actif (admin uniquement).
//
// ── SEC-0 : le client ne voit QUE son espace ─────────────────────────────────
// La branche client ne lit ni `ps_active_ws` ni le corps : elle part de
// `claims.ws`, signé. Un cookie posé à la main n'a donc aucun effet.
//
// ⚠️ REPLI SUPPRIMÉ. `claims?.ws || 'admin'` faisait d'une session client sans
// espace un lecteur de l'espace ADMINISTRATEUR — le nom de l'espace admin
// partait alors vers un client mal provisionné. C'est la classe de défaut que
// `lib/prospector/tenant.ts` a refusée pour les dépenses (MT-0) ; elle vaut
// aussi pour la lecture. Une session client sans espace ferme.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  // ⚠️ `!claims` NE VAUT PLUS ADMIN. La forme précédente — `!claims || role ===
  // 'admin' || !role` — promouvait une requête SANS session en administrateur,
  // qui obtenait alors l'identifiant et le nom de tous les espaces. Le
  // middleware rend ce cas inatteignable aujourd'hui ; c'est précisément la
  // raison de ne pas s'y fier seule. Une session héritée SANS rôle reste admin :
  // sa signature, elle, a été vérifiée.
  if (!claims) return res.status(403).json({ error: 'forbidden' })
  const isAdmin = claims.role === 'admin' || !claims.role

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
    const ws = (claims?.ws || '').trim()
    if (!ws) return res.status(403).json({ error: 'forbidden' })
    const w = await getWorkspaceById(ws)
    return res.status(200).json({
      current: ws, canSwitch: false,
      options: [workspaceOption({ id: ws, name: w?.name || 'Mon espace' })],
    })
  }
  const current = req.cookies?.[ACTIVE_WS_COOKIE] || 'admin'
  const list = await listWorkspaces()
  const options = [
    workspaceOption({ id: 'admin', name: 'Mon espace (Smart.AI)' }),
    ...list.map(workspaceOption),
  ]
  res.status(200).json({ current, canSwitch: true, options })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
