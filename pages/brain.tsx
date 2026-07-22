import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { AgentConfig, KnowledgeBlock } from '../types/prospector'
import { getAgents, getKnowledgeBlocks, getReferentiel, addForbiddenTerm, removeForbiddenTerm, type Referentiel } from '../lib/prospector/capabilities'

type Tab = 'prompts' | 'connaissances' | 'referentiel' | 'modeles'

const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'perplexity-sonar-pro', 'gpt-4.1-mini']

export default function BrainPage() {
  const [tab, setTab] = useState<Tab>('prompts')
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [blocks, setBlocks] = useState<KnowledgeBlock[]>([])
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const [ref, setRef] = useState<Referentiel | null>(null)
  const [newTerm, setNewTerm] = useState('')

  useEffect(() => {
    getAgents().then(setAgents)
    getKnowledgeBlocks().then(setBlocks)
    getReferentiel().then(setRef)
  }, [])

  const addTerm = async () => { if (newTerm.trim()) { await addForbiddenTerm(newTerm); setNewTerm(''); getReferentiel().then(setRef) } }
  const removeTerm = async (t: string) => { await removeForbiddenTerm(t); getReferentiel().then(setRef) }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'prompts', label: 'Prompts' },
    { key: 'connaissances', label: 'Connaissances (RAG)' },
    { key: 'referentiel', label: 'Référentiel Smart.AI' },
    { key: 'modeles', label: 'Modèles & Clés' },
  ]

  return (
    <>
      <Head><title>Prospector · Cerveau IA</title></Head>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Cerveau IA</h1>
        <p className="text-gray-400 text-sm mt-0.5">Réglez ce que l'IA sait et comment elle s'exprime, agent par agent.</p>
      </div>

      <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === t.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'prompts' && (
        <div className="space-y-3">
          {agents.map((a) => {
            const open = openAgent === a.id
            return (
              <div key={a.id} className="card overflow-hidden">
                <button onClick={() => setOpenAgent(open ? null : a.id)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg icon-bg-purple flex items-center justify-center">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.5 3a3 3 0 013 3v12a3 3 0 01-6 0V6a3 3 0 013-3z" /></svg>
                    </span>
                    <div className="text-left">
                      <p className="text-sm font-semibold text-gray-800">{a.name}</p>
                      <p className="text-xs text-gray-400">{a.model} · temp {a.temperature}</p>
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {open && (
                  <div className="px-5 pb-5">
                    <textarea defaultValue={a.prompt} rows={5} className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none leading-relaxed" />
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {a.ragBlocks.map((b) => (
                        <span key={b} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">RAG: {b}</span>
                      ))}
                      <button className="ml-auto gradient-brand text-white text-xs font-semibold px-4 py-1.5 rounded-lg hover:opacity-90 transition-opacity">Enregistrer</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'connaissances' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {blocks.map((b) => (
            <div key={b.id} className="card p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-800">{b.name}</span>
                <span className="text-xs text-gray-400">{b.sections} sections</span>
              </div>
              <p className="text-xs text-gray-500 mb-3 leading-relaxed">{b.description}</p>
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                {b.agents.map((ag) => (
                  <span key={ag} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{ag}</span>
                ))}
              </div>
              <button className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors">Éditer le bloc</button>
            </div>
          ))}
        </div>
      )}

      {tab === 'referentiel' && ref && (
        <div className="space-y-4 max-w-3xl">
          <p className="text-sm text-gray-500">Le règlement de marque appliqué à <span className="font-medium">toute</span> génération (rédaction, passe qualité, réponses). Rien de ce que l'IA produit ne doit contenir un terme interdit.</p>

          {/* Vocabulaire interdit */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L18.364 5.636M5.636 18.364l12.728-12.728" /></svg>
              <h2 className="text-sm font-semibold text-gray-700">Vocabulaire interdit (deal-killers)</h2>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {ref.forbidden.map((t) => (
                <span key={t} className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-50 text-red-600 flex items-center gap-1.5">
                  {t}
                  <button onClick={() => removeTerm(t)} className="hover:text-red-800">×</button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input value={newTerm} onChange={(e) => setNewTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTerm() }} placeholder="Ajouter un terme interdit…" className="flex-1 text-sm px-3 py-2 rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white" />
              <button onClick={addTerm} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity">Ajouter</button>
            </div>
          </div>

          {/* Vocabulaire à utiliser */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <h2 className="text-sm font-semibold text-gray-700">Vocabulaire à utiliser</h2>
            </div>
            <div className="space-y-2">
              {ref.preferred.map((p) => (
                <div key={p.avoid} className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-red-500 line-through">{p.avoid}</span>
                  <svg className="w-3.5 h-3.5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  <span className="text-xs text-emerald-600 font-medium">{p.use}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Offre */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Offre Smart.AI</h2>
            <textarea defaultValue={ref.offer} rows={3} className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none leading-relaxed" />
          </div>
        </div>
      )}

      {tab === 'modeles' && (
        <div className="space-y-3">
          {agents.map((a) => (
            <div key={a.id} className="card p-4 flex items-center gap-4 flex-wrap">
              <span className="text-sm font-semibold text-gray-800 w-40 flex-shrink-0">{a.name}</span>
              <select defaultValue={a.model} className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400">
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="text-xs text-gray-400">temp</span>
              <input type="number" step="0.1" min="0" max="1" defaultValue={a.temperature} className="w-16 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-2 py-2 focus:outline-none focus:border-indigo-400" />
              <button className="ml-auto text-xs font-medium text-gray-500 bg-gray-50 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">Enregistrer</button>
            </div>
          ))}
          <div className="card p-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Clés API</p>
            <div className="space-y-2">
              {['Anthropic (Claude)', 'OpenAI', 'Perplexity'].map((k) => (
                <div key={k} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{k}</span>
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Configurée</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
