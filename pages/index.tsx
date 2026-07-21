import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { STAGE_META } from '../types/prospector'
import { getDashboard, type DashboardData } from '../lib/prospector/capabilities'

const KIND_ICON: Record<DashboardData['activity'][number]['kind'], { bg: string; path: string }> = {
  reply: { bg: 'icon-bg-purple', path: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  accepted: { bg: 'icon-bg-green', path: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  invitation: { bg: 'icon-bg-blue', path: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z' },
  message: { bg: 'icon-bg-blue', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  meeting: { bg: 'icon-bg-pink', path: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-semibold text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-bold gradient-text">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => { getDashboard().then(setData) }, [])

  const funnelMax = data ? Math.max(...data.funnel.map((f) => f.count)) : 1

  return (
    <>
      <Head><title>Prospector · Tableau de bord</title></Head>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Tableau de bord</h1>
        <p className="text-gray-400 text-sm mt-0.5">Vue d'ensemble de votre prospection et de vos campagnes.</p>
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
                <p className="text-white/80 text-sm">Générées par l'IA — à valider avant envoi.</p>
              </div>
            </div>
            <span className="text-sm font-semibold bg-white/20 px-4 py-2 rounded-xl flex items-center gap-2">
              Traiter <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </span>
          </div>
        </Link>
      )}

      {/* KPIs résultat */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Invitations (semaine)" value={data ? String(data.kpis.invitationsSent) : '—'} />
        <Kpi label="Taux d'acceptation" value={data ? `${data.kpis.acceptanceRate}%` : '—'} sub="des invitations" />
        <Kpi label="Réponses" value={data ? String(data.kpis.replies) : '—'} sub="cette semaine" />
        <Kpi label="RDV planifiés" value={data ? String(data.kpis.meetings) : '—'} sub="à convertir" />
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
            <span className="text-gray-400">Coût IA cette semaine</span>
            <span className="font-semibold text-gray-600">{data ? `$${data.kpis.iaCostWeek.toFixed(2)}` : '—'}</span>
          </div>
        </div>
      </div>
    </>
  )
}
