import type { NextApiRequest, NextApiResponse } from 'next'
import { generateSecret, otpauthUri } from '../../../../lib/auth/totp'
import { isAdminRequest } from '../../../../lib/auth/guard'
import {
  platformSecretStatus,
  stageAdminTotpSecret,
  replacePlatformSecretValue,
} from '../../../../lib/secrets/platformVault'

/**
 * Genere un secret TOTP et le place dans le coffre en etat staged.
 *
 * Aucun secret staged ne peut authentifier une connexion.
 * Il devra etre prouve par un premier code valide avant promotion vers active.
 *
 * La garde administrateur precede toute lecture, generation ou ecriture.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })

  const current = await platformSecretStatus('admin_totp_secret')

  if (current.kind === 'error') {
    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  if (current.kind === 'present' && current.status !== 'revoked') {
    return res.status(409).json({
      error: 'Une configuration MFA existe deja ou est en attente.',
    })
  }

  const secret = generateSecret()

  const staged = current.kind === 'absent'
    ? await stageAdminTotpSecret(secret)
    : await replacePlatformSecretValue(
        'admin_totp_secret',
        secret,
        current.version,
      )

  if (!staged.ok) {
    if (staged.outcome === 'exists' || staged.outcome === 'stale') {
      return res.status(409).json({
        error: 'La configuration MFA a change. Recommencez.',
      })
    }

    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  return res.status(200).json({
    secret,
    uri: otpauthUri(secret, 'admin@smart-ai'),
  })
}
