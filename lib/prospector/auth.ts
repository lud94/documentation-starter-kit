// Gestion de l'accès (côté Node) : mot de passe HASHÉ (bcrypt) + MFA TOTP.
// Stockage via keystore (mémoire + env). Pour du durable → Vercel env / Supabase.
import bcrypt from 'bcryptjs'
import { getKey, setKeys } from './keystore'
import { appEnv, onVercel } from '../env'

/** Empreinte bcrypt ? Seul format d'identifiant admin accepté depuis SEC-AUTH-0. */
function isBcrypt(v: string | undefined): boolean {
  return typeof v === 'string' && /^\$2[aby]?\$/.test(v)
}

/**
 * Un identifiant administrateur UTILISABLE existe-t-il ?
 *
 * ⚠️ Un `APP_PASSWORD` en clair ne compte plus. Il ne rend pas l'application
 * « configurée » : il la rend non authentifiable, et c'est exactement ce qu'on
 * veut dire à l'opérateur plutôt que de le laisser croire à un compte valide.
 */
export function isSetup(): boolean {
  return isBcrypt(getKey('APP_PASSWORD'))
}

/**
 * Le setup PUBLIC est-il autorisé ? Par défaut : NON.
 *
 * ── LE DÉFAUT FERMÉ (§8) ────────────────────────────────────────────────────
 * `/api/auth/setup` était une route publique qui, tant qu'aucun mot de passe
 * n'existait, acceptait du PREMIER VENU un email et un mot de passe et en
 * faisait l'administrateur. Sur un déploiement, la fenêtre entre la mise en
 * ligne et la première connexion légitime est une prise de contrôle offerte —
 * et elle se rouvre à chaque fois que le stockage des clés est vide.
 *
 * Il faut désormais TROIS conditions simultanées, et l'opt-in ne suffit pas
 * seul : `NODE_ENV !== 'production'` ne protège rien (une préversion Vercel
 * n'est pas « production »).
 */
export function localSetupAllowed(): boolean {
  if (onVercel()) return false                       // jamais sur un déploiement
  const env = appEnv()
  if (env && env !== 'development') return false     // ni staging, ni production
  return (process.env.ALLOW_LOCAL_AUTH_SETUP || '').trim() === '1'
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

/**
 * Vérifie email + mot de passe administrateur.
 *
 * ── LE DÉFAUT FERMÉ (§10) ───────────────────────────────────────────────────
 *
 *     if (!ref.startsWith('$2')) return pw === ref
 *
 * Cette branche acceptait un `APP_PASSWORD` en CLAIR. Autrement dit, le mot de
 * passe administrateur pouvait vivre en variable d'environnement, lisible par
 * quiconque a accès au tableau de bord Vercel, aux journaux de construction ou
 * à un `printenv` dans une fonction. Une comparaison `===` en prime, donc
 * sensible au temps.
 *
 * On ne maintient pas une branche faible permanente au nom de la
 * compatibilité : `scripts/hash-password.mjs` produit l'empreinte bcrypt en
 * local, et c'est elle qu'on pose en configuration.
 */
export function checkCredentials(email: string, pw: string): boolean {
  const refEmail = getKey('APP_EMAIL')
  if (refEmail && normEmail(email) !== normEmail(refEmail)) return false
  const ref = getKey('APP_PASSWORD')
  if (!ref || typeof pw !== 'string' || !pw) return false
  if (!isBcrypt(ref)) return false      // clair hérité ⇒ DENY, jamais une comparaison
  try { return bcrypt.compareSync(pw, ref) } catch { return false }
}

// ── Réinitialisation du mot de passe ────────────────────────────────────────
//
// ── LE DÉFAUT FERMÉ (§15) ───────────────────────────────────────────────────
// Le jeton était stocké EN CLAIR dans `APP_RESET_TOKEN`, donc dans
// `prospector_settings`. C'est un jeton PORTEUR : le lire, c'est pouvoir
// changer le mot de passe administrateur. Une lecture de la table des réglages
// — sauvegarde, export, fuite de la clé de service — donnait le compte.
//
// Désormais : le jeton brut n'existe QUE dans l'email. On ne conserve que son
// empreinte. SHA-256 suffit ici et bcrypt serait un contresens : bcrypt protège
// un secret DEVINABLE choisi par un humain ; ce jeton fait 192 bits d'aléa, il
// n'y a rien à ralentir.

const RESET_TTL_MS = 30 * 60 * 1000

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Comparaison à temps constant — même contrat que pour les signatures. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Crée un jeton fort. Le BRUT est rendu à l'appelant — pour l'email, et rien d'autre. */
export async function createResetToken(): Promise<string> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  await setKeys({
    APP_RESET_TOKEN_HASH: await sha256Hex(token),
    APP_RESET_EXP: String(Date.now() + RESET_TTL_MS),
    APP_RESET_TOKEN: '',    // écrase l'artefact hérité en clair, là où il traîne
  })
  return token
}

/** Ferme immédiatement toute réinitialisation en cours. */
export async function invalidateResetToken(): Promise<void> {
  await setKeys({ APP_RESET_TOKEN_HASH: '', APP_RESET_EXP: '', APP_RESET_TOKEN: '' })
}

export async function checkResetToken(token: string): Promise<boolean> {
  const ref = getKey('APP_RESET_TOKEN_HASH')
  const exp = parseInt(getKey('APP_RESET_EXP') || '0', 10)
  if (!ref || !token || typeof token !== 'string') return false
  if (!Number.isFinite(exp) || Date.now() >= exp) return false
  return timingSafeEqual(await sha256Hex(token), ref)
}

export async function resetPassword(token: string, pw: string): Promise<boolean> {
  if (!(await checkResetToken(token))) return false
  const email = getEmail() || ''
  await setCredentials(email, pw)
  await invalidateResetToken()          // usage unique
  return true
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
