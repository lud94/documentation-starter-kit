import type { NextApiRequest, NextApiResponse } from 'next'
import { getEmail } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

// Renvoie l'email du compte (route protégée par le middleware).
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  res.status(200).json({ email: getEmail() || null })
}
