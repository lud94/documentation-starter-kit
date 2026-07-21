import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { AgentConfig, KnowledgeBlock } from '../types/prospector'
import { getAgents, getKnowledgeBlocks } from '../lib/prospector/capabilities'

type Tab = 'prompts' | 'connaissances' | 'modeles'

const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'perplexity-sonar-pro', 'gpt-4.1-mini']

export default function BrainPage() {
  const [tab, setTab] = useState<Tab>('prompts')
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [blocks, setBlocks] = useState<KnowledgeBlock[]>([])
  const [openAgent, setOpenAgent] = useState<string | null>(null)

  useEffect(() => {
    getAgents().then(setAgents)
    getKnowledgeBlocks().then(setBlocks)
  }, [])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'prompts', label: 'Prompts' },
    { key: 'connaissances', label: 'Connaissances (RAG)' },
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
