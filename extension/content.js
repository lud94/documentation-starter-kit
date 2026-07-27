/* Prospector — Jarvis flottant (Phase 2).
   Injecte une bulle + un mini-chat sur toutes les pages web. L'utilisateur donne
   une directive (« explique Redsen et crée les contacts », « charge cette personne »).
   La directive + l'URL/titre de la page partent vers /api/jarvis/agent (jeton INGEST).
   Aucune action sur LinkedIn : Jarvis ne pilote que Prospector. */
(function () {
  if (window.__prospectorJarvis) return
  window.__prospectorJarvis = true

  let base = '', token = '', pending = null
  chrome.storage.local.get(['base', 'token'], (s) => {
    base = (s.base || '').replace(/\/$/, ''); token = s.token || ''
    // Ne pas s'injecter sur l'app Prospector elle-même (elle a déjà son Jarvis).
    if (base && location.href.indexOf(base) === 0) { host.remove(); return }
  })

  const host = document.createElement('div')
  host.id = 'prospector-jarvis-host'
  document.documentElement.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      :host { all: initial; }
      #fab { position: fixed; bottom: 20px; right: 20px; width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-size:22px; border:none; cursor:pointer;
        box-shadow:0 6px 20px rgba(102,126,234,.5); z-index:2147483647; display:flex; align-items:center; justify-content:center; }
      #panel { position: fixed; bottom: 84px; right: 20px; width: 340px; max-height: 70vh; background:#fff; border-radius:16px;
        box-shadow:0 12px 40px rgba(0,0,0,.25); z-index:2147483647; display:none; flex-direction:column; overflow:hidden;
        font-family: -apple-system,Segoe UI,Roboto,sans-serif; }
      #panel.open { display:flex; }
      #hd { padding:12px 14px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-weight:700; font-size:14px; display:flex; align-items:center; gap:8px; }
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
      .hint { font-size:11px; color:#888; padding:2px 2px; }
    </style>
    <button id="fab" title="Jarvis">✦</button>
    <div id="panel">
      <div id="hd">✦ Jarvis <small>· pilote Prospector</small><span style="flex:1"></span><span id="cls" style="cursor:pointer">✕</span></div>
      <div id="msgs"><div class="hint">Ex : « explique Redsen et crée les contacts », « charge cette personne dans Prospector ».</div></div>
      <div id="ft"><input id="in" placeholder="Directive à Jarvis…" /><button id="snd">➤</button></div>
    </div>`

  const $ = (id) => root.getElementById(id)
  const panel = $('panel'), msgs = $('msgs')
  $('fab').onclick = () => panel.classList.toggle('open')
  $('cls').onclick = () => panel.classList.remove('open')

  function add(text, cls) { const d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d }

  async function call(payload) {
    const r = await fetch(`${base}/api/jarvis/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-token': token },
      body: JSON.stringify(Object.assign({ token, url: location.href, title: document.title }, payload)),
    })
    return r.json()
  }

  async function send() {
    const text = $('in').value.trim(); if (!text) return
    if (!base || !token) { add('Configure d\'abord l\'URL + le jeton dans le popup de l\'extension.', 'ja'); return }
    $('in').value = ''; add(text, 'me')
    const wait = add('…', 'ja')
    try {
      const d = await call({ message: text })
      wait.remove()
      if (d.reply) add(d.reply, 'ja')
      if (d.result) add(d.result, 'ja')
      if (d.needsConfirm && d.action) {
        pending = d.action
        const box = add('', 'ja'); const act = document.createElement('div'); act.className = 'act'
        const ok = document.createElement('button'); ok.textContent = 'Confirmer'
        const no = document.createElement('button'); no.textContent = 'Annuler'
        ok.onclick = async () => { act.remove(); const w2 = add('…', 'ja'); const r = await call({ message: text, confirm: true, action: pending }); w2.remove(); add(r.reply || 'Fait.', 'ja') }
        no.onclick = () => { act.remove(); add('Annulé.', 'ja') }
        act.appendChild(ok); act.appendChild(no); box.appendChild(act)
      }
    } catch (e) { wait.remove(); add('Erreur réseau : ' + e.message, 'ja') }
  }
  $('snd').onclick = send
  $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
})()
