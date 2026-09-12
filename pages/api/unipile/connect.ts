import type { NextApiRequest, NextApiResponse } from 'next'
import { getKey, hydrateKeystore } from '../../../lib/prospector/keystore'
import { isAdminRequest } from '../../../lib/auth/guard'
import { appBaseUrl } from '../../../lib/auth/baseUrl'

// Génère un lien d'authentification hébergée Unipile (hosted auth).
// L'utilisateur clique → connecte son compte LinkedIn/WhatsApp/Email chez Unipile
// (session réelle, cookies gérés par Unipile → pas de scraping, moins de risque de strike).
//
// ── QUATRE DÉFAUTS FERMÉS (lot SEC-AUTH-2) ──────────────────────────────────
//
// 1. AUCUNE GARDE. Le middleware n'exige qu'une session VALIDE : une session
//    CLIENT déclenchait donc une opération de plan de contrôle sur le compte
//    Unipile de la PLATEFORME, avec la clé d'API plateforme, et obtenait une
//    URL d'authentification hébergée — c'est-à-dire l'occasion de rattacher un
//    compte de son choix à l'infrastructure de Smart.AI.
//
// 2. L'ORIGINE VENAIT DE LA REQUÊTE : `req.headers.origin || \`https://${host}\``.
//    Exactement le défaut fermé pour la réinitialisation en SEC-AUTH-0 : un
//    en-tête `Host: attacker.example` faisait pointer les redirections de
//    succès et d'échec vers un domaine hostile, dans un flux d'authentification
//    lancé par nous.
//
// 3. PROVIDER NON VALIDÉ. Toute valeur inconnue devenait silencieusement
//    `LINKEDIN`. Une erreur de saisie se lisait alors comme un succès sur le
//    mauvais canal.
//
// 4. ERREURS DU FOURNISSEUR RELAYÉES BRUTES : `data?.detail` et `e?.message`
//    repartaient tels quels dans la réponse HTTP. Un corps d'erreur de tiers
//    n'est pas sous notre contrôle et peut porter l'en-tête présenté, une URL
//    authentifiée ou un identifiant d'infrastructure.

/** Allowlist fermée. Rien d'autre n'est demandable. */
const PROVIDERS: Record<string, string> = {
  linkedin: 'LINKEDIN', whatsapp: 'WHATSAPP', email: 'GOOGLE',
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ⚠️ AVANT toute lecture de secret et tout appel réseau.
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Réservé aux administrateurs.' })

  const demande = String((Array.isArray(req.query.provider) ? req.query.provider[0] : req.query.provider) || 'linkedin')
  const provider = PROVIDERS[demande]
  // Pas de repli sur LinkedIn : une valeur inconnue est une erreur d'appel, et
  // la traiter en silence ferait connecter un canal que personne n'a demandé.
  if (!provider) return res.status(400).json({ error: 'invalid_provider' })

  await hydrateKeystore()
  const dsn = getKey('UNIPILE_DSN')
  const key = getKey('UNIPILE_API_KEY')

  if (!dsn || !key) {
    return res.status(200).json({
      configured: false,
      message: 'Unipile non configuré. Ajoutez UNIPILE_DSN et UNIPILE_API_KEY dans Vercel, puis reconnectez.',
    })
  }

  // ⚠️ L'ORIGINE VIENT DE LA CONFIGURATION DÉCLARÉE. Cette route ne lit ni
  // `Origin`, ni `Host`, ni `X-Forwarded-Host`, ni `X-Forwarded-Proto`.
  // Absente ou invalide ⇒ aucun appel Unipile : mieux vaut pas de lien du tout
  // qu'un lien dont on ne maîtrise pas la destination.
  const base = appBaseUrl()
  if (!base) {
    return res.status(200).json({ configured: true, error: 'app_base_url_missing' })
  }

  try {
    // expiration du lien à +1h ; à câbler : success/failure/notify_url réels.
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const body = {
      type: 'create',
      providers: [provider],
      api_url: `https://${dsn}`,
      expiresOn: expires,
      success_redirect_url: `${base}/admin?connected=${demande}`,
      failure_redirect_url: `${base}/admin?failed=${demande}`,
    }
    const r = await fetch(`https://${dsn}/api/v1/hosted/accounts/link`, {
      method: 'POST',
      headers: { 'X-API-KEY': key, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok || !data?.url) {
      // Code générique : ni le corps d'Unipile, ni le DSN, ni la clé.
      return res.status(200).json({ configured: true, error: 'unipile_connection_failed' })
    }
    return res.status(200).json({ configured: true, url: data.url })
  } catch {
    return res.status(200).json({ configured: true, error: 'unipile_connection_failed' })
  }
}
