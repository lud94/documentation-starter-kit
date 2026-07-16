import { useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useLeadStore } from '../store/leads'
import type { Lead } from '../types/lead'

type EmailStatus = 'idle' | 'sending' | 'sent' | 'error'

function LeadRow({ lead, isSent, onSent }: { lead: Lead; isSent: boolean; onSent: () => void }) {
  const [status, setStatus] = useState<EmailStatus>(isSent ? 'sent' : 'idle')
  const { person, company } = lead

  const sendEmail = async () => {
    setStatus('sending')
    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person, company }),
      })
      if (!res.ok) throw new Error()
      setStatus('sent')
      onSent()
    } catch {
      setStatus('error')
    }
  }

  const initials = `${person.first_name?.[0] ?? ''}${person.last_name?.[0] ?? ''}`.toUpperCase()

  return (
    <tr className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials || '?'}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800">{person.full_name}</p>
            <p className="text-xs text-gray-400">{person.job_title}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <p className="text-sm text-gray-700 font-medium">{company.name}</p>
        {company.industry && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">{company.industry}</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 hidden md:table-cell">
        {person.location?.city ? `${person.location.city}, ${person.location.country}` : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 hidden lg:table-cell">
        {company.size ? `${company.size} emp.` : '—'}
      </td>
      <td className="px-4 py-3">
        <a href={`mailto:${person.email}`} className="text-xs text-indigo-500 hover:underline">{person.email}</a>
      </td>
      <td className="px-4 py-3 text-right">
        {status === 'sent' ? (
          <span className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-600 font-medium">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Envoyé
          </span>
        ) : status === 'error' ? (
          <button onClick={sendEmail} className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors font-medium">
            Réessayer
          </button>
        ) : (
          <button
            onClick={sendEmail}
            disabled={status === 'sending'}
            className="
              text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-150
              gradient-brand text-white shadow-sm hover:opacity-90 hover:shadow
              disabled:opacity-50 disabled:cursor-not-allowed
              flex items-center gap-1.5 ml-auto
            "
          >
            {status === 'sending' ? (
              <>
                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                IA...
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Envoyer
              </>
            )}
          </button>
        )}
      </td>
    </tr>
  )
}

export default function ProspectsPage() {
  const { leads, sentEmails, markSent } = useLeadStore()
  const [search, setSearch] = useState('')

  const filtered = leads.filter(l =>
    !search ||
    l.person.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    l.company.name?.toLowerCase().includes(search.toLowerCase()) ||
    l.company.industry?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <Head><title>LeadFlow · Prospects</title></Head>

      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-0.5">Prospects</h1>
          <p className="text-gray-400 text-sm">{leads.length} prospect{leads.length !== 1 ? 's' : ''} dans votre base</p>
        </div>
        <Link
          href="/search"
          className="gradient-brand text-white text-sm font-medium px-4 py-2 rounded-xl shadow-sm hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Nouvelle recherche
        </Link>
      </div>

      {leads.length === 0 ? (
        <div className="card p-16 text-center">
          <div className="w-16 h-16 rounded-2xl icon-bg-blue flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-700 mb-2">Aucun prospect encore</h2>
          <p className="text-gray-400 text-sm mb-5">Lancez une recherche pour trouver vos premiers leads qualifiés.</p>
          <Link href="/search" className="gradient-brand text-white text-sm font-medium px-5 py-2.5 rounded-xl inline-block shadow-sm hover:opacity-90 transition-opacity">
            Lancer une recherche
          </Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          {/* Search bar */}
          <div className="p-4 border-b border-gray-100">
            <div className="relative max-w-xs">
              <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Filtrer les prospects..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm rounded-lg bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white transition-all"
              />
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Contact</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Entreprise</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider hidden md:table-cell">Localisation</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider hidden lg:table-cell">Taille</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Email</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead, i) => (
                  <LeadRow
                    key={`${lead.person.email}-${i}`}
                    lead={lead}
                    isSent={sentEmails.has(lead.person.email)}
                    onSent={() => markSent(lead.person.email)}
                  />
                ))}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <div className="text-center py-10 text-gray-400 text-sm">Aucun résultat pour "{search}"</div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
            <span>{filtered.length} prospect{filtered.length !== 1 ? 's' : ''} affiché{filtered.length !== 1 ? 's' : ''}</span>
            <span>{sentEmails.size} email{sentEmails.size !== 1 ? 's' : ''} envoyé{sentEmails.size !== 1 ? 's' : ''}</span>
          </div>
        </div>
      )}
    </>
  )
}
