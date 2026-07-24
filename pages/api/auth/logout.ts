import type { NextApiRequest, NextApiResponse } from 'next'
import { SESSION_COOKIE } from '../../../lib/auth/session'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;`)
  res.status(200).json({ ok: true })
}
