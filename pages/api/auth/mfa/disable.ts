import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../../lib/auth/guard'
import {
  platformSecretStatus,
  revokeAdminTotpSecret,
} from '../../../../lib/secrets/platformVault'

/**
 * Desactive la MFA administrateur en revoquant son secret dans le Vault.
 *
 * La revocation efface l'enveloppe et conserve une tombstone versionnee.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })

  const current = await platformSecretStatus('admin_totp_secret')

  if (current.kind === 'error') {
    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  if (current.kind === 'absent') {
    return res.status(200).json({ ok: true })
  }

  if (current.status === 'revoked') {
    return res.status(200).json({ ok: true })
  }

  const revoked = await revokeAdminTotpSecret(current.version)

  if (!revoked.ok) {
    if (revoked.outcome === 'stale') {
      return res.status(409).json({
        error: 'La configuration MFA a change. Recommencez.',
      })
    }

    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  return res.status(200).json({ ok: true })
}
