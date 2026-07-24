import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchCompanies, debugSearch } from '../../../lib/prospector/datagouv'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const query = {
    sector: str(req.query.sector),
    location: str(req.query.location),
    size: str(req.query.size),
    page: Math.max(1, parseInt(str(req.query.page) || '1', 10) || 1),
    activeOnly: str(req.query.activeOnly) !== '0',
  }
  if (req.query.debug) {
    try { return res.status(200).json(await debugSearch(query)) }
    catch (e: any) { return res.status(200).json({ error: e?.message, stack: String(e) }) }
  }
  try {
    const data = await fetchCompanies(query)
    // cache léger côté edge/CDN
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
    res.status(200).json(data)
  } catch (e: any) {
    console.error('sourcing/search error:', e?.message)
    res.status(502).json({ error: e?.message || 'Erreur DataGouv' })
  }
}
