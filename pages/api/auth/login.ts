import type { NextApiRequest, NextApiResponse } from 'next'
import { checkCredentials, isSetup, mfaEnabled, getTotpSecret } from '../../../lib/prospector/auth'
import { verifyTotp } from '../../../lib/auth/totp'
import { createSessionToken, sessionSecretConfigured } from '../../../lib/auth/session'
import { sessionCookie } from '../../../lib/auth/cookie'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { authClient } from '../../../lib/supabase/workspaces'

const TTL = 60 * 60 * 12 // 12 h

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  // Sans racine d'identité, aucune session ne peut être émise : on refuse AVANT
  // de vérifier le moindre identifiant, et sans jamais poser de cookie.
  if (!sessionSecretConfigured()) return res.status(503).json({ error: 'auth_unavailable' })
  if (!isSetup()) return res.status(409).json({ error: 'not_setup' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const email = String(body?.email || '')
  const password = body?.password

  // 1) Admin ?
  if (checkCredentials(email, password)) {
    if (mfaEnabled()) {
      const code = String(body?.code || '')
      if (!code) return res.status(401).json({ error: 'mfa_required' })
      if (!(await verifyTotp(getTotpSecret() || '', code))) return res.status(401).json({ error: 'Code MFA invalide.' })
    }
    const token = await createSessionToken(email || 'admin', TTL, { role: 'admin' })
    if (!token) return res.status(503).json({ error: 'auth_unavailable' })
    res.setHeader('Set-Cookie', sessionCookie(token, TTL))
    return res.status(200).json({ ok: true, role: 'admin' })
  }

  // 2) Client d'un workspace ?
  const ws = await authClient(email, password)
  if (ws) {
    const token = await createSessionToken(email.trim().toLowerCase(), TTL, { role: 'client', ws: ws.id })
    // Un espace client qui ne respecte pas le contrat de session (vide, `admin`,
    // `_system`) ne produit AUCUN jeton — plutôt qu'un jeton qu'on refuserait
    // ensuite à chaque requête.
    if (!token) return res.status(503).json({ error: 'auth_unavailable' })
    res.setHeader('Set-Cookie', sessionCookie(token, TTL))
    return res.status(200).json({ ok: true, role: 'client' })
  }

  return res.status(401).json({ error: 'Identifiants invalides.' })
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
