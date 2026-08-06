/* Prospector — Jarvis flottant, bulle DÉPLAÇABLE.
   INJECTÉ À LA DEMANDE par le popup (chrome.scripting sur l'onglet actif), plus
   jamais automatiquement sur tout Internet.

   ── CE QUE CE SCRIPT NE CONNAÎT PLUS (lot SEC-EXT-0) ────────────────────────
   Il lisait `chrome.storage.local['token']` et appelait l'API lui-même : le
   credential vivait donc dans un script injecté dans le document d'une page
   arbitraire. Il ne connaît désormais NI le jeton, NI l'origine Prospector, NI
   l'action à exécuter. Il envoie une intention au service worker, qui seul
   détient le credential, et reçoit en retour du texte à afficher.

   Le confirmationId qu'il manipule est un identifiant opaque : il ne permet
   d'exécuter que l'action déjà décidée et stockée PAR LE SERVEUR. */
(function () {
  if (window.__prospectorJarvis) return
  window.__prospectorJarvis = true

  let pendingId = null
  chrome.storage.local.get(['brand'], (s) => {
    if (s.brand) { const el = root.getElementById('brand'); if (el) el.textContent = s.brand }
  })

  const host = document.createElement('div')
  host.id = 'prospector-jarvis-host'
  document.documentElement.appendChild(host)
  // ⚠️ RACINE FERMÉE. En `mode: 'open'`, la page atteignait l'interface par
  // `document.getElementById('prospector-jarvis-host').shadowRoot` : elle
  // pouvait lire la conversation, réécrire la directive, et déclencher
  // « Confirmer » par `button.click()`. En `closed`, `host.shadowRoot` vaut
  // `null` pour la page — la référence ne vit que dans cette closure.
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
    <style>
      :host { all: initial; }
      #wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font-family: -apple-system,Segoe UI,Roboto,sans-serif; }
      #fab { width: 52px; height: 52px; border-radius: 50%; background: linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-size:22px;
        border:none; cursor: grab; box-shadow:0 6px 20px rgba(102,126,234,.5); display:flex; align-items:center; justify-content:center; touch-action:none; }
      #fab:active { cursor: grabbing; }
      #panel { position: absolute; bottom: 64px; right: 0; width: 340px; max-height: 70vh; background:#fff; border-radius:16px;
        box-shadow:0 12px 40px rgba(0,0,0,.25); display:none; flex-direction:column; overflow:hidden; }
      #panel.open { display:flex; }
      #hd { padding:12px 14px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-weight:700; font-size:14px; display:flex; align-items:center; gap:8px; cursor:grab; }
      #hd small { font-weight:400; opacity:.85; font-size:11px; }
      #msgs { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; background:#f7f8fc; }
      .m { font-size:13px; line-height:1.4; padding:8px 11px; border-radius:12px; max-width:85%; white-space:pre-wrap; }
      .me { align-self:flex-end; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; }
      .ja { align-self:flex-start; background:#eef0f6; color:#222; }
      .act { display:flex; gap:6px; margin-top:6px; }
      .act button { font-size:12px; font-weight:600; border-radius:8px; padding:5px 10px; cursor:pointer; border:1px solid #c7cce8; background:#fff; color:#4b3fae; }
      #ft { display:flex; gap:6px; padding:10px; border-top:1px solid #eee; }
      #in { flex:1; font-size:13px; padding:8px 10px; border:1px solid #ddd; border-radius:10px; outline:none; }
      #snd { background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; border:none; border-radius:10px; padding:0 12px; font-weight:600; cursor:pointer; font-size:13px; }
      .hint { font-size:11px; color:#888; }
    </style>
    <div id="wrap">
      <div id="panel">
        <div id="hd">✦ <span id="brand">Jarvis</span> <small>· déplace-moi</small><span style="flex:1"></span><span id="cls" style="cursor:pointer">✕</span></div>
        <div id="msgs"><div class="hint">Ex : « explique-moi cette société », « crée le compte + les contacts », « charge cette personne », « ajoute à la liste ESN », « mets en séquence X ».</div></div>
        <div id="ft"><input id="in" placeholder="Directive à Jarvis…" /><button id="snd">➤</button></div>
      </div>
      <button id="fab" title="Jarvis (glisser pour déplacer)">✦</button>
    </div>`

  const $ = (id) => root.getElementById(id)
  const wrap = $('wrap'), panel = $('panel'), msgs = $('msgs'), fab = $('fab')

  // ── Déplacement (bulle + entête du panneau) via Pointer Events + capture ──
  // setPointerCapture garantit qu'on reçoit les mouvements même si la page interfère.
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false
  function down(e) {
    const r = wrap.getBoundingClientRect()
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; dragging = true; moved = false
    try { e.target.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  }
  function move(e) {
    if (!dragging) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
    const left = Math.max(6, Math.min(window.innerWidth - 58, ox + dx))
    const top = Math.max(6, Math.min(window.innerHeight - 58, oy + dy))
    wrap.style.left = left + 'px'; wrap.style.top = top + 'px'; wrap.style.right = 'auto'; wrap.style.bottom = 'auto'
  }
  function up() { dragging = false }
  ;[fab, $('hd')].forEach((el) => {
    el.style.touchAction = 'none'
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
  fab.addEventListener('click', () => { if (!moved) panel.classList.toggle('open') })
  $('cls').onclick = () => panel.classList.remove('open')

  function add(text, cls) { const d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d }

  /* Aucun `fetch` ici, aucun credential, aucune origine : le service worker
     est le seul à savoir où et avec quoi appeler. */
  function ask(message) {
    return chrome.runtime.sendMessage({
      type: 'jarvis.ask', message,
      pageContext: { url: location.href, title: document.title },
    })
  }
  function confirmAction(confirmationId) {
    return chrome.runtime.sendMessage({ type: 'jarvis.confirm', confirmationId })
  }
  function cancelAction(confirmationId) {
    return chrome.runtime.sendMessage({ type: 'jarvis.cancel', confirmationId })
  }

  /* ⚠️ GESTE HUMAIN EXIGÉ. `isTrusted` est faux pour tout événement fabriqué
     par un script — `button.click()` comme `dispatchEvent(new MouseEvent(…))`.
     La racine fermée met déjà l'interface hors de portée de la page ; ceci en
     est la seconde ligne, pour les actions qui déclenchent une écriture. */
  const human = (e) => !e || e.isTrusted === true

  async function send(e) {
    if (!human(e)) return
    const text = $('in').value.trim(); if (!text) return
    $('in').value = ''; add(text, 'me')
    const wait = add('…', 'ja')
    try {
      const d = (await ask(text)) || {}
      wait.remove()
      if (d.error) { add(d.error, 'ja'); return }
      if (d.reply) add(d.reply, 'ja')
      if (d.result) add(d.result, 'ja')
      // Le serveur ne renvoie plus l'action, seulement son identifiant.
      if (d.needsConfirm && d.confirmationId) {
        pendingId = d.confirmationId
        const box = add('', 'ja'); const act = document.createElement('div'); act.className = 'act'
        const ok = document.createElement('button'); ok.textContent = 'Confirmer'
        const no = document.createElement('button'); no.textContent = 'Annuler'
        ok.addEventListener('click', async (ev) => {
          if (!human(ev)) return
          act.remove(); const w2 = add('…', 'ja')
          const r = (await confirmAction(pendingId)) || {}
          w2.remove(); add(r.error || r.reply || 'Fait.', 'ja'); pendingId = null
        })
        no.addEventListener('click', async (ev) => {
          if (!human(ev)) return
          act.remove(); await cancelAction(pendingId); pendingId = null; add('Annulé.', 'ja')
        })
        act.appendChild(ok); act.appendChild(no); box.appendChild(act)
      }
    } catch (e2) { wait.remove(); add('Prospector est injoignable.', 'ja') }
  }
  $('snd').addEventListener('click', send)
  $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter' && human(e)) send(e) })
})()
