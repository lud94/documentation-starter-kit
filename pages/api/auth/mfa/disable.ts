import type { NextApiRequest, NextApiResponse } from 'next'
import { disableMfa } from '../../../../lib/prospector/auth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  disableMfa()
  res.status(200).json({ ok: true })
}
