import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem } from '../../../lib/supabase/store'
import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { runStep } from '../../../lib/prospector/missionTools'
import {
  actionFingerprint,
  canonicalNeedsApproval,
  missionAuthorityInstanceOf,
  validateExecutableStep,
} from '../../../lib/prospector/missionContract'
import { consumeApproval } from '../../../lib/prospector/missionApprovals'
import { resolveSalesRole } from '../../../lib/prospector/authz/roleAssignmentStore'
import {
  actionRequiresExternalAI,
  evaluatePermission,
  INTRINSIC_ADMIN_WORKSPACE_POLICY,
  isActionRef,
} from '../../../lib/prospector/authz/permissionVerdict'
import { ADMIN_TENANT_ID } from '../../../lib/prospector/tenant'
import { getWorkspacePermissionsStrict } from '../../../lib/supabase/workspaces'
import { MISSION_TOOL_META } from '../../../types/prospector'
import type { Mission } from '../../../types/prospector'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// ORCHESTRATEUR : exécute UNE étape par appel, puis persiste l'état.
// Découpage volontaire → compatible serverless (pas de timeout), reprise après
// interruption gratuite, et pause avant toute étape sensible/coûteuse.
//
// SEC-004 — `approve: true` N'EST PLUS UNE AUTORITÉ. Une étape qui exige
// l'approbation ne s'exécute que si /run consomme ATOMIQUEMENT l'approbation
// EXACTE accordée par /api/missions/approve : même acteur, même espace, même
// mission, même étape, même outil, même empreinte de paramètres — recalculés
// ici depuis l'état serveur COURANT, jamais fournis par le corps. Manquante,
// déjà consommée, ou liée à autre chose ⇒ AUCUNE exécution, la mission reste
// en pause. L'approbation accordée ne marque RIEN comme accompli : seule
// l'exécution réussie de runStep termine l'étape.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  // SEC-004 — l'ACTEUR aussi : la consommation d'approbation est liée à `sub`.
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })
  const tenant = acteur.tenant
  const ws = tenant.id
  await hydrateKeystore()

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const id = String(body?.id || '')
  const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : ''

  // ── JS-020 R1-2 : UN SEUL instantané de rôle par requête, et la porte
  // mission:read AVANT toute révélation de contenu. Une mission TERMINALE
  // (done/cancelled) était rendue avant le verdict : un acteur au rôle révoqué
  // récupérait par /run ce que GET /api/missions lui refuse. La porte de
  // lecture précède désormais le chargement ; la révocation prend effet à la
  // requête suivante (instantané strict par requête, jamais de cache).
  const role = await resolveSalesRole(ws, acteur.actorId)
  const verdictLecture = evaluatePermission({ role, action: 'mission:read' })
  if (verdictLecture.state !== 'ALLOWED') {
    return res.status(403).json({
      error: 'forbidden', state: verdictLecture.state, reason: (verdictLecture as any).reason,
    })
  }

  const missions = await listItems<Mission>('mission', ws)
  const mission = missions.find((m) => m.id === id)
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' })
  // Retour terminal : atteignable UNIQUEMENT après la porte mission:read.
  if (mission.status === 'done' || mission.status === 'cancelled') return res.status(200).json({ mission })

  const step = mission.steps[mission.cursor]
  if (!step) {
    mission.status = 'done'
    mission.log.push({ at: Date.now(), text: 'Mission terminée.' })
    await upsertItem('mission', mission.id, mission, ws)
    return res.status(200).json({ mission })
  }

  // ── VALIDATION D'EXÉCUTION, INDÉPENDANTE DE LA CRÉATION (SEC-004). ────────
  // Une ligne persistée corrompue — outil inconnu, params hors bornes — ne
  // doit JAMAIS atteindre l'exécuteur. La frontière est CE refus explicite,
  // pas un TypeError accidentel en aval.
  if (!validateExecutableStep(step)) {
    step.status = 'failed'
    step.result = 'Étape non exécutable : outil inconnu ou paramètres invalides.'
    step.endedAt = Date.now()
    mission.status = 'failed'
    mission.log.push({ at: Date.now(), text: 'Échec : étape non exécutable (refus de sécurité).' })
    await upsertItem('mission', mission.id, mission, ws)
    return res.status(422).json({ mission, error: 'step_not_executable' })
  }

  // ── JS-020 : LE VERDICT DE PERMISSION PRÉCÈDE TOUTE CONSOMMATION (§11). ──
  // L'ORDRE EST LA SÉCURITÉ : rôle et politique d'espace sont évalués depuis
  // l'état serveur COURANT, AVANT consumeApproval. Un rôle révoqué ou une
  // politique retirée APRÈS l'accord refuse l'exécution SANS brûler l'accord
  // SEC-004 encore valide. L'approbation est NÉCESSAIRE où elle est exigée,
  // jamais SUFFISANTE.
  const actionRef = `mission:${step.tool}`
  const besoinPolitique = isActionRef(actionRef) && actionRequiresExternalAI(actionRef)
  const verdict = evaluatePermission({
    // MÊME instantané de rôle que la porte de lecture — un seul par requête.
    role,
    action: actionRef,
    // R1-1 — l'espace PROPRE de l'admin (identifiant, jamais le genre) porte
    // l'autorisation externalAI intrinsèque ; tout autre espace répond de sa
    // politique STRICTEMENT persistée.
    workspacePolicy: besoinPolitique
      ? (ws === ADMIN_TENANT_ID ? INTRINSIC_ADMIN_WORKSPACE_POLICY : await getWorkspacePermissionsStrict(ws))
      : undefined,
    missionScope: { ok: true }, // l'étape courante a passé validateExecutableStep
    needsApproval: canonicalNeedsApproval(step.tool, step.needsApproval),
  })
  if (verdict.state === 'BLOCKED' || verdict.state === 'SALES_ROLE_UNASSIGNED') {
    // R1.1 — REFUS DE PERMISSION ⇒ ZÉRO mutation d'autorité. Un acteur refusé
    // (capacité, politique d'espace, affectation) ne fait RIEN avancer ni
    // changer : ni statut, ni curseur, ni journal, ni persistance. La mission
    // reste EXACTEMENT dans l'état chargé. (La pause d'attente d'approbation,
    // elle, reste : c'est l'exécutant AUTORISÉ qui entre en attente légitime.)
    return res.status(403).json({
      mission, error: 'forbidden', state: verdict.state, reason: (verdict as any).reason,
    })
  }

  // ── APPROBATION CANONIQUE — recalculée serveur, le client ne peut que durcir.
  if (verdict.state === 'APPROVAL_REQUIRED') {
    if (!approvalId) {
      // Pas d'approbation présentée : on rend la main. `approve: true` ne
      // change RIEN — cette clé n'est plus lue.
      mission.status = 'paused'
      await upsertItem('mission', mission.id, mission, ws)
      return res.status(200).json({ mission, awaiting: step })
    }
    const attendu = {
      actorId: acteur.actorId,
      workspaceId: ws,
      missionId: mission.id,
      // R2 — re-dérivée de la mission relue : delete + recréation du même id
      // change l'instance, donc l'identifiant attendu — un accord périmé ne
      // peut pas autoriser une mission différente.
      missionAuthorityInstance: missionAuthorityInstanceOf(mission),
      stepId: step.id,
      tool: step.tool,
      actionFingerprint: actionFingerprint(step.tool, step.params || {}),
    }
    const consomme = await consumeApproval(attendu, approvalId)
    if (consomme.ok === false) {
      // Approbation absente, déjà consommée, ou liée à un autre acteur/étape/
      // paramètre : AUCUNE exécution. La mission reste en pause — l'état
      // n'avance pas sur une autorité qu'on n'a pas.
      mission.status = 'paused'
      await upsertItem('mission', mission.id, mission, ws)
      return res.status(403).json({ mission, error: consomme.reason })
    }
  }

  mission.status = 'running'
  step.status = 'running'
  try {
    const { result, context } = await runStep(tenant, step, mission, ws)
    step.status = 'done'; step.result = result; step.endedAt = Date.now()
    mission.context = context
    mission.log.push({ at: Date.now(), text: `${MISSION_TOOL_META[step.tool].label} → ${result}` })
    mission.cursor += 1
    mission.status = mission.cursor >= mission.steps.length ? 'done' : 'running'
    if (mission.status === 'done') mission.log.push({ at: Date.now(), text: 'Mission terminée.' })
  } catch (e: any) {
    // SEC-LOG-01 — `step.result` est PERSISTÉ puis réaffiché dans le journal de
    // mission : c'est une frontière durable, pas un log éphémère.
    logSafeError('missions.step_error', e, { operation: 'mission_step' })
    step.status = 'failed'; step.result = PUBLIC_ERROR; step.endedAt = Date.now()
    mission.status = 'failed'
    mission.log.push({ at: Date.now(), text: `Échec : ${step.result}` })
  }

  await upsertItem('mission', mission.id, mission, ws)
  res.status(200).json({ mission })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
