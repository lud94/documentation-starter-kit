import type { NextApiRequest, NextApiResponse } from 'next'
import { randomUUID } from 'node:crypto'
import { listItems, insertItemIfAbsent, deleteItem } from '../../../lib/supabase/store'
import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { canonicalizeMission } from '../../../lib/prospector/missionContract'
import { resolveSalesRole } from '../../../lib/prospector/authz/roleAssignmentStore'
import { evaluatePermission } from '../../../lib/prospector/authz/permissionVerdict'
import type { Mission } from '../../../types/prospector'

// CRUD des missions, cloisonné par espace.
//
// SEC-0b — l'espace vient du résolveur MT-0. Aucun repli sur « admin » : une
// session absente, un client sans espace ou un espace admin invalide ferment.
//
// SEC-004 — PLANNER ≠ CONTROLLER. La Mission reçue est une ENTRÉE : le serveur
// RECONSTRUIT le contrat exécutable (`canonicalizeMission`) — statut draft,
// curseur 0, contexte vide, journal vide, étapes reconstruites, approbation
// canonique, outil inconnu ⇒ REFUS, instance d'autorité serveur (R2). La
// création reste CREATE-ONLY (`insertItemIfAbsent`).
//
// JS-020 — AUTORITÉ DE RÔLE CANONIQUE. Les MUTATIONS (POST/DELETE) exigent un
// RoleKind Sales AFFECTÉ portant la capacité mission:create / mission:delete —
// pour TOUT acteur, session admin comprise (l'infrastructure n'implique aucun
// rôle métier). Le GET conserve l'inspection admin en lecture seule ; un
// client exige mission:read. Le périmètre V0 est explicitement l'espace
// entier (aucune propriété de Mission n'est modélisée — on n'en invente pas).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'forbidden' })
  const ws = acteur.tenant.id
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

  if (req.method === 'GET') {
    // Inspection d'infrastructure : l'admin conserve sa lecture d'espace
    // actuelle (lecture seule). Un acteur CLIENT projette via son rôle Sales.
    if (acteur.tenant.kind !== 'admin') {
      const verdict = evaluatePermission({
        role: await resolveSalesRole(ws, acteur.actorId), action: 'mission:read',
      })
      if (verdict.state !== 'ALLOWED') {
        return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
      }
    }
    const items = await listItems<Mission>('mission', ws)
    return res.status(200).json({ missions: items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
  }

  if (req.method === 'POST') {
    // ── JS-020 : capacité AVANT contrat. Le RoleKind vient du document
    // d'affectation serveur — jamais du corps ni de la query.
    const verdict = evaluatePermission({
      role: await resolveSalesRole(ws, acteur.actorId), action: 'mission:create',
    })
    if (verdict.state !== 'ALLOWED') {
      return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
    }
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
    const verdict = evaluatePermission({
      role: await resolveSalesRole(ws, acteur.actorId), action: 'mission:delete',
    })
    if (verdict.state !== 'ALLOWED') {
      return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
    }
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    // Périmètre V0 explicite : l'espace entier — la propriété de Mission n'est
    // pas modélisée, on ne la fabrique pas ici.
    return res.status(200).json({ ok: await deleteItem('mission', id, ws) })
  }

  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
