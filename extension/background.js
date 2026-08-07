/* Service worker — SEUL CONTEXTE QUI CONNAÎT LE CREDENTIAL (lot SEC-EXT-0).
 *
 * ── LE DÉFAUT CORRIGÉ ────────────────────────────────────────────────────────
 * `content.js` lisait lui-même `chrome.storage.local['token']` et appelait
 * l'API. Le credential vivait donc dans un script injecté dans le document
 * d'une page arbitraire. Un content script est isolé du « page world », mais
 * c'est une frontière du navigateur, pas une frontière de sécurité qu'on
 * choisit d'ériger : elle tombe avec une faille de l'isolation, une extension
 * tierce mal élevée, ou une simple erreur de code qui expose une variable.
 *
 * Désormais :
 *
 *   page (non fiable)
 *     └─ content script : UI seulement, aucun secret
 *          └─ chrome.runtime.sendMessage
 *               └─ service worker : credential + origine + appels API
 *
 * Le content script ne voit jamais le jeton, ni l'origine, ni l'action.
 */
importScripts('config.js')

/* ── LE STORAGE DEVIENT INACCESSIBLE AUX CONTENT SCRIPTS (lot SEC-EXT-0.1) ───
 *
 * SEC-EXT-0 affirmait que `content.js` ne LIT PAS les jetons. C'était vrai du
 * code, mais pas de la capacité : par défaut, un content script atteint
 * `chrome.storage.local` de son extension. La propriété reposait donc sur la
 * discipline du code, et une seule ligne ajoutée par mégarde l'aurait annulée.
 *
 * `TRUSTED_CONTEXTS` restreint l'accès au service worker et au popup. Le
 * content script vit, lui, dans le document d'une page arbitraire : il n'a plus
 * accès au credential, quoi qu'on écrive dedans.
 *
 * Appelé aussi à l'installation ET au démarrage : un service worker MV3 est
 * arrêté et relancé sans prévenir. */
async function restrictStorage() {
  try {
    // API disponible depuis Chrome 111 ; en son absence, on n'invente rien.
    if (chrome.storage.local.setAccessLevel) {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    }
  } catch (_) { /* rien à faire de plus ici */ }
}
restrictStorage()
chrome.runtime.onInstalled.addListener(restrictStorage)
chrome.runtime.onStartup?.addListener(restrictStorage)

/** Le jeton ne sort JAMAIS de ce fichier. Aucun message ne le renvoie. */
async function credential(scope) {
  const s = await chrome.storage.local.get(['tokenCapture', 'tokenJarvis'])
  const t = scope === 'jarvis' ? s.tokenJarvis : s.tokenCapture
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

async function callProspector(path, scope, payload) {
  const origin = resolveOrigin(PROSPECTOR_ORIGIN)
  if (!origin) return { error: 'Origine Prospector non autorisée dans cette build.' }
  const token = await credential(scope)
  if (!token) return { error: 'Jeton absent. Ouvre les réglages de l\'extension.' }
  try {
    const r = await fetch(`${origin}${path}`, {
      method: 'POST',
      // Le credential voyage dans l'en-tête PRÉVU, jamais dans le corps.
      headers: { 'content-type': 'application/json', 'x-ingest-token': token },
      body: JSON.stringify(payload),
    })
    return await r.json()
  } catch (e) {
    // Aucun détail réseau ne remonte à la page.
    return { error: 'Prospector est injoignable.' }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    // ⚠️ Seuls des messages venant de CETTE extension sont traités. Une page ne
    // peut pas émettre sur ce canal sans `externally_connectable`, que le
    // manifeste ne déclare pas — mais on ne s'en remet pas à cette absence.
    if (!sender || sender.id !== chrome.runtime.id) return sendResponse({ error: 'refusé' })

    if (msg?.type === 'jarvis.ask') {
      // Le contexte de page est de la DONNÉE : url et titre, rien de plus.
      return sendResponse(await callProspector('/api/jarvis/agent', 'jarvis', {
        message: String(msg.message || ''),
        url: String(msg.pageContext?.url || ''),
        title: String(msg.pageContext?.title || ''),
      }))
    }

    if (msg?.type === 'jarvis.confirm') {
      // ⚠️ UN IDENTIFIANT, ET RIEN D'AUTRE. L'action n'existe pas côté client :
      // elle est relue par le serveur sous cet identifiant.
      return sendResponse(await callProspector('/api/jarvis/agent', 'jarvis', {
        confirmationId: String(msg.confirmationId || ''),
      }))
    }

    if (msg?.type === 'jarvis.cancel') {
      return sendResponse(await callProspector('/api/jarvis/agent', 'jarvis', {
        cancel: String(msg.confirmationId || ''),
      }))
    }

    /* ⚠️ ALLOWLIST FERMÉE DE RÉGLAGES. `ui.brand` rend UNIQUEMENT la marque.
       Aucun message ne permet de demander une clé arbitraire du storage : il
       n'existe pas de `settings.get(<nom>)`, précisément pour qu'aucun appelant
       ne puisse réclamer `tokenJarvis`. */
    if (msg?.type === 'ui.brand') {
      const s = await chrome.storage.local.get(['brand'])
      return sendResponse({ brand: typeof s.brand === 'string' ? s.brand : '' })
    }

    if (msg?.type === 'capture.lead') {
      return sendResponse(await callProspector('/api/ingest/lead', 'capture', {
        url: String(msg.url || ''), name: String(msg.name || ''),
        company: String(msg.company || ''), title: String(msg.title || ''),
      }))
    }

    sendResponse({ error: 'type inconnu' })
  })()
  return true   // réponse asynchrone
})
