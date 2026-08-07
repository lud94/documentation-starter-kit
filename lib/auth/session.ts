// Session signée (HMAC-SHA256) — RACINE D'IDENTITÉ (lot SEC-AUTH-0).
//
// Compatible edge middleware ET routes API Node : n'utilise que Web Crypto.
//
// ── LES DEUX DÉFAUTS FERMÉS ICI ─────────────────────────────────────────────
//
// 1. SECRET PUBLIC PAR DÉFAUT.
//
//        const DEFAULT_SECRET = 'prospector-dev-secret-change-me'
//        process.env.APP_SESSION_SECRET || DEFAULT_SECRET
//
//    Ce littéral est dans le dépôt. Quiconque le lisait pouvait signer
//    `{"sub":"x","role":"admin","exp":<loin>}` et devenir administrateur de
//    toute instance dont `APP_SESSION_SECRET` n'était pas posé. Ce n'est pas
//    une faiblesse de configuration : c'est une clé d'administration publiée.
//    Il n'y a plus AUCUN repli. Secret absent ou trop court ⇒ aucune session
//    n'est émise, aucune session n'est acceptée.
//
// 2. RÔLE OPTIONNEL. `role?: 'admin' | 'client'` laissait exister des jetons
//    sans rôle, que `guard.ts` et `tenant.ts` promouvaient en ADMINISTRATEUR
//    (« compte unique historique »). Un jeton client mal formé, ou une route
//    qui oubliait de passer le rôle — c'était le cas de `/api/auth/setup` —
//    produisait donc un administrateur. Le rôle est désormais OBLIGATOIRE à
//    l'émission (le compilateur l'exige) et EXIGÉ à la lecture.
//
// ⚠️ RUPTURE VOULUE : les sessions historiques sans rôle sont invalidées.
//
// ── CE QUI N'EST PAS FERMÉ ICI ──────────────────────────────────────────────
// La session reste un HMAC APATRIDE : la révoquer avant son expiration est
// impossible. Un changement de mot de passe ne tue pas les sessions déjà
// émises. Cela demande un `session_version` — c'est SEC-AUTH-1, et je ne le
// présente pas comme fait.

export const SESSION_COOKIE = 'ps_session'

/**
 * Longueur minimale du secret, en octets UTF-8.
 *
 * Aucune « analyse d'entropie » : elle est facile à tromper et donne une fausse
 * assurance. Une longueur plancher plus une génération réellement aléatoire par
 * l'opérateur (`openssl rand -hex 32`) est un contrat vérifiable.
 */
export const MIN_SESSION_SECRET_BYTES = 32

const enc = new TextEncoder()

/**
 * Secret de signature, ou `null`.
 *
 * UNIQUEMENT depuis la configuration serveur. Jamais depuis le corps, le
 * cookie, la base, ni un littéral de repli.
 */
function sessionSecret(): string | null {
  const s = (process.env.APP_SESSION_SECRET || '').trim()
  if (!s) return null
  return enc.encode(s).length >= MIN_SESSION_SECRET_BYTES ? s : null
}

/**
 * La racine d'identité est-elle utilisable ? Les routes qui émettent une
 * session s'en servent pour répondre 503 AVANT de poser un cookie.
 *
 * ⚠️ AUCUN `throw` à l'import : le middleware, la construction et les pages de
 * diagnostic doivent pouvoir démarrer sur une instance mal configurée — sinon
 * la panne devient impossible à diagnostiquer. On ferme à l'usage, pas au
 * chargement.
 */
export function sessionSecretConfigured(): boolean {
  return sessionSecret() !== null
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return b64url(sig)
}

/** Comparaison à temps constant : une signature se compare, elle ne se devine pas. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Les deux seuls rôles. Tout autre valeur est refusée, pas interprétée. */
export type SessionRole = 'admin' | 'client'

export interface SessionClaims {
  sub: string
  /** OBLIGATOIRE. Il n'existe plus de session sans rôle. */
  role: SessionRole
  /** Obligatoire et non vide pour un client ; ignoré pour un administrateur. */
  ws?: string
  exp: number
}

/** Le contrat d'espace d'une session client, appliqué à l'ÉMISSION comme à la LECTURE. */
function clientWorkspaceValid(ws: unknown): ws is string {
  const id = typeof ws === 'string' ? ws.trim() : ''
  // `admin` est l'espace propre de l'administrateur ; `_system` est le tenant
  // système. Aucun des deux n'est un espace client, donc aucune session client
  // ne peut les porter — même signée.
  return !!id && id !== 'admin' && id !== '_system'
}

/**
 * Émet un jeton `payload.signature`.
 *
 * Rend `null` — et l'appelant DOIT répondre en erreur SANS poser de cookie —
 * si le secret manque, s'il est trop court, ou si les claims sont incohérentes.
 */
export async function createSessionToken(
  sub: string,
  ttlSeconds: number,
  claims: { role: SessionRole; ws?: string },
): Promise<string | null> {
  const secret = sessionSecret()
  if (!secret) return null
  const subject = (sub || '').trim()
  if (!subject) return null
  if (claims?.role !== 'admin' && claims?.role !== 'client') return null
  if (claims.role === 'client' && !clientWorkspaceValid(claims.ws)) return null
  if (!Number.isFinite(ttlSeconds)) return null

  const payload: SessionClaims = {
    sub: subject,
    role: claims.role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(claims.role === 'client' ? { ws: String(claims.ws).trim() } : {}),
  }
  const body = b64url(enc.encode(JSON.stringify(payload)))
  return `${body}.${await hmac(body, secret)}`
}

/**
 * Rend les claims d'un jeton VALIDE, sinon `null`.
 *
 * Le parsing est canonique : exactement deux segments non vides, signature
 * comparée à temps constant, payload JSON, `sub` non vide, `exp` fini et non
 * échu, rôle explicitement `admin` ou `client`, et pour un client un espace qui
 * n'est ni vide, ni `admin`, ni `_system`.
 *
 * Un jeton dont on ne sait pas exactement ce qu'il affirme n'est pas accepté
 * « au mieux » : il est refusé.
 */
export async function readSession(token: string | undefined): Promise<SessionClaims | null> {
  const secret = sessionSecret()
  if (!secret || !token) return null

  // Exactement DEUX segments. `body.sig.autrechose` était accepté par
  // `split('.')` déstructuré en deux : la queue était simplement ignorée.
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null

  if (!timingSafeEqual(await hmac(body, secret), sig)) return null

  let payload: any
  try {
    payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null

  if (payload.role === 'admin') {
    return { sub: payload.sub, role: 'admin', exp: payload.exp }
  }
  if (payload.role === 'client') {
    if (!clientWorkspaceValid(payload.ws)) return null
    return { sub: payload.sub, role: 'client', ws: String(payload.ws).trim(), exp: payload.exp }
  }
  // Rôle absent, inconnu, ou non textuel : DENY. Aucune rétrocompatibilité
  // implicite — c'est précisément « pas de rôle = admin » qu'on ferme.
  return null
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  return (await readSession(token)) !== null
}
