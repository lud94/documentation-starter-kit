// SEC-004_MISSION_EXEC_AUTHORITY_V0_001 — ACCORDER UNE APPROBATION.
//
// ── APPROBATION ≠ EXÉCUTION ─────────────────────────────────────────────────
// Cette route ACCORDE ; elle n'exécute JAMAIS. L'étape approuvée reste
// intouchée : c'est /api/missions/run qui, muni de l'identifiant rendu ici,
// consommera l'approbation atomiquement puis exécutera — ou refusera.
//
// Le client ne fournit QUE `missionId` et `stepId`. Acteur et espace viennent
// de la session (`resolveActorFromRequest`) ; outil, paramètres et empreinte
// sont recalculés depuis la mission SERVEUR courante. Aucun champ du corps ne
// porte d'autorité.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { listItems } from '../../../lib/supabase/store'
import {
  actionFingerprint,
  canonicalNeedsApproval,
  missionAuthorityInstanceOf,
  validateExecutableStep,
} from '../../../lib/prospector/missionContract'
import { grantApproval } from '../../../lib/prospector/missionApprovals'
import { resolveSalesRole } from '../../../lib/prospector/authz/roleAssignmentStore'
import {
  actionRequiresExternalAI,
  evaluatePermission,
  INTRINSIC_ADMIN_WORKSPACE_POLICY,
  isActionRef,
} from '../../../lib/prospector/authz/permissionVerdict'
import { ADMIN_TENANT_ID } from '../../../lib/prospector/tenant'
import { getWorkspacePermissionsStrict } from '../../../lib/supabase/workspaces'
import type { Mission } from '../../../types/prospector'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'forbidden' })
  const ws = acteur.tenant.id

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const missionId = String(body?.missionId || '')
  const stepId = String(body?.stepId || '')
  if (!missionId || !stepId) return res.status(400).json({ error: 'missionId et stepId requis' })

  try {
    // ── JS-020 R1-3 : LA CAPACITÉ DE CYCLE DE VIE mission:approve EST UNE
    // AUTORITÉ RÉELLE, évaluée EN PREMIER — avant même de charger la mission.
    // Un acteur non affecté ou interdit du cycle de vie n'utilise pas /approve
    // comme oracle (existence de mission, état paused, identifiant d'étape) :
    // il reçoit le refus d'autorité, et rien d'autre. UN SEUL instantané de
    // rôle par requête, réutilisé par la porte OUTIL plus bas.
    const role = await resolveSalesRole(ws, acteur.actorId)
    const verdictCycle = evaluatePermission({ role, action: 'mission:approve' })
    if (verdictCycle.state !== 'ALLOWED') {
      return res.status(403).json({
        error: 'forbidden', state: verdictCycle.state, reason: (verdictCycle as any).reason,
      })
    }
    const missions = await listItems<Mission>('mission', ws)
    const mission = missions.find((m) => m.id === missionId)
    if (!mission) return res.status(404).json({ error: 'Mission introuvable.' })

    // ── L'APPROBATION NE VAUT QUE POUR L'ÉTAPE COURANTE, EN PAUSE. ──────────
    // Approuver une étape future ou passée n'a pas de sens : la liaison est
    // recalculée depuis l'état exécutable COURANT, et lui seul.
    if (mission.status !== 'paused') {
      return res.status(409).json({ error: 'mission_not_awaiting_approval', status: mission.status })
    }
    const step = mission.steps?.[mission.cursor]
    if (!step || !validateExecutableStep(step)) {
      return res.status(422).json({ error: 'step_not_executable' })
    }
    if (step.id !== stepId) {
      return res.status(409).json({ error: 'step_not_current', current: step.id })
    }
    if (!canonicalNeedsApproval(step.tool, step.needsApproval)) {
      return res.status(409).json({ error: 'step_does_not_require_approval' })
    }

    // ── JS-020 : AUCUN ACCORD SANS AUTORITÉ (§12). Seul un verdict
    // APPROVAL_REQUIRED — rôle affecté, capacité présente, politique d'espace
    // satisfaite — peut créer ou rejouer un accord. Un acteur non affecté,
    // interdit de capacité ou sous politique refusée n'obtient RIEN.
    const actionRef = `mission:${step.tool}`
    const besoinPolitique = isActionRef(actionRef) && actionRequiresExternalAI(actionRef)
    // La porte OUTIL ne REMPLACE pas mission:approve : l'autorité d'accord est
    // l'INTERSECTION des deux (cycle de vie ∩ capacité d'outil ∩ politique).
    const verdict = evaluatePermission({
      role, // même instantané que la porte de cycle de vie
      action: actionRef,
      // R1-1 — même règle que /run : identifiant d'espace admin ⇒ intrinsèque.
      workspacePolicy: besoinPolitique
        ? (ws === ADMIN_TENANT_ID ? INTRINSIC_ADMIN_WORKSPACE_POLICY : await getWorkspacePermissionsStrict(ws))
        : undefined,
      missionScope: { ok: true },
      needsApproval: true, // l'étape courante exige l'approbation (vérifié ci-dessus)
    })
    if (verdict.state !== 'APPROVAL_REQUIRED') {
      return res.status(403).json({
        error: 'forbidden', state: verdict.state, reason: (verdict as any).reason,
      })
    }

    const grant = await grantApproval({
      actorId: acteur.actorId,
      workspaceId: ws,
      missionId: mission.id,
      // R2 — dérivée de la mission CHARGÉE DU SERVEUR, jamais du client.
      missionAuthorityInstance: missionAuthorityInstanceOf(mission),
      stepId: step.id,
      tool: step.tool,
      actionFingerprint: actionFingerprint(step.tool, step.params || {}),
    }, Date.now())
    if (grant.ok === false) return res.status(503).json({ error: 'approval_store_failed' })

    // AUCUNE exécution ici : la mission et l'étape restent telles quelles.
    return res.status(200).json({
      ok: true,
      approvalId: grant.approvalId,
      alreadyGranted: grant.alreadyGranted,
      missionId: mission.id,
      stepId: step.id,
    })
  } catch (e) {
    logSafeError('missions.approve_failed', e, { operation: 'mission_approve' })
    return res.status(502).json({ error: PUBLIC_ERROR })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
