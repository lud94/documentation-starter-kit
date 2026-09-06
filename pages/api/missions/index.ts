import type { NextApiRequest, NextApiResponse } from 'next'
import { randomUUID } from 'node:crypto'
import { listItems, insertItemIfAbsent, deleteItem } from '../../../lib/supabase/store'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { canonicalizeMission } from '../../../lib/prospector/missionContract'
import type { Mission } from '../../../types/prospector'

// CRUD des missions, cloisonné par espace.
//
// SEC-0b — l'espace vient du résolveur MT-0. Aucun repli sur « admin » : une
// session absente, un client sans espace ou un espace admin invalide ferment.
//
// SEC-004 — PLANNER ≠ CONTROLLER. La Mission reçue est une ENTRÉE : le serveur
// RECONSTRUIT le contrat exécutable (`canonicalizeMission`) — statut draft,
// curseur 0, contexte vide, journal vide, étapes reconstruites, approbation
// canonique (write ∨ costly ∨ souhait client), outil inconnu ⇒ REFUS. La
// création est CREATE-ONLY (`insertItemIfAbsent`) : re-POSTer un identifiant
// existant ne peut plus remplacer l'état exécutable d'une mission en cours —
// c'est un 409, pas un écrasement. Les mutations d'exécution passent par
// /api/missions/run, et par lui seul.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })
  const ws = tenant.id
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

  if (req.method === 'GET') {
    const items = await listItems<Mission>('mission', ws)
    return res.status(200).json({ missions: items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
  }
  if (req.method === 'POST') {
    // R2 — identité d'INSTANCE d'autorité : opaque, aléatoire, serveur. La
    // valeur éventuellement proposée par le client est ignorée par le contrat.
    const canonique = canonicalizeMission(body?.mission, Date.now(), `mai_${randomUUID()}`)
    if (canonique.ok === false) {
      return res.status(422).json({ error: 'mission invalide', reason: canonique.reason })
    }
    const mission = canonique.mission
    const inserted = await insertItemIfAbsent('mission', mission.id, mission, ws)
    if (!inserted) {
      // Déjà présente (ou base muette) : on ne restaure PAS un upsert. Une
      // mission existante ne se remplace pas par un POST — fail closed.
      return res.status(409).json({ error: 'mission déjà enregistrée', id: mission.id })
    }
    return res.status(200).json({ ok: true, mission })
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    return res.status(200).json({ ok: await deleteItem('mission', id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
