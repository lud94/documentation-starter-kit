import type { NextApiRequest, NextApiResponse } from 'next'
import { resetPassword } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

// Applique le nouveau mot de passe à partir d'un jeton valide.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const token = String(body?.token || '')
  const password = String(body?.password || '')
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' })
  const ok = await resetPassword(token, password)
  if (!ok) return res.status(400).json({ error: 'Lien invalide ou expiré. Refais une demande.' })
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
