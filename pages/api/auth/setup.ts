import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, setPassword } from '../../../lib/prospector/auth'
import { createSessionToken, SESSION_COOKIE } from '../../../lib/auth/session'

const TTL = 60 * 60 * 12

// Création du mot de passe à la première visite (tant qu'aucun n'existe).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (isSetup()) return res.status(409).json({ error: 'already_setup' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const password = String(body?.password || '')
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' })

  setPassword(password)
  const token = await createSessionToken('admin', TTL)
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL};${process.env.NODE_ENV === 'production' ? ' Secure;' : ''}`)
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
