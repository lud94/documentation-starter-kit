import type { NextApiRequest, NextApiResponse } from 'next'
import { resetPassword } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

/**
 * Applique un nouveau mot de passe à partir d'un jeton valide.
 *
 * Le jeton présenté est comparé à une EMPREINTE (voir `lib/prospector/auth.ts`)
 * et consommé : usage unique, rejeu refusé.
 *
 * ⚠️ CE QUE CETTE ROUTE NE FAIT PAS. Elle n'invalide pas les sessions déjà
 * émises. La session est un HMAC apatride de 12 h : après un changement de mot
 * de passe, une session volée AVANT reste valable jusqu'à son expiration.
 * Fermer cela demande un `session_version` — c'est SEC-AUTH-1, et ce n'est pas
 * fait ici.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const token = String(body?.token || '')
  const password = String(body?.password || '')
  // Bornes : un jeton fait 48 caractères hexadécimaux, un mot de passe se hache.
  // Rien de démesuré n'a de raison d'atteindre bcrypt.
  if (!token || token.length > 256) return res.status(400).json({ error: 'Lien invalide ou expiré. Refais une demande.' })
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' })
  const ok = await resetPassword(token, password)
  // Jeton absent, faux, expiré ou déjà consommé : même réponse.
  if (!ok) return res.status(400).json({ error: 'Lien invalide ou expiré. Refais une demande.' })
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
