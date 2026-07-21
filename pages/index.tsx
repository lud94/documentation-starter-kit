import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { STAGE_META } from '../types/prospector'
import { getDashboard, type DashboardData, type Period, type DetailItem } from '../lib/prospector/capabilities'

const KIND_ICON: Record<DashboardData['activity'][number]['kind'], { bg: string; path: string }> = {
  reply: { bg: 'icon-bg-purple', path: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  accepted: { bg: 'icon-bg-green', path: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  invitation: { bg: 'icon-bg-blue', path: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z' },
  message: { bg: 'icon-bg-blue', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  meeting: { bg: 'icon-bg-pink', path: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
}

function Kpi({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick} className="card p-5 text-left transition-all enabled:hover:shadow-md enabled:hover:border-indigo-100 group">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold text-gray-400">{label}</p>
        {onClick && <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
      </div>
      <p className="text-2xl font-bold gradient-text">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </button>
  )
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'quarter', label: 'Trimestre' },
  { key: 'year', label: 'Année' },
]

const PERIOD_LABEL: Record<Period, string> = {
  week: 'cette semaine', month: 'ce mois', quarter: 'ce trimestre', year: 'cette année',
}

function exportCsv(data: DashboardData) {
  const rows: (string | number)[][] = [
    ['Rapport Prospector', PERIOD_LABEL[data.period]],
    [],
    ['Métrique', 'Valeur'],
    ['Invitations envoyées', data.kpis.invitationsSent],
    ["Taux d'acceptation (%)", data.kpis.acceptanceRate],
    ['Réponses reçues', data.kpis.replies],
    ['RDV planifiés', data.kpis.meetings],
    ['Coût IA ($)', data.kpis.iaCostWeek],
    [],
    ['Pipeline par étape', ''],
    ...data.funnel.map((f) => [f.stage, f.count] as (string | number)[]),
    [],
    ['Activité récente', ''],
    ...data.activity.map((a) => [a.text, a.when] as (string | number)[]),
  ]
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `prospector-rapport-${data.period}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const DRILL_LABEL: Record<string, string> = {
  invitations: 'Invitations envoyées',
  acceptance: 'Invitations acceptées',
  replies: 'Réponses reçues',
  meetings: 'RDV planifiés',
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [period, setPeriod] = useState<Period>('week')
  const [drill, setDrill] = useState<{ key: string; items: DetailItem[] } | null>(null)

  useEffect(() => { getDashboard(period).then(setData) }, [period])

  const funnelMax = data ? Math.max(...data.funnel.map((f) => f.count)) : 1

  return (
    <>
      <Head><title>Prospector · Tableau de bord</title></Head>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tableau de bord</h1>
          <p className="text-gray-400 text-sm mt-0.5">Vue d'ensemble de votre prospection et de vos campagnes.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => setPeriod(p.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${period === p.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <button onClick={() => data && exportCsv(data)} disabled={!data} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:opacity-50">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 4h16v16H4z" /></svg>
            Exporter
          </button>
        </div>
      </div>

      {/* Hero action — jamais contempler sans agir */}
      {data && data.pendingActions > 0 && (
        <Link href="/actions" className="block mb-6">
          <div className="rounded-2xl gradient-brand shadow-brand p-5 flex items-center justify-between text-white hover:opacity-95 transition-opacity">
            <div className="flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-white/20 flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <div>
                <p className="font-bold text-lg leading-tight">{data.pendingActions} actions vous attendent aujourd'hui</p>
                <p className="text-white/80 text-sm">Générées par l'IA, à valider avant envoi.</p>
              </div>
            </div>
            <span className="text-sm font-semibold bg-white/20 px-4 py-2 rounded-xl flex items-center gap-2">
              Traiter <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </span>
          </div>
        </Link>
      )}

      {/* KPIs résultat — cliquables */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Invitations" value={data ? String(data.kpis.invitationsSent) : '—'} sub="envoyées" onClick={data ? () => setDrill({ key: 'invitations', items: data.details.invitations }) : undefined} />
        <Kpi label="Taux d'acceptation" value={data ? `${data.kpis.acceptanceRate}%` : '—'} sub="des invitations" onClick={data ? () => setDrill({ key: 'acceptance', items: data.details.acceptance }) : undefined} />
        <Kpi label="Réponses" value={data ? String(data.kpis.replies) : '—'} sub="reçues" onClick={data ? () => setDrill({ key: 'replies', items: data.details.replies }) : undefined} />
        <Kpi label="RDV planifiés" value={data ? String(data.kpis.meetings) : '—'} sub="à convertir" onClick={data ? () => setDrill({ key: 'meetings', items: data.details.meetings }) : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Funnel */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">Pipeline par étape</h2>
            <Link href="/pipeline" className="text-xs text-indigo-500 hover:text-indigo-700">Voir le pipeline →</Link>
          </div>
          {!data ? (
            <p className="text-sm text-gray-400">Chargement…</p>
          ) : (
            <div className="space-y-2.5">
              {data.funnel.map((f) => {
                const meta = STAGE_META[f.stage]
                return (
                  <div key={f.stage} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-24 flex-shrink-0">{meta.label}</span>
                    <div className="flex-1 bg-gray-50 rounded-full h-5 relative overflow-hidden">
                      <div className="h-5 rounded-full flex items-center justify-end pr-2" style={{ width: `${Math.max(8, (f.count / funnelMax) * 100)}%`, backgroundColor: meta.color }}>
                        <span className="text-[11px] font-bold text-white">{f.count}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Activité récente */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Activité récente</h2>
          {!data ? (
            <p className="text-sm text-gray-400">Chargement…</p>
          ) : (
            <div className="space-y-3">
              {data.activity.map((e) => {
                const ic = KIND_ICON[e.kind]
                return (
                  <div key={e.id} className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg ${ic.bg} flex items-center justify-center flex-shrink-0`}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ic.path} /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700 leading-snug">
                        {e.text}
                        {e.hot && <span className="ml-1.5 text-xs">🟢</span>}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{e.when}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className="mt-4 pt-3 border-t border-gray-50 flex items-center justify-between text-xs">
            <span className="text-gray-400">Coût IA sur la période</span>
            <span className="font-semibold text-gray-600">{data ? `$${data.kpis.iaCostWeek.toFixed(2)}` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Drill-down KPI */}
      {drill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setDrill(null)} />
          <div className="relative card w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">{DRILL_LABEL[drill.key]}</h2>
              <button onClick={() => setDrill(null)} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <div className="p-3 overflow-y-auto">
              {drill.items.map((it) => (
                <Link key={`${drill.key}-${it.id}`} href={it.href} className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-gray-50 transition-colors">
                  <span className="w-8 h-8 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{it.name.split(' ').map((w) => w[0]).join('').toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-800 truncate">{it.name}</span>
                    <span className="block text-xs text-gray-400 truncate">{it.company}</span>
                  </span>
                  <span className="text-xs text-gray-400 flex-shrink-0">{it.meta}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
