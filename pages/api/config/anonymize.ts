import type { NextApiRequest, NextApiResponse } from 'next'
import { maskPII, countPII } from '../../../lib/prospector/anonymize'
import { getKey, setKeys, hydrateKeystore } from '../../../lib/prospector/keystore'
import { isAdminRequest } from '../../../lib/auth/guard'

/**
 * Réglage GLOBAL de masquage des données personnelles — ADMIN UNIQUEMENT.
 *
 * ── LE DÉFAUT FERMÉ (lot SEC-AUTH-2) ────────────────────────────────────────
 * Le POST appelait `setKeys({ PII_MASKING })` sans aucune garde. Une session
 * CLIENT — que le middleware laisse passer, puisqu'elle est valide — pouvait
 * donc DÉSACTIVER LE MASQUAGE PII DE TOUTE LA PLATEFORME, pour tous les espaces
 * à la fois. C'est un réglage d'egress de données personnelles : le modifier
 * n'est pas une préférence d'affichage, c'est une décision de conformité.
 *
 * Le GET est fermé au même titre : cette route appartient à l'Admin (seul
 * `pages/admin.tsx` l'appelle, en GET comme en POST), et l'état global du
 * masquage renseigne sur la configuration de la plateforme. Aucune
 * fonctionnalité client n'en dépend — vérifié par recherche des appelants.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ⚠️ AVANT `hydrateKeystore()` et AVANT tout `setKeys` : un refus ne doit
  // avoir ni lu, ni écrit.
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Réservé aux administrateurs.' })
  await hydrateKeystore()
  if (req.method === 'GET') {
    return res.status(200).json({ enabled: getKey('PII_MASKING') !== '0' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (typeof body?.enabled === 'boolean') await setKeys({ PII_MASKING: body.enabled ? '1' : '0' })

  let preview = null
  if (typeof body?.text === 'string') {
    const { masked, map } = maskPII(body.text, Array.isArray(body.terms) ? body.terms : [])
    preview = { masked, counts: countPII(map), total: Object.keys(map).length }
  }
  res.status(200).json({ enabled: getKey('PII_MASKING') !== '0', preview })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
