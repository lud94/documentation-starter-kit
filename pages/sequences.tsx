import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { Sequence, SequenceStep, ActionType, Channel as ChannelType, StepCondition, Lead } from '../types/prospector'
import { CONDITION_LABEL, ACTION_META, CHANNEL_META } from '../types/prospector'
import { getSequences, saveSequence, deleteSequence, nextSequenceId, enrollLeadsInSequence, getChannels, toggleChannel, getLeads } from '../lib/prospector/capabilities'
import type { Channel } from '../lib/prospector/capabilities'

const CHANNELS: ChannelType[] = ['linkedin', 'email', 'whatsapp']
const CONDITIONS: StepCondition[] = ['always', 'if_connected', 'if_no_response', 'if_responded']

function clone(s: Sequence): Sequence { return JSON.parse(JSON.stringify(s)) }

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Sequence | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = () => getSequences().then((s) => { setSequences([...s]); if (!selectedId && s[0]) { setSelectedId(s[0].id); setDraft(clone(s[0])) } })
  useEffect(() => { load(); getChannels().then(setChannels) /* eslint-disable-next-line */ }, [])

  const select = (s: Sequence) => { setSelectedId(s.id); setDraft(clone(s)); setSaved(false) }

  const newSequence = () => {
    const s: Sequence = { id: nextSequenceId(), name: 'Nouvelle séquence', status: 'paused', enrolled: 0, responseRate: 0, steps: [{ id: 'st1', channel: 'linkedin', type: 'invitation', condition: 'always', delayDays: 0 }] }
    setSequences((prev) => [...prev, s]); select(s)
  }

  const updateStep = (i: number, patch: Partial<SequenceStep>) => {
    if (!draft) return
    const steps = draft.steps.map((st, j) => j === i ? { ...st, ...patch } : st)
    setDraft({ ...draft, steps })
  }
  const addStep = () => { if (!draft) return; setDraft({ ...draft, steps: [...draft.steps, { id: 'st' + (draft.steps.length + 1), channel: 'linkedin', type: 'message', condition: 'if_no_response', delayDays: 3 }] }) }
  const removeStep = (i: number) => { if (!draft) return; setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) }) }

  const save = async () => { if (!draft) return; await saveSequence(draft); await load(); setSaved(true); setTimeout(() => setSaved(false), 1500) }
  const toggleStatus = () => { if (!draft) return; setDraft({ ...draft, status: draft.status === 'active' ? 'paused' : 'active' }) }
  const remove = async () => { if (!draft) return; await deleteSequence(draft.id); const rest = sequences.filter((s) => s.id !== draft.id); setSequences(rest); setSelectedId(rest[0]?.id ?? null); setDraft(rest[0] ? clone(rest[0]) : null) }

  const channelConnected = (c: ChannelType) => channels.find((x) => x.key === c)?.connected ?? false
  const flip = async (k: Channel['key']) => { await toggleChannel(k); getChannels().then(setChannels) }

  const inputCls = 'text-xs bg-white border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-400'

  return (
    <>
      <Head><title>Prospector · Séquences</title></Head>

      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Séquences</h1>
          <p className="text-gray-400 text-sm mt-0.5">Enchaînements multi-canaux, exécutés dans le respect des quotas et des délais anti-détection.</p>
        </div>
        <button onClick={newSequence} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          Nouvelle séquence
        </button>
      </div>

      {/* Canaux connectés (Unipile) */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <span className="text-xs font-semibold text-gray-400 mr-1">Canaux :</span>
        {channels.map((c) => (
          <button key={c.key} onClick={() => flip(c.key)} className={`text-xs font-medium px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-colors ${c.connected ? 'bg-emerald-50 border-emerald-200 text-emerald-600' : 'bg-white border-gray-200 text-gray-500 hover:border-indigo-300'}`} title={c.detail}>
            <span className={`w-1.5 h-1.5 rounded-full ${c.connected ? 'bg-emerald-500' : 'bg-gray-300'}`} />
            {c.label} · {c.connected ? 'connecté' : 'connecter'}
          </button>
        ))}
        <span className="text-[11px] text-gray-300">via Unipile</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Liste */}
        <div className="space-y-3">
          {sequences.map((s) => {
            const on = s.id === selectedId
            return (
              <button key={s.id} onClick={() => select(s)} className={`card p-4 w-full text-left transition-all ${on ? 'ring-2 ring-indigo-400' : 'hover:shadow-md'}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-800 truncate">{s.name}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${s.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>{s.status === 'active' ? 'Active' : 'En pause'}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>{s.enrolled} leads</span>
                  <span>{s.steps.length} étapes</span>
                  <span className="ml-auto font-semibold text-gray-500">{s.responseRate}%</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Éditeur */}
        <div className="lg:col-span-2">
          {draft ? (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="text-lg font-bold text-gray-900 bg-transparent border-b border-transparent hover:border-gray-200 focus:border-indigo-400 focus:outline-none flex-1 min-w-0" />
                <div className="flex items-center gap-2">
                  <button onClick={toggleStatus} className="text-xs font-medium text-gray-600 bg-gray-50 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">{draft.status === 'active' ? 'Mettre en pause' : 'Activer'}</button>
                  <button onClick={remove} className="text-xs font-medium text-red-400 px-2 py-1.5 rounded-lg hover:bg-red-50 transition-colors">Supprimer</button>
                </div>
              </div>

              <p className="text-xs text-gray-400 mb-3">{draft.enrolled} leads enrôlés · {draft.responseRate}% de réponses · <button onClick={() => setPickerOpen(true)} className="text-indigo-500 hover:text-indigo-700">+ Ajouter des leads</button></p>

              {/* Étapes éditables */}
              <div className="space-y-2">
                {draft.steps.map((step, i) => {
                  const cm = CHANNEL_META[step.channel]
                  const allowed = cm.types
                  const notConnected = !channelConnected(step.channel)
                  return (
                    <div key={i} className="flex items-center gap-2 flex-wrap bg-gray-50 rounded-xl p-2.5">
                      <span className="w-6 h-6 rounded-lg bg-white flex items-center justify-center text-[11px] font-bold text-gray-400 flex-shrink-0">{i + 1}</span>
                      <select value={step.channel} onChange={(e) => { const ch = e.target.value as ChannelType; updateStep(i, { channel: ch, type: CHANNEL_META[ch].types[0] }) }} className={inputCls} style={{ color: cm.color }}>
                        {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_META[c].label}</option>)}
                      </select>
                      <select value={step.type} onChange={(e) => updateStep(i, { type: e.target.value as ActionType })} className={inputCls}>
                        {allowed.map((t) => <option key={t} value={t}>{ACTION_META[t].label}</option>)}
                      </select>
                      <select value={step.condition} onChange={(e) => updateStep(i, { condition: e.target.value as StepCondition })} className={inputCls}>
                        {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
                      </select>
                      <span className="flex items-center gap-1 text-xs text-gray-400">J+<input type="number" min={0} value={step.delayDays} onChange={(e) => updateStep(i, { delayDays: Number(e.target.value) })} className="w-12 text-xs bg-white border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-400" /></span>
                      {notConnected && <span className="text-[10px] font-medium text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded">canal à connecter</span>}
                      <button onClick={() => removeStep(i)} className="ml-auto text-gray-300 hover:text-red-500 transition-colors"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                    </div>
                  )
                })}
                <button onClick={addStep} className="text-sm text-gray-400 hover:text-indigo-500 transition-colors flex items-center gap-1.5 mt-1"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>Ajouter une étape</button>
              </div>

              <div className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-gray-50">
                {saved && <span className="text-xs text-emerald-600">✓ Enregistré</span>}
                <button onClick={save} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity">Enregistrer</button>
              </div>
            </div>
          ) : (
            <div className="card p-16 text-center text-sm text-gray-400">Sélectionnez ou créez une séquence</div>
          )}
        </div>
      </div>

      {pickerOpen && draft && <LeadPicker onClose={() => setPickerOpen(false)} onEnroll={async (n) => { await enrollLeadsInSequence(draft.id, n); await load(); setDraft((dd) => dd ? { ...dd, enrolled: dd.enrolled + n } : dd); setPickerOpen(false) }} />}
    </>
  )
}

function LeadPicker({ onClose, onEnroll }: { onClose: () => void; onEnroll: (n: number) => void }) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  useEffect(() => { getLeads().then(setLeads) }, [])
  const filtered = leads.filter((l) => !q || `${l.firstName} ${l.lastName} ${l.company}`.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">Enrôler des leads</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>
        <div className="p-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…" className="w-full text-sm px-3 py-2 rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
        </div>
        <div className="px-3 pb-2 overflow-y-auto flex-1">
          {filtered.map((l) => {
            const on = selected.has(l.id)
            return (
              <button key={l.id} onClick={() => toggle(l.id)} className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-gray-50 text-left transition-colors">
                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'gradient-brand border-transparent' : 'border-gray-300'}`}>{on && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}</span>
                <span className="w-7 h-7 rounded-lg gradient-brand text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">{`${l.firstName[0]}${l.lastName[0]}`.toUpperCase()}</span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-800 truncate">{l.firstName} {l.lastName}</span><span className="block text-xs text-gray-400 truncate">{l.company}</span></span>
              </button>
            )
          })}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-400">{selected.size} sélectionné(s)</span>
          <button onClick={() => onEnroll(selected.size)} disabled={selected.size === 0} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">Enrôler {selected.size} lead{selected.size !== 1 ? 's' : ''}</button>
        </div>
      </div>
    </div>
  )
}
