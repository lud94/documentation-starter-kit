import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup } from '../../../lib/prospector/auth'

// Indique seulement si un mot de passe existe (pour afficher setup vs login).
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ setup: isSetup() })
}
