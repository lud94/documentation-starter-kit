import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { SourcingData, SourcedCompany, ResolvedContact, SignalHit } from '../types/prospector'
import { PromptDialog } from '../components/Dialog'
import { getSourcing, importCompaniesToPipeline, importSignalToPipeline, addContactsToPipeline, findContactsForCompany, findContactsForCompanies, getImportedSirens, searchPeople, importPerson, createList, takeWriteRejections, rejectionLabel, PERSONA_TARGETS, CONTACT_BATCH_CAP, type Period } from '../lib/prospector/capabilities'
import { useRouter } from 'next/router'
import type { PersonHit } from '../lib/prospector/capabilities'

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

// Thèses de signal pré-remplies (l'utilisateur peut charger ses propres mots-clés).
const SIGNAL_PRESETS = [
  'Startups fintech qui recrutent des sales',
  'Sociétés de conseil en cybersécurité en levée de fonds',
  'Scale-ups SaaS B2B qui recrutent un Head of Sales',
  "ESN qui recrutent des business developers en Île-de-France",
  'Startups IA ayant levé des fonds récemment',
]

const SIG_STYLE: Record<string, string> = {
  recrutement: 'bg-blue-50 text-blue-600', 'levée': 'bg-emerald-50 text-emerald-600',
  actu: 'bg-purple-50 text-purple-600', autre: 'bg-gray-100 text-gray-500',
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
  const [tab, setTab] = useState<'recherche' | 'signal' | 'people' | 'prospects'>('recherche')

  // Recherche de personnes (Unipile / LinkedIn)
  const [pRole, setPRole] = useState('')
  const [pSector, setPSector] = useState('')
  const [pLocation, setPLocation] = useState('')
  const [pRunning, setPRunning] = useState(false)
  const [pPeople, setPPeople] = useState<PersonHit[]>([])
  const [pMock, setPMock] = useState(false)
  const [pImported, setPImported] = useState<Set<string>>(new Set())
  const runPeople = async () => {
    setPRunning(true)
    const r = await searchPeople({ role: pRole, sector: pSector, location: pLocation })
    setPPeople(r.people); setPMock(r.mock); setPRunning(false)
  }
  const importP = async (p: PersonHit) => { await importPerson(p); setPImported((s) => new Set(s).add(p.id)) }

  // Recherche par signal (agent Claude web)
  const [sigThesis, setSigThesis] = useState('')
  const [sigRunning, setSigRunning] = useState(false)
  const [sigHits, setSigHits] = useState<SignalHit[]>([])
  const [sigMode, setSigMode] = useState('')
  const [sigPasses, setSigPasses] = useState(1)
  const [sigError, setSigError] = useState<string | null>(null)
  const [sigImported, setSigImported] = useState<Set<string>>(new Set())
  // Critères structurés de la recherche par signal
  const [sigTypes, setSigTypes] = useState<Set<string>>(new Set())
  const [sigSector, setSigSector] = useState('')
  const [sigLocation, setSigLocation] = useState('')
  const [sigMonths, setSigMonths] = useState(6)
  const [sigKeywords, setSigKeywords] = useState('')
  const [sigBuilt, setSigBuilt] = useState('')
  const [sigDone, setSigDone] = useState(false) // une recherche a été effectuée (pour l'état « aucun résultat »)
  const [sigCatalog, setSigCatalog] = useState<{ key: string; label: string; group: string }[]>([])
  useEffect(() => { fetch('/api/signals/search?catalog=1').then((r) => r.json()).then((d) => setSigCatalog(d.types || [])).catch(() => {}) }, [])
  const toggleSigType = (k: string) => setSigTypes((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const [copied, setCopied] = useState<string | null>(null)
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
  const [resolvedMap, setResolvedMap] = useState<Record<string, ResolvedContact[]>>({})
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchNote, setBatchNote] = useState<string | null>(null)

  const [fSector, setFSector] = useState('')
  const [fLocation, setFLocation] = useState('')
  const [fSize, setFSize] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [excludePipe, setExcludePipe] = useState(true)
  const [sortYoung, setSortYoung] = useState(false)
  const [inPipe, setInPipe] = useState<Set<string>>(new Set())

  useEffect(() => { getSourcing(period).then(setData) }, [period])
  useEffect(() => { getImportedSirens().then((s) => setInPipe(new Set(s))) }, [])

  const toggleSignal = (s: string) => setPickedSignals((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })

  const query = () => {
    const params = new URLSearchParams()
    if (fSector) params.set('sector', fSector)
    if (fLocation) params.set('location', fLocation)
    if (fSize) params.set('size', fSize)
    if (!activeOnly) params.set('activeOnly', '0')
    return params
  }

  // Vue dérivée : exclusion des comptes déjà en pipe + tri fraîcheur.
  const visibleCompanies = (() => {
    let list = companies
    if (excludePipe) list = list.filter((c) => !inPipe.has(c.id) && !imported.has(c.id))
    if (sortYoung) list = [...list].sort((a, b) => (b.dateCreation || '').localeCompare(a.dateCreation || ''))
    return list
  })()
  const hiddenCount = companies.length - visibleCompanies.length

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

  // Recherche par signal — thèse libre OU critères cochés (types, secteur, période).
  const runSignal = async (thesis?: string) => {
    const q = (thesis ?? sigThesis).trim()
    const usingTypes = !thesis && sigTypes.size > 0
    if (!q && !usingTypes) return
    if (thesis) setSigThesis(thesis)
    setSigRunning(true); setSigError(null); setSigHits([]); setSigDone(false)
    try {
      const res = await fetch('/api/signals/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(usingTypes
          ? { types: Array.from(sigTypes), sector: sigSector, location: sigLocation, months: sigMonths, keywords: sigKeywords }
          : { thesis: q }),
      })
      // Un timeout de la fonction renvoie du HTML, pas du JSON : sans ce garde-fou
      // l'utilisateur voyait « Unexpected token '<' » au lieu du vrai problème.
      const raw = await res.text()
      let d: any = null
      try { d = JSON.parse(raw) } catch { throw new Error(res.ok ? 'Réponse illisible du serveur' : `Le serveur a coupé (HTTP ${res.status}) — recherche trop longue, réduis la période ou les critères.`) }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setSigHits(d.hits || []); setSigMode(d.mode || ''); setSigBuilt(d.thesis || ''); setSigPasses(d.passes || 1)
      // Plus de données de démonstration : une erreur est une erreur, on l'affiche.
      if (d.error) setSigError(d.error)
    } catch (e: any) {
      setSigError(e.message || 'Agent indisponible')
    } finally { setSigRunning(false); setSigDone(true) }
  }

  // Résultat de la vérification data.gouv, obtenue AU MOMENT de l'import.
  // Refus d'écriture remontés par la couche de persistance : ils DOIVENT être
  // affichés, sinon l'utilisateur croit avoir importé.
  const [writeRejected, setWriteRejected] = useState<string | null>(null)
  const reportRejections = () => {
    const r = takeWriteRejections()
    setWriteRejected(r.length ? `${r.length} enregistrement(s) refusé(s) — ${rejectionLabel(r[0].reason)}. Rien n'a été écrasé.` : null)
  }
  const [sigCheck, setSigCheck] = useState<Record<string, { verified: boolean; siren?: string }>>({})
  const [sigBusy, setSigBusy] = useState<string | null>(null)

  const importSignal = async (h: SignalHit) => {
    setSigBusy(h.company)
    try {
      const r: any = await importSignalToPipeline(h)
      reportRejections()
      setSigCheck((c) => ({ ...c, [h.company]: { verified: !!r?.verified, siren: r?.siren } }))
      setSigImported((s) => new Set(s).add(h.company))
    } finally { setSigBusy(null) }
  }

  const router = useRouter()
  const [signalListOpen, setSignalListOpen] = useState(false)
  const [signalListMsg, setSignalListMsg] = useState<string | null>(null)
  const makeSignalList = () => { if (sigHits.length > 0) setSignalListOpen(true) }
  const createSignalList = async (name: string) => {
    setSignalListOpen(false)
    const ids: string[] = []
    for (const h of sigHits) { const r = await importSignalToPipeline(h); if (r?.id) ids.push(r.id) }
    reportRejections()
    setSigImported((s) => { const n = new Set(s); sigHits.forEach((h) => n.add(h.company)); return n })
    await createList(name, ids, 'signaux Exa/Claude')
    setSignalListMsg(`Liste « ${name} » créée depuis les signaux.`); setTimeout(() => setSignalListMsg(null), 4000)
  }

  const copyIce = (h: SignalHit) => { navigator.clipboard?.writeText(h.icebreaker); setCopied(h.company); setTimeout(() => setCopied(null), 1500) }

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
    reportRejections()
    setImported((s) => new Set(s).add(c.id))
  }
  const importAll = async () => {
    const toAdd = visibleCompanies.filter((c) => !imported.has(c.id))
    await importCompaniesToPipeline(toAdd)
    setImported((s) => { const n = new Set(s); toAdd.forEach((c) => n.add(c.id)); return n })
  }

  const resolveContacts = async (c: SourcedCompany) => {
    setContactsFor(c); setContacts(resolvedMap[c.id] || [])
    if (resolvedMap[c.id]) return
    setResolving(true)
    const res = await findContactsForCompany(c, PERSONA_TARGETS)
    setContacts(res); setResolvedMap((m) => ({ ...m, [c.id]: res })); setResolving(false)
  }

  const [pushedContacts, setPushedContacts] = useState<Set<string>>(new Set())
  const pushContacts = async (c: SourcedCompany) => {
    await addContactsToPipeline(c, contacts)
    setPushedContacts((s) => new Set(s).add(c.id))
    setImported((s) => new Set(s).add(c.id))
  }

  const resolveBatch = async () => {
    setBatchRunning(true); setBatchNote(null)
    const targets = companies.filter((c) => !resolvedMap[c.id])
    const { results, capped } = await findContactsForCompanies(targets, PERSONA_TARGETS)
    setResolvedMap((m) => { const n = { ...m }; results.forEach((r) => { n[r.company.id] = r.contacts }); return n })
    const mock = results.some((r) => r.mock)
    setBatchNote(`${results.length} entreprises résolues${capped ? ` (lot plafonné à ${CONTACT_BATCH_CAP})` : ''}${mock ? ' · mode simulé (clés non posées)' : ''}.`)
    setBatchRunning(false)
  }

  const sectorMax = data ? Math.max(...data.bySector.map((s) => s.count)) : 1
  const allImported = visibleCompanies.length > 0 && visibleCompanies.every((c) => imported.has(c.id))

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
        <button onClick={() => setTab('recherche')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === 'recherche' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Par critères</button>
        <button onClick={() => setTab('signal')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${tab === 'signal' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          Par signal
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded gradient-brand text-white">IA</span>
        </button>
        <button onClick={() => setTab('people')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${tab === 'people' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          Par personnes
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500 text-white">in</span>
        </button>
        <button onClick={() => setTab('prospects')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${tab === 'prospects' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          Résultats · critères
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

          <label className="flex items-center gap-2 text-xs text-gray-500 mb-4 cursor-pointer w-fit">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-indigo-500" />
            Sociétés actives uniquement <span className="text-gray-400">(exclut les radiées / cessées)</span>
          </label>

          <div className="flex items-center gap-3">
            <button onClick={launch} disabled={running} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2">
              {running ? 'Recherche…' : <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>Lancer la recherche</>}
            </button>
            {lastRun && <span className={`text-xs ${runError ? 'text-red-600' : 'text-emerald-600'}`}>{lastRun}</span>}
          </div>
        </div>
      ) : tab === 'signal' ? (
        <div className="space-y-4">
          {/* Recherche ciblée par critères */}
          <div className="card p-6 max-w-3xl">
            <p className="text-xs font-semibold text-gray-500 mb-2">Type de signal <span className="font-normal text-gray-400">— coche ce que tu cherches, l'agent va sur les bonnes sources</span></p>
            {['financement', 'croissance', 'direction'].map((g) => {
              const items = sigCatalog.filter((t) => t.group === g)
              if (!items.length) return null
              const gl: Record<string, string> = { financement: '💰 Financement', croissance: '📈 Croissance', direction: '👔 Direction & produit' }
              return (
                <div key={g} className="mb-2.5">
                  <p className="text-[11px] text-gray-400 mb-1">{gl[g]}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((t) => {
                      const on = sigTypes.has(t.key)
                      return <button key={t.key} onClick={() => toggleSigType(t.key)} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${on ? 'gradient-brand text-white border-transparent' : 'text-gray-500 bg-gray-50 border-gray-200 hover:border-indigo-300'}`}>{t.label}</button>
                    })}
                  </div>
                </div>
              )
            })}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4 mb-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Secteur</label>
                <select value={sigSector} onChange={(e) => setSigSector(e.target.value)} className={inputClass}><option value="">Tous</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Localisation</label>
                <input value={sigLocation} onChange={(e) => setSigLocation(e.target.value)} className={inputClass} placeholder="ex: Paris" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Fraîcheur</label>
                <select value={sigMonths} onChange={(e) => setSigMonths(Number(e.target.value))} className={inputClass}>
                  {[1, 3, 6, 12, 18].map((m) => <option key={m} value={m}>{m} mois</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Mots-clés</label>
                <input value={sigKeywords} onChange={(e) => setSigKeywords(e.target.value)} className={inputClass} placeholder="optionnel" />
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => runSignal()} disabled={sigRunning || (sigTypes.size === 0 && !sigThesis.trim())} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
                {sigRunning ? 'Recherche…' : 'Lancer la veille'}
              </button>
              {sigTypes.size > 0 && <span className="text-xs text-gray-400">{sigTypes.size} type(s) · {sigMonths} mois{sigSector ? ` · ${sigSector}` : ''}{sigLocation ? ` · ${sigLocation}` : ''}</span>}
              {sigTypes.size > 0 && <button onClick={() => setSigTypes(new Set())} className="text-xs text-gray-400 hover:text-gray-600">Effacer</button>}
            </div>
            {sigBuilt && <p className="text-[11px] text-gray-400 mt-2 italic">Requête envoyée : « {sigBuilt} »</p>}
            {/* Retour visible ICI (et non plus seulement plus bas) : erreur, attente, vide. */}
            {sigRunning && <p className="text-xs text-indigo-600 mt-2">Veille en cours — l'agent interroge le web puis vérifie chaque entreprise sur data.gouv (10 à 40 s).</p>}
            {!sigRunning && sigError && <p className="text-xs text-red-600 mt-2">Échec : {sigError}</p>}
            {!sigRunning && !sigError && sigDone && sigHits.length === 0 && (
              <p className="text-xs text-amber-600 mt-2">Aucune entreprise trouvée pour ces critères. Élargis la fraîcheur (12-18 mois), retire le secteur ou la ville, ou coche plus de types de signaux.</p>
            )}
            {!sigRunning && sigHits.length > 0 && (
              <p className="text-xs text-emerald-600 mt-2">{sigHits.length} entreprise(s) détectée(s) — voir les résultats ci-dessous ↓</p>
            )}
          </div>

          {/* Mode expert : thèse libre */}
          <div className="card p-6 max-w-3xl">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Ou thèse libre <span className="font-normal text-gray-400">— mode expert : décris toi-même ce que tu cherches</span></label>
            <div className="flex gap-2 mb-3">
              <input value={sigThesis} onChange={(e) => setSigThesis(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSignal()} className={inputClass} placeholder="ex: sociétés de conseil en cybersécurité qui recrutent des sales" />
              <button onClick={() => runSignal()} disabled={sigRunning || !sigThesis.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex-shrink-0">
                {sigRunning ? 'Recherche…' : 'Chercher'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[11px] text-gray-400 self-center mr-1">Exemples :</span>
              {SIGNAL_PRESETS.map((p) => (
                <button key={p} onClick={() => runSignal(p)} className="text-xs font-medium px-2.5 py-1 rounded-full text-gray-500 bg-gray-50 border border-gray-200 hover:border-indigo-300 transition-colors">{p}</button>
              ))}
            </div>
            {sigError && <p className="text-xs text-red-600 mt-3">Échec : {sigError}</p>}
            {sigHits.length > 0 && (
              <p className={`text-[11px] mt-3 ${sigMode === 'exa+claude' ? 'text-emerald-600' : 'text-amber-600'}`}>
                {sigMode === 'exa+claude'
                  ? '⚡ Capteur Exa → cerveau Claude'
                  : '⚡ Claude web seul (ajoute EXA_API_KEY pour un capteur plus frais et un meilleur ciblage des sources)'}
                {sigPasses > 1 && ` · ${sigPasses} passes (une par mois) pour couvrir la période`}
              </p>
            )}
          </div>

          {writeRejected && (
            <div className="card p-4 max-w-3xl border-l-4 border-red-500">
              <p className="text-xs text-red-600 font-semibold">⚠️ {writeRejected}</p>
            </div>
          )}

          {sigHits.length > 0 && (
            <div className="card p-5 max-w-3xl">
              <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-gray-700">Entreprises détectées ({sigHits.length})</h2>
                <button onClick={makeSignalList} className="text-xs font-semibold text-indigo-600 border border-indigo-200 bg-indigo-50/50 px-2.5 py-1 rounded-lg hover:bg-indigo-50">+ Créer une liste depuis ces signaux</button>
              </div>
              <p className="text-xs text-gray-400 mb-4">Chaque résultat cite sa source et sa date — cliquez sur « Source » pour contrôler. La vérification SIREN (data.gouv) se déclenche <b>à l&apos;import</b>, uniquement sur les entreprises que vous retenez. Le bouton corbeille écarte un résultat hors cible.</p>
              <div className="space-y-2">
                {sigHits.map((h) => (
                  <div key={h.company} className="p-3 rounded-xl border border-gray-100">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <span className="text-sm font-medium text-gray-800">{h.company}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${SIG_STYLE[h.signalType]}`}>{h.signalType}</span>
                      {sigCheck[h.company] && (sigCheck[h.company].verified
                        ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">✓ SIREN {sigCheck[h.company].siren}</span>
                        : <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">SIREN introuvable</span>)}
                      {h.city && <span className="text-xs text-gray-400">{h.city}</span>}
                      {/* Écarter un résultat non pertinent (hors cible, doublon, faux positif). */}
                      <button onClick={() => setSigHits((hs) => hs.filter((x) => x.company !== h.company))} title="Écarter ce résultat" className="ml-auto text-gray-300 hover:text-red-500 flex-shrink-0">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mb-1.5">📌 {h.detail}</p>
                    {/* Traçabilité : ce que la source dit réellement (aucun champ inventé). */}
                    {(h.date || h.amount || h.sourceName || h.role) && (
                      <div className="flex items-center gap-2 flex-wrap mb-2 text-[11px] text-gray-400">
                        {h.date && <span>🗓 {h.date}</span>}
                        {h.amount && <span className="font-medium text-gray-500">💰 {h.amount}</span>}
                        {h.role && <span>👤 {h.role}</span>}
                        {h.sourceName && <span>📰 {h.sourceName}</span>}
                      </div>
                    )}
                    <div className="bg-indigo-50/40 border border-indigo-100 rounded-lg p-2.5 mb-2">
                      <p className="text-xs text-gray-700 italic">« {h.icebreaker} »</p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => copyIce(h)} className="text-xs font-medium text-gray-500 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors">{copied === h.company ? '✓ Copié' : 'Copier l\'accroche'}</button>
                      {h.sourceUrl && <a href={h.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-indigo-600 hover:underline">Source</a>}
                      <a href={`https://www.google.com/search?q=${encodeURIComponent(h.company + ' ' + (h.city || ''))}`} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-gray-400 hover:underline">Recouper</a>
                      {sigImported.has(h.company) ? (
                        // Point de repère : une entreprise importée devient un COMPTE
                        // dans Pipeline → Comptes (pas dans « Entreprises sourcées »,
                        // qui liste les résultats de la recherche par critères).
                        <a href={`/pipeline?tab=comptes&q=${encodeURIComponent(h.company)}`} className="text-xs font-semibold px-3 py-1 rounded-lg ml-auto bg-emerald-50 text-emerald-600 hover:bg-emerald-100">✓ Dans Pipeline → voir le compte</a>
                      ) : (
                        <button onClick={() => importSignal(h)} disabled={sigBusy === h.company} className="text-xs font-semibold px-3 py-1 rounded-lg ml-auto transition-opacity gradient-brand text-white hover:opacity-90 disabled:opacity-50">{sigBusy === h.company ? 'Vérification…' : '+ Importer'}</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : tab === 'people' ? (
        <div className="space-y-4">
          <div className="card p-6 max-w-3xl">
            <p className="text-sm text-gray-500 mb-4">Recherche de <strong className="text-gray-700">personnes</strong> sur LinkedIn (via Unipile) — par poste, secteur, localisation.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Poste / titre</label>
                <input value={pRole} onChange={(e) => setPRole(e.target.value)} className={inputClass} placeholder="ex: Head of Sales" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Secteur</label>
                <select value={pSector} onChange={(e) => setPSector(e.target.value)} className={inputClass}><option value="">Tous</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Localisation</label>
                <input value={pLocation} onChange={(e) => setPLocation(e.target.value)} className={inputClass} placeholder="ex: Paris" />
              </div>
            </div>
            <button onClick={runPeople} disabled={pRunning} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">{pRunning ? 'Recherche…' : 'Rechercher sur LinkedIn'}</button>
          </div>

          {pPeople.length > 0 && (
            <div className="card p-5 max-w-3xl">
              <h2 className="text-sm font-semibold text-gray-700 mb-1">Profils trouvés</h2>
              {pMock && <p className="text-[11px] text-amber-600 mb-3">⚠️ Résultats simulés — connecte Unipile (Admin → Connexions) pour la vraie recherche LinkedIn.</p>}
              <div className="space-y-2">
                {pPeople.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition-colors flex-wrap">
                    <span className="w-9 h-9 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{p.name.slice(0, 2).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{p.name} <span className="text-gray-400 font-normal">· {p.title}</span></p>
                      <p className="text-xs text-gray-400 truncate">{p.company} · {p.location}</p>
                    </div>
                    <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-indigo-600 hover:underline flex-shrink-0">LinkedIn</a>
                    <button onClick={() => importP(p)} disabled={pImported.has(p.id)} className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity flex-shrink-0 ${pImported.has(p.id) ? 'bg-emerald-50 text-emerald-600' : 'gradient-brand text-white hover:opacity-90'}`}>{pImported.has(p.id) ? '✓ Ajouté' : '+ Pipeline'}</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 card p-5">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-gray-700">Résultats de la recherche par critères <span className="font-normal text-gray-400">— les comptes importés vivent dans Pipeline → Comptes</span></h2>
              {companies.length > 0 && (
                <div className="flex items-center gap-2">
                  <button onClick={resolveBatch} disabled={batchRunning} className="text-xs font-semibold text-gray-600 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
                    {batchRunning ? 'Résolution…' : `Résoudre les contacts (lot ${CONTACT_BATCH_CAP})`}
                  </button>
                  <button onClick={importAll} disabled={allImported} className="text-xs font-semibold text-indigo-600 border border-indigo-200 bg-indigo-50/50 px-2.5 py-1 rounded-lg hover:bg-indigo-50 transition-colors disabled:opacity-50">
                    {allImported ? 'Toutes importées' : 'Tout importer dans le pipe'}
                  </button>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-1">Importez l'entreprise dans le pipe, puis « Trouver les contacts » pour résoudre vos personas (CEO, Head of Sales…).</p>
            {batchNote && <p className="text-xs text-emerald-600 mb-2">{batchNote}</p>}
            {companies.length > 0 && (
              <div className="flex items-center gap-4 mb-3 flex-wrap text-xs">
                <label className="flex items-center gap-1.5 text-gray-500 cursor-pointer">
                  <input type="checkbox" checked={excludePipe} onChange={(e) => setExcludePipe(e.target.checked)} className="accent-indigo-500" />
                  Masquer celles déjà dans le pipe{hiddenCount > 0 && excludePipe ? ` (${hiddenCount})` : ''}
                </label>
                <label className="flex items-center gap-1.5 text-gray-500 cursor-pointer">
                  <input type="checkbox" checked={sortYoung} onChange={(e) => setSortYoung(e.target.checked)} className="accent-indigo-500" />
                  Plus récentes d'abord
                </label>
              </div>
            )}
            {companies.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">Lancez une recherche pour voir des entreprises.</p>
            ) : visibleCompanies.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">Toutes les entreprises de cette page sont déjà dans le pipe.</p>
            ) : (
              <div className="space-y-2">
                {visibleCompanies.map((c) => {
                  const done = imported.has(c.id)
                  return (
                    <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition-colors flex-wrap">
                      <span className="w-9 h-9 rounded-xl gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{c.name.slice(0, 2).toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate flex items-center gap-1.5">
                          {c.name}
                          <a href={`https://annuaire-entreprises.data.gouv.fr/entreprise/${c.id}`} target="_blank" rel="noopener noreferrer" title="Vérifier la fiche officielle (annuaire des entreprises)" className="text-gray-300 hover:text-indigo-500 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                          </a>
                          <a href={`https://www.google.com/search?q=${encodeURIComponent(c.name + ' ' + c.city)}`} target="_blank" rel="noopener noreferrer" title="Recherche web" className="text-gray-300 hover:text-indigo-500 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                          </a>
                        </p>
                        <p className="text-xs text-gray-400 truncate">{c.sector}{c.dirigeant ? ` · dir. ${c.dirigeant}` : ''}</p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {c.signals.map((s) => <span key={s} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{s}</span>)}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                        <button onClick={() => resolveContacts(c)} className="text-xs font-semibold text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                          {resolvedMap[c.id] ? `${resolvedMap[c.id].length} contacts` : 'Trouver les contacts'}
                        </button>
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
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-amber-700 flex-1 min-w-[200px]">⚠️ Contacts simulés tant que les clés Pappers/Unipile ne sont pas posées dans Vercel.</p>
              {!resolving && contacts.length > 0 && (
                <button
                  onClick={() => contactsFor && pushContacts(contactsFor)}
                  disabled={!!(contactsFor && pushedContacts.has(contactsFor.id))}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity flex-shrink-0 ${contactsFor && pushedContacts.has(contactsFor.id) ? 'bg-emerald-50 text-emerald-600' : 'gradient-brand text-white hover:opacity-90'}`}
                >
                  {contactsFor && pushedContacts.has(contactsFor.id) ? '✓ Ajoutés au pipe' : `Ajouter ces ${contacts.length} contacts au pipe`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {signalListOpen && (
        <PromptDialog title="Créer une liste depuis les signaux" message={`${sigHits.length} entreprise(s) détectée(s) seront importées et regroupées.`} defaultValue={sigThesis.slice(0, 60) || 'Signaux'} submitLabel="Créer la liste" onSubmit={createSignalList} onCancel={() => setSignalListOpen(false)} />
      )}
      {signalListMsg && <div className="fixed bottom-4 right-4 z-50 bg-emerald-600 text-white text-sm px-4 py-2 rounded-xl shadow-lg">{signalListMsg} · <a href="/lists" className="underline">Voir</a></div>}
    </>
  )
}
