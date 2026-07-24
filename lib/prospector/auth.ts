// Gestion de l'accès (côté Node) : mot de passe HASHÉ (bcrypt) + MFA TOTP.
// Stockage via keystore (mémoire + env). Pour du durable → Vercel env / Supabase.
import bcrypt from 'bcryptjs'
import { getKey, setKeys } from './keystore'

export function isSetup(): boolean {
  return !!getKey('APP_PASSWORD')
}

export function setPassword(pw: string) {
  const hash = bcrypt.hashSync(pw, 10)
  setKeys({ APP_PASSWORD: hash })
}

export function checkPassword(pw: string): boolean {
  const ref = getKey('APP_PASSWORD')
  if (!ref || typeof pw !== 'string' || !pw) return false
  // rétro-compat : si un ancien mot de passe en clair traîne, on l'accepte une fois.
  if (!ref.startsWith('$2')) return pw === ref
  try { return bcrypt.compareSync(pw, ref) } catch { return false }
}

// ── MFA (TOTP) ──
export function mfaEnabled(): boolean {
  return getKey('APP_MFA_ENABLED') === '1' && !!getKey('APP_TOTP_SECRET')
}
export function getTotpSecret(): string | undefined {
  return getKey('APP_TOTP_SECRET')
}
export function stageTotpSecret(secret: string) {
  // secret provisoire tant que l'utilisateur n'a pas confirmé un 1er code
  setKeys({ APP_TOTP_SECRET: secret, APP_MFA_ENABLED: '0' })
}
export function enableMfa() {
  setKeys({ APP_MFA_ENABLED: '1' })
}
export function disableMfa() {
  setKeys({ APP_MFA_ENABLED: '0', APP_TOTP_SECRET: '' })
}
