import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Canal IN-APP (barre ⌘K) — adaptateur mince, MÊME cerveau que l'extension et
// Telegram. L'espace vient de la session (pas d'un jeton).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  // SEC-0b — l'espace de PERSISTANCE est désormais le même : il venait
  // d'`activeWs()`, qui repliait sur « admin ». Le refus précède aussi la
  // lecture des réglages : une requête sans espace n'apprend plus si une clé
  // Anthropic est configurée.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })
  const ws = tenant.id
  await hydrateKeystore()
  if (!getKey('ANTHROPIC_API_KEY')) {
    return res.status(200).json({ reply: 'Configure ta clé Anthropic (Admin → Connexions) pour activer Jarvis.', off: true })
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const message = String(body?.message || '')
  const confirm = !!body?.confirm
  const action = body?.action || null

  try {
    // 2e appel : l'utilisateur a confirmé → on exécute.
    if (confirm && action) {
      return res.status(200).json({ reply: await executeJarvis(tenant, action, ws), done: true })
    }

    const plan = await planJarvis(tenant, message, { channel: 'app' })
    if (plan.action && isWrite(plan.action)) {
      return res.status(200).json({ reply: plan.reply, action: plan.action, needsConfirm: true })
    }
    if (plan.action) {
      return res.status(200).json({ reply: plan.reply, result: await executeJarvis(tenant, plan.action, ws) })
    }
    return res.status(200).json({ reply: plan.reply || '…' })
  } catch (e: any) {
    return res.status(200).json({ reply: 'Jarvis est momentanément indisponible (' + (e?.message || 'erreur') + ').' })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
