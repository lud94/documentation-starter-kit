// Session signée (HMAC-SHA256) — compatible edge middleware ET routes API Node.
// N'utilise QUE Web Crypto (globalThis.crypto.subtle), disponible dans les deux.
// Le secret vient de APP_SESSION_SECRET (Vercel env) — à poser en prod.

export const SESSION_COOKIE = 'ps_session'
const DEFAULT_SECRET = 'prospector-dev-secret-change-me'

function sessionSecret(): string {
  return process.env.APP_SESSION_SECRET || DEFAULT_SECRET
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(sessionSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return b64url(sig)
}

export interface SessionClaims { sub: string; role?: 'admin' | 'client'; ws?: string; exp: number }

// Jeton = payloadB64.signature ; payload = { sub, role, ws, exp }
export async function createSessionToken(sub: string, ttlSeconds: number, extra?: { role?: 'admin' | 'client'; ws?: string }): Promise<string> {
  const payload: SessionClaims = { sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds, ...extra }
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await hmac(body)
  return `${body}.${sig}`
}

// Renvoie les claims si la signature ET l'expiration sont valides, sinon null.
export async function readSession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  if ((await hmac(body)) !== sig) return null
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000) ? payload : null
  } catch {
    return null
  }
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  return (await readSession(token)) !== null
}
