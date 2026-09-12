// JS-013 — MONITEURS DE COMPTE : lecture, création, arrêt.
//
// ── LECTURE ≠ REVALIDATION (ABSOLU) ─────────────────────────────────────────
// GET ne déclenche RIEN : aucun producteur, aucun web, aucun LLM, aucune
// évaluation de matérialité, aucune mutation cachée. Lire un moniteur n'est
// pas le faire tourner.
//
// ── AUTORITÉ AVANT DIVULGATION ──────────────────────────────────────────────
// Chaque méthode évalue son verdict JS-020 (monitoring:read/create/stop)
// AVANT tout chargement/révélation. Refus ⇒ 403 typé, ZÉRO mutation.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { resolveSalesRole } from '../../../lib/prospector/authz/roleAssignmentStore'
import { evaluatePermission } from '../../../lib/prospector/authz/permissionVerdict'
import {
  validateAccountMonitorInput,
} from '../../../lib/prospector/monitoring/accountMonitor'
import {
  acquireMonitorOperationLease,
  createAccountMonitor,
  listMonitors,
  loadMonitor,
  releaseMonitorOperationLease,
  stopMonitor,
} from '../../../lib/prospector/monitoring/monitoringStore'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'forbidden' })
  const ws = acteur.tenant.id

  try {
    // UN SEUL instantané de rôle par requête (doctrine JS-020).
    const role = await resolveSalesRole(ws, acteur.actorId)

    if (req.method === 'GET') {
      const verdict = evaluatePermission({ role, action: 'monitoring:read' })
      if (verdict.state !== 'ALLOWED') {
        return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
      }
      // Lecture STRICTE du magasin — et rien d'autre. « La base n'a pas
      // répondu » ≠ « aucun moniteur » (R1, Fix 3-A) : jamais un 200 vide
      // mensonger sur panne.
      const lu = await listMonitors(ws)
      if (lu.ok === false) return res.status(503).json({ error: 'store_unavailable' })
      return res.status(200).json({ monitors: lu.monitors })
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

    if (req.method === 'POST') {
      const verdict = evaluatePermission({ role, action: 'monitoring:create' })
      if (verdict.state !== 'ALLOWED') {
        return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
      }
      // Validation d'entrée APRÈS l'autorité. Le client ne contrôle NI le
      // workspace, NI la provenance, NI les horodatages, NI le statut, NI la
      // révision : le serveur canonicalise tout.
      const valide = validateAccountMonitorInput({
        accountRef: body?.accountRef, lensId: body?.lensId, cadencePolicy: body?.cadencePolicy,
      })
      if (valide.ok === false) return res.status(400).json({ error: valide.reason })
      const cree = await createAccountMonitor({
        workspaceId: ws,
        accountRef: valide.accountRef,
        lensId: valide.lensId,
        cadencePolicy: valide.cadencePolicy,
        createdByActorId: acteur.actorId,
        nowMs: Date.now(),
      })
      if (cree.ok === false) {
        if (cree.reason === 'monitor_already_exists') {
          return res.status(409).json({ error: 'monitor_already_exists', monitorId: cree.existingId })
        }
        return res.status(503).json({ error: 'store_write_failed' })
      }
      return res.status(200).json({ monitor: cree.monitor })
    }

    if (req.method === 'PATCH') {
      // SEULE transition de cycle de vie : ACTIVE → STOPPED, TERMINALE.
      const verdict = evaluatePermission({ role, action: 'monitoring:stop' })
      if (verdict.state !== 'ALLOWED') {
        return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
      }
      const monitorId = typeof body?.monitorId === 'string' ? body.monitorId : ''
      if (!monitorId || body?.action !== 'stop') return res.status(400).json({ error: 'monitorId et action=stop requis' })
      // ── R1, Fix 2 : RUN et STOP partagent LE MÊME bail d'opération. Un STOP
      // ne court jamais SOUS un run en vol (qui ré-upserterait ensuite son
      // objet ACTIVE périmé) : bail détenu ⇒ conflit temporaire typé.
      const bail = await acquireMonitorOperationLease(ws, monitorId, Date.now())
      if (bail.ok === false) {
        return bail.reason === 'STORE_FAILURE'
          ? res.status(503).json({ error: 'store_unavailable' })
          : res.status(409).json({ error: 'monitor_busy' })
      }
      try {
        const lu = await loadMonitor(ws, monitorId)
        if (lu.ok === false) return res.status(503).json({ error: 'store_unavailable' })
        if (lu.monitor === null) return res.status(404).json({ error: 'monitor_not_found' })
        if (lu.monitor.status === 'STOPPED') {
          return res.status(409).json({ error: 'monitor_already_stopped' })
        }
        const arrete = await stopMonitor(lu.monitor, acteur.actorId, Date.now())
        if (arrete.ok === false) return res.status(503).json({ error: 'store_write_failed' })
        return res.status(200).json({ monitor: arrete.monitor })
      } finally {
        await releaseMonitorOperationLease(ws, monitorId, bail.leaseToken)
      }
    }

    return res.status(405).json({ error: 'GET, POST ou PATCH' })
  } catch (e) {
    logSafeError('monitoring.index_failed', e, { operation: 'monitoring_index' })
    return res.status(502).json({ error: PUBLIC_ERROR })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
