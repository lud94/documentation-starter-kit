import type { NextApiRequest, NextApiResponse } from 'next'
import { getTotpSecret, enableMfa } from '../../../../lib/prospector/auth'
import { verifyTotp } from '../../../../lib/auth/totp'
import { hydrateKeystore } from '../../../../lib/prospector/keystore'

// Active la MFA après vérification d'un premier code (preuve que l'app est bien configurée).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const code = String(body?.code || '')
  const secret = getTotpSecret()
  if (!secret) return res.status(409).json({ error: 'Aucun secret en attente. Relancez la configuration.' })
  if (!(await verifyTotp(secret, code))) return res.status(400).json({ error: 'Code invalide, réessayez.' })
  enableMfa()
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
