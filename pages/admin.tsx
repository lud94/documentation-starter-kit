import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { UsageSummary, Diagnostic, Workspace } from '../types/prospector'
import { getUsage, getDiagnostics, getWorkspaces, createWorkspace, getChannels, connectChannel, disconnectChannel } from '../lib/prospector/capabilities'
import type { Channel, ChannelConfig } from '../lib/prospector/capabilities'

type Tab = 'usage' | 'connexions' | 'protocole' | 'diagnostic' | 'workspaces'

interface ModelRouteRow { phase: string; provider: string; model: string; requires: string; why: string; fallback?: string; ready: boolean }

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

const DOT: Record<Diagnostic['status'], string> = { ok: 'bg-emerald-500', warn: 'bg-amber-400', error: 'bg-red-500' }

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('usage')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [diags, setDiags] = useState<Diagnostic[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [wsOpen, setWsOpen] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsPlan, setWsPlan] = useState('Starter')
  const createWs = async () => {
    if (!wsName.trim()) return
    await createWorkspace(wsName, wsPlan)
    setWsName(''); setWsPlan('Starter'); setWsOpen(false)
    getWorkspaces().then(setWorkspaces)
  }

  useEffect(() => {
    getUsage().then(setUsage)
    getDiagnostics().then(setDiags)
    getWorkspaces().then(setWorkspaces)
    getChannels().then(setChannels)
  }, [])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'usage', label: 'Usage & coûts' },
    { key: 'connexions', label: 'Connexions' },
    { key: 'protocole', label: 'Protocole LLM' },
    { key: 'diagnostic', label: 'Diagnostic' },
    { key: 'workspaces', label: 'Workspaces clients' },
  ]

  return (
    <>
      <Head><title>Prospector · Admin</title></Head>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
        <p className="text-gray-400 text-sm mt-0.5">Supervision de la consommation IA, des connexions et des accès clients.</p>
      </div>

      <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === t.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'usage' && usage && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            {[
              { l: 'Appels IA', v: String(usage.calls) },
              { l: 'Tokens (in)', v: fmt(usage.tokensIn) },
              { l: 'Tokens (out)', v: fmt(usage.tokensOut) },
              { l: 'Coût estimé', v: `$${usage.cost.toFixed(2)}` },
            ].map((k) => (
              <div key={k.l} className="card p-5">
                <p className="text-xs font-semibold text-gray-400 mb-1">{k.l}</p>
                <p className="text-2xl font-bold gradient-text">{k.v}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mb-4">{fmt(usage.cached)} tokens lus depuis le cache (prompt caching).</p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Par agent</h2>
              <div className="space-y-2.5">
                {usage.byAgent.map((a) => (
                  <div key={a.agent} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-600 flex-1 truncate">{a.agent}</span>
                    <span className="text-xs text-gray-400">{a.calls} appels · {fmt(a.tokens)}</span>
                    <span className="text-xs font-semibold text-gray-600 w-12 text-right">${a.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Par modèle</h2>
              <div className="space-y-2.5">
                {usage.byModel.map((m) => (
                  <div key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-600 flex-1 truncate">{m.model}</span>
                    <span className="text-xs text-gray-400">{m.calls} appels · {fmt(m.tokens)}</span>
                    <span className="text-xs font-semibold text-gray-600 w-12 text-right">${m.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'connexions' && (
        <ConnexionsTab channels={channels} onChange={setChannels} />
      )}

      {tab === 'protocole' && <ProtocoleTab />}

      {tab === 'diagnostic' && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">Connexions & configuration</h2>
            <button className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors">Tester tout</button>
          </div>
          <div className="space-y-1">
            {diags.map((d) => (
              <div key={d.name} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <span className={`w-2 h-2 rounded-full ${DOT[d.status]}`} />
                <span className="text-sm text-gray-700">{d.name}</span>
                <span className="text-xs text-gray-400 ml-auto">{d.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'workspaces' && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Espaces clients</h2>
            <button onClick={() => setWsOpen((v) => !v)} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">+ Nouveau workspace</button>
          </div>
          {wsOpen && (
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/60 flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom du client</label>
                <input value={wsName} onChange={(e) => setWsName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createWs()} className={fieldCls} placeholder="ex: Smart.AI" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Plan</label>
                <select value={wsPlan} onChange={(e) => setWsPlan(e.target.value)} className={fieldCls}><option>Starter</option><option>Growth</option><option>Scale</option></select>
              </div>
              <button onClick={createWs} disabled={!wsName.trim()} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Créer l'espace</button>
              {wsName.trim() && <span className="text-[11px] text-gray-400 pb-2">ID : <code>ws_{wsName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)}</code></span>}
            </div>
          )}
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                {['Client', 'Leads', 'Utilisateurs', 'Plan', ''].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center">{w.name[0]}</span>
                      <span className="text-sm font-medium text-gray-800">{w.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-600">{w.leads}</td>
                  <td className="px-5 py-3 text-sm text-gray-600">{w.users}</td>
                  <td className="px-5 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{w.plan}</span></td>
                  <td className="px-5 py-3 text-right"><button className="text-xs text-gray-400 hover:text-indigo-600">Gérer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

const fieldCls = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'
const CHANNEL_ICON: Record<Channel['key'], string> = {
  linkedin: 'in', email: '@', whatsapp: 'WA',
}

interface KeyStatus { key: string; label: string; set: boolean; source: 'app' | 'env' | null }

function ConnexionsTab({ channels, onChange }: { channels: Channel[]; onChange: (c: Channel[]) => void }) {
  const [drafts, setDrafts] = useState<Record<string, ChannelConfig>>({})
  const [linking, setLinking] = useState<string | null>(null)
  const [linkMsg, setLinkMsg] = useState<Record<string, string>>({})
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const [sigMode, setSigMode] = useState<string>('')
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [savingKeys, setSavingKeys] = useState(false)
  const [keySaved, setKeySaved] = useState(false)

  const loadStatus = () => fetch('/api/config/status').then((r) => r.json()).then((d) => { setKeys(d.keys || []); setSigMode(d.signalsMode || '') }).catch(() => {})
  useEffect(() => { loadStatus() }, [])

  // ── MFA ──
  const [mfaOn, setMfaOn] = useState(false)
  const [mfaSecret, setMfaSecret] = useState('')
  const [mfaUri, setMfaUri] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMsg, setMfaMsg] = useState('')
  const loadMfa = () => fetch('/api/auth/status').then((r) => r.json()).then((d) => setMfaOn(!!d.mfa)).catch(() => {})
  useEffect(() => { loadMfa() }, [])

  const startMfa = async () => {
    setMfaMsg('')
    const d = await fetch('/api/auth/mfa/setup', { method: 'POST' }).then((r) => r.json())
    setMfaSecret(d.secret || ''); setMfaUri(d.uri || '')
  }
  const confirmMfa = async () => {
    const res = await fetch('/api/auth/mfa/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: mfaCode }) })
    const d = await res.json()
    if (res.ok) { setMfaSecret(''); setMfaUri(''); setMfaCode(''); setMfaMsg('✓ MFA activée'); loadMfa() }
    else setMfaMsg(d.error || 'Échec')
  }
  const disableMfa = async () => { await fetch('/api/auth/mfa/disable', { method: 'POST' }); setMfaMsg('MFA désactivée'); loadMfa() }

  const saveKeys = async () => {
    const patch: Record<string, string> = {}
    Object.entries(keyDrafts).forEach(([k, v]) => { if (v.trim()) patch[k] = v.trim() })
    if (Object.keys(patch).length === 0) return
    setSavingKeys(true)
    try {
      await fetch('/api/config/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      setKeyDrafts({}); setKeySaved(true); setTimeout(() => setKeySaved(false), 2000)
      await loadStatus()
    } finally { setSavingKeys(false) }
  }

  const setDraft = (key: string, patch: ChannelConfig) => setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }))
  const cfg = (c: Channel): ChannelConfig => ({ ...c.config, ...drafts[c.key] })

  const connect = async (c: Channel) => onChange(await connectChannel(c.key, cfg(c)))
  const disconnect = async (c: Channel) => onChange(await disconnectChannel(c.key))

  // Lance la connexion réelle via Unipile (hosted auth). Ouvre le lien si configuré.
  const linkUnipile = async (c: Channel) => {
    setLinking(c.key); setLinkMsg((m) => ({ ...m, [c.key]: '' }))
    try {
      const res = await fetch(`/api/unipile/connect?provider=${c.key}`)
      const d = await res.json()
      if (d.url) window.open(d.url, '_blank', 'noopener')
      else setLinkMsg((m) => ({ ...m, [c.key]: d.message || d.error || 'Unipile indisponible' }))
    } catch { setLinkMsg((m) => ({ ...m, [c.key]: 'Erreur réseau' })) }
    finally { setLinking(null) }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="card p-4 bg-indigo-50/40 border-indigo-100">
        <p className="text-xs text-indigo-700">Tous les canaux passent par <strong>Unipile</strong> (une seule intégration). LinkedIn et WhatsApp se connectent via authentification hébergée / QR code ; l'email via Gmail, Outlook ou IMAP.</p>
      </div>

      {/* Sécurité — MFA */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-700">Sécurité du compte</h2>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${mfaOn ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{mfaOn ? 'MFA activée' : 'MFA désactivée'}</span>
          </div>
          {mfaOn
            ? <button onClick={disableMfa} className="text-xs font-medium text-gray-400 hover:text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors">Désactiver la MFA</button>
            : <button onClick={startMfa} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">Activer la MFA (TOTP)</button>}
        </div>
        <p className="text-xs text-gray-400">Mot de passe hashé (bcrypt) + double authentification par application (Google Authenticator / Authy). Recommandé avant de poser des clés de production.</p>

        {mfaSecret && !mfaOn && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-600 mb-2">1. Ajoutez ce compte dans votre app d'authentification (saisie manuelle de la clé, ou via l'URI <code className="text-[10px]">otpauth</code>) :</p>
            <div className="bg-gray-50 rounded-lg p-3 mb-3">
              <p className="text-[11px] text-gray-400">Clé secrète</p>
              <code className="text-sm font-mono font-semibold text-gray-800 tracking-wider break-all">{mfaSecret}</code>
              <p className="text-[10px] text-gray-400 mt-2 break-all">{mfaUri}</p>
            </div>
            <p className="text-xs text-gray-600 mb-2">2. Entrez le code à 6 chiffres généré :</p>
            <div className="flex items-center gap-2">
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" className={`${fieldCls} w-32 text-center tracking-[0.3em] font-semibold`} />
              <button onClick={confirmMfa} disabled={mfaCode.length !== 6} className="gradient-brand text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Confirmer</button>
            </div>
          </div>
        )}
        {mfaMsg && <p className="text-xs text-emerald-600 mt-3">{mfaMsg}</p>}
      </div>

      {/* Clés API — statut lecture seule (les valeurs se posent dans Vercel, jamais ici) */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Clés API & modèles</h2>
          {sigMode && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sigMode === 'exa+claude' ? 'bg-emerald-50 text-emerald-600' : sigMode === 'claude-web' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-400'}`}>
              Signaux : {sigMode === 'exa+claude' ? 'Exa → Claude' : sigMode === 'claude-web' ? 'Claude web seul' : 'mode simulé'}
            </span>
          )}
        </div>
        <div className="space-y-2.5">
          {keys.map((k) => (
            <div key={k.key} className="flex items-center gap-3 flex-wrap">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${k.set ? 'bg-emerald-500' : 'bg-gray-300'}`} />
              <div className="min-w-[180px] flex-shrink-0">
                <p className="text-sm text-gray-700 leading-tight">{k.label}</p>
                <code className="text-[10px] text-gray-400">{k.key}</code>
              </div>
              <input
                type="password"
                value={keyDrafts[k.key] ?? ''}
                onChange={(e) => setKeyDrafts((d) => ({ ...d, [k.key]: e.target.value }))}
                placeholder={k.set ? '•••••••• (configurée — laisser vide pour garder)' : 'Coller la clé…'}
                autoComplete="off"
                className={`${fieldCls} flex-1 min-w-[180px]`}
              />
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${k.source === 'app' ? 'bg-indigo-50 text-indigo-600' : k.source === 'env' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                {k.source === 'app' ? 'saisie app' : k.source === 'env' ? 'Vercel env' : 'manquante'}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={saveKeys} disabled={savingKeys} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
            {savingKeys ? 'Enregistrement…' : 'Enregistrer les clés'}
          </button>
          {keySaved && <span className="text-xs text-emerald-600">✓ Clés enregistrées</span>}
        </div>
        <p className="text-[11px] text-amber-600 mt-3">⚠️ Les clés saisies ici sont stockées <strong>en mémoire serveur</strong> : pratique pour tester, mais elles peuvent être réinitialisées après une mise en veille / un redéploiement. Pour du <strong>durable</strong>, pose-les aussi dans Vercel → Environment Variables (ou on branchera Supabase). Ne partage jamais cet écran.</p>
      </div>

      {channels.map((c) => {
        const d = cfg(c)
        return (
          <div key={c.key} className="card p-5">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-9 h-9 rounded-xl gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{CHANNEL_ICON[c.key]}</span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-800">{c.label}</p>
                <p className="text-xs text-gray-400">{c.detail}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>{c.connected ? 'Connecté' : 'Non connecté'}</span>
            </div>

            {c.key === 'linkedin' && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Compte LinkedIn</label>
                <input value={d.account || ''} onChange={(e) => setDraft(c.key, { account: e.target.value })} className={fieldCls} placeholder="Nom du compte lié" />
              </div>
            )}

            {c.key === 'email' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Fournisseur</label>
                  <select value={d.provider || ''} onChange={(e) => setDraft(c.key, { provider: e.target.value })} className={fieldCls}>
                    <option value="">Choisir…</option><option>Gmail</option><option>Outlook</option><option>IMAP</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Adresse d'envoi</label>
                  <input value={d.fromEmail || ''} onChange={(e) => setDraft(c.key, { fromEmail: e.target.value })} className={fieldCls} placeholder="ludwig@smart-ai.com" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom expéditeur</label>
                  <input value={d.fromName || ''} onChange={(e) => setDraft(c.key, { fromName: e.target.value })} className={fieldCls} placeholder="Ludwig Graham" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Signature</label>
                  <textarea value={d.signature || ''} onChange={(e) => setDraft(c.key, { signature: e.target.value })} className={`${fieldCls} h-20 resize-none`} placeholder="Ludwig Graham · Smart.AI" />
                </div>
              </div>
            )}

            {c.key === 'whatsapp' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Numéro WhatsApp</label>
                  <input value={d.phone || ''} onChange={(e) => setDraft(c.key, { phone: e.target.value })} className={fieldCls} placeholder="+33 6 12 34 56 78" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom affiché</label>
                  <input value={d.displayName || ''} onChange={(e) => setDraft(c.key, { displayName: e.target.value })} className={fieldCls} placeholder="Ludwig · Smart.AI" />
                </div>
                <p className="md:col-span-2 text-[11px] text-gray-400">La connexion réelle se fait par scan d'un QR code depuis WhatsApp mobile (Unipile). Le numéro renseigné sert d'identifiant d'envoi.</p>
              </div>
            )}

            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <button onClick={() => linkUnipile(c)} disabled={linking === c.key} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
                {linking === c.key ? 'Ouverture…' : `Connecter via Unipile`}
              </button>
              <button onClick={() => connect(c)} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                Enregistrer les paramètres
              </button>
              {c.connected && (
                <button onClick={() => disconnect(c)} className="text-xs font-medium text-gray-400 px-3 py-1.5 rounded-lg hover:text-red-500 hover:bg-red-50 transition-colors">Déconnecter</button>
              )}
              {linkMsg[c.key] && <span className="text-[11px] text-amber-600 w-full">{linkMsg[c.key]}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const PROVIDER_STYLE: Record<string, string> = {
  anthropic: 'bg-indigo-50 text-indigo-600', exa: 'bg-emerald-50 text-emerald-600',
  perplexity: 'bg-purple-50 text-purple-600', openai: 'bg-teal-50 text-teal-600', gemini: 'bg-amber-50 text-amber-600',
}

function ProtocoleTab() {
  const [routes, setRoutes] = useState<ModelRouteRow[]>([])
  useEffect(() => { fetch('/api/config/models').then((r) => r.json()).then((d) => setRoutes(d.routes || [])).catch(() => {}) }, [])

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="card p-4 bg-indigo-50/40 border-indigo-100">
        <p className="text-xs text-indigo-700">Chaque <strong>phase métier</strong> est routée vers le LLM le plus pertinent. Un point vert = la clé du provider est configurée (onglet Connexions). Modèles surchargeables par variable sans toucher au code.</p>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              {['Phase', 'Provider', 'Modèle', 'Pourquoi', 'Prêt'].map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.phase} className="border-b border-gray-50 align-top">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-800">{r.phase}</p>
                  {r.fallback && <p className="text-[11px] text-gray-400">repli : {r.fallback}</p>}
                </td>
                <td className="px-4 py-3"><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${PROVIDER_STYLE[r.provider] || 'bg-gray-100 text-gray-500'}`}>{r.provider}</span></td>
                <td className="px-4 py-3"><code className="text-[11px] text-gray-600">{r.model}</code></td>
                <td className="px-4 py-3"><p className="text-xs text-gray-500 leading-relaxed max-w-md">{r.why}</p></td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${r.ready ? 'text-emerald-600' : 'text-gray-400'}`}>
                    <span className={`w-2 h-2 rounded-full ${r.ready ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    {r.ready ? 'prêt' : r.requires}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
