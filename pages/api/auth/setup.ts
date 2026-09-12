import type { NextApiRequest, NextApiResponse } from 'next'
import { isSetup, localSetupAllowed, setCredentials } from '../../../lib/prospector/auth'
import { createSessionToken, sessionSecretConfigured } from '../../../lib/auth/session'
import { sessionCookie } from '../../../lib/auth/cookie'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

const TTL = 60 * 60 * 12

/**
 * Création du compte administrateur — DÉVELOPPEMENT LOCAL UNIQUEMENT.
 *
 * ⚠️ CE QUE CETTE ROUTE FAISAIT (lot SEC-AUTH-0, §8). Elle était publique et
 * sans condition d'environnement : tant qu'aucun mot de passe n'existait, le
 * PREMIER POST venu — de n'importe qui sur Internet — définissait l'email et le
 * mot de passe administrateur, et repartait avec une session. Sur un
 * déploiement neuf, ou dès que le stockage des clés était vide, l'application
 * offrait son compte d'administration à qui la trouvait le premier.
 *
 * Le bootstrap d'un déploiement passe désormais par la CONFIGURATION opérateur
 * (`APP_EMAIL` + `APP_PASSWORD` contenant une empreinte bcrypt, cf.
 * `scripts/hash-password.mjs`), jamais par une requête HTTP anonyme.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Refus AVANT toute lecture du corps : rien de ce que l'appelant envoie n'est
  // même regardé sur un environnement où le setup public n'a pas lieu d'être.
  if (!localSetupAllowed()) return res.status(403).json({ error: 'setup_disabled' })

  await hydrateKeystore()
  if (isSetup()) return res.status(409).json({ error: 'already_setup' })

  // Sans racine d'identité, on ne peut pas émettre de session : on ne crée pas
  // non plus le compte, pour ne pas laisser une instance à moitié initialisée.
  if (!sessionSecretConfigured()) return res.status(503).json({ error: 'auth_unavailable' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const email = String(body?.email || '').trim()
  const password = String(body?.password || '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' })
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' })

  // ⚠️ RÔLE EXPLICITE. L'appel était `createSessionToken(email, TTL)` : la
  // session émise ici n'avait PAS de rôle, et n'était administrateur que par la
  // grâce du « pas de rôle = admin » de guard.ts. Les deux sont fermés.
  const token = await createSessionToken(email, TTL, { role: 'admin' })
  if (!token) return res.status(503).json({ error: 'auth_unavailable' })

  await setCredentials(email, password)
  res.setHeader('Set-Cookie', sessionCookie(token, TTL))
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
