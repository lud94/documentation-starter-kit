import type { NextApiRequest, NextApiResponse } from 'next'
import { getUsage } from '../../../lib/supabase/pappersCache'

// Conso réelle des connecteurs facturés (appels comptés, hors cache).
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ pappersCalls: await getUsage('pappers_calls') })
}
