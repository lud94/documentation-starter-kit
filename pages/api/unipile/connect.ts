import type { NextApiRequest, NextApiResponse } from 'next'
import { getKey } from '../../../lib/prospector/keystore'

// Génère un lien d'authentification hébergée Unipile (hosted auth).
// L'utilisateur clique → connecte son compte LinkedIn/WhatsApp/Email chez Unipile
// (session réelle, cookies gérés par Unipile → pas de scraping, moins de risque de strike).
// Nécessite UNIPILE_DSN + UNIPILE_API_KEY. Sans clés : renvoie un message explicite.

const PROVIDERS: Record<string, string> = {
  linkedin: 'LINKEDIN', whatsapp: 'WHATSAPP', email: 'GOOGLE',
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const provider = String((Array.isArray(req.query.provider) ? req.query.provider[0] : req.query.provider) || 'linkedin')
  const dsn = getKey('UNIPILE_DSN')
  const key = getKey('UNIPILE_API_KEY')

  if (!dsn || !key) {
    return res.status(200).json({
      configured: false,
      message: 'Unipile non configuré. Ajoutez UNIPILE_DSN et UNIPILE_API_KEY dans Vercel, puis reconnectez.',
    })
  }

  try {
    // expiration du lien à +1h ; à câbler : success/failure/notify_url réels.
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const base = req.headers.origin || `https://${req.headers.host}`
    const body = {
      type: 'create',
      providers: [PROVIDERS[provider] || 'LINKEDIN'],
      api_url: `https://${dsn}`,
      expiresOn: expires,
      success_redirect_url: `${base}/admin?connected=${provider}`,
      failure_redirect_url: `${base}/admin?failed=${provider}`,
    }
    const r = await fetch(`https://${dsn}/api/v1/hosted/accounts/link`, {
      method: 'POST',
      headers: { 'X-API-KEY': key, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok || !data?.url) {
      return res.status(200).json({ configured: true, error: data?.detail || `Unipile ${r.status}` })
    }
    return res.status(200).json({ configured: true, url: data.url })
  } catch (e: any) {
    return res.status(200).json({ configured: true, error: e?.message || 'Erreur Unipile' })
  }
}
