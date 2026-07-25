import type { NextApiRequest, NextApiResponse } from 'next'
import { getEmail, isSetup, createResetToken } from '../../../lib/prospector/auth'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

// Demande de réinitialisation. Vérifie l'email, génère un lien à usage unique.
// Si un fournisseur d'email est configuré (RESEND_API_KEY), on l'envoie ;
// sinon (mono-admin) on renvoie le lien directement dans la réponse.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  if (!isSetup()) return res.status(409).json({ error: 'not_setup' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const email = String(body?.email || '').trim().toLowerCase()
  const ref = (getEmail() || '').toLowerCase()
  // Réponse générique pour ne pas révéler si l'email existe (anti-énumération).
  if (!ref || email !== ref) return res.status(200).json({ sent: true })

  const token = await createResetToken()
  const base = req.headers.origin || `https://${req.headers.host}`
  const link = `${base}/login?reset=${token}`

  const resendKey = process.env.RESEND_API_KEY
  if (resendKey) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESET_FROM_EMAIL || 'Prospector <onboarding@resend.dev>',
          to: [ref], subject: 'Réinitialisation de votre mot de passe Prospector',
          html: `<p>Cliquez pour réinitialiser votre mot de passe (valable 30 min) :</p><p><a href="${link}">${link}</a></p>`,
        }),
      })
      return res.status(200).json({ sent: true })
    } catch { /* retombe sur le lien direct */ }
  }
  // Pas d'email configuré → lien direct (usage mono-admin).
  return res.status(200).json({ sent: true, link, noEmailProvider: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
