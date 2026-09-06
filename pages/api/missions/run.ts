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

  const missions = await listItems<Mission>('mission', ws)
  const mission = missions.find((m) => m.id === id)
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' })
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

  // ── APPROBATION CANONIQUE — recalculée serveur, le client ne peut que durcir.
  if (canonicalNeedsApproval(step.tool, step.needsApproval)) {
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
