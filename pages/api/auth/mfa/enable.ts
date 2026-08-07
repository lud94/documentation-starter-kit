import type { NextApiRequest, NextApiResponse } from 'next'
import { getTotpSecret, enableMfa } from '../../../../lib/prospector/auth'
import { verifyTotp } from '../../../../lib/auth/totp'
import { hydrateKeystore } from '../../../../lib/prospector/keystore'
import { isAdminRequest } from '../../../../lib/auth/guard'

/**
 * Active la MFA après vérification d'un premier code.
 *
 * ⚠️ AUCUNE GARDE D'AUTORISATION avant SEC-AUTH-2. Couplée à `mfa/setup`, cette
 * route permettait à une session CLIENT de sceller le second facteur de
 * l'administrateur sur un secret qu'elle venait elle-même de poser. Le protocole
 * TOTP était correct ; c'est l'AUTORISATION D'Y TOUCHER qui manquait.
 *
 * Le protocole MFA lui-même est inchangé.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const code = String(body?.code || '')
  const secret = getTotpSecret()
  if (!secret) return res.status(409).json({ error: 'Aucun secret en attente. Relancez la configuration.' })
  if (!(await verifyTotp(secret, code))) return res.status(400).json({ error: 'Code invalide, réessayez.' })
  await enableMfa()
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
