import type { NextApiRequest, NextApiResponse } from 'next'
import { maskPII, countPII } from '../../../lib/prospector/anonymize'
import { getKey, setKeys, hydrateKeystore } from '../../../lib/prospector/keystore'

// GET  → état du réglage global (activé par défaut).
// POST { text, terms?, enabled? } → prévisualise le masquage et/ou change le réglage.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  if (req.method === 'GET') {
    return res.status(200).json({ enabled: getKey('PII_MASKING') !== '0' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (typeof body?.enabled === 'boolean') setKeys({ PII_MASKING: body.enabled ? '1' : '0' })

  let preview = null
  if (typeof body?.text === 'string') {
    const { masked, map } = maskPII(body.text, Array.isArray(body.terms) ? body.terms : [])
    preview = { masked, counts: countPII(map), total: Object.keys(map).length }
  }
  res.status(200).json({ enabled: getKey('PII_MASKING') !== '0', preview })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
