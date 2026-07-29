import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import { hydrateKeystore, getKey, setKeys } from '../../../lib/prospector/keystore'

// Branche le webhook Telegram sur cette instance, en un clic (admin uniquement).
// Génère aussi un secret de webhook si absent (anti-spoofing).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()

  const token = getKey('TELEGRAM_BOT_TOKEN')
  if (!token) return res.status(200).json({ error: 'Renseigne TELEGRAM_BOT_TOKEN dans Connexions.' })

  let secret = getKey('TELEGRAM_WEBHOOK_SECRET')
  if (!secret) { secret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); await setKeys({ TELEGRAM_WEBHOOK_SECRET: secret }) }

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host = req.headers.host
  const url = `${proto}://${host}/api/channels/telegram`

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
    }).then((x) => x.json())
    if (!r.ok) return res.status(200).json({ error: r.description || 'setWebhook a échoué.' })

    // Récupère le nom du bot pour l'afficher dans l'app.
    try {
      const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((x) => x.json())
      if (me?.result?.username) await setKeys({ TELEGRAM_BOT_NAME: me.result.username })
      return res.status(200).json({ ok: true, url, botName: me?.result?.username || '' })
    } catch { return res.status(200).json({ ok: true, url }) }
  } catch (e: any) {
    res.status(200).json({ error: e?.message || 'Erreur réseau.' })
  }
}
