// TOTP (RFC 6238) via Web Crypto — compatible Google Authenticator / Authy.
// Secret en base32. Pas de dépendance externe.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateSecret(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let bits = '', out = ''
  for (let i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, '0')
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

function base32ToBytes(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = ''
  for (const c of clean) {
    const idx = B32.indexOf(c)
    if (idx < 0) continue
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return new Uint8Array(bytes)
}

async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32ToBytes(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setUint32(4, counter) // 32 bits de poids faible suffisent
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
  const offset = sig[sig.length - 1] & 0xf
  const code = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3]
  return (code % 1_000_000).toString().padStart(6, '0')
}

// Vérifie un code sur une fenêtre ±1 pas (30 s) pour tolérer le décalage d'horloge.
export async function verifyTotp(secret: string, token: string, stepMs = 30_000): Promise<boolean> {
  if (!secret || !/^\d{6}$/.test(token || '')) return false
  const counter = Math.floor(Date.now() / stepMs)
  for (const c of [counter - 1, counter, counter + 1]) {
    if (await hotp(secret, c) === token) return true
  }
  return false
}

export function otpauthUri(secret: string, account: string, issuer = 'Prospector'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
