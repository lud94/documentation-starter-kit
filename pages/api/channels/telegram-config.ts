import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import {
  platformSecretStatus,
  putTelegramBotToken,
  replacePlatformSecretValue,
  revokeTelegramBotToken,
  revokeTelegramWebhook,
} from '../../../lib/secrets/platformVault'

// SEC-SECRETS-0D.1 — autorité unique du jeton Telegram.
//
// Cette surface remplace /api/config/keys pour TELEGRAM_BOT_TOKEN.
// Le navigateur peut poser, remplacer ou révoquer le jeton, mais ne peut
// jamais le relire. Le clair n'existe que dans le corps de la requête puis
// dans Platform Vault le temps de son scellement.
//
// Aucun fallback vers prospector_settings ou process.env n'est permis ici.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminRequest(req))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  if (req.method === 'GET') {
    const status = await platformSecretStatus('telegram_bot_token')

    if (status.kind === 'error') {
      return res.status(503).json({ error: 'Vault indisponible.' })
    }

    return res.status(200).json({
      configured: status.kind === 'present' && status.status === 'active',
      status: status.kind === 'present' ? status.status : 'absent',
      version: status.kind === 'present' ? status.version : null,
    })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const token = typeof body?.token === 'string' ? body.token.trim() : ''

    // Borne volontairement large : on ne dépend pas d'un format Telegram
    // susceptible d'évoluer, mais on refuse vide et charges anormales.
    if (!token || token.length > 512) {
      return res.status(400).json({ error: 'Jeton Telegram invalide.' })
    }

    const current = await platformSecretStatus('telegram_bot_token')
    if (current.kind === 'error') {
      return res.status(503).json({ error: 'Vault indisponible.' })
    }

    const written = current.kind === 'absent'
      ? await putTelegramBotToken(token)
      : await replacePlatformSecretValue(
          'telegram_bot_token',
          token,
          current.version,
        )

    if (!written.ok) {
      if (written.outcome === 'stale' || written.outcome === 'exists') {
        return res.status(409).json({ error: 'Le jeton a changé entre-temps. Réessaie.' })
      }
      return res.status(503).json({ error: 'Impossible d’enregistrer le jeton.' })
    }

    return res.status(200).json({
      ok: true,
      configured: true,
      version: written.version,
    })
  }

  if (req.method === 'DELETE') {
  const [bot, webhook] = await Promise.all([
    platformSecretStatus('telegram_bot_token'),
    platformSecretStatus('telegram_webhook_secret'),
  ])

  if (bot.kind === 'error' || webhook.kind === 'error') {
    return res.status(503).json({ error: 'Vault indisponible.' })
  }

  // On révoque d'abord le secret d'entrée : même si la révocation du token
  // échoue ensuite, le webhook n'est déjà plus une porte autorisée.
  if (webhook.kind === 'present' && webhook.status !== 'revoked') {
    const revokedWebhook = await revokeTelegramWebhook(webhook.version)

    if (!revokedWebhook.ok) {
      if (revokedWebhook.outcome === 'stale') {
        return res.status(409).json({ error: 'La configuration Telegram a changé entre-temps. Réessaie.' })
      }
      return res.status(503).json({ error: 'Impossible de révoquer le webhook Telegram.' })
    }
  }

  if (bot.kind === 'present' && bot.status !== 'revoked') {
    const revokedBot = await revokeTelegramBotToken(bot.version)

    if (!revokedBot.ok) {
      if (revokedBot.outcome === 'stale') {
        return res.status(409).json({ error: 'La configuration Telegram a changé entre-temps. Réessaie.' })
      }
      return res.status(503).json({ error: 'Impossible de révoquer le jeton Telegram.' })
    }
  }

  return res.status(200).json({
    ok: true,
    configured: false,
  })
}

  return res.status(405).json({ error: 'GET/POST/DELETE only' })
}

function safeParse(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}