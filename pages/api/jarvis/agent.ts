import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { resolveWorkspaceByToken } from '../../../lib/prospector/wstoken'
import { tenantFromVerifiedWorkspace } from '../../../lib/prospector/tenant'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Canal EXTENSION (widget flottant sur le web) — adaptateur mince.
// Utilise le MÊME cerveau Jarvis que Telegram : mêmes capacités partout.
// Protégé par le jeton d'ingestion (qui détermine aussi l'espace de destination).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ingest-token')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  await hydrateKeystore()
  const ref = getKey('INGEST_TOKEN')
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const token = String(req.headers['x-ingest-token'] || body?.token || '')
  if (!ref) return res.status(401).json({ error: 'Aucun jeton configuré côté Prospector.' })
  const ws = await resolveWorkspaceByToken(token)
  if (!ws) return res.status(401).json({ error: 'Jeton invalide.' })
  // MT-0 — l'espace vient du jeton d'ingestion, déjà vérifié ci-dessus.
  const tenant = await tenantFromVerifiedWorkspace(ws)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })

  const message = String(body?.message || '')
  const url = String(body?.url || '')
  const title = String(body?.title || '')
  const confirm = !!body?.confirm
  const action = body?.action || null

  try {
    // 2e appel : l'utilisateur a confirmé → on exécute.
    if (confirm && action) {
      return res.status(200).json({ reply: await executeJarvis(tenant, action, ws, url), done: true })
    }

    const plan = await planJarvis(tenant, message, { url, title, channel: 'extension' })
    // Écriture → on demande confirmation ; lecture → on exécute tout de suite.
    if (plan.action && isWrite(plan.action)) {
      return res.status(200).json({ reply: plan.reply, action: plan.action, needsConfirm: true })
    }
    if (plan.action) {
      return res.status(200).json({ reply: plan.reply, result: await executeJarvis(tenant, plan.action, ws, url) })
    }
    return res.status(200).json({ reply: plan.reply || "Je n'ai pas d'action à proposer ici.", action: null })
  } catch (e: any) {
    return res.status(200).json({ reply: 'Erreur : ' + (e?.message || 'agent indisponible'), action: null })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
