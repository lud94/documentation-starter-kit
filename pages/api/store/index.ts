import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { PROACTIVE_KIND_LIST } from '../../../lib/prospector/proactive/persistence'

// JARVIS-PROACTIVE-01D — les quatre `kind` du Decision Model rejoignent la
// whitelist DE LECTURE, et rien d'autre. La liste est importée plutôt que
// recopiée : deux listes finiraient par diverger.
//
// SEC-004 — LECTURE ≠ ÉCRITURE CLIENT. La whitelist unique laissait un client
// authentifié POSTer des `mission` forgées (contournant le contrat canonique)
// et des `proactive_*` forgés (fabriquant Evidence/Situations/Recommendations
// dans sa propre histoire décisionnelle). Deux listes désormais :
//
//   READ_KINDS   ce que l'UI peut LIRE ici — inclut mission et les kinds du
//                Decision Model (affichage) ;
//   WRITE_KINDS  ce que le client peut ÉCRIRE/SUPPRIMER ici — les objets
//                d'usage UI uniquement. Les missions se créent par
//                /api/missions (contrat canonique, create-only) ; les objets
//                du Decision Model ne s'écrivent que par leurs producteurs
//                serveur validés.
//
// ⚠️ AUCUN kind d'AUTORITÉ (approbation de mission, affectation de rôle…) ne
// doit JAMAIS rejoindre WRITE_KINDS — ni, sauf besoin d'affichage prouvé,
// READ_KINDS.
//
// Aucun assouplissement du cloisonnement : la route continue de résoudre le
// tenant AVANT toute lecture, et `ws` reste `tenant.id` — jamais le corps de la
// requête, jamais la query.
const WRITE_KINDS = ['sequence', 'task', 'thread', 'list', 'notification']
const READ_KINDS = [...WRITE_KINDS, 'mission', ...PROACTIVE_KIND_LIST]

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

  if (req.method === 'GET') {
    if (!READ_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
    return res.status(200).json({ items: await listItems(kind, ws) })
  }

  // ── MUTATIONS : whitelist d'ÉCRITURE seule. Un kind lisible mais non
  // inscriptible est REFUSÉ explicitement — jamais accepté « parce que connu ».
  if (!WRITE_KINDS.includes(kind)) {
    return res.status(READ_KINDS.includes(kind) ? 403 : 400).json({ error: 'kind non modifiable par le client' })
  }

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
