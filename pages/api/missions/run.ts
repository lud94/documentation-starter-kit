import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem } from '../../../lib/supabase/store'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { runStep } from '../../../lib/prospector/missionTools'
import { MISSION_TOOL_META } from '../../../types/prospector'
import type { Mission } from '../../../types/prospector'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// ORCHESTRATEUR : exécute UNE étape par appel, puis persiste l'état.
// Découpage volontaire → compatible serverless (pas de timeout), reprise après
// interruption gratuite, et pause avant toute étape sensible/coûteuse.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  // SEC-0b — l'espace de PERSISTANCE est désormais le même : il venait
  // d'`activeWs()`, qui repliait sur « admin ». Deux résolveurs pour une même
  // requête, c'est deux vérités qui peuvent diverger ; il n'y en a plus qu'une.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })
  const ws = tenant.id
  await hydrateKeystore()

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const id = String(body?.id || '')
  const approve = !!body?.approve   // l'utilisateur a validé l'étape en attente

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

  // Pause : étape sensible/coûteuse non encore validée → on rend la main.
  if (step.needsApproval && !approve) {
    mission.status = 'paused'
    await upsertItem('mission', mission.id, mission, ws)
    return res.status(200).json({ mission, awaiting: step })
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
