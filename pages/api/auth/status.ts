import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, mfaEnabled } from '../../../lib/prospector/auth'

// Indique si un mot de passe existe (setup vs login) et si la MFA est active.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ setup: isSetup(), mfa: mfaEnabled() })
}
