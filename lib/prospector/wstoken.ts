// Jetons d'ingestion PAR WORKSPACE (multi-tenant) : dérivés par
// HMAC(secret, "ingest:"+wsId+":"+version). La `version` (par workspace, stockée
// dans prospector_store namespace "_meta") permet une RÉVOCATION INDIVIDUELLE :
// régénérer = incrémenter la version → l'ancien jeton du client cesse de valider,
// sans impacter les autres. Jeton global INGEST_TOKEN = espace admin.
import { getKey } from './keystore'
import { listWorkspaces } from '../supabase/workspaces'
import { listItems, upsertItem } from '../supabase/store'

const VER_NS = '_meta'
const VER_KIND = 'wsver'

function secret(): string {
  return process.env.APP_SESSION_SECRET || getKey('APP_SESSION_SECRET') || 'prospector-dev-secret'
}

const enc = new TextEncoder()
async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Version courante du jeton d'un workspace (1 par défaut). Lue à chaud (pas de cache).
export async function getTokenVersion(wsId: string): Promise<number> {
  try {
    const items = await listItems<{ id: string; v: number }>(VER_KIND, VER_NS)
    const it = items.find((x) => x.id === wsId)
    return it?.v || 1
  } catch { return 1 }
}

// Incrémente la version → révoque l'ancien jeton de CE workspace uniquement.
export async function bumpTokenVersion(wsId: string): Promise<number> {
  const v = (await getTokenVersion(wsId)) + 1
  await upsertItem(VER_KIND, wsId, { id: wsId, v }, VER_NS)
  return v
}

// Jeton d'un workspace (préfixe lisible + 32 hex), fonction de la version courante.
export async function tokenForWorkspace(wsId: string): Promise<string> {
  const v = await getTokenVersion(wsId)
  const h = await hmacHex(`ingest:${wsId}:${v}`)
  return `pk_${wsId}_${h.slice(0, 32)}`
}

// Résout un jeton → id de workspace ('admin' pour le jeton global), ou null.
export async function resolveWorkspaceByToken(token: string): Promise<string | null> {
  const t = (token || '').trim()
  if (!t) return null
  const admin = getKey('INGEST_TOKEN')
  if (admin && t === admin.trim()) return 'admin'
  // Le préfixe contient l'id → on recalcule le jeton attendu (avec sa version courante).
  const m = t.match(/^pk_(.+)_[0-9a-f]{32}$/)
  if (m) { if ((await tokenForWorkspace(m[1])) === t) return m[1] }
  else {
    try { const wss = await listWorkspaces(); for (const w of wss) { if ((await tokenForWorkspace(w.id)) === t) return w.id } } catch { /* pas de Supabase */ }
  }
  return null
}
