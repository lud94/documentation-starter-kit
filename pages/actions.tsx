import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { Action, Lead, Quota, LeadDetail } from '../types/prospector'
import { ACTION_META } from '../types/prospector'
import RedactionModal from '../components/RedactionModal'
import {
  getTodayActions,
  validateAction,
  validateAll,
  cancelAction,
  updateActionMessage,
  regenerateActionMessage,
  getLeadDetail,
} from '../lib/prospector/capabilities'

const REGEN_CHIPS = ['Plus court', 'Plus direct', 'Moins commercial', 'Autre angle']

const TEMP_DOT: Record<Lead['temperature'], string> = {
  hot: 'bg-red-400',
  warm: 'bg-amber-400',
  cold: 'bg-sky-400',
}

const TYPE_STYLE: Record<Action['type'], string> = {
  invitation: 'bg-indigo-50 text-indigo-600',
  message: 'bg-violet-50 text-violet-600',
  relance: 'bg-amber-50 text-amber-600',
  visit: 'bg-sky-50 text-sky-600',
  inmail: 'bg-fuchsia-50 text-fuchsia-600',
  email: 'bg-emerald-50 text-emerald-600',
}

function QuotaPill({ q }: { q: Quota }) {
  const label = q.type === 'invitation' ? 'Invitations' : q.type === 'message' ? 'Messages' : 'Visites'
  const pct = Math.min(100, Math.round((q.used / q.max) * 100))
  return (
    <div className="card px-4 py-3 flex-1 min-w-[150px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">{label}</span>
        <span className="text-xs text-gray-400">{q.used}/{q.max}</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full">
        <div className="h-1.5 rounded-full gradient-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ActionCard({
  action, lead, onValidate, onCancel, onSaveMessage, onRegenerate, onOpenRedaction,
}: {
  action: Action
  lead: Lead
  onValidate: () => void
  onCancel: () => void
  onSaveMessage: (msg: string) => void
  onRegenerate: (instruction: string) => Promise<string>
  onOpenRedaction: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(action.generatedMessage ?? '')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const meta = ACTION_META[action.type]
  const initials = `${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()
  const done = action.status === 'validated'

  const regen = async (ins: string) => {
    setBusy(true)
    const m = await onRegenerate(ins)
    setDraft(m)
    setBusy(false)
  }

  return (
    <div className={`card p-5 transition-opacity ${done ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl gradient-brand flex items-center justify-center text-white font-bold text-sm flex-shrink-0">{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-800 text-sm">{lead.firstName} {lead.lastName}</span>
            <span className={`w-1.5 h-1.5 rounded-full ${TEMP_DOT[lead.temperature]}`} />
            <span className="text-xs text-gray-400">score {lead.score}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{lead.title} · {lead.company}</p>
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg flex-shrink-0 ${TYPE_STYLE[action.type]}`}>{meta.label}</span>
      </div>

      {/* Message */}
      {meta.needsMessage && action.generatedMessage != null && (
        <div className="mt-4">
          {editing ? (
            <>
              <textarea
                value={busy ? 'Régénération…' : draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400 focus:bg-white resize-none"
              />
              {/* Vitesse 1 — puces d'instruction */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {REGEN_CHIPS.map((c) => (
                  <button key={c} onClick={() => regen(c)} disabled={busy} className="text-[11px] font-medium text-gray-500 bg-gray-50 border border-gray-200 px-2.5 py-1 rounded-full hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-50">
                    {c}
                  </button>
                ))}
              </div>
              {/* Vitesse 2 — instruction libre + régénérer */}
              <div className="flex items-center gap-2 mt-2">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Donnez une instruction à l'IA (optionnel)…"
                  className="flex-1 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-400 focus:bg-white"
                />
                <button onClick={() => regen(instruction)} disabled={busy} className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                  <span className="gradient-text">✦</span> Régénérer
                </button>
              </div>
              {/* Vitesse 3 — échappatoire rédaction complète */}
              <button onClick={onOpenRedaction} className="text-[11px] text-gray-400 hover:text-indigo-500 transition-colors mt-2">
                Ouvrir en rédaction complète (variantes + coach) →
              </button>
            </>
          ) : (
            <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5 leading-relaxed">{action.generatedMessage}</p>
          )}
        </div>
      )}
      {!meta.needsMessage && (
        <p className="mt-3 text-xs text-gray-400 italic">Action automatique — aucun message à valider.</p>
      )}

      {/* Footer */}
      <div className="mt-4 flex items-center gap-2">
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-2 rounded-xl">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            Planifié · {action.scheduledLabel}
          </span>
        ) : (
          <>
            <button onClick={onValidate} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              Valider
            </button>
            {meta.needsMessage && (
              editing ? (
                <button onClick={() => { onSaveMessage(draft); setEditing(false) }} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-2 rounded-xl hover:bg-indigo-100 transition-colors">Enregistrer</button>
              ) : (
                <button onClick={() => { setDraft(action.generatedMessage ?? ''); setEditing(true) }} className="text-xs font-medium text-gray-500 bg-gray-50 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors">Modifier</button>
              )
            )}
            <button onClick={onCancel} className="text-xs font-medium text-gray-400 px-3 py-2 rounded-xl hover:text-red-500 hover:bg-red-50 transition-colors ml-auto">Ignorer</button>
          </>
        )}
      </div>
    </div>
  )
}

export default function ActionsPage() {
  const [actions, setActions] = useState<Action[]>([])
  const [leads, setLeads] = useState<Record<string, Lead>>({})
  const [quotas, setQuotas] = useState<Quota[]>([])
  const [loading, setLoading] = useState(true)
  const [redaction, setRedaction] = useState<LeadDetail | null>(null)

  const refresh = async () => {
    const data = await getTodayActions()
    setActions(data.actions)
    setLeads(data.leads)
    setQuotas(data.quotas)
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const pending = actions.filter((a) => a.status === 'pending')

  const handleValidate = async (id: string) => { await validateAction(id); refresh() }
  const handleValidateAll = async () => { await validateAll(); refresh() }
  const handleCancel = async (id: string) => { await cancelAction(id); refresh() }
  const handleSave = async (id: string, msg: string) => { await updateActionMessage(id, msg); refresh() }
  const handleRegenerate = async (id: string, instruction: string) => {
    const a = await regenerateActionMessage(id, instruction)
    refresh()
    return a?.generatedMessage ?? ''
  }
  const handleOpenRedaction = async (leadId: string) => {
    const d = await getLeadDetail(leadId)
    if (d) setRedaction(d)
  }

  return (
    <>
      <Head><title>Prospector · Actions du jour</title></Head>

      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Actions du jour</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {loading ? 'Chargement…' : `${pending.length} action${pending.length !== 1 ? 's' : ''} générée${pending.length !== 1 ? 's' : ''} par l'IA, en attente de validation.`}
          </p>
        </div>
        {pending.length > 0 && (
          <button onClick={handleValidateAll} className="gradient-brand text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            Tout valider ({pending.length})
          </button>
        )}
      </div>

      {/* Quotas */}
      <div className="flex gap-3 mb-6 flex-wrap">
        {quotas.map((q) => <QuotaPill key={q.type} q={q} />)}
      </div>

      {/* Liste */}
      {!loading && pending.length === 0 ? (
        <div className="card p-16 text-center">
          <div className="w-16 h-16 rounded-2xl icon-bg-green flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-700 mb-1">Tout est traité 🎉</h2>
          <p className="text-gray-400 text-sm">Les actions validées partiront automatiquement aux créneaux planifiés.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {actions
            .filter((a) => a.status === 'pending' || a.status === 'validated')
            .map((a) => {
              const lead = leads[a.leadId]
              if (!lead) return null
              return (
                <ActionCard
                  key={a.id}
                  action={a}
                  lead={lead}
                  onValidate={() => handleValidate(a.id)}
                  onCancel={() => handleCancel(a.id)}
                  onSaveMessage={(msg) => handleSave(a.id, msg)}
                  onRegenerate={(ins) => handleRegenerate(a.id, ins)}
                  onOpenRedaction={() => handleOpenRedaction(a.leadId)}
                />
              )
            })}
        </div>
      )}

      {redaction && <RedactionModal detail={redaction} onClose={() => setRedaction(null)} />}
    </>
  )
}
