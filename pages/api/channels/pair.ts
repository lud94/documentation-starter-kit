import type { NextApiRequest, NextApiResponse } from 'next'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { platformSecretStatus } from '../../../lib/secrets/platformVault'
import { createPairingCode, listChannelsFor, unlinkChannel } from '../../../lib/prospector/pairing'

// Appairage d'un canal mobile à l'espace courant (session requise).
// GET    → canaux déjà liés + état de configuration du bot.
// POST   → génère un code à usage unique (15 min).
// DELETE → délie un canal.
//
// SEC-0b — l'espace vient du résolveur MT-0, jamais d'un repli sur « admin ».
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })
  const ws = tenant.id
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

if (req.method === 'GET') {
  const telegram = await platformSecretStatus('telegram_bot_token')

  if (telegram.kind === 'error') {
    return res.status(503).json({ error: 'Vault Telegram indisponible.' })
  }

  return res.status(200).json({
    channels: await listChannelsFor(ws),
    telegramReady: telegram.kind === 'present' && telegram.status === 'active',
    botName: getKey('TELEGRAM_BOT_NAME') || '',
  })
}
if (req.method === 'POST') {
const telegram = await platformSecretStatus('telegram_bot_token')

if (telegram.kind === 'error') {
  return res.status(503).json({ error: 'Vault Telegram indisponible.' })
}

if (telegram.kind !== 'present' || telegram.status !== 'active') {
  return res.status(200).json({ error: 'Bot Telegram non configuré.' })
}
    // `createPairingCode` rend `null` quand le titre d'espace est disputé par
    // une génération concurrente, ou après cinq collisions de code. Un refus,
    // jamais un code silencieusement écrasé.
    const created = await createPairingCode(ws)
    if (!created) return res.status(200).json({ error: 'Génération impossible pour le moment. Réessaie.' })
    return res.status(200).json(created)
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    // La propriété est vérifiée DANS `unlinkChannel` : les liens vivent dans un
    // espace technique partagé, où le cloisonnement du magasin ne s'applique pas.
    return res.status(200).json({ ok: await unlinkChannel(id, ws) })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
