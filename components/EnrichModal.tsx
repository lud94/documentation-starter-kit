import { useEffect, useState } from 'react'
import type { Lead } from '../types/prospector'

const CAP = 20

export default function EnrichModal({ leads, onClose, onConfirm }: {
  leads: Lead[]
  onClose: () => void
  onConfirm: (ids: string[], mode: 'email' | 'full') => void
}) {
  const [mode, setMode] = useState<'email' | 'full'>('full')

  const needs = (l: Lead) => mode === 'email' ? !l.email : (!l.email || !l.phone)
  const pool = leads.filter(needs).sort((a, b) => b.score - a.score)
  const candidates = pool.slice(0, CAP)
  const overflow = pool.length - candidates.length

  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => { setSelected(new Set(candidates.map((c) => c.id))) /* eslint-disable-next-line */ }, [mode, leads.length])

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900">Enrichir un lot</h2>
            <p className="text-xs text-gray-400">Kaspr · les 20 meilleurs scores à enrichir. Décochez ceux à exclure.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div className="px-5 pt-4">
          <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-3">
            <button onClick={() => setMode('email')} className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${mode === 'email' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Emails</button>
            <button onClick={() => setMode('full')} className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${mode === 'full' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Emails + téléphones</button>
          </div>
        </div>

        <div className="px-3 pb-2 overflow-y-auto flex-1">
          {candidates.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">Aucun lead à enrichir dans la sélection 🎉</p>
          ) : candidates.map((l) => {
            const on = selected.has(l.id)
            return (
              <button key={l.id} onClick={() => toggle(l.id)} className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-gray-50 text-left transition-colors">
                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'gradient-brand border-transparent' : 'border-gray-300'}`}>
                  {on && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </span>
                <span className="w-7 h-7 rounded-full text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0" style={{ backgroundColor: l.score >= 80 ? '#059669' : l.score >= 65 ? '#f59e0b' : '#94a3b8' }}>{l.score}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-800 truncate">{l.firstName} {l.lastName}</span>
                  <span className="block text-xs text-gray-400 truncate">{l.company}</span>
                </span>
                <span className="text-[10px] text-gray-400 flex-shrink-0">{!l.email ? 'email' : ''}{!l.email && !l.phone ? ' + ' : ''}{!l.phone ? 'tél' : ''} manquant</span>
              </button>
            )
          })}
          {overflow > 0 && <p className="text-xs text-gray-400 text-center py-2">+ {overflow} autres à enrichir au prochain lot</p>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-500">≈ <span className="font-semibold text-gray-700">{selected.size} crédits Kaspr</span></span>
          <button onClick={() => onConfirm(Array.from(selected), mode)} disabled={selected.size === 0} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
            Enrichir {selected.size} lead{selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
