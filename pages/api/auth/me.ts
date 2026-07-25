import type { NextApiRequest, NextApiResponse } from 'next'
import { getEmail } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'
import { getWorkspaceById } from '../../../lib/supabase/workspaces'
import { DEFAULT_PERMISSIONS } from '../../../types/prospector'

// Renvoie l'identité + le rôle + (pour un client) son workspace et ses permissions.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const claims = await readSession(req.cookies[SESSION_COOKIE])
  const role = claims?.role || 'admin'

  if (role === 'client' && claims?.ws) {
    const ws = await getWorkspaceById(claims.ws)
    return res.status(200).json({
      email: claims.sub, role: 'client',
      workspaceId: ws?.id, workspaceName: ws?.name,
      permissions: ws?.permissions || DEFAULT_PERMISSIONS,
      status: ws?.status || 'active',
    })
  }
  res.status(200).json({ email: getEmail() || claims?.sub || null, role: 'admin' })
}
