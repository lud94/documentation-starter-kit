import { useState } from 'react'
import type { Lead, EmailStatus } from '../types/lead'

interface Props {
  lead: Lead
}

export default function LeadCard({ lead }: Props) {
  const [status, setStatus] = useState<EmailStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const { person, company } = lead

  const sendEmail = async () => {
    setStatus('sending')
    setErrorMsg('')
    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person, company }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Erreur lors de l\'envoi')
      }
      setStatus('sent')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  }

  const initials = `${person.first_name?.[0] ?? ''}${person.last_name?.[0] ?? ''}`.toUpperCase()

  const techCount = company.technologies?.length ?? 0
  const displayTechs = company.technologies?.slice(0, 3) ?? []

  return (
    <div className="glass rounded-2xl p-5 shadow-glass flex flex-col gap-4 hover:border-white/20 transition-all duration-200 group">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="
          w-11 h-11 rounded-xl gradient-brand shadow-brand
          flex items-center justify-center text-white font-bold text-sm flex-shrink-0
        ">
          {initials || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-sm leading-tight truncate">{person.full_name}</p>
          <p className="text-xs text-white/50 mt-0.5 truncate">{person.job_title}</p>
          {person.location?.city && (
            <p className="text-xs text-white/30 mt-0.5">
              📍 {person.location.city}, {person.location.country}
            </p>
          )}
        </div>
      </div>

      {/* Company */}
      <div className="bg-white/5 rounded-xl p-3 border border-white/5">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className="font-semibold text-white/90 text-sm truncate">{company.name}</p>
          {company.size && (
            <span className="text-xs text-white/40 flex-shrink-0">{company.size} emp.</span>
          )}
        </div>
        {company.industry && (
          <span className="inline-block text-xs px-2 py-0.5 rounded-md bg-[#667eea]/20 text-[#a78bfa] font-medium">
            {company.industry}
          </span>
        )}
        {company.financials?.annual_revenue_clean && (
          <p className="text-xs text-white/40 mt-1.5">
            Revenue: <span className="text-white/60">{company.financials.annual_revenue_clean}</span>
          </p>
        )}
      </div>

      {/* Contact info */}
      <div className="flex flex-col gap-1.5">
        <a
          href={`mailto:${person.email}`}
          className="flex items-center gap-2 text-xs text-white/50 hover:text-white/80 transition-colors group/link"
        >
          <svg className="w-3.5 h-3.5 text-[#667eea]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="truncate">{person.email}</span>
        </a>
        {person.linkedin && (
          <a
            href={person.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-white/50 hover:text-white/80 transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-[#667eea]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
            </svg>
            LinkedIn
          </a>
        )}
      </div>

      {/* Technologies */}
      {displayTechs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {displayTechs.map(tech => (
            <span key={tech} className="text-xs px-2 py-0.5 rounded-md bg-white/5 text-white/40 border border-white/8">
              {tech}
            </span>
          ))}
          {techCount > 3 && (
            <span className="text-xs px-2 py-0.5 rounded-md bg-white/5 text-white/30">
              +{techCount - 3}
            </span>
          )}
        </div>
      )}

      {/* CTA */}
      <div className="mt-auto pt-1">
        {status === 'sent' ? (
          <div className="flex items-center gap-2 justify-center py-2.5 px-4 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Email envoyé !
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 py-2 px-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-xs">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {errorMsg || 'Erreur lors de l\'envoi'}
            </div>
            <button
              onClick={() => setStatus('idle')}
              className="text-xs text-white/40 hover:text-white/70 text-center transition-colors"
            >
              Réessayer
            </button>
          </div>
        ) : (
          <button
            onClick={sendEmail}
            disabled={status === 'sending'}
            className="
              w-full py-2.5 px-4 rounded-xl text-xs font-semibold text-white
              gradient-brand shadow-brand transition-all duration-200
              hover:opacity-90 hover:scale-[1.02] active:scale-[0.98]
              disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100
              flex items-center justify-center gap-2
            "
          >
            {status === 'sending' ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Génération IA...
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Envoyer l'email IA
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
