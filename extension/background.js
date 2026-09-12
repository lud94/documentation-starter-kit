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

/* ── LE STORAGE INACCESSIBLE AUX CONTENT SCRIPTS, OU RIEN (lots 0.1 / 0.1b) ──
 *
 * SEC-EXT-0 affirmait que `content.js` ne LIT PAS les jetons. C'était vrai du
 * code, mais pas de la capacité : par défaut, un content script atteint
 * `chrome.storage.local` de son extension. SEC-EXT-0.1 a donc appelé
 * `setAccessLevel({ TRUSTED_CONTEXTS })`.
 *
 * ⚠️ MAIS L'ÉCHEC ÉTAIT IGNORÉ. L'appel vivait dans un `try { … } catch {}`, et
 * le courtier continuait ensuite à lire les jetons et à appeler l'API. Si l'API
 * manquait, ou levait, la protection n'existait pas — et l'assertion « un
 * content script ne PEUT PAS lire le credential » redevenait une simple
 * promesse de code. Un garde dont on ignore l'échec n'est pas un garde.
 *
 * Désormais, la propriété est binaire : PAS DE PROTECTION = PAS DE CREDENTIAL.
 * Aucun jeton n'est lu, aucun appel n'est émis, tant que le verrouillage n'est
 * pas CONFIRMÉ. Et l'absence de l'API est un échec, pas une dispense.
 */
let storageSecurityReady = false

async function restrictStorage() {
  try {
    // Absence d'API = refus. Surtout pas « si l'API existe, on sécurise ;
    // sinon, on continue » — ce serait exactement le fail-open corrigé ici.
    if (typeof chrome.storage.local.setAccessLevel !== 'function') {
      storageSecurityReady = false
      return false
    }
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    storageSecurityReady = true
    return true
  } catch (_) {
    storageSecurityReady = false
    return false
  }
}

/* Le service worker MV3 est arrêté et relancé sans prévenir : on reverrouille
 * au démarrage, à l'installation, et on RETIENT la promesse pour que le premier
 * message n'ait pas à courir devant elle. */
let storageSecurityPromise = restrictStorage()
chrome.runtime.onInstalled.addListener(() => { storageSecurityPromise = restrictStorage() })
chrome.runtime.onStartup?.addListener(() => { storageSecurityPromise = restrictStorage() })

/** Le verrou est-il CONFIRMÉ ? Toute opération à credential passe par là. */
async function securityReady() {
  try { await storageSecurityPromise } catch (_) { /* déjà reflété dans l'état */ }
  return storageSecurityReady === true
}

/** Le jeton ne sort JAMAIS de ce fichier. Aucun message ne le renvoie. */
async function credential(scope) {
  // Ceinture ET bretelles : même appelé par erreur, rien ne sort sans verrou.
  if (!(await securityReady())) return null
  const s = await chrome.storage.local.get(['tokenCapture', 'tokenJarvis'])
  const t = scope === 'jarvis' ? s.tokenJarvis : s.tokenCapture
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

async function callProspector(path, scope, payload) {
  // Aucun appel tant que le cloisonnement du storage n'est pas confirmé.
  if (!(await securityReady())) {
    return { error: "Extension de sécurité non initialisée : ce navigateur ne peut pas cloisonner le stockage." }
  }
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
      // Choix explicite : la marque reste servie même sans verrou. C'est un
      // libellé d'affichage, jamais un secret — et priver l'interface de son nom
      // n'ajouterait aucune sécurité. Les capacités à credential, elles,
      // refusent (voir `callProspector`).
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
