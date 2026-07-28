// Jetons d'ingestion PAR WORKSPACE (multi-tenant), sans migration ni stockage :
// dérivés par HMAC(secret, "ingest:"+wsId). Déterministe (l'admin peut l'afficher),
// et révocable en tournant APP_SESSION_SECRET. Le jeton global INGEST_TOKEN reste
// le jeton admin (espace « admin »).
import { getKey } from './keystore'
import { listWorkspaces } from '../supabase/workspaces'

function secret(): string {
  return process.env.APP_SESSION_SECRET || getKey('APP_SESSION_SECRET') || 'prospector-dev-secret'
}

const enc = new TextEncoder()
async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Jeton d'un workspace (préfixe lisible + 32 hex).
export async function tokenForWorkspace(wsId: string): Promise<string> {
  const h = await hmacHex(`ingest:${wsId}`)
  return `pk_${wsId}_${h.slice(0, 32)}`
}

// Résout un jeton → id de workspace ('admin' pour le jeton global), ou null.
export async function resolveWorkspaceByToken(token: string): Promise<string | null> {
  const t = (token || '').trim()
  if (!t) return null
  const admin = getKey('INGEST_TOKEN')
  if (admin && t === admin.trim()) return 'admin'
  // Court-circuit : le préfixe contient l'id → on vérifie juste le HMAC de cet id.
  const m = t.match(/^pk_(.+)_[0-9a-f]{32}$/)
  if (m) { const expected = await tokenForWorkspace(m[1]); if (expected === t) return m[1] }
  // Repli : compare à tous les workspaces (jeton sans préfixe exploitable).
  try {
    const wss = await listWorkspaces()
    for (const w of wss) { if ((await tokenForWorkspace(w.id)) === t) return w.id }
  } catch { /* pas de Supabase */ }
  return null
}
