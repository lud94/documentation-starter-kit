import type { NextApiRequest, NextApiResponse } from 'next'
import { listItems, upsertItem } from '../../../lib/supabase/store'
import { activeWs } from '../../../lib/auth/ws'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { runStep } from '../../../lib/prospector/missionTools'
import { MISSION_TOOL_META } from '../../../types/prospector'
import type { Mission } from '../../../types/prospector'

// ORCHESTRATEUR : exécute UNE étape par appel, puis persiste l'état.
// Découpage volontaire → compatible serverless (pas de timeout), reprise après
// interruption gratuite, et pause avant toute étape sensible/coûteuse.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const ws = await activeWs(req)
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
    const { result, context } = await runStep(step, mission, ws)
    step.status = 'done'; step.result = result; step.endedAt = Date.now()
    mission.context = context
    mission.log.push({ at: Date.now(), text: `${MISSION_TOOL_META[step.tool].label} → ${result}` })
    mission.cursor += 1
    mission.status = mission.cursor >= mission.steps.length ? 'done' : 'running'
    if (mission.status === 'done') mission.log.push({ at: Date.now(), text: 'Mission terminée.' })
  } catch (e: any) {
    step.status = 'failed'; step.result = e?.message || 'Échec'; step.endedAt = Date.now()
    mission.status = 'failed'
    mission.log.push({ at: Date.now(), text: `Échec : ${step.result}` })
  }

  await upsertItem('mission', mission.id, mission, ws)
  res.status(200).json({ mission })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
