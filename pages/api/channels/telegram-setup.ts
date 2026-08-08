import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import { hydrateKeystore, getKey, setKeys } from '../../../lib/prospector/keystore'
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
  await hydrateKeystore()

  const token = getKey('TELEGRAM_BOT_TOKEN')
  if (!token) return res.status(200).json({ error: 'Renseigne TELEGRAM_BOT_TOKEN dans Connexions.' })

  // ⚠️ L'URL vient de la CONFIGURATION, jamais de la requête. Vérifiée AVANT de
  // produire quoi que ce soit : sans origine sûre, on n'engendre pas de secret
  // et on n'enregistre aucun webhook.
  const base = appBaseUrl()
  if (!base) return res.status(200).json({ error: 'APP_BASE_URL absente ou invalide : impossible de déclarer un webhook.' })
  const url = `${base}/api/channels/telegram`

  let secret = getKey('TELEGRAM_WEBHOOK_SECRET')
  if (!secret) {
    // 32 octets d'un générateur CRYPTOGRAPHIQUE. `Math.random()` n'en est pas un.
    secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    // ⚠️ DETTE CONNUE, NON TRAITÉE ICI : `setKeys` ne rend aucun accusé de
    // persistance durable (elle écrit la mémoire, puis tente Supabase en
    // absorbant l'échec). Ce secret peut donc n'exister que dans l'instance
    // courante alors que Telegram, lui, l'a bien enregistré — et une autre
    // instance rejetterait les mises à jour. Corriger cela demande de refondre
    // l'acquittement d'écriture du keystore : c'est SEC-SECRETS-0C, et je ne
    // prétends pas le résoudre dans ce lot.
    await setKeys({ TELEGRAM_WEBHOOK_SECRET: secret })
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
