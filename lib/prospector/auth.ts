// Gestion de l'accès (côté Node) : mot de passe HASHÉ (bcrypt) + MFA TOTP.
// Stockage via keystore (mémoire + env). Pour du durable → Vercel env / Supabase.
import bcrypt from 'bcryptjs'
import { getKey, setKeys } from './keystore'

export function isSetup(): boolean {
  return !!getKey('APP_PASSWORD')
}

export function getEmail(): string | undefined {
  return getKey('APP_EMAIL')
}

const normEmail = (e: string) => (e || '').trim().toLowerCase()

// Crée le compte : email (identifiant) + mot de passe hashé.
export async function setCredentials(email: string, pw: string) {
  const hash = bcrypt.hashSync(pw, 10)
  await setKeys({ APP_EMAIL: normEmail(email), APP_PASSWORD: hash })
}

// Vérifie email + mot de passe. Si aucun email n'est enregistré (ancien compte),
// on ne vérifie que le mot de passe (rétro-compat).
export function checkCredentials(email: string, pw: string): boolean {
  const refEmail = getKey('APP_EMAIL')
  if (refEmail && normEmail(email) !== normEmail(refEmail)) return false
  const ref = getKey('APP_PASSWORD')
  if (!ref || typeof pw !== 'string' || !pw) return false
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
export async function stageTotpSecret(secret: string) {
  // secret provisoire tant que l'utilisateur n'a pas confirmé un 1er code
  await setKeys({ APP_TOTP_SECRET: secret, APP_MFA_ENABLED: '0' })
}
export async function enableMfa() {
  await setKeys({ APP_MFA_ENABLED: '1' })
}
export async function disableMfa() {
  await setKeys({ APP_MFA_ENABLED: '0', APP_TOTP_SECRET: '' })
}
