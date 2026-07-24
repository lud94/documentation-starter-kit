import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { SourcingData, SourcedCompany, ResolvedContact } from '../types/prospector'
import { getSourcing, importCompaniesToPipeline, findContactsForCompany, PERSONA_TARGETS, type Period } from '../lib/prospector/capabilities'

const INDUSTRIES = [
  'Real Estate', 'Technology', 'Healthcare', 'Finance', 'Retail', 'Manufacturing',
  'Education', 'Hospitality', 'Legal', 'Marketing', 'Logistics', 'Construction',
  'Media', 'Energy', 'Consulting', 'SaaS B2B', 'Fintech', 'IA / ML', 'Cybersécurité',
]
const SIZES = ['1-10', '11-20', '21-50', '51-100', '101-250', '251-500', '501-1000', '1000+']
const COMPANY_TYPES = ['Tous types', 'Éditeur SaaS', 'ESN / conseil IT', 'Cabinet de conseil', 'Agence', 'Startup', 'Scale-up', 'Grand groupe', 'PME']
const REVENUES = ['Aucun minimum', '500K', '1M', '5M', '10M', '50M', '100M']

// Signaux avec leur source technique et leur faisabilité
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

function exportCsv(companies: SourcedCompany[], period: Period) {
  const rows: (string | number)[][] = [
    ['Rapport Sourcing entreprises', period],
    [],
    ['SIREN', 'Entreprise', 'Secteur', 'Effectif', 'Ville', 'Dép', 'Dirigeant SIRENE'],
    ...companies.map((c) => [c.id, c.name, c.sector, c.effectif, c.city, c.dep, c.dirigeant || ''] as (string | number)[]),
  ]
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = `prospector-entreprises-${period}.csv`; a.click(); URL.revokeObjectURL(url)
}

const inputClass = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'
const SOURCE_STYLE: Record<string, string> = {
  pappers: 'bg-blue-50 text-blue-600', unipile: 'bg-purple-50 text-purple-600', sirene: 'bg-gray-100 text-gray-500',
}

