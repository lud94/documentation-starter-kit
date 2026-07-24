import type { NextApiRequest, NextApiResponse } from 'next'
import { stageTotpSecret } from '../../../../lib/prospector/auth'
import { generateSecret, otpauthUri } from '../../../../lib/auth/totp'

// Génère un secret TOTP et le stocke en attente de confirmation par un 1er code.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const secret = generateSecret()
  stageTotpSecret(secret)
  res.status(200).json({ secret, uri: otpauthUri(secret, 'admin@smart-ai') })
}
