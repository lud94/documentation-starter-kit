import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { SourcingData, SourcedLead } from '../types/prospector'
import { getSourcing } from '../lib/prospector/capabilities'

const INDUSTRIES = ['SaaS B2B', 'Fintech', 'IA / ML', 'MarTech', 'Cybersécurité']
const SIZES = ['1-10', '11-50', '51-100', '101-250']
const SENIORITY = ['Founder', 'C-level', 'VP', 'Director', 'Manager']
const SIGNALS = ['Levée de fonds', 'Recrute sales', 'Recrute marketing', 'Croissance effectif', 'Nouveau décideur', 'Ouverture Paris']

function scoreColor(s: number) { return s >= 80 ? '#059669' : s >= 65 ? '#f59e0b' : '#94a3b8' }

export default function SourcingPage() {
  const [data, setData] = useState<SourcingData | null>(null)
  const [incoming, setIncoming] = useState<SourcedLead[]>([])
  const [pickedSignals, setPickedSignals] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<string | null>(null)

  useEffect(() => { getSourcing().then((d) => { setData(d); setIncoming(d.incoming) }) }, [])

  const toggleSignal = (s: string) => setPickedSignals((p) => {
    const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n
  })

  const launch = () => {
    setRunning(true)
    setTimeout(() => { setRunning(false); setLastRun('Recherche lancée — les nouveaux leads qualifiés apparaîtront ci-dessous.') }, 900)
  }

  const triage = (id: string) => setIncoming((l) => l.filter((x) => x.id !== id))

  const sectorMax = data ? Math.max(...data.bySector.map((s) => s.count)) : 1
  const inputClass = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

  return (
    <>
      <Head><title>Prospector · Sourcing</title></Head>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Sourcing</h1>
        <p className="text-gray-400 text-sm mt-0.5">Trouvez de nouveaux comptes, filtrés par signal, puis triez-les vers le pipeline.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div className="card p-5">
          <p className="text-xs font-semibold text-gray-400 mb-1">Leads sourcés</p>
          <p className="text-2xl font-bold gradient-text">{data ? data.totalSourced : '—'}</p>
          <p className="text-xs text-gray-400 mt-0.5">ce mois</p>
        </div>
        <div className="card p-5">
          <p className="text-xs font-semibold text-gray-400 mb-1">Taux de qualification</p>
          <p className="text-2xl font-bold gradient-text">{data ? `${data.qualificationRate}%` : '—'}</p>
          <p className="text-xs text-gray-400 mt-0.5">passent le gate signal</p>
        </div>
        <div className="card p-5">
          <p className="text-xs font-semibold text-gray-400 mb-1">À trier</p>
          <p className="text-2xl font-bold gradient-text">{incoming.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">leads qualifiés en attente</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Formulaire recherche */}
        <div className="lg:col-span-2 card p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Nouvelle recherche</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Secteur</label>
              <select className={inputClass}>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Taille</label>
              <select className={inputClass}>{SIZES.map((s) => <option key={s}>{s}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Séniorité</label>
              <select className={inputClass}>{SENIORITY.map((s) => <option key={s}>{s}</option>)}</select>
            </div>
          </div>
          <label className="block text-xs font-semibold text-gray-500 mb-1.5">Signaux d'achat (le gate ne garde que ceux-ci)</label>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {SIGNALS.map((s) => {
              const on = pickedSignals.has(s)
              return (
                <button key={s} onClick={() => toggleSignal(s)} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${on ? 'gradient-brand text-white border-transparent' : 'text-gray-500 bg-gray-50 border-gray-200 hover:border-indigo-300'}`}>
                  {s}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={launch} disabled={running} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2">
              {running ? 'Recherche…' : <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                Lancer la recherche
              </>}
            </button>
            {lastRun && <span className="text-xs text-emerald-600">{lastRun}</span>}
          </div>
        </div>

        {/* Par secteur + runs */}
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Par secteur</h2>
            {!data ? <p className="text-sm text-gray-400">…</p> : (
              <div className="space-y-2">
                {data.bySector.map((s) => (
                  <div key={s.sector} className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-24 truncate">{s.sector}</span>
                    <div className="flex-1 bg-gray-50 rounded-full h-1.5"><div className="h-1.5 rounded-full gradient-brand" style={{ width: `${(s.count / sectorMax) * 100}%` }} /></div>
                    <span className="text-xs font-medium text-gray-500 w-6 text-right">{s.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Recherches récentes</h2>
            {!data ? <p className="text-sm text-gray-400">…</p> : (
              <div className="space-y-2.5">
                {data.runs.map((r) => (
                  <div key={r.id} className="text-xs">
                    <p className="text-gray-700 font-medium">{r.label}</p>
                    <p className="text-gray-400">{r.qualified}/{r.found} qualifiés · {r.when}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Leads à trier */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Leads sourcés à trier</h2>
        <p className="text-xs text-gray-400 mb-4">Qualifiés par le gate signal. Ajoutez-les au pipeline ou écartez-les.</p>
        {incoming.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">Tout est trié 🎉</p>
        ) : (
          <div className="space-y-2">
            {incoming.map((l) => (
              <div key={l.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition-colors flex-wrap">
                <span className="w-8 h-8 rounded-full text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0" style={{ backgroundColor: scoreColor(l.score) }}>{l.score}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate">{l.name} <span className="text-gray-400 font-normal">· {l.title}</span></p>
                  <p className="text-xs text-gray-400 truncate">{l.company} · {l.sector}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {l.signals.map((s) => <span key={s} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{s}</span>)}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                  <button onClick={() => triage(l.id)} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">+ Pipeline</button>
                  <button onClick={() => triage(l.id)} className="text-xs font-medium text-gray-400 px-2 py-1.5 rounded-lg hover:text-red-500 hover:bg-red-50 transition-colors">Ignorer</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
