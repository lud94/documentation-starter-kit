import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, localSetupAllowed, mfaEnabled } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

/**
 * État public du portail : un compte existe-t-il, la MFA est-elle active, et le
 * setup local est-il ouvert ?
 *
 * `setupAllowed` existe pour que l'interface cesse de proposer « Créez votre
 * compte » là où cette opération est désormais refusée — proposer une action
 * impossible n'est pas une sécurité, c'est une impasse pour l'opérateur.
 * Ce booléen ne divulgue rien : il décrit une politique de déploiement, pas un
 * secret, et la route de setup refuse de toute façon par elle-même.
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  res.status(200).json({ setup: isSetup(), mfa: mfaEnabled(), setupAllowed: localSetupAllowed() })
}
