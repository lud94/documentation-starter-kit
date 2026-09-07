// JS-013 — EXÉCUTION HUMAINE À LA DEMANDE d'un run de monitoring.
//
// ── ORDRE DE PRÉ-ADMISSION (R2-6, FIGÉ) ─────────────────────────────────────
//   1. acteur/espace   2. rôle Sales UNE FOIS   3. verdict monitoring:run
//   4. politique d'espace exigée par le producteur CONCRET
//   5. moniteur ACTIVE chargé (sans effet)   6. éligibilité de cadence
//   7. ADMISSION (claim + run + lastAttemptAt)   8+. producteurs/évaluation.
//
// Un refus AVANT admission est un refus de SÉCURITÉ : 403 typé, ZÉRO écriture
// (ni run, ni claim, ni reçu, ni lastAttemptAt). `executionState = BLOCKED`
// est réservé au run ADMIS qui rencontre un blocage OPÉRATIONNEL.
//
// ── monitoring:run = CAPACITÉ HUMAINE V0 ────────────────────────────────────
// Pas une autorité de scheduler : une future exécution machine exigera son
// propre contrat d'autorité runtime — et n'usurpera jamais l'identifiant de
// provenance du créateur du moniteur.
import type { NextApiRequest, NextApiResponse } from 'next'

import { ADMIN_TENANT_ID, resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { resolveSalesRole } from '../../../lib/prospector/authz/roleAssignmentStore'
import {
  evaluatePermission,
  INTRINSIC_ADMIN_WORKSPACE_POLICY,
} from '../../../lib/prospector/authz/permissionVerdict'
import { getWorkspacePermissionsStrict } from '../../../lib/supabase/workspaces'
import { cadenceEligibility } from '../../../lib/prospector/monitoring/accountMonitor'
import { loadMonitor } from '../../../lib/prospector/monitoring/monitoringStore'
import {
  defaultMonitoringRuntime,
  executeMonitoringRun,
} from '../../../lib/prospector/monitoring/monitoringRun'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'forbidden' })
  const ws = acteur.tenant.id

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const monitorId = typeof body?.monitorId === 'string' ? body.monitorId : ''
    if (!monitorId) return res.status(400).json({ error: 'monitorId requis' })

    // 2-3 — rôle UNE FOIS, puis verdict monitoring:run AVANT toute divulgation.
    const role = await resolveSalesRole(ws, acteur.actorId)
    const verdict = evaluatePermission({ role, action: 'monitoring:run' })
    if (verdict.state !== 'ALLOWED') {
      return res.status(403).json({ error: 'forbidden', state: verdict.state, reason: (verdict as any).reason })
    }

    // 4 — la politique d'espace suit la capacité RÉELLE des producteurs
    //     configurés : externalAI n'est exigé que si un producteur le déclare.
    //     (Le producteur V0 contrôlé ne prétend PAS l'exiger s'il n'appelle
    //     aucun fournisseur — pas d'interdit hors sujet.)
    const runtime = defaultMonitoringRuntime()
    const exigeExternalAI = runtime.producers.some((p) => p.requiresExternalAI)
    if (exigeExternalAI) {
      const politique = ws === ADMIN_TENANT_ID
        ? INTRINSIC_ADMIN_WORKSPACE_POLICY
        : await getWorkspacePermissionsStrict(ws)
      if (politique.ok === false) {
        return res.status(403).json({ error: 'forbidden', reason: 'WORKSPACE_POLICY_UNAVAILABLE' })
      }
      if (politique.state !== 'CONFIGURED' || politique.permissions.externalAI !== true) {
        return res.status(403).json({ error: 'forbidden', reason: 'WORKSPACE_POLICY_DENIED' })
      }
    }

    // 5 — chargement SANS effet de bord.
    const lu = await loadMonitor(ws, monitorId)
    if (lu.ok === false) return res.status(503).json({ error: 'store_unavailable' })
    if (lu.monitor === null) return res.status(404).json({ error: 'monitor_not_found' })
    if (lu.monitor.status !== 'ACTIVE') {
      return res.status(409).json({ error: 'monitor_not_active', status: lu.monitor.status })
    }

    // 6 — cadence : trop tôt ⇒ AUCUNE acquisition, AUCUNE écriture.
    const cadence = cadenceEligibility(lu.monitor, new Date())
    if (cadence.eligible === false) {
      return res.status(200).json({
        eligible: false, reason: cadence.reason, nextEligibleAt: cadence.nextEligibleAt,
      })
    }

    // 7-8 — ADMISSION puis exécution SOUS BAIL : re-lecture STRICTE du
    //        moniteur COURANT (un STOP commité entre-temps est VU — R1 Fix 2),
    //        lastAttemptAt vérifié, producteurs, reçus, matérialité,
    //        constructeur unique — chaque écriture vérifiée (R1 Fix 3).
    const resultat = await executeMonitoringRun(lu.monitor, runtime, Date.now())
    if (resultat.ok === false) {
      switch (resultat.reason) {
        case 'CLAIM_HELD':
          return res.status(409).json({ error: 'run_claim_held' })
        case 'MONITOR_STOPPED':
          return res.status(409).json({ error: 'monitor_not_active', status: 'STOPPED' })
        case 'MONITOR_MISSING':
          return res.status(404).json({ error: 'monitor_not_found' })
        case 'NOT_ELIGIBLE_YET':
          return res.status(200).json({ eligible: false, reason: 'NOT_ELIGIBLE_YET', nextEligibleAt: resultat.nextEligibleAt })
        case 'STORE_FAILURE':
          // Jamais un succès fabriqué sur panne. Si le résultat de run est
          // néanmoins durable (échec APRÈS son écriture), on le joint.
          return res.status(503).json({
            error: 'store_failure', stage: resultat.stage,
            ...(resultat.run ? { run: resultat.run } : {}),
          })
      }
    }
    return res.status(200).json({ run: resultat.run, monitor: resultat.monitor })
  } catch (e) {
    logSafeError('monitoring.run_failed', e, { operation: 'monitoring_run' })
    return res.status(502).json({ error: PUBLIC_ERROR })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
