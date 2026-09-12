import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { inspectFactualMemory } from '../../../lib/prospector/proactive/inspector'
import { HARNESS_WORKSPACE } from '../../../lib/prospector/proactive/harness/factualHarness'

// FACTUAL_MEMORY_INSPECTOR_V0_001 — ENDPOINT INTERNE, GET SEULEMENT.
//
// ── CE QUE CETTE ROUTE NE FAIT PAS ──────────────────────────────────────────
// Aucune mutation (POST/PUT/DELETE ⇒ 405), aucun accès générique au magasin
// (pas de `kind` choisi par le client), aucun espace choisi par le navigateur :
// l'espace est TOUJOURS celui du tenant résolu côté serveur — à l'unique
// exception, FERMÉE, de l'espace du harnais ci-dessous.
//
// ── ESPACE DU HARNAIS — LOCAL/DEV UNIQUEMENT, FAIL CLOSED ───────────────────
// `?scope=harness` mappe vers `ws_factual_harness` SEULEMENT quand le
// processus se prouve non-production (ni NODE_ENV=production, ni exécution
// Vercel). En production, la requête reçoit 404 : l'espace du harnais n'y est
// jamais adressable, quel que soit le rôle de la session.

function contexteLocal(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined) return false
  return true
}

const str = (v: unknown) => String((Array.isArray(v) ? v[0] : v) ?? '')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })

  let ws = tenant.id
  if (str(req.query.scope) === 'harness') {
    if (!contexteLocal()) return res.status(404).json({ error: 'not found' })
    ws = HARNESS_WORKSPACE
  }

  const lecture = await inspectFactualMemory(str(req.query.accountId), ws)
  if (lecture.ok === false) {
    if (lecture.reason === 'INVALID_ACCOUNT') {
      return res.status(400).json({ error: 'accountId invalide (forme attendue : acc_siren_<9 chiffres>)' })
    }
    return res.status(503).json({ error: 'store unavailable' })
  }
  return res.status(200).json({ view: lecture.view })
}
