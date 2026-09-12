import type { NextApiRequest, NextApiResponse } from 'next'
import { checkCredentials, isSetup } from '../../../lib/prospector/auth'
import { verifyTotp } from '../../../lib/auth/totp'
import { createSessionToken, sessionSecretConfigured } from '../../../lib/auth/session'
import { sessionCookie } from '../../../lib/auth/cookie'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { authClient } from '../../../lib/supabase/workspaces'
import { readAdminTotpSecret } from '../../../lib/secrets/platformVault'

const TTL = 60 * 60 * 12 // 12 h

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Le keystore reste l'autorite pour APP_EMAIL / APP_PASSWORD uniquement.
  await hydrateKeystore()

  if (!sessionSecretConfigured()) {
    return res.status(503).json({ error: 'auth_unavailable' })
  }

  if (!isSetup()) {
    return res.status(409).json({ error: 'not_setup' })
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const email = String(body?.email || '')
  const password = body?.password

  // 1) Admin ?
  if (checkCredentials(email, password)) {
    const mfa = await readAdminTotpSecret()

    if (!('reason' in mfa)) {
      const code = String(body?.code || '')

      if (!code) {
        return res.status(401).json({ error: 'mfa_required' })
      }

      if (!(await verifyTotp(mfa.value, code))) {
        return res.status(401).json({ error: 'Code MFA invalide.' })
      }
    } else if (
      mfa.reason === 'storage_error' ||
      mfa.reason === 'unreadable'
    ) {
      // Une MFA dont l'etat est inconnu ne doit jamais etre contournee.
      return res.status(503).json({ error: 'auth_unavailable' })
    }

    // not_configured / staged(wrong_state) / revoked :
    // aucune MFA ACTIVE ne fait autorite a cet instant.
    const token = await createSessionToken(email || 'admin', TTL, { role: 'admin' })

    if (!token) {
      return res.status(503).json({ error: 'auth_unavailable' })
    }

    res.setHeader('Set-Cookie', sessionCookie(token, TTL))
    return res.status(200).json({ ok: true, role: 'admin' })
  }

  // 2) Client d'un workspace ?
  const ws = await authClient(email, password)

  if (ws) {
    const token = await createSessionToken(
      email.trim().toLowerCase(),
      TTL,
      { role: 'client', ws: ws.id },
    )

    if (!token) {
      return res.status(503).json({ error: 'auth_unavailable' })
    }

    res.setHeader('Set-Cookie', sessionCookie(token, TTL))
    return res.status(200).json({ ok: true, role: 'client' })
  }

  return res.status(401).json({ error: 'Identifiants invalides.' })
}

function safeParse(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
