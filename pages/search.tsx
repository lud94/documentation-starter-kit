import { useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { useLeadStore } from '../store/leads'
import type { SearchParams } from '../types/lead'

const INDUSTRIES = [
  'Real Estate', 'Technology', 'Healthcare', 'Finance', 'Retail',
  'Manufacturing', 'Education', 'Hospitality', 'Legal', 'Marketing',
  'Logistics', 'Construction', 'Media', 'Energy', 'Consulting',
]
const SENIORITY = ['founder', 'c_suite', 'vp', 'director', 'manager', 'senior', 'entry']
const EMP_RANGES = ['1-10', '11-20', '21-50', '51-100', '101-250', '251-500', '501-1000', '1000+']
const REVENUES = ['100K', '500K', '1M', '5M', '10M', '50M', '100M']

const inputClass = `
  w-full px-4 py-2.5 rounded-xl text-sm text-gray-800 bg-gray-50
  border border-gray-200 transition-all duration-150
  focus:outline-none focus:border-indigo-400 focus:bg-white
  placeholder-gray-400
`
const labelClass = 'block text-xs font-semibold text-gray-500 mb-1.5'

export default function SearchPage() {
  const router = useRouter()
  const { setLeads } = useLeadStore()

  const [params, setParams] = useState<SearchParams>({
    industry: '',
    location: '',
    jobTitle: '',
    employeeRange: '',
    revenue: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (key: keyof SearchParams) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setParams(p => ({ ...p, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

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
      const leads = Array.isArray(data)
        ? data.map((item: any) => ({
            person: item.person ?? item,
            company: item.company ?? {},
          })).filter((l: any) => l.person?.email)
        : []

      setLeads(leads)
      router.push('/prospects')
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <>
      <Head><title>LeadFlow · Nouvelle recherche</title></Head>

      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Nouvelle recherche</h1>
          <p className="text-gray-400 text-sm">Définissez vos critères pour trouver jusqu'à 100 prospects qualifiés.</p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className={labelClass}>Secteur d'activité *</label>
              <select className={inputClass} value={params.industry} onChange={set('industry')} required>
                <option value="">Sélectionner...</option>
                {INDUSTRIES.map(i => <option key={i} value={i.toLowerCase()}>{i}</option>)}
              </select>
            </div>

            <div>
              <label className={labelClass}>Localisation *</label>
              <input
                type="text"
                className={inputClass}
                placeholder="ex: France, Paris, Europe..."
                value={params.location}
                onChange={set('location')}
                required
              />
            </div>

            <div>
              <label className={labelClass}>Niveau hiérarchique</label>
              <select className={inputClass} value={params.jobTitle} onChange={set('jobTitle')}>
                <option value="">Tous les niveaux</option>
                {SENIORITY.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div>
              <label className={labelClass}>Taille de l'entreprise</label>
              <select className={inputClass} value={params.employeeRange} onChange={set('employeeRange')}>
                <option value="">Toutes tailles</option>
                {EMP_RANGES.map(r => <option key={r} value={r}>{r} employés</option>)}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className={labelClass}>Revenue annuel minimum</label>
              <select className={inputClass} value={params.revenue} onChange={set('revenue')}>
                <option value="">Aucun minimum</option>
                {REVENUES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="
              w-full py-3 rounded-xl text-white font-semibold text-sm
              gradient-brand shadow-sm transition-all duration-150
              hover:opacity-90 hover:shadow-md active:scale-[0.99]
              disabled:opacity-50 disabled:cursor-not-allowed
              flex items-center justify-center gap-2
            "
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Recherche en cours...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Lancer la recherche
              </>
            )}
          </button>
        </form>

        {/* Info box */}
        <div className="mt-4 p-4 rounded-xl bg-indigo-50 border border-indigo-100 flex gap-3">
          <svg className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-indigo-600">
            Les prospects trouvés seront affichés avec leurs informations complètes. Vous pourrez ensuite envoyer des emails IA ultra-personnalisés en un clic.
          </p>
        </div>
      </div>
    </>
  )
}
