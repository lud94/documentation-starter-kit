import type { NextApiRequest, NextApiResponse } from 'next'
import { getEmail, isSetup, purgeLegacyResetKeys } from '../../../lib/prospector/auth'
import { createResetAuthority, invalidateResetAuthority } from '../../../lib/auth/resetAuthority'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { appBaseUrl } from '../../../lib/auth/baseUrl'

/**
 * Demande de réinitialisation du mot de passe administrateur.
 *
 * ── LES TROIS DÉFAUTS FERMÉS (§11 à §14) ────────────────────────────────────
 *
 * 1. LE BACKEND RENDAIT LE LIEN. Sans `RESEND_API_KEY`, ou dès que `fetch`
 *    levait, la route répondait `{ sent:true, link, noEmailProvider:true }`.
 *    Donc : n'importe qui postant l'email de l'administrateur — une adresse
 *    publique — recevait dans la réponse HTTP un lien de réinitialisation
 *    valide. Le mot de passe administrateur était accessible à un inconnu au
 *    prix d'une requête. Ce n'était pas une commodité mono-admin : c'était la
 *    porte d'entrée.
 *
 * 2. L'ORIGINE VENAIT DE LA REQUÊTE (`Origin` / `Host`). Voir
 *    `lib/auth/baseUrl.ts` : le lien pouvait être empoisonné vers un domaine
 *    hostile, puis envoyé par nous, dans un email authentique.
 *
 * 3. `fetch` NE LÈVE PAS SUR UN 4xx/5xx. Le `try/catch` autour de l'appel
 *    Resend ne voyait donc jamais un 401 (clé révoquée) ni un 500 : l'envoi
 *    était compté comme réussi alors que rien n'était parti — et un jeton de
 *    réinitialisation restait actif, que personne n'avait reçu.
 *
 * ── LA RÈGLE MAINTENANT ─────────────────────────────────────────────────────
 * UNE SEULE RÉPONSE EXTERNE, quoi qu'il arrive : `{ sent: true }`. Email connu
 * ou inconnu, fournisseur absent, en panne ou refusant : rien ne distingue les
 * cas. Aucun jeton, aucune URL, aucun état de fournisseur ne sort d'ici.
 *
 * Et aucun jeton n'est CRÉÉ tant que toutes les préconditions d'envoi ne sont
 * pas réunies : un jeton actif que personne ne peut recevoir est une fenêtre
 * ouverte sans bénéficiaire.
 *
 * ── CE QUE SEC-AUTH-0.1 AJOUTE ──────────────────────────────────────────────
 * L'invalidation qui suit un échec d'envoi est désormais CONDITIONNELLE à
 * l'empreinte créée par CETTE requête. Inconditionnelle, elle supprimait
 * l'autorité d'une demande concurrente arrivée entre-temps : provoquer des
 * échecs d'envoi suffisait à tuer en boucle la réinitialisation d'autrui —
 * un déni de service sur la seule voie de récupération du compte.
 */
const GENERIC = { sent: true }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const email = String(body?.email || '').trim().toLowerCase()
  const ref = (getEmail() || '').trim().toLowerCase()

  // ── Préconditions. Chaque échec rend la MÊME réponse, sans créer de jeton ──
  const key = (process.env.RESEND_API_KEY || '').trim()
  const base = appBaseUrl()
  if (!isSetup()) return res.status(200).json(GENERIC)
  if (!ref || !email || email !== ref) return res.status(200).json(GENERIC)
  if (!key || !base) return res.status(200).json(GENERIC)

  // L'écriture de l'autorité peut échouer (base absente sur un déploiement,
  // base muette) : alors rien n'est envoyé, et la réponse ne change pas.
  const authority = await createResetAuthority()
  if (!authority) return res.status(200).json(GENERIC)
  const { token, hash } = authority
  // Au passage : on écrase les artefacts de réinitialisation d'avant ce lot.
  await purgeLegacyResetKeys()
  // ⚠️ L'origine vient de la CONFIGURATION. Ni `Origin`, ni `Host`, ni
  // `X-Forwarded-Host`, ni `Referer` ne sont lus — cette route ne touche pas
  // à `req.headers`.
  const link = `${base}/login?reset=${token}`

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESET_FROM_EMAIL || 'Prospector <onboarding@resend.dev>',
        to: [ref], subject: 'Réinitialisation de votre mot de passe Prospector',
        html: `<p>Cliquez pour réinitialiser votre mot de passe (valable 30 min) :</p><p><a href="${link}">${link}</a></p>`,
      }),
    })
    // Le statut HTTP fait foi : `fetch` a « réussi » même sur un 401.
    if (!r.ok) {
      await invalidateResetAuthority(hash)
      return res.status(200).json(GENERIC)
    }
  } catch {
    // Réseau injoignable : le lien n'est pas parti, CETTE réinitialisation
    // meurt — et elle seule.
    await invalidateResetAuthority(hash)
    return res.status(200).json(GENERIC)
  }

  return res.status(200).json(GENERIC)
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
