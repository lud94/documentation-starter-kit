import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { Sequence, ActionType } from '../types/prospector'
import { CONDITION_LABEL, ACTION_META } from '../types/prospector'
import { getSequences } from '../lib/prospector/capabilities'

const STEP_STYLE: Record<ActionType, { bg: string; color: string; path: string }> = {
  visit: { bg: '#e0f2fe', color: '#0284c7', path: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z' },
  invitation: { bg: '#eef2ff', color: '#4f46e5', path: 'M18 9v6m3-3h-6M13 7a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3z' },
  message: { bg: '#f5f3ff', color: '#7c3aed', path: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  relance: { bg: '#fffbeb', color: '#d97706', path: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
  inmail: { bg: '#fdf4ff', color: '#c026d3', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  email: { bg: '#ecfdf5', color: '#059669', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    getSequences().then((s) => { setSequences(s); setSelected((cur) => cur ?? s[0]?.id ?? null) })
  }, [])

  const active = sequences.find((s) => s.id === selected)

  return (
    <>
      <Head><title>Prospector · Séquences</title></Head>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Séquences</h1>
          <p className="text-gray-400 text-sm mt-0.5">Enchaînements automatisés d'actions, exécutés dans le respect des quotas.</p>
        </div>
        <button className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          Nouvelle séquence
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Liste séquences */}
        <div className="space-y-3">
          {sequences.map((s) => {
            const on = s.id === selected
            return (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                className={`card p-4 w-full text-left transition-all ${on ? 'ring-2 ring-indigo-400' : 'hover:shadow-md'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-800 truncate">{s.name}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${s.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                    {s.status === 'active' ? 'Active' : 'En pause'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span>{s.enrolled} leads</span>
                  <span>{s.steps.length} étapes</span>
                  <span className="ml-auto font-semibold text-gray-500">{s.responseRate}% réponses</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Détail séquence */}
        <div className="lg:col-span-2">
          {active ? (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">{active.name}</h2>
                  <p className="text-xs text-gray-400 mt-0.5">{active.enrolled} leads en cours · {active.responseRate}% de réponses</p>
                </div>
                <div className="flex items-center gap-2">
                  <button className="text-xs font-medium text-gray-600 bg-gray-50 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                    {active.status === 'active' ? 'Mettre en pause' : 'Activer'}
                  </button>
                </div>
              </div>

              {/* Timeline étapes */}
              <div className="space-y-0">
                {active.steps.map((step, i) => {
                  const meta = ACTION_META[step.type]
                  const st = STEP_STYLE[step.type]
                  const last = i === active.steps.length - 1
                  return (
                    <div key={step.id} className="flex gap-3">
                      <div className="flex flex-col items-center flex-shrink-0">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: st.bg }}>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={st.color}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={st.path} /></svg>
                        </div>
                        {!last && <div className="w-px flex-1 bg-gray-200 my-1" />}
                      </div>
                      <div className={`flex-1 ${last ? '' : 'pb-4'}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-800">{meta.label}</span>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{CONDITION_LABEL[step.condition]}</span>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">
                            {step.delayDays === 0 ? 'Immédiat' : `J+${step.delayDays}`}
                          </span>
                        </div>
                        {meta.needsMessage && (
                          <p className="text-xs text-gray-400 mt-1">Message généré par l'IA à partir du Dossier d'attaque de chaque lead.</p>
                        )}
                      </div>
                    </div>
                  )
                })}

                {/* Ajouter étape */}
                <div className="flex gap-3">
                  <div className="w-9 flex justify-center flex-shrink-0">
                    <div className="w-9 h-9 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    </div>
                  </div>
                  <button className="text-sm text-gray-400 hover:text-indigo-500 transition-colors self-center">Ajouter une étape</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="card p-16 text-center text-sm text-gray-400">Sélectionnez une séquence</div>
          )}
        </div>
      </div>
    </>
  )
}
