import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Lead } from '../types/prospector'
import {
  getLeads, getLists, getSequences, createList, enrollLead, enrollLeadsInSequence,
  verifyLeadCompany, enrichCompanyWebsite, isAccountLead,
} from '../lib/prospector/capabilities'

type Action = any
interface Msg { role: 'user' | 'assistant'; content: string; action?: Action | null; result?: string; leads?: Lead[]; done?: boolean }

const countBy = (arr: Lead[], k: 'stage' | 'status') => arr.reduce((a, l) => { a[l[k]] = (a[l[k]] || 0) + 1; return a }, {} as Record<string, number>)

function matchFilter(l: Lead, f: any): boolean {
  if (!f) return true
  if (f.persona && l.persona !== f.persona) return false
  if (f.status && l.status !== f.status) return false
  if (f.stage && l.stage !== f.stage) return false
  if (f.query && !`${l.firstName} ${l.lastName} ${l.company} ${l.title}`.toLowerCase().includes(String(f.query).toLowerCase())) return false
  return true
}

const SUGGESTIONS = [
  'Combien de comptes et de contacts j\'ai ?',
  'Montre-moi les contacts en séquence',
  'Crée une liste des Head of Sales',
  'Enrichis l\'entreprise Redsen',
]

export default function Jarvis({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [msgs, busy])

  const buildContext = async () => {
    const leads = await getLeads()
    const contacts = leads.filter((l) => !isAccountLead(l))
    const accounts = leads.filter((l) => isAccountLead(l))
    const [lists, seqs] = await Promise.all([getLists(), getSequences()])
    return {
      contacts: contacts.length, accounts: accounts.length,
      byStage: countBy(contacts, 'stage'), byStatus: countBy(contacts, 'status'),
      personas: Array.from(new Set(contacts.map((c) => c.persona).filter(Boolean))),
      lists: lists.map((l) => ({ name: l.name, count: l.leadIds.length })),
      sequences: seqs.map((s) => ({ name: s.name, enrolled: s.enrolled })),
    }
  }

  const send = async (text: string) => {
    const q = text.trim(); if (!q || busy) return
    setInput('')
    const next = [...msgs, { role: 'user' as const, content: q }]
    setMsgs(next); setBusy(true)
    try {
      const context = await buildContext()
      const d = await fetch('/api/jarvis/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })), context }),
      }).then((r) => r.json())
      const action = d.action || null
      // search_leads = lecture → on exécute tout de suite et on affiche.
      if (action?.type === 'search_leads') {
        const leads = (await getLeads()).filter((l) => !isAccountLead(l) && matchFilter(l, action))
        setMsgs((m) => [...m, { role: 'assistant', content: d.reply || `${leads.length} contact(s).`, leads }])
      } else {
        setMsgs((m) => [...m, { role: 'assistant', content: d.reply || '…', action }])
      }
    } catch {
      setMsgs((m) => [...m, { role: 'assistant', content: 'Erreur — réessaie.' }])
    } finally { setBusy(false) }
  }

  // Exécution des actions d'ÉCRITURE, après confirmation.
  const runAction = async (idx: number, a: Action) => {
    setBusy(true)
    let result = 'Action inconnue.'
    try {
      if (a.type === 'create_list') {
        const leads = (await getLeads()).filter((l) => !isAccountLead(l) && matchFilter(l, a.filter))
        const list = await createList(a.name || 'Liste', leads.map((l) => l.id), 'via Jarvis')
        result = `Liste « ${list.name} » créée avec ${leads.length} contact(s).`
      } else if (a.type === 'add_to_sequence') {
        const seqs = await getSequences()
        const seq = seqs.find((s) => s.name.toLowerCase().includes(String(a.sequenceName || '').toLowerCase()))
        if (!seq) result = `Séquence « ${a.sequenceName} » introuvable.`
        else {
          const leads = (await getLeads()).filter((l) => !isAccountLead(l) && matchFilter(l, a.filter))
          for (const l of leads) await enrollLead(l.id)
          await enrollLeadsInSequence(seq.id, leads.length, leads.map((l) => l.id))
          result = `${leads.length} contact(s) enrôlé(s) dans « ${seq.name} ».`
        }
      } else if (a.type === 'enrich_company') {
        const acc = (await getLeads()).find((l) => isAccountLead(l) && l.company.toLowerCase().includes(String(a.company || '').toLowerCase()))
        if (!acc) result = `Compte « ${a.company} » introuvable dans le pipe. Importe-le d'abord.`
        else { await verifyLeadCompany(acc.id); const r = await enrichCompanyWebsite(acc.id); result = `« ${acc.company} » vérifié + enrichi${r.website ? ` · ${r.website}` : ''}.` }
      }
    } catch { result = 'Échec de l\'action.' }
    setMsgs((m) => m.map((x, i) => i === idx ? { ...x, done: true, result } : x))
    setBusy(false)
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-gray-900/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col animate-[slideIn_.2s_ease]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <span className="w-8 h-8 rounded-xl gradient-brand flex items-center justify-center text-white font-bold">✦</span>
          <div className="flex-1"><p className="text-sm font-bold text-gray-900">Jarvis</p><p className="text-[11px] text-gray-400">Copilote Prospector · pilote ta plateforme</p></div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto p-4 space-y-3">
          {msgs.length === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">Demande-moi d'analyser tes données ou d'agir. Exemples :</p>
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="block w-full text-left text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg hover:bg-indigo-100">{s}</button>)}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`max-w-[85%] text-sm rounded-2xl px-3.5 py-2 ${m.role === 'user' ? 'gradient-brand text-white' : 'bg-gray-100 text-gray-800'}`}>
                {m.content}
                {m.leads && (
                  <div className="mt-2 space-y-1">
                    {m.leads.slice(0, 12).map((l) => (
                      <Link key={l.id} href={`/leads/${l.id}`} onClick={onClose} className="block bg-white rounded-lg px-2.5 py-1.5 border border-gray-100 hover:border-gray-200">
                        <span className="block text-xs font-medium text-gray-800">{l.firstName} {l.lastName}</span>
                        <span className="block text-[11px] text-gray-400">{l.title} · {l.company}</span>
                      </Link>
                    ))}
                    {m.leads.length > 12 && <p className="text-[11px] text-gray-400">+{m.leads.length - 12} autres…</p>}
                    {m.leads.length === 0 && <p className="text-[11px] text-gray-400">Aucun contact ne correspond.</p>}
                  </div>
                )}
                {m.action && !m.done && (
                  <div className="mt-2 flex items-center gap-2">
                    <button onClick={() => runAction(i, m.action)} disabled={busy} className="text-xs font-semibold bg-white text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 disabled:opacity-40">Confirmer</button>
                    <button onClick={() => setMsgs((mm) => mm.map((x, j) => j === i ? { ...x, done: true, result: 'Annulé.' } : x))} className="text-xs text-gray-400 px-2">Annuler</button>
                  </div>
                )}
                {m.result && <p className="mt-1.5 text-[12px] font-medium text-emerald-700">{m.result}</p>}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-gray-400">Jarvis réfléchit…</p>}
        </div>

        <div className="p-3 border-t border-gray-100 flex items-center gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(input)} placeholder="Demande à Jarvis…" className="flex-1 px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
          <button onClick={() => send(input)} disabled={busy || !input.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">Envoyer</button>
        </div>
      </div>
      <style jsx>{`@keyframes slideIn { from { transform: translateX(20px); opacity: 0 } to { transform: none; opacity: 1 } }`}</style>
    </div>
  )
}
