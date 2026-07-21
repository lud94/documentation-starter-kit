import { useState } from 'react'
import type { QualityPassResult, QualityProposal } from '../types/prospector'
import { batchQualityPass, updateActionMessage } from '../lib/prospector/capabilities'

const CRITERIA_CHIPS = [
  'Pose une vraie question ouverte',
  'Aucun pitch direct',
  'Moins de 60 mots',
  'Ton chaleureux, pas commercial',
]

export default function ReviewModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [criterion, setCriterion] = useState('')
  const [result, setResult] = useState<QualityPassResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const analyze = async (c: string) => {
    setAnalyzing(true)
    const r = await batchQualityPass(c)
    setResult(r)
    setSelected(new Set(r.proposals.map((p) => p.actionId)))
    setAnalyzing(false)
  }

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) { n.delete(id) } else { n.add(id) }
      return n
    })
  }

  const apply = async () => {
    if (!result) return
    const toApply = result.proposals.filter((p) => selected.has(p.actionId))
    await Promise.all(toApply.map((p) => updateActionMessage(p.actionId, p.after)))
    onApplied()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-3xl max-h-[88vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900 flex items-center gap-2"><span className="gradient-text">✦</span> Passe qualité — mode revue</h2>
            <p className="text-xs text-gray-400">Vérifie tous les messages en attente contre un critère. Rien n'est modifié sans ta validation.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div className="p-5 overflow-y-auto">
          {/* Critère */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {CRITERIA_CHIPS.map((c) => (
              <button key={c} onClick={() => { setCriterion(c); analyze(c) }} className="text-[11px] font-medium text-gray-500 bg-gray-50 border border-gray-200 px-2.5 py-1 rounded-full hover:border-indigo-300 hover:text-indigo-600 transition-colors">{c}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 mb-5">
            <input
              value={criterion}
              onChange={(e) => setCriterion(e.target.value)}
              placeholder="Critère à vérifier sur tous les messages…"
              className="flex-1 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-400 focus:bg-white"
            />
            <button onClick={() => analyze(criterion)} disabled={analyzing || !criterion.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
              {analyzing ? 'Analyse…' : 'Analyser'}
            </button>
          </div>

          {result && (
            <>
              <div className="flex items-center gap-3 text-sm mb-4">
                <span className="text-gray-600"><span className="font-bold text-gray-900">{result.evaluated}</span> messages évalués</span>
                <span className="text-emerald-600">{result.conforming} conformes</span>
                <span className="text-amber-600">{result.proposals.length} à corriger</span>
              </div>

              {result.proposals.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">Tous les messages respectent déjà ce critère 🎉</p>
              ) : (
                <div className="space-y-3">
                  {result.proposals.map((p: QualityProposal) => {
                    const on = selected.has(p.actionId)
                    return (
                      <div key={p.actionId} className={`border rounded-xl p-3 transition-colors ${on ? 'border-indigo-200 bg-indigo-50/30' : 'border-gray-100'}`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-gray-800">{p.leadName}</span>
                          <button onClick={() => toggle(p.actionId)} className={`text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${on ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                            {on ? '✓ Appliquer' : 'Garder l\'original'}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div className="bg-gray-50 rounded-lg px-3 py-2">
                            <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Avant</p>
                            <p className="text-xs text-gray-500 line-through leading-relaxed">{p.before}</p>
                          </div>
                          <div className="bg-emerald-50/60 rounded-lg px-3 py-2">
                            <p className="text-[10px] font-semibold text-emerald-500 uppercase mb-1">Après</p>
                            <p className="text-xs text-gray-700 leading-relaxed">{p.after}</p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {result && result.proposals.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-gray-400">{selected.size} correction(s) sélectionnée(s)</span>
            <button onClick={apply} disabled={selected.size === 0} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
              Appliquer la sélection
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
