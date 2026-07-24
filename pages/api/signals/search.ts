import type { NextApiRequest, NextApiResponse } from 'next'
import { searchSignals } from '../../../lib/prospector/signals'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const thesis = str(req.query.thesis).trim()
  if (!thesis) return res.status(400).json({ error: 'Thèse de recherche manquante.' })
  try {
    const data = await searchSignals(thesis)
    res.status(200).json(data)
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Erreur agent signaux' })
  }
}
