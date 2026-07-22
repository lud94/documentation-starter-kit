import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { SourcingData, SourcedLead } from '../types/prospector'
import { getSourcing, type Period } from '../lib/prospector/capabilities'

const INDUSTRIES = [
  'Real Estate', 'Technology', 'Healthcare', 'Finance', 'Retail', 'Manufacturing',
  'Education', 'Hospitality', 'Legal', 'Marketing', 'Logistics', 'Construction',
  'Media', 'Energy', 'Consulting', 'SaaS B2B', 'Fintech', 'IA / ML', 'Cybersécurité',
]
const SIZES = ['1-10', '11-20', '21-50', '51-100', '101-250', '251-500', '501-1000', '1000+']
const SENIORITY = ['Tous', 'Founder', 'C-level', 'VP', 'Director', 'Manager']
const REVENUES = ['Aucun minimum', '500K', '1M', '5M', '10M', '50M', '100M']

// Signaux avec leur source technique et leur faisabilité (cf. réponse point 4)
const SIGNALS: { label: string; feasibility: 'facile' | 'moyen' | 'difficile' }[] = [
  { label: 'Recrute des sales', feasibility: 'facile' },
  { label: 'Recrute du marketing', feasibility: 'facile' },
  { label: 'Croissance effectif', feasibility: 'facile' },
  { label: 'Ouverture bureau', feasibility: 'moyen' },
  { label: 'Nouveau décideur', feasibility: 'moyen' },
  { label: 'Levée de fonds', feasibility: 'difficile' },
  { label: 'Stack HubSpot / Salesforce', feasibility: 'difficile' },
]

const FEAS_STYLE: Record<string, string> = {
  facile: 'bg-emerald-50 text-emerald-600',
  moyen: 'bg-amber-50 text-amber-600',
  difficile: 'bg-red-50 text-red-500',
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'quarter', label: 'Trimestre' },
  { key: 'year', label: 'Année' },
]

function scoreColor(s: number) { return s >= 80 ? '#059669' : s >= 65 ? '#f59e0b' : '#94a3b8' }

function exportCsv(data: SourcingData, incoming: SourcedLead[], period: Period) {
  const rows: (string | number)[][] = [
    ['Rapport Sourcing', period],
    [],
    ['Leads sourcés', data.totalSourced],
    ['Taux de qualification (%)', data.qualificationRate],
    [],
    ['Par secteur', ''],
    ...data.bySector.map((s) => [s.sector, s.count] as (string | number)[]),
    [],
    ['Leads à trier', ''],
    ['Nom', 'Titre', 'Entreprise', 'Secteur', 'Score', 'Signaux'],
    ...incoming.map((l) => [l.name, l.title, l.company, l.sector, l.score, l.signals.join(' · ')] as (string | number)[]),
  ]
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = `prospector-sourcing-${period}.csv`; a.click(); URL.revokeObjectURL(url)
}

const inputClass = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

export default function SourcingPage() {
  const [data, setData] = useState<SourcingData | null>(null)
  const [incoming, setIncoming] = useState<SourcedLead[]>([])
  const [period, setPeriod] = useState<Period>('month')
  const [tab, setTab] = useState<'recherche' | 'prospects'>('recherche')
  const [pickedSignals, setPickedSignals] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<string | null>(null)

  useEffect(() => { getSourcing(period).then((d) => { setData(d); setIncoming(d.incoming) }) }, [period])

  const toggleSignal = (s: string) => setPickedSignals((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })
  const launch = () => { setRunning(true); setTimeout(() => { setRunning(false); setLastRun('Recherche lancée — les leads qualifiés apparaîtront dans « Prospects sourcés ».'); setTab('prospects') }, 900) }
  const triage = (id: string) => setIncoming((l) => l.filter((x) => x.id !== id))
  const sectorMax = data ? Math.max(...data.bySector.map((s) => s.count)) : 1

  return (
    <>
      <Head><title>Prospector · Sourcing</title></Head>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sourcing</h1>
          <p className="text-gray-400 text-sm mt-0.5">Trouvez de nouveaux comptes filtrés par signal, puis triez-les vers le pipeline.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => setPeriod(p.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${period === p.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{p.label}</button>
            ))}
          </div>
          <button onClick={() => data && exportCsv(data, incoming, period)} disabled={!data} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:opacity-50">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 4h16v16H4z" /></svg>
            Exporter
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div className="card p-5"><p className="text-xs font-semibold text-gray-400 mb-1">Leads sourcés</p><p className="text-2xl font-bold gradient-text">{data ? data.totalSourced : '—'}</p></div>
        <div className="card p-5"><p className="text-xs font-semibold text-gray-400 mb-1">Taux de qualification</p><p className="text-2xl font-bold gradient-text">{data ? `${data.qualificationRate}%` : '—'}</p><p className="text-xs text-gray-400 mt-0.5">passent le gate signal</p></div>
        <div className="card p-5"><p className="text-xs font-semibold text-gray-400 mb-1">À trier</p><p className="text-2xl font-bold gradient-text">{incoming.length}</p></div>
      </div>

      {/* Onglets */}
      <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-5">
        <button onClick={() => setTab('recherche')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === 'recherche' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Nouvelle recherche</button>
        <button onClick={() => setTab('prospects')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${tab === 'prospects' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          Prospects sourcés
          {incoming.length > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{incoming.length}</span>}
        </button>
      </div>

      {tab === 'recherche' ? (
        <div className="card p-6 max-w-3xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Secteur d'activité</label>
              <select className={inputClass}><option>Sélectionner…</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Localisation</label>
              <input className={inputClass} placeholder="ex: France, Paris, Europe…" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Niveau hiérarchique</label>
              <select className={inputClass}>{SENIORITY.map((s) => <option key={s}>{s}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Taille de l'entreprise</label>
              <select className={inputClass}><option>Toutes tailles</option>{SIZES.map((s) => <option key={s}>{s} employés</option>)}</select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Revenue annuel minimum</label>
              <select className={inputClass}>{REVENUES.map((r) => <option key={r}>{r}</option>)}</select>
            </div>
          </div>

          <label className="block text-xs font-semibold text-gray-500 mb-1.5">Signaux d'achat <span className="font-normal text-gray-400">— le gate ne garde que les comptes porteurs d'au moins un signal</span></label>
          <div className="flex flex-wrap gap-1.5 mb-1">
            {SIGNALS.map((s) => {
              const on = pickedSignals.has(s.label)
              return (
                <button key={s.label} onClick={() => toggleSignal(s.label)} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1.5 ${on ? 'gradient-brand text-white border-transparent' : 'text-gray-500 bg-gray-50 border-gray-200 hover:border-indigo-300'}`}>
                  {s.label}
                  <span className={`text-[9px] px-1 py-0.5 rounded ${on ? 'bg-white/20 text-white' : FEAS_STYLE[s.feasibility]}`}>{s.feasibility}</span>
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-gray-400 mb-4">La pastille indique la faisabilité de détection : <span className="text-emerald-600">facile</span> (API structurée), <span className="text-amber-600">moyen</span> (presse + résolution), <span className="text-red-500">difficile</span> (scraping / payant).</p>

          <div className="flex items-center gap-3">
            <button onClick={launch} disabled={running} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2">
              {running ? 'Recherche…' : <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>Lancer la recherche</>}
            </button>
            {lastRun && <span className="text-xs text-emerald-600">{lastRun}</span>}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Leads à trier */}
          <div className="lg:col-span-2 card p-5">
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

          {/* Par secteur + runs */}
          <div className="space-y-4">
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Par secteur</h2>
              {data && (
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
              {data && (
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
      )}
    </>
  )
}
