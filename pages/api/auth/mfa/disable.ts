import type { NextApiRequest, NextApiResponse } from 'next'
import { disableMfa } from '../../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../../lib/prospector/keystore'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  await disableMfa()
  res.status(200).json({ ok: true })
}
