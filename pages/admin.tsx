import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { UsageSummary, Diagnostic, Workspace } from '../types/prospector'
import { getUsage, getDiagnostics, getWorkspaces } from '../lib/prospector/capabilities'

type Tab = 'usage' | 'diagnostic' | 'workspaces'

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

  useEffect(() => {
    getUsage().then(setUsage)
    getDiagnostics().then(setDiags)
    getWorkspaces().then(setWorkspaces)
  }, [])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'usage', label: 'Usage & coûts' },
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
