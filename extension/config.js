/* Origine Prospector — FIXÉE À LA COMPILATION (lot SEC-EXT-0).
 *
 * ⚠️ DÉFAUT CORRIGÉ. Le popup exposait un champ « URL Prospector » librement
 * modifiable, et le credential partait vers ce qu'on y saisissait. Un utilisateur
 * abusé — ou une capture d'écran de tutoriel malveillant — suffisait à envoyer le
 * jeton d'un espace vers `https://evil.example`. Un credential ne doit jamais
 * pouvoir être adressé à une origine arbitraire choisie à l'exécution.
 *
 * Pour publier une build cliente : remplacer PROSPECTOR_ORIGIN par l'origine
 * réelle. Pour le développement, ALLOWED_ORIGINS peut contenir un `localhost`
 * explicite — mais il ne sert JAMAIS de repli : si l'origine configurée n'est
 * pas dans la liste, l'extension refuse d'appeler.
 */
const PROSPECTOR_ORIGIN = 'https://app.prospector.example'

/* Liste close. Rien d'autre n'est appelable, quoi qu'on stocke. */
const ALLOWED_ORIGINS = [
  PROSPECTOR_ORIGIN,
  // 'http://localhost:3000',   // ← à décommenter dans une build de DÉVELOPPEMENT
]

function resolveOrigin(candidate) {
  const o = String(candidate || PROSPECTOR_ORIGIN).replace(/\/$/, '')
  return ALLOWED_ORIGINS.includes(o) ? o : null
}

// Chargé aussi bien par le service worker (importScripts) que par le popup.
if (typeof self !== 'undefined') {
  self.PROSPECTOR_ORIGIN = PROSPECTOR_ORIGIN
  self.ALLOWED_ORIGINS = ALLOWED_ORIGINS
  self.resolveOrigin = resolveOrigin
}
