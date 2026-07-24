import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchCompanies } from '../../../lib/prospector/datagouv'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const data = await fetchCompanies({
      sector: str(req.query.sector),
      location: str(req.query.location),
      size: str(req.query.size),
    })
    // cache léger côté edge/CDN
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
    res.status(200).json(data)
  } catch (e: any) {
    console.error('sourcing/search error:', e?.message)
    res.status(502).json({ error: e?.message || 'Erreur DataGouv' })
  }
}
