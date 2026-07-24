// Gestion du mot de passe d'accès (côté Node — lit le keystore + env).
// Le mot de passe se pose à la 1re visite (setup) ou via APP_PASSWORD (Vercel env).
import { getKey, setKeys } from './keystore'

export function isSetup(): boolean {
  return !!getKey('APP_PASSWORD')
}

export function checkPassword(pw: string): boolean {
  const ref = getKey('APP_PASSWORD')
  if (!ref) return false
  // comparaison simple (le vrai durcissement = hash + Supabase, cf. préco).
  return typeof pw === 'string' && pw.length > 0 && pw === ref
}

export function setPassword(pw: string) {
  setKeys({ APP_PASSWORD: pw })
}
