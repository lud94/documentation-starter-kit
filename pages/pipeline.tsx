import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Lead, Stage, LeadStatus } from '../types/prospector'
import { STAGE_META, STATUS_META } from '../types/prospector'
import { getLeads, enrichEmails, enrichAll, setLeadStatus } from '../lib/prospector/capabilities'

const STAGE_ORDER: Stage[] = ['to_invite', 'invited', 'connected', 'in_sequence', 'responded', 'meeting', 'closed']
const STATUS_ORDER: LeadStatus[] = ['chaud', 'tiede', 'froid', 'converti', 'perdu']

function scoreColor(s: number) { return s >= 80 ? '#059669' : s >= 65 ? '#f59e0b' : '#94a3b8' }

function EnrichDots({ lead }: { lead: Lead }) {
  return (
    <span className="flex items-center gap-1">
      <span title={lead.email ?? 'Email manquant'} className="inline-flex">
        <svg className={`w-3.5 h-3.5 ${lead.email ? 'text-emerald-500' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
      </span>
      <span title={lead.phone ?? 'Téléphone manquant'} className="inline-flex">
        <svg className={`w-3.5 h-3.5 ${lead.phone ? 'text-emerald-500' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
      </span>
    </span>
  )
}

function MultiFilter({ label, options, selected, onToggle, onClear }: {
  label: string
  options: { value: string; label: string }[]
  selected: Set<string>
  onToggle: (v: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-1.5">
        {label}
        {selected.size > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{selected.size}</span>}
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-2 w-52 card p-1.5 z-40">
            {options.map((o) => {
              const on = selected.has(o.value)
              return (
                <button key={o.value} onClick={() => onToggle(o.value)} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 text-sm text-gray-700 text-left">
                  <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'gradient-brand border-transparent' : 'border-gray-300'}`}>
                    {on && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                  </span>
                  {o.label}
                </button>
              )
            })}
            {selected.size > 0 && <button onClick={onClear} className="w-full text-xs text-gray-400 hover:text-gray-600 px-2.5 py-1.5 text-left">Effacer</button>}
          </div>
        </>
      )}
    </div>
  )
}

function LeadCard({ lead }: { lead: Lead }) {
  const initials = `${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()
  const sm = STATUS_META[lead.status]
  return (
    <Link href={`/leads/${lead.id}`} className="block bg-white rounded-xl border border-gray-100 p-3 hover:shadow-sm hover:border-gray-200 transition-all">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{initials}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</p>
          <p className="text-xs text-gray-400 truncate">{lead.title}</p>
        </div>
        {lead.score > 0
          ? <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style={{ backgroundColor: scoreColor(lead.score) }}>{lead.score}</span>
          : <span className="w-7 h-7 rounded-full flex items-center justify-center text-gray-300 text-xs flex-shrink-0 border border-gray-200">—</span>}
      </div>
      <div className="flex items-center justify-between mt-2.5">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sm.bg}`}>{sm.label}</span>
        <EnrichDots lead={lead} />
      </div>
    </Link>
  )
}

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'kanban' | 'table'>('kanban')
  const [query, setQuery] = useState('')
  const [statusF, setStatusF] = useState<Set<string>>(new Set())
  const [stageF, setStageF] = useState<Set<string>>(new Set())
  const [enrichF, setEnrichF] = useState<'all' | 'enriched' | 'no_email' | 'no_phone'>('all')
  const [importOpen, setImportOpen] = useState(false)

  const refresh = () => getLeads().then((l) => { setLeads(l); setLoading(false) })
  useEffect(() => { refresh() }, [])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n)
  }

  const q = query.trim().toLowerCase()
  const filtered = leads.filter((l) => {
    if (q && !`${l.firstName} ${l.lastName} ${l.company} ${l.title}`.toLowerCase().includes(q)) return false
    if (statusF.size > 0 && !statusF.has(l.status)) return false
    if (stageF.size > 0 && !stageF.has(l.stage)) return false
    if (enrichF === 'enriched' && !(l.email && l.phone)) return false
    if (enrichF === 'no_email' && l.email) return false
    if (enrichF === 'no_phone' && l.phone) return false
    return true
  })
  const byStage = (s: Stage) => filtered.filter((l) => l.stage === s)
  const hasFilter = query || statusF.size || stageF.size || enrichF !== 'all'

  const changeStatus = async (id: string, status: LeadStatus) => { await setLeadStatus(id, status); refresh() }
  const doEnrichEmails = async () => { await enrichEmails(); refresh() }
  const doEnrichAll = async () => { await enrichAll(); refresh() }

  const exportCsv = () => {
    const rows = [['Nom', 'Titre', 'Entreprise', 'Statut', 'Stage', 'Score', 'Email', 'Téléphone'],
      ...filtered.map((l) => [`${l.firstName} ${l.lastName}`, l.title, l.company, STATUS_META[l.status].label, STAGE_META[l.stage].label, l.score, l.email ?? '', l.phone ?? ''])]
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = 'prospector-pipeline.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const btn = 'text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2'

  return (
    <>
      <Head><title>Prospector · Pipeline & Leads</title></Head>

      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline &amp; Leads</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {loading ? 'Chargement…' : hasFilter ? `${filtered.length} leads sur ${leads.length}` : `${leads.length} prospects dans votre base`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={doEnrichAll} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Enrichir tout
          </button>
          <button onClick={doEnrichEmails} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            Enrichir emails
          </button>
          <button onClick={() => setImportOpen(true)} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Importer CSV
          </button>
          <button onClick={exportCsv} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 4h16v16H4z" /></svg>
            Exporter
          </button>
        </div>
      </div>

      {/* Filtres */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher par nom, entreprise, titre…" className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-white border border-gray-200 focus:outline-none focus:border-indigo-400 transition-all" />
        </div>
        <MultiFilter label="Statut" options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label }))} selected={statusF} onToggle={(v) => toggle(statusF, setStatusF, v)} onClear={() => setStatusF(new Set())} />
        <MultiFilter label="Stage" options={STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))} selected={stageF} onToggle={(v) => toggle(stageF, setStageF, v)} onClear={() => setStageF(new Set())} />
        <select value={enrichF} onChange={(e) => setEnrichF(e.target.value as typeof enrichF)} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl focus:outline-none focus:border-indigo-400">
          <option value="all">Enrichissement : tous</option>
          <option value="enriched">Enrichis (email + tél)</option>
          <option value="no_email">Email manquant</option>
          <option value="no_phone">Téléphone manquant</option>
        </select>
        <div className="flex bg-gray-100 rounded-xl p-1">
          {(['kanban', 'table'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${view === v ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{v === 'kanban' ? 'Kanban' : 'Table'}</button>
          ))}
        </div>
        {hasFilter && <button onClick={() => { setQuery(''); setStatusF(new Set()); setStageF(new Set()); setEnrichF('all') }} className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>Effacer</button>}
      </div>

      {/* Table */}
      {view === 'table' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-gray-100 text-left">
                {['Contact', 'Entreprise', 'Stage', 'Statut', 'Enrich.', 'Score'].map((h) => <th key={h} className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>)}
              </tr></thead>
              <tbody>
                {[...filtered].sort((a, b) => b.score - a.score).map((lead) => {
                  const sm = STAGE_META[lead.stage]
                  return (
                    <tr key={lead.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${lead.id}`} className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{`${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()}</span>
                          <span className="min-w-0"><span className="block text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</span><span className="block text-xs text-gray-400 truncate">{lead.title}</span></span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{lead.company}</td>
                      <td className="px-4 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: sm.color }}>{sm.label}</span></td>
                      <td className="px-4 py-3">
                        <select value={lead.status} onChange={(e) => changeStatus(lead.id, e.target.value as LeadStatus)} className="text-xs font-medium bg-transparent border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-400">
                          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3"><EnrichDots lead={lead} /></td>
                      <td className="px-4 py-3">{lead.score > 0 ? <span className="w-7 h-7 rounded-full inline-flex items-center justify-center text-white text-[11px] font-bold" style={{ backgroundColor: scoreColor(lead.score) }}>{lead.score}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Kanban */}
      {view === 'kanban' && (
        <div className="overflow-x-auto pb-4 -mx-6 px-6">
          <div className="flex gap-3 min-w-max">
            {STAGE_ORDER.map((stage) => {
              const meta = STAGE_META[stage]
              const items = byStage(stage)
              return (
                <div key={stage} className="w-60 flex-shrink-0">
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl" style={{ backgroundColor: `${meta.color}14` }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
                    <span className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="text-xs font-bold ml-auto" style={{ color: meta.color }}>{items.length}</span>
                  </div>
                  <div className="bg-gray-50/70 rounded-2xl p-2 space-y-2 min-h-[120px]">
                    {items.map((lead) => <LeadCard key={lead.id} lead={lead} />)}
                    {items.length === 0 && <p className="text-xs text-gray-300 text-center py-6">Vide</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setImportOpen(false)} />
          <div className="relative card p-6 max-w-md w-full">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Importer des prospects</h2>
            <p className="text-sm text-gray-500 mb-4">Chargez un CSV (nom, entreprise, titre, email…). Le mapping des colonnes se fera à l'import.</p>
            <label className="block border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-300 transition-colors mb-4">
              <input type="file" accept=".csv" className="hidden" />
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              <span className="text-sm text-gray-400">Glissez un fichier CSV ou cliquez</span>
            </label>
            <button onClick={() => setImportOpen(false)} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity">Importer</button>
          </div>
        </div>
      )}
    </>
  )
}
