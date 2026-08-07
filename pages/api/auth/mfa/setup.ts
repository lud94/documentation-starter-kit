import type { NextApiRequest, NextApiResponse } from 'next'
import { stageTotpSecret } from '../../../../lib/prospector/auth'
import { generateSecret, otpauthUri } from '../../../../lib/auth/totp'
import { hydrateKeystore } from '../../../../lib/prospector/keystore'
import { isAdminRequest } from '../../../../lib/auth/guard'

/**
 * Génère un secret TOTP et le met en attente d'un premier code.
 *
 * ── LE DÉFAUT FERMÉ (lot SEC-AUTH-2) ────────────────────────────────────────
 * Cette route n'avait AUCUNE garde d'autorisation. Le middleware n'exige qu'une
 * session VALIDE — un client d'un espace en a une. N'importe lequel pouvait
 * donc appeler cette route et, d'un seul POST :
 *
 *   • écraser le secret TOTP de l'ADMINISTRATEUR ;
 *   • recevoir le nouveau secret et son URI `otpauth` dans la réponse ;
 *   • et, par `stageTotpSecret`, poser `APP_MFA_ENABLED = '0'` — donc
 *     DÉSACTIVER le second facteur de l'administrateur au passage.
 *
 * Il ne restait plus qu'à appeler `/api/auth/mfa/enable` avec un code calculé
 * depuis ce secret pour devenir le porteur du second facteur du compte
 * d'administration. « Session valide » n'est pas « administrateur autorisé ».
 *
 * ⚠️ LA GARDE PRÉCÈDE TOUT : ni hydratation du keystore, ni génération de
 * secret, ni écriture. Un refus ne doit rien avoir produit — pas même un secret
 * jeté ensuite.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()
  const secret = generateSecret()
  await stageTotpSecret(secret)
  res.status(200).json({ secret, uri: otpauthUri(secret, 'admin@smart-ai') })
}
