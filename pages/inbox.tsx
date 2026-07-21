import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Conversation, Visitor } from '../types/prospector'
import { getConversations, getVisitors } from '../lib/prospector/capabilities'

function initials(first: string, last: string) {
  return `${first[0]}${last[0]}`.toUpperCase()
}

export default function InboxPage() {
  const [tab, setTab] = useState<'conversations' | 'visiteurs'>('conversations')
  const [convs, setConvs] = useState<Conversation[]>([])
  const [visitors, setVisitors] = useState<Visitor[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [reply, setReply] = useState('')

  useEffect(() => {
    getConversations().then((c) => { setConvs(c); setSelected((s) => s ?? c[0]?.id ?? null) })
    getVisitors().then(setVisitors)
  }, [])

  const active = convs.find((c) => c.id === selected)
  const unreadCount = convs.filter((c) => c.unread).length

  return (
    <>
      <Head><title>Prospector · Inbox</title></Head>

      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
          <p className="text-gray-400 text-sm mt-0.5">Conversations LinkedIn et signaux de visite.</p>
        </div>
        {/* Onglets */}
        <div className="flex bg-gray-100 rounded-xl p-1">
          <button
            onClick={() => setTab('conversations')}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${tab === 'conversations' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
          >
            Conversations
            {unreadCount > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{unreadCount}</span>}
          </button>
          <button
            onClick={() => setTab('visiteurs')}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === 'visiteurs' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
          >
            Visiteurs
          </button>
        </div>
      </div>

      {tab === 'conversations' ? (
        <div className="card overflow-hidden grid grid-cols-1 lg:grid-cols-3 min-h-[560px]">
          {/* Liste */}
          <div className="border-r border-gray-100 divide-y divide-gray-50 overflow-y-auto max-h-[560px]">
            {convs.map((c) => {
              const last = c.messages[c.messages.length - 1]
              const on = c.id === selected
              return (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${on ? 'bg-indigo-50/60' : 'hover:bg-gray-50'}`}
                >
                  <div className="w-9 h-9 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {initials(c.lead.firstName, c.lead.lastName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{c.lead.firstName} {c.lead.lastName}</span>
                      {c.unread && <span className="w-2 h-2 rounded-full gradient-brand flex-shrink-0" />}
                      <span className="text-xs text-gray-400 ml-auto flex-shrink-0">{last.time}</span>
                    </div>
                    <p className="text-xs text-gray-400 truncate">{c.lead.company}</p>
                    <p className={`text-xs truncate mt-0.5 ${c.unread ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
                      {last.from === 'us' ? 'Vous : ' : ''}{last.text}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Thread */}
          <div className="lg:col-span-2 flex flex-col max-h-[560px]">
            {active ? (
              <>
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{active.lead.firstName} {active.lead.lastName}</p>
                    <p className="text-xs text-gray-400">{active.lead.title} · {active.lead.company}</p>
                  </div>
                  <Link href={`/leads/${active.lead.id}`} className="text-xs text-indigo-500 hover:text-indigo-700">Voir la fiche →</Link>
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

                {/* Composer */}
                <div className="border-t border-gray-100 p-3">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={2}
                    placeholder="Votre réponse…"
                    className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <button
                      onClick={() => setReply(active.suggestedReply)}
                      className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1.5"
                    >
                      <span className="gradient-text font-semibold">✦</span> Générer une réponse
                    </button>
                    <button className="gradient-brand text-white text-xs font-semibold px-4 py-1.5 rounded-lg hover:opacity-90 transition-opacity">
                      Envoyer
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Sélectionnez une conversation</div>
            )}
          </div>
        </div>
      ) : (
        /* Visiteurs */
        <div className="card p-5">
          <p className="text-sm text-gray-500 mb-4">
            Ces personnes ont consulté votre profil — un signal d'intérêt tiède. Idéal pour une invitation contextualisée.
          </p>
          <div className="space-y-2">
            {visitors.map((v) => (
              <div key={v.lead.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                <div className="w-9 h-9 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {initials(v.lead.firstName, v.lead.lastName)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate">{v.lead.firstName} {v.lead.lastName}</p>
                  <p className="text-xs text-gray-400 truncate">{v.lead.title} · {v.lead.company}</p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {v.times > 1 ? `${v.times}× · ` : ''}{v.viewedAt}
                </span>
                <Link href={`/leads/${v.lead.id}`} className="text-xs font-medium text-gray-500 bg-gray-50 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0">
                  Voir la fiche
                </Link>
                <button className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity flex-shrink-0">
                  Inviter
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
