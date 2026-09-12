import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, localSetupAllowed } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { platformSecretStatus } from '../../../lib/secrets/platformVault'

/**
 * Etat public du portail :
 * - compte administrateur configure ?
 * - MFA active ?
 * - setup local autorise ?
 *
 * Le statut MFA vient uniquement du Vault.
 * Aucun dechiffrement du secret TOTP n'est necessaire ici.
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()

  const mfaStatus = await platformSecretStatus('admin_totp_secret')

  if (mfaStatus.kind === 'error') {
    return res.status(503).json({ error: 'auth_unavailable' })
  }

  const mfa =
    mfaStatus.kind === 'present' &&
    mfaStatus.status === 'active'

  return res.status(200).json({
    setup: isSetup(),
    mfa,
    setupAllowed: localSetupAllowed(),
  })
}
