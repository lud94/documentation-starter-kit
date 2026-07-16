import Head from 'next/head'
import Link from 'next/link'
import { useLeadStore } from '../store/leads'

const STAT_CARDS = [
  {
    key: 'total',
    label: 'Total prospects',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    bg: 'icon-bg-blue',
  },
  {
    key: 'sent',
    label: 'Emails envoyés',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    bg: 'icon-bg-green',
  },
  {
    key: 'pending',
    label: 'En attente',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    bg: 'icon-bg-orange',
  },
  {
    key: 'rate',
    label: "Taux d'envoi",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
    ),
    bg: 'icon-bg-purple',
  },
]

export default function Dashboard() {
  const { leads, sentEmails } = useLeadStore()

  const total = leads.length
  const sent = sentEmails.size
  const pending = total - sent
  const rate = total > 0 ? Math.round((sent / total) * 100) : 0

  const statValues: Record<string, string> = {
    total: total.toString(),
    sent: sent.toString(),
    pending: pending > 0 ? pending.toString() : '0',
    rate: `${rate}%`,
  }

  // Group by industry
  const bySector = leads.reduce<Record<string, number>>((acc, lead) => {
    const sector = lead.company?.industry ?? 'Autre'
    acc[sector] = (acc[sector] ?? 0) + 1
    return acc
  }, {})

  const recentActivity = leads
    .filter(l => sentEmails.has(l.person.email))
    .slice(-5)
    .reverse()

  return (
    <>
      <Head>
        <title>LeadFlow · Tableau de bord</title>
      </Head>

      {/* Page header */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 mb-1">Tableau de bord</h1>
        <p className="text-gray-400 text-sm">Vue d'ensemble de votre prospection et de vos campagnes d'emailing.</p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Link href="/search" className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow group cursor-pointer">
          <div className="w-10 h-10 rounded-xl icon-bg-blue flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-800 group-hover:text-indigo-600 transition-colors">Nouvelle recherche</p>
            <p className="text-xs text-gray-400 mt-0.5">Trouver de nouveaux prospects</p>
          </div>
        </Link>

        <Link href="/prospects" className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow group cursor-pointer">
          <div className="w-10 h-10 rounded-xl icon-bg-purple flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-800 group-hover:text-indigo-600 transition-colors">Voir les prospects</p>
            <p className="text-xs text-gray-400 mt-0.5">{total} prospect{total !== 1 ? 's' : ''} disponible{total !== 1 ? 's' : ''}</p>
          </div>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {STAT_CARDS.map(s => (
          <div key={s.key} className="card p-5">
            <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center mb-3`}>
              {s.icon}
            </div>
            <p className="text-2xl font-bold text-gray-900">{statValues[s.key]}</p>
            <p className="text-xs text-gray-400 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Bottom sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By sector */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-700">Par secteur d'activité</h2>
          </div>

          {Object.keys(bySector).length === 0 ? (
            <div className="text-center py-8">
              <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-xs text-gray-400">Aucun prospect pour le moment</p>
              <Link href="/search" className="text-xs text-indigo-500 hover:text-indigo-700 mt-1 inline-block">
                Lancer une recherche
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([sector, count]) => (
                <div key={sector} className="flex items-center gap-3">
                  <div className="flex-1 text-xs text-gray-600 truncate">{sector}</div>
                  <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                    <div
                      className="gradient-brand h-1.5 rounded-full"
                      style={{ width: `${(count / total) * 100}%` }}
                    />
                  </div>
                  <div className="text-xs font-medium text-gray-500 w-6 text-right">{count}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent activity */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-700">Activité récente</h2>
          </div>

          {recentActivity.length === 0 ? (
            <div className="text-center py-8">
              <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-xs text-gray-400">Aucune activité récente</p>
              <Link href="/prospects" className="text-xs text-indigo-500 hover:text-indigo-700 mt-1 inline-block">
                Trouver des prospects
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentActivity.map(lead => (
                <div key={lead.person.email} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {lead.person.first_name?.[0]}{lead.person.last_name?.[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-700 truncate">{lead.person.full_name}</p>
                    <p className="text-xs text-gray-400 truncate">{lead.company.name}</p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-medium flex-shrink-0">Envoyé</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
