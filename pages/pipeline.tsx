import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Lead, Stage } from '../types/prospector'
import { STAGE_META } from '../types/prospector'
import { getLeads } from '../lib/prospector/capabilities'

const STAGE_ORDER: Stage[] = ['to_invite', 'invited', 'connected', 'in_sequence', 'responded', 'meeting', 'closed']

function scoreColor(score: number) {
  if (score >= 80) return '#059669'
  if (score >= 65) return '#f59e0b'
  return '#94a3b8'
}

function LeadCard({ lead }: { lead: Lead }) {
  const initials = `${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()
  return (
    <Link href={`/leads/${lead.id}`} className="block bg-white rounded-xl border border-gray-100 p-3 hover:shadow-sm hover:border-gray-200 transition-all">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</p>
          <p className="text-xs text-gray-400 truncate">{lead.title}</p>
        </div>
        <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style={{ backgroundColor: scoreColor(lead.score) }}>
          {lead.score}
        </span>
      </div>
      <div className="flex items-center justify-between mt-2.5">
        <span className="text-xs text-gray-500 truncate">{lead.company}</span>
        {lead.temperature === 'hot' && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-500 flex-shrink-0">Chaud</span>}
      </div>
    </Link>
  )
}

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'kanban' | 'table'>('kanban')

  useEffect(() => { getLeads().then((l) => { setLeads(l); setLoading(false) }) }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? leads.filter((l) =>
        `${l.firstName} ${l.lastName} ${l.company} ${l.title}`.toLowerCase().includes(q))
    : leads
  const byStage = (stage: Stage) => filtered.filter((l) => l.stage === stage)

  return (
    <>
      <Head><title>Prospector · Pipeline & Leads</title></Head>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline &amp; Leads</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {loading ? 'Chargement…' : `${leads.length} prospects dans votre base, répartis par étape.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2.5 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Enrichir tout
          </button>
          <Link
            href="/sourcing"
            className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            Sourcer des leads
          </Link>
        </div>
      </div>

      {/* Recherche + toggle vue */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher par nom, entreprise, titre…"
            className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl bg-white border border-gray-200 focus:outline-none focus:border-indigo-400 transition-all"
          />
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1">
          {(['kanban', 'table'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors capitalize ${view === v ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
            >
              {v === 'kanban' ? 'Kanban' : 'Table'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {view === 'table' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  {['Contact', 'Entreprise', 'Étape', 'Temp.', 'Score'].map((h) => (
                    <th key={h} className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...filtered].sort((a, b) => b.score - a.score).map((lead) => {
                  const sm = STAGE_META[lead.stage]
                  return (
                    <tr key={lead.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${lead.id}`} className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                            {`${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</span>
                            <span className="block text-xs text-gray-400 truncate">{lead.title}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{lead.company}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: sm.color }}>{sm.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        {lead.temperature === 'hot' ? '🔥' : lead.temperature === 'warm' ? '🟠' : '🔵'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="w-7 h-7 rounded-full inline-flex items-center justify-center text-white text-[11px] font-bold" style={{ backgroundColor: scoreColor(lead.score) }}>
                          {lead.score}
                        </span>
                      </td>
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
                  {items.length === 0 && (
                    <p className="text-xs text-gray-300 text-center py-6">Vide</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      )}
    </>
  )
}
