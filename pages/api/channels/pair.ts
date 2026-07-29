import type { NextApiRequest, NextApiResponse } from 'next'
import { activeWs } from '../../../lib/auth/ws'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { createPairingCode, listChannelsFor, unlinkChannel } from '../../../lib/prospector/pairing'

// Appairage d'un canal mobile à l'espace courant (session requise).
// GET    → canaux déjà liés + état de configuration du bot.
// POST   → génère un code à usage unique (15 min).
// DELETE → délie un canal.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const ws = await activeWs(req)
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

  if (req.method === 'GET') {
    return res.status(200).json({
      channels: await listChannelsFor(ws),
      telegramReady: !!getKey('TELEGRAM_BOT_TOKEN'),
      botName: getKey('TELEGRAM_BOT_NAME') || '',
    })
  }
  if (req.method === 'POST') {
    if (!getKey('TELEGRAM_BOT_TOKEN')) return res.status(200).json({ error: 'Bot Telegram non configuré (Admin → Connexions → TELEGRAM_BOT_TOKEN).' })
    return res.status(200).json(await createPairingCode(ws))
  }
  if (req.method === 'DELETE') {
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis' })
    await unlinkChannel(id)
    return res.status(200).json({ ok: true })
  }
  res.status(405).json({ error: 'GET/POST/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
