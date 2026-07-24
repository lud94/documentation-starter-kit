import type { NextApiRequest, NextApiResponse } from 'next'
import { checkPassword, isSetup, mfaEnabled, getTotpSecret } from '../../../lib/prospector/auth'
import { verifyTotp } from '../../../lib/auth/totp'
import { createSessionToken, SESSION_COOKIE } from '../../../lib/auth/session'

const TTL = 60 * 60 * 12 // 12 h

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!isSetup()) return res.status(409).json({ error: 'not_setup' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const password = body?.password
  if (!checkPassword(password)) return res.status(401).json({ error: 'Identifiants invalides.' })

  // 2e facteur si la MFA est activée
  if (mfaEnabled()) {
    const code = String(body?.code || '')
    if (!code) return res.status(401).json({ error: 'mfa_required' })
    if (!(await verifyTotp(getTotpSecret() || '', code))) return res.status(401).json({ error: 'Code MFA invalide.' })
  }

  const token = await createSessionToken('admin', TTL)
  res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token, TTL))
  res.status(200).json({ ok: true })
}

function cookie(name: string, value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : ''
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure}`
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
