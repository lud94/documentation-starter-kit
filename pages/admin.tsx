import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { UsageSummary, Diagnostic, Workspace } from '../types/prospector'
import { getUsage, getDiagnostics, getWorkspaces, getChannels, connectChannel, disconnectChannel } from '../lib/prospector/capabilities'
import type { Channel, ChannelConfig } from '../lib/prospector/capabilities'

type Tab = 'usage' | 'connexions' | 'diagnostic' | 'workspaces'

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

  useEffect(() => {
    getUsage().then(setUsage)
    getDiagnostics().then(setDiags)
    getWorkspaces().then(setWorkspaces)
    getChannels().then(setChannels)
  }, [])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'usage', label: 'Usage & coûts' },
    { key: 'connexions', label: 'Connexions' },
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
            <button className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">+ Nouveau workspace</button>
          </div>
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

interface KeyStatus { key: string; label: string; set: boolean }

function ConnexionsTab({ channels, onChange }: { channels: Channel[]; onChange: (c: Channel[]) => void }) {
  const [drafts, setDrafts] = useState<Record<string, ChannelConfig>>({})
  const [linking, setLinking] = useState<string | null>(null)
  const [linkMsg, setLinkMsg] = useState<Record<string, string>>({})
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const [sigMode, setSigMode] = useState<string>('')

  useEffect(() => {
    fetch('/api/config/status').then((r) => r.json()).then((d) => { setKeys(d.keys || []); setSigMode(d.signalsMode || '') }).catch(() => {})
  }, [])

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
        <div className="space-y-1">
          {keys.map((k) => (
            <div key={k.key} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
              <span className={`w-2 h-2 rounded-full ${k.set ? 'bg-emerald-500' : 'bg-gray-300'}`} />
              <span className="text-sm text-gray-700">{k.label}</span>
              <code className="text-[11px] text-gray-400">{k.key}</code>
              <span className={`text-xs ml-auto font-medium ${k.set ? 'text-emerald-600' : 'text-gray-400'}`}>{k.set ? 'configurée' : 'manquante'}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-3">🔒 Pour des raisons de sécurité, les clés se posent dans <strong>Vercel → Settings → Environment Variables</strong> (côté serveur), jamais dans le navigateur. Ce tableau montre seulement lesquelles sont détectées.</p>
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
