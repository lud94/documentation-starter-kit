import { useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Conversation, Visitor, LeadDetail } from '../types/prospector'
import { STATUS_META } from '../types/prospector'
import { getConversations, getVisitors, getLeadDetail, detectDealKillers, regenerateReply } from '../lib/prospector/capabilities'

const REGEN_CHIPS = ['Plus court', 'Plus direct', 'Moins commercial', 'Autre angle']

function initials(first: string, last: string) { return `${first[0]}${last[0]}`.toUpperCase() }
function linkedinUrl(first: string, last: string) { return `https://linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}` }

const CHANNEL: Record<Conversation['channel'], { label: string; color: string; path: string; fill?: boolean }> = {
  linkedin: { label: 'LinkedIn', color: '#0a66c2', fill: true, path: 'M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14zM8 17v-7H6v7h2zM7 8a1 1 0 100-2 1 1 0 000 2zm11 9v-4c0-2-1-3-2.5-3S13 11 13 12v5h2v-4c0-.5.5-1 1-1s1 .5 1 1v4h1z' },
  email: { label: 'Email', color: '#059669', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  whatsapp: { label: 'WhatsApp', color: '#25d366', path: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
}

function ChannelIcon({ channel, className }: { channel: Conversation['channel']; className?: string }) {
  const c = CHANNEL[channel]
  return c.fill
    ? <svg className={className} style={{ color: c.color }} fill="currentColor" viewBox="0 0 24 24"><path d={c.path} /></svg>
    : <svg className={className} style={{ color: c.color }} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={c.path} /></svg>
}

export default function InboxPage() {
  const [tab, setTab] = useState<'conversations' | 'visiteurs'>('conversations')
  const [convs, setConvs] = useState<Conversation[]>([])
  const [visitors, setVisitors] = useState<Visitor[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [detail, setDetail] = useState<LeadDetail | null>(null)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const regen = async (leadId: string, ins: string) => { setBusy(true); const m = await regenerateReply(leadId, ins); setReply(m); setBusy(false) }

  useEffect(() => {
    getConversations().then((c) => { setConvs(c); setSelected((s) => s ?? c[0]?.id ?? null) })
    getVisitors().then(setVisitors)
  }, [])

  const active = convs.find((c) => c.id === selected)

  // Charge le Dossier du lead actif (contexte de réponse)
  useEffect(() => { if (active) getLeadDetail(active.lead.id).then(setDetail); else setDetail(null) }, [selected]) // eslint-disable-line
  // Auto-scroll vers le dernier message
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [selected, active?.messages.length])

  const openConv = (id: string) => { setSelected(id); setReply(''); setConvs((p) => p.map((x) => x.id === id ? { ...x, unread: false } : x)) }
  const unreadCount = convs.filter((c) => c.unread).length
  const list = unreadOnly ? convs.filter((c) => c.unread) : convs

  return (
    <>
      <Head><title>Prospector · Inbox</title></Head>

      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
          <p className="text-gray-400 text-sm mt-0.5">Conversations multi-canaux et signaux de visite.</p>
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1">
          <button onClick={() => setTab('conversations')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${tab === 'conversations' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
            Conversations{unreadCount > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{unreadCount}</span>}
          </button>
          <button onClick={() => setTab('visiteurs')} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === 'visiteurs' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>Visiteurs</button>
        </div>
      </div>

      {tab === 'conversations' ? (
        <div className="card overflow-hidden grid grid-cols-1 lg:grid-cols-3 min-h-[580px]">
          {/* Liste */}
          <div className="border-r border-gray-100 flex flex-col max-h-[580px]">
            <div className="px-3 py-2 border-b border-gray-50 flex items-center justify-between">
              <span className="text-xs text-gray-400">{list.length} conversation{list.length !== 1 ? 's' : ''}</span>
              <button onClick={() => setUnreadOnly((v) => !v)} className={`text-xs font-medium px-2 py-1 rounded-lg transition-colors ${unreadOnly ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-50'}`}>Non lus</button>
            </div>
            <div className="divide-y divide-gray-50 overflow-y-auto">
              {list.map((c) => {
                const lastMsg = c.messages[c.messages.length - 1]
                const on = c.id === selected
                return (
                  <button key={c.id} onClick={() => openConv(c.id)} className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${on ? 'bg-indigo-50/60' : 'hover:bg-gray-50'}`}>
                    <div className="relative flex-shrink-0">
                      <div className="w-9 h-9 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold">{initials(c.lead.firstName, c.lead.lastName)}</div>
                      <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-white flex items-center justify-center"><ChannelIcon channel={c.channel} className="w-3 h-3" /></span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 truncate">{c.lead.firstName} {c.lead.lastName}</span>
                        {c.unread && <span className="w-2 h-2 rounded-full gradient-brand flex-shrink-0" />}
                        <span className="text-xs text-gray-400 ml-auto flex-shrink-0">{lastMsg.time}</span>
                      </div>
                      <p className="text-xs text-gray-400 truncate">{c.lead.company}</p>
                      <p className={`text-xs truncate mt-0.5 ${c.unread ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>{lastMsg.from === 'us' ? 'Vous : ' : ''}{lastMsg.text}</p>
                    </div>
                  </button>
                )
              })}
              {list.length === 0 && <p className="text-sm text-gray-400 text-center py-8">Aucune conversation</p>}
            </div>
          </div>

          {/* Thread */}
          <div className="lg:col-span-2 flex flex-col max-h-[580px]">
            {active ? (
              <>
                {/* En-tête avec actions rapides */}
                <div className="px-5 py-3 border-b border-gray-100">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <a href={linkedinUrl(active.lead.firstName, active.lead.lastName)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-gray-800 hover:text-indigo-600 transition-colors inline-flex items-center gap-1.5 group" title="Ouvrir le profil LinkedIn">
                        {active.lead.firstName} {active.lead.lastName}
                        <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-indigo-500" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14zM8 17v-7H6v7h2zM7 8a1 1 0 100-2 1 1 0 000 2zm11 9v-4c0-2-1-3-2.5-3S13 11 13 12v5h2v-4c0-.5.5-1 1-1s1 .5 1 1v4h1z" /></svg>
                      </a>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${STATUS_META[active.lead.status].bg}`}>{STATUS_META[active.lead.status].label}</span>
                      {active.lead.score > 0 && <span className="text-xs font-semibold text-gray-500">score {active.lead.score}</span>}
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full"><ChannelIcon channel={active.channel} className="w-3 h-3" />{CHANNEL[active.channel].label}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Link href={`/leads/${active.lead.id}`} className="text-xs font-medium text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg hover:bg-gray-100 transition-colors">Fiche</Link>
                      <Link href={`/leads/${active.lead.id}`} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg hover:bg-indigo-100 transition-colors">+ Séquence</Link>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{active.lead.title} · {active.lead.company}</p>
                </div>

                {/* Messages */}
                <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                  {active.messages.map((m) => (
                    <div key={m.id} className={`flex ${m.from === 'us' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.from === 'us' ? 'gradient-brand text-white' : 'bg-gray-100 text-gray-700'}`}>
                        {m.text}
                        <div className={`text-[10px] mt-1 ${m.from === 'us' ? 'text-white/70' : 'text-gray-400'}`}>{m.time}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Contexte Dossier (repliable) */}
                {detail && (
                  <div className="border-t border-gray-100 px-3 pt-2">
                    <button onClick={() => setCtxOpen((v) => !v)} className="text-[11px] font-medium text-gray-400 hover:text-indigo-500 flex items-center gap-1">
                      <svg className={`w-3 h-3 transition-transform ${ctxOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      Contexte du Dossier (pour calibrer la réponse)
                    </button>
                    {ctxOpen && (
                      <div className="bg-indigo-50/40 border border-indigo-100 rounded-xl px-3 py-2 mt-1.5 text-xs space-y-1.5">
                        <p className="text-gray-600"><span className="font-semibold text-indigo-600">Accroche pivot :</span> {detail.dossier.accrochePivot}</p>
                        <p className="text-gray-600"><span className="font-semibold text-red-500">À éviter :</span> {detail.dossier.aEviter.slice(0, 2).join(' · ')}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Composer */}
                <div className="border-t border-gray-100 p-3">
                  <textarea value={busy ? 'Régénération…' : reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder="Votre réponse… (générez avec l'IA puis modifiez librement)" className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none" />
                  {(() => {
                    const flagged = detectDealKillers(reply)
                    return flagged.length > 0
                      ? <p className="text-[11px] text-red-600 mt-1.5">⚠ Deal-killer : {flagged.map((f) => `« ${f} »`).join(', ')}</p>
                      : reply ? <p className="text-[11px] text-gray-400 mt-1.5">✎ Message modifiable avant envoi</p> : null
                  })()}

                  {/* Régénération guidée */}
                  {reply && (
                    <>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {REGEN_CHIPS.map((c) => (
                          <button key={c} onClick={() => regen(active.lead.id, c)} disabled={busy} className="text-[11px] font-medium text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-50">{c}</button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <input value={instruction} onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') regen(active.lead.id, instruction) }} placeholder="Dites à l'IA quoi changer…" className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white" />
                        <button onClick={() => regen(active.lead.id, instruction)} disabled={busy} className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50 flex items-center gap-1"><span className="gradient-text">✦</span> Régénérer</button>
                      </div>
                    </>
                  )}

                  <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
                    <button onClick={() => setReply(active.suggestedReply)} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1.5"><span className="gradient-text font-semibold">✦</span> Générer une réponse</button>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 bg-gray-50 px-2 py-1 rounded-lg"><ChannelIcon channel={active.channel} className="w-3 h-3" />Répondre via {CHANNEL[active.channel].label}</span>
                      <button disabled={!reply.trim()} className="gradient-brand text-white text-xs font-semibold px-4 py-1.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Envoyer</button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Sélectionnez une conversation</div>
            )}
          </div>
        </div>
      ) : (
        <div className="card p-5">
          <p className="text-sm text-gray-500 mb-4">Ces personnes ont consulté votre profil — un signal d'intérêt tiède. Idéal pour une invitation contextualisée.</p>
          <div className="space-y-2">
            {visitors.map((v) => (
              <div key={v.lead.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                <div className="w-9 h-9 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{initials(v.lead.firstName, v.lead.lastName)}</div>
                <div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-800 truncate">{v.lead.firstName} {v.lead.lastName}</p><p className="text-xs text-gray-400 truncate">{v.lead.title} · {v.lead.company}</p></div>
                <span className="text-xs text-gray-400 flex-shrink-0">{v.times > 1 ? `${v.times}× · ` : ''}{v.viewedAt}</span>
                <Link href={`/leads/${v.lead.id}`} className="text-xs font-medium text-gray-500 bg-gray-50 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0">Voir la fiche</Link>
                <button className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity flex-shrink-0">Inviter</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
