import { useState } from 'react'
import Head from 'next/head'
import SearchForm from '../components/SearchForm'
import LeadCard from '../components/LeadCard'
import StatsBar from '../components/StatsBar'
import type { Lead, SearchParams } from '../types/lead'

export default function Home() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [sentCount, setSentCount] = useState(0)

  const handleSearch = async (params: SearchParams) => {
    setLoading(true)
    setError('')
    setLeads([])
    setSearched(true)
    setSentCount(0)

    try {
      const res = await fetch('/api/search-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Erreur lors de la recherche')
      }

      const data = await res.json()
      // n8n retourne un tableau d'items, chacun avec person + company
      const parsed: Lead[] = Array.isArray(data)
        ? data.map((item: any) => ({
            person: item.person ?? item,
            company: item.company ?? {},
          })).filter((l: Lead) => l.person?.email)
        : []

      setLeads(parsed)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Head>
        <title>NAIOM · Lead Generation</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>" />
      </Head>

      <div className="min-h-screen p-6 md:p-10">
        <div className="max-w-7xl mx-auto">

          {/* Navbar */}
          <header className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg gradient-brand shadow-brand flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <span className="text-white font-bold text-lg tracking-tight">NAIOM</span>
                <span className="text-white/30 text-sm ml-2">· AI & Automation</span>
              </div>
            </div>
            <div className="glass rounded-xl px-4 py-2 text-xs text-white/40 font-medium">
              LEAD 2.0
            </div>
          </header>

          {/* Hero */}
          <div className="mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-white leading-tight mb-2">
              Génération de leads{' '}
              <span className="gradient-text">B2B intelligente</span>
            </h1>
            <p className="text-white/40 text-base">
              Trouvez vos prospects, générez des emails IA ultra-personnalisés, envoyez en un clic.
            </p>
          </div>

          {/* Search */}
          <div className="mb-8">
            <SearchForm onSearch={handleSearch} loading={loading} />
          </div>

          {/* Stats */}
          {searched && (
            <div className="mb-8">
              <StatsBar total={leads.length} sent={sentCount} loading={loading} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-6 glass rounded-2xl p-4 border border-red-500/30 bg-red-500/10 text-red-400 text-sm flex items-center gap-3">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="glass rounded-2xl p-5 shadow-glass animate-pulse">
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-11 h-11 rounded-xl bg-white/10" />
                    <div className="flex-1">
                      <div className="h-3.5 bg-white/10 rounded w-3/4 mb-2" />
                      <div className="h-2.5 bg-white/5 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="h-16 bg-white/5 rounded-xl mb-4" />
                  <div className="h-2.5 bg-white/5 rounded w-full mb-2" />
                  <div className="h-2.5 bg-white/5 rounded w-2/3 mb-4" />
                  <div className="h-9 bg-white/10 rounded-xl" />
                </div>
              ))}
            </div>
          )}

          {/* Results */}
          {!loading && leads.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-4">
                <p className="text-white/50 text-sm">
                  <span className="text-white font-semibold">{leads.length}</span> leads trouvés
                </p>
                <button
                  onClick={() => {
                    const remaining = leads.filter((_, i) => {
                      const card = document.querySelector(`[data-lead-index="${i}"]`)
                      return !card?.classList.contains('sent')
                    })
                    // bulk send could be added here
                  }}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors"
                >
                  Envoyer tous les emails →
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {leads.map((lead, i) => (
                  <LeadCard key={`${lead.person.email}-${i}`} lead={lead} />
                ))}
              </div>
            </>
          )}

          {/* Empty state */}
          {!loading && searched && leads.length === 0 && !error && (
            <div className="glass rounded-2xl p-12 shadow-glass text-center">
              <div className="w-16 h-16 rounded-2xl gradient-brand shadow-brand flex items-center justify-center mx-auto mb-4 opacity-60">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-white/50 text-sm">Aucun lead trouvé pour ces critères.</p>
              <p className="text-white/30 text-xs mt-1">Essayez d'élargir votre recherche.</p>
            </div>
          )}

          {/* Initial state */}
          {!searched && (
            <div className="glass rounded-2xl p-16 shadow-glass text-center">
              <div className="w-20 h-20 rounded-2xl gradient-brand shadow-brand flex items-center justify-center mx-auto mb-6">
                <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Lancez votre première recherche</h2>
              <p className="text-white/40 text-sm max-w-md mx-auto">
                Sélectionnez un secteur et une localisation pour trouver jusqu'à 100 leads qualifiés.
                L'IA génère ensuite un email ultra-personnalisé pour chaque prospect.
              </p>
              <div className="flex items-center justify-center gap-6 mt-8 text-xs text-white/25">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full gradient-brand inline-block" />
                  Données validées
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full gradient-brand inline-block" />
                  Emails IA personnalisés
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full gradient-brand inline-block" />
                  Envoi en 1 clic
                </span>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
