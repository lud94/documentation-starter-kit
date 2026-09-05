// Cookie de session — une seule construction, pour tout le monde (SEC-AUTH-0).
//
// `login.ts` et `setup.ts` fabriquaient chacun leur en-tête `Set-Cookie` à la
// main, avec deux chaînes voisines mais distinctes. Deux copies d'une règle de
// sécurité divergent : il suffit qu'un attribut soit corrigé d'un seul côté.
// Ce module ne change PAS la politique en vigueur (HttpOnly, SameSite=Lax,
// Path=/, Secure sur déploiement) — il la rend unique.
import { onVercel } from '../env'
import { SESSION_COOKIE } from './session'

/** `Secure` dès qu'on n'est plus sur un poste de développement. */
function secureAttr(): string {
  return onVercel() || process.env.NODE_ENV === 'production' ? ' Secure;' : ''
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds};${secureAttr()}`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secureAttr()}`
}
