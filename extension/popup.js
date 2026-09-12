/* Popup de l'extension — lot SEC-EXT-0.
 *
 * Deux changements de fond :
 *   • l'ORIGINE Prospector n'est plus saisissable. Le champ libre permettait
 *     d'adresser le credential d'un espace à `https://evil.example` ;
 *   • les appels passent par le SERVICE WORKER : le popup ne manipule le jeton
 *     que pour l'enregistrer, jamais pour l'envoyer lui-même.
 *
 * Jarvis n'est plus injecté partout : il s'ouvre ici, explicitement, sur le seul
 * onglet actif, via `chrome.scripting` et la permission `activeTab`.
 */
const $ = (id) => document.getElementById(id)
let currentUrl = ''

$('origin').textContent = 'Connecté à ' + PROSPECTOR_ORIGIN

chrome.storage.local.get(['tokenCapture', 'tokenJarvis', 'brand'], (s) => {
  if (s.tokenCapture) $('tokenCapture').value = s.tokenCapture
  if (s.tokenJarvis) $('tokenJarvis').value = s.tokenJarvis
  if (s.brand) $('brand').value = s.brand
})

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0]
  if (!tab) return
  currentUrl = tab.url || ''
  // Titre LinkedIn typique : "Prénom Nom | LinkedIn" ou "(x) Prénom Nom | ..."
  const t = (tab.title || '').replace(/^\(\d+\)\s*/, '').split('|')[0].split(' - ')[0].trim()
  if (t && !/linkedin/i.test(t)) $('name').value = t
})

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    tokenCapture: $('tokenCapture').value.trim(),
    tokenJarvis: $('tokenJarvis').value.trim(),
    brand: $('brand').value.trim(),
  }, () => show('Réglages enregistrés.', 'ok'))
})

$('add').addEventListener('click', async () => {
  $('add').disabled = true; show('Envoi…', '')
  try {
    // Le jeton n'est pas lu ici : le service worker le détient.
    const d = (await chrome.runtime.sendMessage({
      type: 'capture.lead',
      url: currentUrl, name: $('name').value.trim(),
      company: $('company').value.trim(), title: $('title').value.trim(),
    })) || {}
    if (d.ok) show('✓ Lead ajouté à Prospector !', 'ok')
    else show(d.error || 'Échec (jeton ?)', 'err')
  } catch (e) {
    show('Prospector est injoignable.', 'err')
  } finally { $('add').disabled = false }
})

/* ── Jarvis À LA DEMANDE ────────────────────────────────────────────────────
 * `activeTab` n'accorde l'accès à l'onglet qu'après ce geste. Aucune permission
 * permanente sur les sites visités, et aucune injection automatique. */
$('jarvis').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return show('Aucun onglet actif.', 'err')
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    show('Jarvis ouvert sur cette page.', 'ok')
    window.close()
  } catch (e) {
    show("Impossible d'ouvrir Jarvis sur cette page.", 'err')
  }
})

function show(text, cls) { const m = $('msg'); m.textContent = text; m.className = 'msg ' + (cls || '') }
