import { useEffect, useState } from 'react'
import Head from 'next/head'
import { STAGE_META } from '../../types/prospector'
import { getDashboard, type DashboardData } from '../../lib/prospector/capabilities'

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-semibold text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-bold gradient-text">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function ClientPerformance() {
  const [data, setData] = useState<DashboardData | null>(null)
  useEffect(() => { getDashboard().then(setData) }, [])
  const funnelMax = data ? Math.max(...data.funnel.map((f) => f.count)) : 1

  return (
    <>
      <Head><title>Espace client · Ma performance</title></Head>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Ma performance</h1>
        <p className="text-gray-400 text-sm mt-0.5">Le point sur votre prospection, en toute transparence.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Invitations (semaine)" value={data ? String(data.kpis.invitationsSent) : '—'} />
        <Kpi label="Taux d'acceptation" value={data ? `${data.kpis.acceptanceRate}%` : '—'} sub="des invitations" />
        <Kpi label="Réponses" value={data ? String(data.kpis.replies) : '—'} sub="cette semaine" />
        <Kpi label="RDV obtenus" value={data ? String(data.kpis.meetings) : '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Votre pipeline par étape</h2>
          {!data ? <p className="text-sm text-gray-400">Chargement…</p> : (
            <div className="space-y-2.5">
              {data.funnel.map((f) => {
                const meta = STAGE_META[f.stage]
                return (
                  <div key={f.stage} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-24 flex-shrink-0">{meta.label}</span>
                    <div className="flex-1 bg-gray-50 rounded-full h-5 overflow-hidden">
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

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Activité récente</h2>
          {!data ? <p className="text-sm text-gray-400">Chargement…</p> : (
            <div className="space-y-3">
              {data.activity.map((e) => (
                <div key={e.id} className="flex items-start gap-3">
                  <span className="w-2 h-2 rounded-full gradient-brand mt-1.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 leading-snug">{e.text}{e.hot && <span className="ml-1.5 text-xs">🟢</span>}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{e.when}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
