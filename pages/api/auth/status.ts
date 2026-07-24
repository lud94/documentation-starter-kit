import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, mfaEnabled } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

// Indique si un mot de passe existe (setup vs login) et si la MFA est active.
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  res.status(200).json({ setup: isSetup(), mfa: mfaEnabled() })
}
