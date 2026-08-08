// Origine publique de l'application — DÉCLARÉE, jamais devinée (SEC-AUTH-0).
//
// ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
// Le lien de réinitialisation était construit ainsi :
//
//     const base = req.headers.origin || `https://${req.headers.host}`
//
// `Origin` et `Host` sont fournis par le CLIENT. Une requête portant
// `Host: evil.example` produisait un lien `https://evil.example/login?reset=…`
// contenant un jeton de réinitialisation VALIDE, envoyé par notre propre
// serveur, dans un email authentique, à la vraie boîte de l'administrateur.
// Il suffisait de le cliquer pour livrer le jeton à l'attaquant.
//
// L'origine d'un lien envoyé par nous est une propriété du DÉPLOIEMENT. Elle ne
// peut pas venir de la requête qui demande le lien.
import { onVercel } from '../env'

/**
 * `APP_BASE_URL` validée, ou `null`.
 *
 * `null` doit fermer la capacité qui en dépend : sans origine sûre, on n'émet
 * aucun lien — donc aucun jeton de réinitialisation n'est créé.
 *
 * HTTPS obligatoire sur un déploiement. `http://localhost` n'est toléré que
 * hors Vercel, pour le développement.
 */
export function appBaseUrl(): string | null {
  const raw = (process.env.APP_BASE_URL || '').trim()
  if (!raw) return null

  let u: URL
  try { u = new URL(raw) } catch { return null }

  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && local && !onVercel()) return u.origin
  return null
}
