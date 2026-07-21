import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { Conversation } from '../../types/prospector'
import { getConversations } from '../../lib/prospector/capabilities'

function initials(f: string, l: string) { return `${f[0]}${l[0]}`.toUpperCase() }

export default function ClientConversations() {
  const [convs, setConvs] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => { getConversations().then((c) => { setConvs(c); setSelected((s) => s ?? c[0]?.id ?? null) }) }, [])
  const active = convs.find((c) => c.id === selected)

  return (
    <>
      <Head><title>Espace client · Conversations</title></Head>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
        <p className="text-gray-400 text-sm mt-0.5">Tous les échanges menés pour vous, envoyés et reçus.</p>
      </div>

      <div className="card overflow-hidden grid grid-cols-1 lg:grid-cols-3 min-h-[540px]">
        <div className="border-r border-gray-100 divide-y divide-gray-50 overflow-y-auto max-h-[540px]">
          {convs.map((c) => {
            const last = c.messages[c.messages.length - 1]
            const on = c.id === selected
            return (
              <button key={c.id} onClick={() => setSelected(c.id)} className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${on ? 'bg-indigo-50/60' : 'hover:bg-gray-50'}`}>
                <div className="w-9 h-9 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{initials(c.lead.firstName, c.lead.lastName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 truncate">{c.lead.firstName} {c.lead.lastName}</span>
                    <span className="text-xs text-gray-400 ml-auto flex-shrink-0">{last.time}</span>
                  </div>
                  <p className="text-xs text-gray-400 truncate">{c.lead.company}</p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{last.from === 'us' ? 'Nous : ' : ''}{last.text}</p>
                </div>
              </button>
            )
          })}
        </div>

        <div className="lg:col-span-2 flex flex-col max-h-[540px]">
          {active ? (
            <>
              <div className="px-5 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-800">{active.lead.firstName} {active.lead.lastName}</p>
                <p className="text-xs text-gray-400">{active.lead.title} · {active.lead.company}</p>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {active.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.from === 'us' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.from === 'us' ? 'gradient-brand text-white' : 'bg-gray-100 text-gray-700'}`}>
                      {m.text}
                      <div className={`text-[10px] mt-1 ${m.from === 'us' ? 'text-white/70' : 'text-gray-400'}`}>{m.time}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-gray-100 px-5 py-3 text-center text-xs text-gray-400">
                Vous suivez cette conversation en lecture seule. Notre équipe gère les échanges pour vous.
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Sélectionnez une conversation</div>
          )}
        </div>
      </div>
    </>
  )
}