export default function SourcingPage() {
  const [data, setData] = useState<SourcingData | null>(null)
  const [period, setPeriod] = useState<Period>('month')
  const [tab, setTab] = useState<'recherche' | 'prospects'>('recherche')
  const [pickedSignals, setPickedSignals] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [runError, setRunError] = useState(false)

  // Résultats entreprises (live data.gouv)
  const [companies, setCompanies] = useState<SourcedCompany[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [imported, setImported] = useState<Set<string>>(new Set())

  // Résolution de contacts (étape 3)
  const [contactsFor, setContactsFor] = useState<SourcedCompany | null>(null)
  const [contacts, setContacts] = useState<ResolvedContact[]>([])
  const [resolving, setResolving] = useState(false)

  const [fSector, setFSector] = useState('')
  const [fLocation, setFLocation] = useState('')
  const [fSize, setFSize] = useState('')

  useEffect(() => { getSourcing(period).then(setData) }, [period])

  const toggleSignal = (s: string) => setPickedSignals((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })

  const query = () => {
    const params = new URLSearchParams()
    if (fSector) params.set('sector', fSector)
    if (fLocation) params.set('location', fLocation)
    if (fSize) params.set('size', fSize)
    return params
  }

  const launch = async () => {
    setRunning(true); setLastRun(null); setRunError(false); setPage(1)
    try {
      const params = query(); params.set('page', '1')
      const res = await fetch(`/api/sourcing/search?${params.toString()}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setCompanies(d.results); setTotal(d.total); setTotalPages(d.totalPages || 1)
      if (d.results.length === 0) { setRunError(true); setLastRun('Aucune entreprise pour ces critères — élargis le secteur ou la localisation.') }
      else { setLastRun(`${d.total} entreprises trouvées (data.gouv) · page 1/${d.totalPages}.`); setTab('prospects') }
    } catch (e: any) {
      setRunError(true); setLastRun('Échec : ' + (e.message || 'API indisponible'))
    } finally { setRunning(false) }
  }

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const next = page + 1
      const params = query(); params.set('page', String(next))
      const res = await fetch(`/api/sourcing/search?${params.toString()}`)
      const d = await res.json()
      if (res.ok) {
        // dédoublonne par SIREN
        setCompanies((prev) => { const seen = new Set(prev.map((c) => c.id)); return [...prev, ...d.results.filter((c: SourcedCompany) => !seen.has(c.id))] })
        setPage(next); setTotalPages(d.totalPages || totalPages)
        setLastRun(`${total} entreprises · ${companies.length + d.results.length} chargées (page ${next}/${d.totalPages}).`)
      }
    } finally { setLoadingMore(false) }
  }

  const importOne = async (c: SourcedCompany) => {
    await importCompaniesToPipeline([c])
    setImported((s) => new Set(s).add(c.id))
  }
  const importAll = async () => {
    const toAdd = companies.filter((c) => !imported.has(c.id))
    await importCompaniesToPipeline(toAdd)
    setImported((s) => { const n = new Set(s); toAdd.forEach((c) => n.add(c.id)); return n })
  }

  const resolveContacts = async (c: SourcedCompany) => {
    setContactsFor(c); setResolving(true); setContacts([])
    const res = await findContactsForCompany(c, PERSONA_TARGETS)
    setContacts(res); setResolving(false)
  }

  const sectorMax = data ? Math.max(...data.bySector.map((s) => s.count)) : 1
  const allImported = companies.length > 0 && companies.every((c) => imported.has(c.id))

  return (
    <>
      <Head><title>Prospector · Sourcing</title></Head>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sourcing</h1>
          <p className="text-gray-400 text-sm mt-0.5">Trouvez des <strong className="font-semibold text-gray-500">entreprises</strong> cibles, importez-les dans le pipe, puis résolvez les contacts.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => setPeriod(p.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${period === p.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{p.label}</button>
            ))}
          </div>
          <button onClick={() => exportCsv(companies, period)} disabled={companies.length === 0} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:opacity-50">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 4h16v16H4z" /></svg>
            Exporter
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Entreprises trouvées', value: total ? String(total) : (data ? String(data.totalSourced) : '—'), sub: 'via data.gouv / SIRENE' },
          { label: 'Chargées à l\'écran', value: String(companies.length), sub: `page ${page}/${totalPages || 1}` },
          { label: 'Importées au pipe', value: String(imported.size), sub: 'prêtes à enrichir' },
        ].map((k) => (
          <div key={k.label} className="card p-5">
            <p className="text-xs font-semibold text-gray-400 mb-1">{k.label}</p>
            <p className="text-2xl font-bold gradient-text">{k.value}</p>
            <p className="text-xs text-gray-400 mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Onglets */}
      <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-5">
        <button onClick={() => setTab('recherche')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === 'recherche' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Nouvelle recherche</button>
        <button onClick={() => setTab('prospects')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${tab === 'prospects' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          Entreprises sourcées
          {companies.length > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{companies.length}</span>}
        </button>
      </div>

      {tab === 'recherche' ? (
        <div className="card p-6 max-w-3xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Secteur d'activité</label>
              <select value={fSector} onChange={(e) => setFSector(e.target.value)} className={inputClass}><option value="">Sélectionner…</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Localisation</label>
              <input value={fLocation} onChange={(e) => setFLocation(e.target.value)} className={inputClass} placeholder="ex: Paris, 75, Lyon…" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Type d'entreprise</label>
              <select className={inputClass}>{COMPANY_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Taille de l'entreprise</label>
              <select value={fSize} onChange={(e) => setFSize(e.target.value)} className={inputClass}><option value="">Toutes tailles</option>{SIZES.map((s) => <option key={s} value={s}>{s} employés</option>)}</select>
            </div>
            <div>
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
            {lastRun && <span className={`text-xs ${runError ? 'text-red-600' : 'text-emerald-600'}`}>{lastRun}</span>}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 card p-5">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-gray-700">Entreprises sourcées</h2>
              {companies.length > 0 && (
                <button onClick={importAll} disabled={allImported} className="text-xs font-semibold text-indigo-600 border border-indigo-200 bg-indigo-50/50 px-2.5 py-1 rounded-lg hover:bg-indigo-50 transition-colors disabled:opacity-50">
                  {allImported ? 'Toutes importées' : 'Tout importer dans le pipe'}
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-4">Importez l'entreprise dans le pipe, puis « Trouver les contacts » pour résoudre vos personas (CEO, Head of Sales…).</p>
            {companies.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">Lancez une recherche pour voir des entreprises.</p>
            ) : (
              <div className="space-y-2">
                {companies.map((c) => {
                  const done = imported.has(c.id)
                  return (
                    <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition-colors flex-wrap">
                      <span className="w-9 h-9 rounded-xl gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{c.name.slice(0, 2).toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                        <p className="text-xs text-gray-400 truncate">{c.sector}{c.dirigeant ? ` · dir. ${c.dirigeant}` : ''}</p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {c.signals.map((s) => <span key={s} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{s}</span>)}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                        <button onClick={() => resolveContacts(c)} className="text-xs font-semibold text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">Trouver les contacts</button>
                        <button onClick={() => importOne(c)} disabled={done} className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity ${done ? 'bg-emerald-50 text-emerald-600' : 'gradient-brand text-white hover:opacity-90'}`}>
                          {done ? '✓ Dans le pipe' : '+ Importer'}
                        </button>
                      </div>
                    </div>
                  )
                })}
                {page < totalPages && (
                  <button onClick={loadMore} disabled={loadingMore} className="w-full text-sm font-medium text-gray-600 border border-dashed border-gray-300 rounded-xl py-2.5 hover:bg-gray-50 transition-colors disabled:opacity-50 mt-1">
                    {loadingMore ? 'Chargement…' : `Charger plus (${companies.length}/${total})`}
                  </button>
                )}
              </div>
            )}
          </div>

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

      {/* Résolution de contacts */}
      {contactsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setContactsFor(null)} />
          <div className="relative card w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-gray-900">Contacts · {contactsFor.name}</h2>
                <p className="text-xs text-gray-400">Personas résolus via Pappers (dirigeants) + Unipile / LinkedIn.</p>
              </div>
              <button onClick={() => setContactsFor(null)} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <div className="p-3 overflow-y-auto space-y-2">
              {resolving ? (
                <p className="text-sm text-gray-400 text-center py-8">Résolution des personas…</p>
              ) : (
                contacts.map((ct, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-100">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{ct.name} <span className="text-gray-400 font-normal">· {ct.persona}</span></p>
                      <p className="text-xs text-gray-400 truncate">{ct.email}</p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${SOURCE_STYLE[ct.source]}`}>{ct.source}</span>
                    {ct.linkedinUrl && <a href={ct.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-indigo-600 hover:underline">LinkedIn</a>}
                  </div>
                ))
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 bg-amber-50/50">
              <p className="text-[11px] text-amber-700">⚠️ Contacts simulés — au câblage : Pappers/societe.com pour les dirigeants, Unipile/LinkedIn pour les personas sales/marketing.</p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
