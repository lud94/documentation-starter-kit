// Gestion de l'accès (côté Node) : mot de passe HASHÉ (bcrypt) + MFA TOTP.
// Stockage via keystore (mémoire + env). Pour du durable → Vercel env / Supabase.
import bcrypt from 'bcryptjs'
import { getKey, setKeys } from './keystore'
import { appEnv, onVercel } from '../env'
import { claimResetAuthority } from '../auth/resetAuthority'

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
// ⚠️ L'AUTORITÉ N'EST PLUS ICI (lot SEC-AUTH-0.1). Elle vit dans
// `lib/auth/resetAuthority.ts`, sur une ligne de `prospector_store`, et se
// consomme d'un seul `DELETE … RETURNING`. Deux raisons, toutes deux des
// défauts constatés :
//
//   1. la séquence `checkResetToken → setCredentials → invalidateResetToken`
//      était un check-then-act : vingt requêtes simultanées passaient toutes
//      la vérification avant la première invalidation ;
//
//   2. `getKey` retombe sur `process.env`. Une empreinte posée en variable
//      d'environnement survivait donc à toute invalidation, et redevenait une
//      autorisation de changer le mot de passe administrateur.
//
// `APP_RESET_TOKEN`, `APP_RESET_TOKEN_HASH` et `APP_RESET_EXP` ne sont PLUS
// LUS pour décider quoi que ce soit. Ils restent déclarés dans le keystore pour
// une seule raison : pouvoir écraser l'artefact hérité là où il traîne encore.
// Le nettoyage physique complet des secrets historiques relève de SEC-SECRETS-0.

/** Efface les artefacts de réinitialisation d'avant SEC-AUTH-0.1. */
export async function purgeLegacyResetKeys(): Promise<void> {
  await setKeys({ APP_RESET_TOKEN: '', APP_RESET_TOKEN_HASH: '', APP_RESET_EXP: '' })
}

/**
 * Change le mot de passe administrateur contre un bearer de réinitialisation.
 *
 * ORDRE IMPOSÉ : CONSOMMER, puis vérifier l'expiration, puis seulement écrire
 * le mot de passe. Jamais l'inverse. Si l'écriture échouait après la
 * réclamation, la réinitialisation serait perdue et l'utilisateur devrait en
 * redemander une — c'est préférable à un bearer réutilisable.
 */
export async function resetPassword(token: string, pw: string): Promise<boolean> {
  if (!(await claimResetAuthority(token))) return false
  await setCredentials(getEmail() || '', pw)
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
