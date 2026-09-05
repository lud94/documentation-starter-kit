import type { NextApiRequest, NextApiResponse } from 'next'
import { verifyTotp } from '../../../../lib/auth/totp'
import { isAdminRequest } from '../../../../lib/auth/guard'
import {
  readStagedAdminTotpSecret,
  promoteAdminTotpSecret,
} from '../../../../lib/secrets/platformVault'

/**
 * Active la MFA apres verification d'un premier code.
 *
 * Le secret staged ne fait jamais autorite pour une connexion.
 * Il devient active uniquement apres preuve TOTP valide.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const code = String(body?.code || '')

  const staged = await readStagedAdminTotpSecret()

  if ('reason' in staged) {
    if (
      staged.reason === 'not_configured' ||
      staged.reason === 'revoked' ||
      staged.reason === 'wrong_state'
    ) {
      return res.status(409).json({
        error: 'Aucun secret MFA en attente. Relancez la configuration.',
      })
    }

    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  if (!(await verifyTotp(staged.value, code))) {
    return res.status(400).json({
      error: 'Code invalide, reessayez.',
    })
  }

  const promoted = await promoteAdminTotpSecret(staged.version)

  if (!promoted.ok) {
    if (promoted.outcome === 'stale') {
      return res.status(409).json({
        error: 'La configuration MFA a change. Recommencez.',
      })
    }

    return res.status(503).json({ error: 'mfa_unavailable' })
  }

  return res.status(200).json({ ok: true })
}

function safeParse(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
