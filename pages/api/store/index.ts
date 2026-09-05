import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { PROACTIVE_KIND_LIST } from '../../../lib/prospector/proactive/persistence'

// JARVIS-PROACTIVE-01D — les quatre `kind` du Decision Model rejoignent la
// whitelist, et RIEN D'AUTRE ne change ici. La liste est importée plutôt que
// recopiée : deux listes finiraient par diverger, et une divergence ici
// signifierait qu'un objet persistable côté serveur devient illisible côté
// route, ou l'inverse.
//
// Aucun assouplissement du cloisonnement : la route continue de résoudre le
// tenant AVANT toute lecture, et `ws` reste `tenant.id` — jamais le corps de la
// requête, jamais la query.
const KINDS = [
  'sequence', 'task', 'thread', 'list', 'mission', 'notification',
  ...PROACTIVE_KIND_LIST,
] // whitelist

const str = (v: any) => (Array.isArray(v) ? v[0] : v) || ''

// SEC-0b — le résolveur local est supprimé au profit de la doctrine MT-0. Il
// traitait `!claims` comme un administrateur et repliait un client sans espace
// sur « admin » : deux fail-open, dans un module qui persiste des données client.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })
  const ws = tenant.id
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const kind = String((req.method === 'GET' ? str(req.query.kind) : body?.kind) || '')
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })

  if (req.method === 'GET') return res.status(200).json({ items: await listItems(kind, ws) })

  if (req.method === 'POST') {
    const items = Array.isArray(body?.items) ? body.items : body?.item ? [body.item] : []
    let n = 0
    for (const it of items) { if (it?.id && (await upsertItem(kind, String(it.id), it, ws))) n++ }
    return res.status(200).json({ ok: true, saved: n })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    return res.status(200).json({ ok: await deleteItem(kind, id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
