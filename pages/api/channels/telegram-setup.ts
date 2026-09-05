import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import { setKeys } from '../../../lib/prospector/keystore'
import {
  readTelegramBotToken,
  platformSecretStatus,
  putTelegramWebhookPending,
  replacePlatformSecretValue,
  readTelegramWebhookSecret,
  confirmTelegramWebhookActive,
} from '../../../lib/secrets/platformVault'
import { appBaseUrl } from '../../../lib/auth/baseUrl'

// Branche le webhook Telegram sur cette instance, en un clic (admin uniquement).
// Génère aussi un secret de webhook si absent (anti-spoofing).
//
// ── DEUX DÉFAUTS FERMÉS (lot SEC-AUTH-2) ────────────────────────────────────
//
// 1. `Math.random()` ENGENDRAIT LE SECRET DU WEBHOOK. Ce n'est pas un
//    générateur cryptographique : sa sortie est prédictible pour qui observe
//    quelques valeurs, et deux instances peuvent produire la même suite. Or ce
//    secret EST la frontière de confiance durcie en SEC-TG — c'est lui qui
//    distingue un appel de Telegram d'un appel de n'importe qui. Le durcissement
//    du webhook reposait donc sur une valeur devinable.
//
// 2. L'URL ENREGISTRÉE CHEZ TELEGRAM VENAIT DE LA REQUÊTE
//    (`x-forwarded-proto` + `Host`). Une requête admin passant par un hôte
//    hostile faisait enregistrer CETTE adresse chez Telegram : toutes les mises
//    à jour du bot — messages, identifiants de conversation, jetons de
//    rappel — seraient parties chez un tiers, et le canal aurait été détourné à
//    la source. Une requête ne choisit pas l'adresse que Prospector déclare.
//
// La garde d'administration, elle, était déjà en place : elle est confirmée ici,
// pas ajoutée.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  const tokenRead = await readTelegramBotToken()

if (!tokenRead.ok) {
  const reason = 'reason' in tokenRead ? tokenRead.reason : 'unreadable'

  if (reason === 'not_configured' || reason === 'revoked') {
    return res.status(200).json({ error: 'Renseigne le jeton Telegram dans Canaux mobiles.' })
  }

  return res.status(503).json({ error: 'Vault Telegram indisponible.' })
}

const token = tokenRead.value

  // ⚠️ L'URL vient de la CONFIGURATION, jamais de la requête. Vérifiée AVANT de
  // produire quoi que ce soit : sans origine sûre, on n'engendre pas de secret
  // et on n'enregistre aucun webhook.
  const base = appBaseUrl()
  if (!base) return res.status(200).json({ error: 'APP_BASE_URL absente ou invalide : impossible de déclarer un webhook.' })
  const url = `${base}/api/channels/telegram`

  const webhookState = await platformSecretStatus('telegram_webhook_secret')

if (webhookState.kind === 'error') {
  return res.status(503).json({ error: 'Vault Telegram indisponible.' })
}

let secret: string
let webhookVersion: number
let webhookNeedsConfirmation = false

if (
  webhookState.kind === 'absent' ||
  (webhookState.kind === 'present' && webhookState.status === 'revoked')
) {
  const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const written = webhookState.kind === 'absent'
    ? await putTelegramWebhookPending(generated)
    : await replacePlatformSecretValue(
        'telegram_webhook_secret',
        generated,
        webhookState.version,
      )

  if (!written.ok) {
    if (written.outcome === 'stale' || written.outcome === 'exists') {
      return res.status(409).json({
        error: 'La configuration Telegram a changé entre-temps. Réessaie.',
      })
    }

    return res.status(503).json({
      error: 'Impossible d’enregistrer le secret webhook.',
    })
  }

  secret = generated
  webhookVersion = written.version
  webhookNeedsConfirmation = true
} else {
  const current = await readTelegramWebhookSecret()

  if (!current.ok) {
    return res.status(503).json({
      error: 'Secret webhook Telegram illisible.',
    })
  }

  secret = current.value
  webhookVersion = current.version
  webhookNeedsConfirmation = current.status === 'pending_provider'
}

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
    }).then((x) => x.json())
    // Le corps d'erreur de Telegram n'est pas sous notre contrôle : il peut
    // réfléchir l'URL déclarée, voire des fragments de la requête. On n'en
    // relaie rien.
    if (!r.ok) return res.status(200).json({ error: 'setWebhook a échoué.' })
if (webhookNeedsConfirmation) {
  const confirmed = await confirmTelegramWebhookActive(webhookVersion)

  if (!confirmed.ok) {
    if (confirmed.outcome === 'stale') {
      return res.status(409).json({
        error: 'La configuration Telegram a changé entre-temps. Réessaie.',
      })
    }

    return res.status(503).json({
      error: 'Webhook accepté par Telegram mais confirmation Vault impossible.',
    })
  }
}

    // Récupère le nom du bot pour l'afficher dans l'app.
    try {
      const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((x) => x.json())
      if (me?.result?.username) await setKeys({ TELEGRAM_BOT_NAME: me.result.username })
      return res.status(200).json({ ok: true, url, botName: me?.result?.username || '' })
    } catch { return res.status(200).json({ ok: true, url }) }
  } catch {
    res.status(200).json({ error: 'Erreur réseau.' })
  }
}
