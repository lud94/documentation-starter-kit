import type { NextApiRequest, NextApiResponse } from 'next'
import { disableMfa } from '../../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../../lib/prospector/keystore'
import { isAdminRequest } from '../../../../lib/auth/guard'

/**
 * Désactive la MFA de l'administrateur et efface son secret.
 *
 * ⚠️ LE DÉFAUT LE PLUS DIRECT DU LOT (SEC-AUTH-2). Cette route n'avait ni garde
 * ni corps : un POST vide, depuis n'importe quelle session valide — donc depuis
 * un compte CLIENT — supprimait le second facteur de l'administrateur. Aucune
 * preuve de possession, aucun rôle vérifié, aucune trace côté victime.
 *
 * ⚠️ CE QUI N'EST PAS FAIT ICI, ET NE DOIT PAS SE LIRE COMME FAIT : cette route
 * ne redemande pas le mot de passe, n'exige aucune ré-authentification forte et
 * n'est pas limitée en débit. Un administrateur dont la SESSION est volée peut
 * donc encore retirer sa propre MFA. Fermer cela relève de SEC-AUTH-1.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()
  await disableMfa()
  res.status(200).json({ ok: true })
}
