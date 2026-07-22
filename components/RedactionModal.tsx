import { useEffect, useState } from 'react'
import type { LeadDetail } from '../types/prospector'
import { generateMessage, detectDealKillers } from '../lib/prospector/capabilities'

type Variant = 'principal' | 'directe' | 'douce'

const VARIANTS: { key: Variant; label: string }[] = [
  { key: 'principal', label: 'Principal' },
  { key: 'directe', label: 'Directe' },
  { key: 'douce', label: 'Douce' },
]

export default function RedactionModal({ detail, onClose }: { detail: LeadDetail; onClose: () => void }) {
  const [variant, setVariant] = useState<Variant>('principal')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const { lead, dossier } = detail

  useEffect(() => {
    setLoading(true)
    generateMessage(lead.id, variant).then((m) => { setMessage(m); setLoading(false) })
  }, [lead.id, variant])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-4xl max-h-[88vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900">Rédaction — {lead.firstName} {lead.lastName}</h2>
            <p className="text-xs text-gray-400">{dossier.canalRecommande} · message pré-chargé depuis le Dossier d'attaque</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 overflow-y-auto">
          {/* Contexte Dossier */}
          <div className="md:col-span-1 p-5 border-r border-gray-100 bg-gray-50/50">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Accroche pivot</p>
            <p className="text-sm text-gray-700 italic mb-4">« {dossier.accrochePivot} »</p>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Question à poser</p>
            <p className="text-sm text-gray-700 italic mb-4">« {dossier.questionAPoser} »</p>
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">À éviter</p>
            <ul className="space-y-1">
              {dossier.aEviter.slice(0, 3).map((x, i) => (
                <li key={i} className="text-xs text-gray-500 flex gap-1.5"><span className="text-red-400">✕</span>{x}</li>
              ))}
            </ul>
          </div>

          {/* Éditeur */}
          <div className="md:col-span-2 p-5">
            {/* Variantes */}
            <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-3">
              {VARIANTS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => setVariant(v.key)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${variant === v.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
                >
                  {v.label}
                </button>
              ))}
            </div>

            <textarea
              value={loading ? 'Génération…' : message}
              onChange={(e) => setMessage(e.target.value)}
              rows={7}
              className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none leading-relaxed"
            />

            {/* Alerte deal-killers (Référentiel Smart.AI) */}
            {(() => {
              const flagged = detectDealKillers(message)
              return flagged.length > 0 ? (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 flex items-start gap-2">
                  <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  <p className="text-xs text-red-700 leading-relaxed">
                    <span className="font-semibold">Deal-killers détectés :</span> {flagged.map((f) => `« ${f} »`).join(', ')} — interdits par le Référentiel Smart.AI. À retirer avant envoi.
                  </p>
                </div>
              ) : null
            })()}

            {/* Coach */}
            <div className="mt-3 bg-indigo-50/60 border border-indigo-100 rounded-xl px-3 py-2.5 flex items-start gap-2">
              <span className="gradient-text font-semibold text-sm">✦</span>
              <p className="text-xs text-indigo-700 leading-relaxed">
                <span className="font-semibold">Coach :</span> l'accroche respecte le Dossier. Vérifie que tu ne promets pas de ROI chiffré et que le ton reste une ouverture, pas un pitch.
              </p>
            </div>

            <div className="flex items-center justify-between mt-4">
              <button
                onClick={() => generateMessage(lead.id, variant).then(setMessage)}
                className="text-xs font-medium text-gray-500 bg-gray-50 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Régénérer
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => navigator.clipboard?.writeText(message)} className="text-xs font-medium text-gray-600 bg-gray-50 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors">Copier</button>
                <button className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity">Envoyer</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
