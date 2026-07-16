import { useState } from 'react'
import type { SearchParams } from '../types/lead'

const INDUSTRIES = [
  'Real Estate', 'Technology', 'Healthcare', 'Finance', 'Retail',
  'Manufacturing', 'Education', 'Hospitality', 'Legal', 'Marketing',
  'Logistics', 'Construction', 'Media', 'Energy', 'Consulting',
]

const SENIORITY_LEVELS = [
  'founder', 'c_suite', 'vp', 'director', 'manager', 'senior', 'entry',
]

const EMPLOYEE_RANGES = [
  '1-10', '11-20', '21-50', '51-100', '101-250', '251-500', '501-1000', '1000+',
]

const REVENUE_OPTIONS = [
  '100K', '500K', '1M', '5M', '10M', '50M', '100M',
]

interface Props {
  onSearch: (params: SearchParams) => void
  loading: boolean
}

export default function SearchForm({ onSearch, loading }: Props) {
  const [params, setParams] = useState<SearchParams>({
    industry: '',
    location: '',
    jobTitle: '',
    employeeRange: '',
    revenue: '',
  })

  const set = (key: keyof SearchParams) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setParams(p => ({ ...p, [key]: e.target.value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch(params)
  }

  const inputClass = `
    w-full px-4 py-3 rounded-xl text-sm text-white placeholder-white/30
    bg-white/5 border border-white/10 transition-all duration-200
    focus:outline-none focus:border-[#667eea]/60 focus:bg-white/8
  `

  const labelClass = 'block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2'

  return (
    <form onSubmit={handleSubmit} className="glass rounded-2xl p-6 shadow-glass">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-2 h-2 rounded-full gradient-brand shadow-[0_0_12px_rgba(102,126,234,0.6)]" />
        <h2 className="text-sm font-bold text-white/90 tracking-wide">RECHERCHE DE LEADS</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>Secteur *</label>
          <select className={inputClass} value={params.industry} onChange={set('industry')} required>
            <option value="">Sélectionner un secteur</option>
            {INDUSTRIES.map(i => <option key={i} value={i.toLowerCase()}>{i}</option>)}
          </select>
        </div>

        <div>
          <label className={labelClass}>Localisation *</label>
          <input
            type="text"
            className={inputClass}
            placeholder="ex: France, Paris, USA..."
            value={params.location}
            onChange={set('location')}
            required
          />
        </div>

        <div>
          <label className={labelClass}>Niveau hiérarchique</label>
          <select className={inputClass} value={params.jobTitle} onChange={set('jobTitle')}>
            <option value="">Tous les niveaux</option>
            {SENIORITY_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <label className={labelClass}>Taille entreprise</label>
          <select className={inputClass} value={params.employeeRange} onChange={set('employeeRange')}>
            <option value="">Toutes tailles</option>
            {EMPLOYEE_RANGES.map(r => <option key={r} value={r}>{r} employés</option>)}
          </select>
        </div>

        <div>
          <label className={labelClass}>Revenue minimum</label>
          <select className={inputClass} value={params.revenue} onChange={set('revenue')}>
            <option value="">Aucun minimum</option>
            {REVENUE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className="flex items-end">
          <button
            type="submit"
            disabled={loading}
            className="
              w-full py-3 px-6 rounded-xl font-semibold text-sm text-white
              gradient-brand shadow-brand transition-all duration-200
              hover:opacity-90 hover:scale-[1.02] active:scale-[0.98]
              disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100
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
                Trouver des leads
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  )
}
