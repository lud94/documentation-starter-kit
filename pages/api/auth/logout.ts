import type { NextApiRequest, NextApiResponse } from 'next'
import { clearedSessionCookie } from '../../../lib/auth/cookie'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Set-Cookie', clearedSessionCookie())
  res.status(200).json({ ok: true })
}
