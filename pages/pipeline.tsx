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
  const [sourcingOpen, setSourcingOpen] = useState(false)
  const [query, setQuery] = useState('')

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
          <button
            onClick={() => setSourcingOpen(true)}
            className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            Sourcer des leads
          </button>
        </div>
      </div>

      {/* Recherche */}
      <div className="relative mb-4 max-w-md">
        <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher par nom, entreprise, titre…"
          className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl bg-white border border-gray-200 focus:outline-none focus:border-indigo-400 transition-all"
        />
      </div>

      {/* Kanban */}
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

      {/* Modal sourcing (placeholder — flux à concevoir) */}
      {sourcingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/30 backdrop-blur-sm" onClick={() => setSourcingOpen(false)} />
          <div className="relative card p-6 max-w-md w-full">
            <div className="w-12 h-12 rounded-2xl icon-bg-blue flex items-center justify-center mb-4">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">Sourcing de leads</h2>
            <p className="text-sm text-gray-500 mb-4">
              Le flux de sourcing (DataGoov + gate de signaux sur ton ICP tech/startup &lt; 250 salariés) est la prochaine brique qu'on conçoit ensemble. Ce n'est plus une recherche par mots-clés : c'est une extraction filtrée par signaux d'achat.
            </p>
            <div className="bg-gray-50 rounded-xl p-3 mb-4 text-xs text-gray-500 space-y-1">
              <p><span className="font-semibold text-gray-700">Cible :</span> tech / startups, &lt; 250 salariés</p>
              <p><span className="font-semibold text-gray-700">Persona :</span> sales / marketing / founders</p>
              <p><span className="font-semibold text-gray-700">Gate :</span> filtre signal avant enrichissement (économie tokens)</p>
            </div>
            <button
              onClick={() => setSourcingOpen(false)}
              className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity"
            >
              Compris
            </button>
          </div>
        </div>
      )}
    </>
  )
}
