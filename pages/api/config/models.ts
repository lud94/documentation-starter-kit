import type { NextApiRequest, NextApiResponse } from 'next'
import { routesWithStatus } from '../../../lib/prospector/models'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ routes: routesWithStatus() })
}
