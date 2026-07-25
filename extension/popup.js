/* Popup de l'extension : lit l'onglet actif, pré-remplit le nom, envoie à Prospector. */
const $ = (id) => document.getElementById(id)
let currentUrl = ''

// Charge les réglages sauvegardés.
chrome.storage.local.get(['base', 'token'], (s) => {
  if (s.base) $('base').value = s.base
  if (s.token) $('token').value = s.token
})

// Récupère l'onglet actif + devine le nom depuis le titre de la page.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0]
  if (!tab) return
  currentUrl = tab.url || ''
  // Titre LinkedIn typique : "Prénom Nom | LinkedIn" ou "(x) Prénom Nom | ..."
  const t = (tab.title || '').replace(/^\(\d+\)\s*/, '').split('|')[0].split(' - ')[0].trim()
  if (t && !/linkedin/i.test(t)) $('name').value = t
})

$('save').addEventListener('click', () => {
  chrome.storage.local.set({ base: $('base').value.trim().replace(/\/$/, ''), token: $('token').value.trim() }, () => {
    show('Réglages enregistrés.', 'ok')
  })
})

$('add').addEventListener('click', async () => {
  const base = $('base').value.trim().replace(/\/$/, '')
  const token = $('token').value.trim()
  if (!base || !token) return show('Configure d\'abord l\'URL + le jeton (Réglages).', 'err')
  $('add').disabled = true; show('Envoi…', '')
  try {
    const res = await fetch(`${base}/api/ingest/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': token },
      body: JSON.stringify({ url: currentUrl, name: $('name').value.trim(), company: $('company').value.trim(), title: $('title').value.trim() }),
    })
    const d = await res.json()
    if (res.ok && d.ok) show('✓ Lead ajouté à Prospector !', 'ok')
    else show(d.error || 'Échec (jeton ?)', 'err')
  } catch (e) {
    show('Erreur réseau : ' + e.message, 'err')
  } finally { $('add').disabled = false }
})

function show(text, cls) { const m = $('msg'); m.textContent = text; m.className = 'msg ' + (cls || '') }
