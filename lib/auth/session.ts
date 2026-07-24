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

// Jeton = payloadB64.signature ; payload = { sub, exp }
export async function createSessionToken(sub: string, ttlSeconds: number): Promise<string> {
  const payload = { sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await hmac(body)
  return `${body}.${sig}`
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token || !token.includes('.')) return false
  const [body, sig] = token.split('.')
  if (!body || !sig) return false
  if ((await hmac(body)) !== sig) return false
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}
