import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Mission, MissionStep } from '../types/prospector'
import { MISSION_TOOL_META } from '../types/prospector'
import { ConfirmDialog } from '../components/Dialog'

const EXAMPLES = [
  'Source 20 ESN à Paris, importe-les, récupère les dirigeants et crée une liste',
  'Trouve 15 sociétés de cybersécurité à Lyon et prépare une séquence de prospection',
  'Source 10 startups SaaS B2B, enrichis-les via le web et crée la liste',
]

const ST_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-500', running: 'bg-indigo-50 text-indigo-600',
  done: 'bg-emerald-50 text-emerald-600', failed: 'bg-red-50 text-red-500', skipped: 'bg-gray-100 text-gray-400',
}
const MI_STYLE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-500', running: 'bg-indigo-50 text-indigo-600', paused: 'bg-amber-50 text-amber-600',
  done: 'bg-emerald-50 text-emerald-600', failed: 'bg-red-50 text-red-500', cancelled: 'bg-gray-100 text-gray-400',
}
const MI_LABEL: Record<string, string> = { draft: 'À valider', running: 'En cours', paused: 'En attente de validation', done: 'Terminée', failed: 'Échec', cancelled: 'Annulée' }

function StepRow({ s, awaiting, onApprove, busy }: { s: MissionStep; awaiting?: boolean; onApprove?: () => void; busy?: boolean }) {
  const meta = MISSION_TOOL_META[s.tool]
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${awaiting ? 'border-amber-300 bg-amber-50/40' : 'border-gray-100'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${ST_STYLE[s.status]}`}>{s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? '…' : '•'}</span>
        <span className="text-sm font-medium text-gray-800">{s.label}</span>
        {meta.write && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-500">écrit</span>}
        {meta.costly && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">tokens</span>}
        {s.needsApproval && s.status === 'pending' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">validation requise</span>}
      </div>
      {Object.keys(s.params || {}).length > 0 && (
        <p className="text-[11px] text-gray-400 mt-1 font-mono">{Object.entries(s.params).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
      )}
      {s.result && <p className="text-xs text-gray-600 mt-1.5">{s.result}</p>}
      {awaiting && onApprove && (
        <button onClick={onApprove} disabled={busy} className="mt-2 text-xs font-semibold gradient-brand text-white px-3 py-1.5 rounded-lg disabled:opacity-40">Valider cette étape et continuer</button>
      )}
    </div>
  )
}

export default function MissionsPage() {
  const [request, setRequest] = useState('')
  const [planning, setPlanning] = useState(false)
  const [draft, setDraft] = useState<Mission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missions, setMissions] = useState<Mission[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [awaiting, setAwaiting] = useState<MissionStep | null>(null)
  const [toDelete, setToDelete] = useState<Mission | null>(null)

  const load = () => fetch('/api/missions').then((r) => r.json()).then((d) => setMissions(d.missions || [])).catch(() => {})
  useEffect(() => { load() }, [])

  const plan = async (text?: string) => {
    const q = (text ?? request).trim(); if (!q) return
    setRequest(q); setPlanning(true); setError(null); setDraft(null)
    try {
      const d = await fetch('/api/missions/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: q }) }).then((r) => r.json())
      if (d.error) setError(d.error); else setDraft(d.mission)
    } catch { setError('Planification indisponible.') } finally { setPlanning(false) }
  }

  // Boucle d'exécution : une étape par appel, s'arrête sur pause/fin/échec.
  const drive = async (id: string, approveFirst = false) => {
    setBusy(true); setAwaiting(null)
    let approve = approveFirst
    for (let i = 0; i < 20; i++) {
      const d = await fetch('/api/missions/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, approve }) }).then((r) => r.json())
      approve = false
      if (d.error) break
      const m: Mission = d.mission
      setMissions((prev) => prev.map((x) => x.id === m.id ? m : x))
      if (d.awaiting) { setAwaiting(d.awaiting); break }
      if (m.status !== 'running') break
    }
    setBusy(false); load()
  }

  const launch = async () => {
    if (!draft) return
    setBusy(true)
    const m = { ...draft, status: 'running' as const }
    await fetch('/api/missions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mission: m }) })
    setMissions((prev) => [m, ...prev]); setOpenId(m.id); setDraft(null); setRequest('')
    await drive(m.id)
  }

  const remove = async (m: Mission) => {
    await fetch('/api/missions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: m.id }) })
    setToDelete(null); load()
  }

  return (
    <>
      <Head><title>Prospector · Missions</title></Head>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Missions</h1>
        <p className="text-gray-400 text-sm mt-0.5">Confie un objectif à Jarvis : il propose un plan, <strong className="text-gray-500">tu valides</strong>, puis il exécute étape par étape — avec les preuves.</p>
      </div>

      {/* Demande */}
      <div className="card p-5 mb-5">
        <label className="block text-xs font-semibold text-gray-500 mb-1.5">Objectif de la mission</label>
        <div className="flex gap-2 mb-3">
          <input value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && plan()} placeholder="ex : source 20 ESN à Paris, importe-les et crée une liste" className="flex-1 px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
          <button onClick={() => plan()} disabled={planning || !request.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40 flex-shrink-0">{planning ? 'Analyse…' : 'Préparer la mission'}</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] text-gray-400 self-center mr-1">Exemples :</span>
          {EXAMPLES.map((e) => <button key={e} onClick={() => plan(e)} className="text-xs font-medium px-2.5 py-1 rounded-full text-gray-500 bg-gray-50 border border-gray-200 hover:border-indigo-300">{e}</button>)}
        </div>
        {error && <p className="text-xs text-red-600 mt-3">{error}</p>}
      </div>

      {/* Contrat de mission à valider */}
      {draft && (
        <div className="card p-5 mb-5 border-2 border-indigo-200">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">Contrat de mission · à valider</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{draft.autonomy === 'create' ? 'crée des données' : 'lecture seule'}</span>
          </div>
          <h2 className="text-base font-bold text-gray-900">{draft.title}</h2>
          <p className="text-sm text-gray-500 mb-3">{draft.objective}</p>

          {draft.assumptions.length > 0 && (
            <div className="mb-2"><p className="text-[11px] font-semibold text-gray-400 mb-1">Hypothèses prises</p>
              <ul className="text-xs text-gray-600 space-y-0.5">{draft.assumptions.map((a, i) => <li key={i}>· {a}</li>)}</ul></div>
          )}
          {draft.missing.length > 0 && (
            <div className="mb-3 bg-amber-50/60 border border-amber-100 rounded-xl p-2.5"><p className="text-[11px] font-semibold text-amber-700 mb-1">Informations manquantes</p>
              <ul className="text-xs text-amber-800 space-y-0.5">{draft.missing.map((a, i) => <li key={i}>· {a}</li>)}</ul></div>
          )}

          <p className="text-[11px] font-semibold text-gray-400 mb-1.5">Plan ({draft.steps.length} étapes)</p>
          <div className="space-y-1.5 mb-4">{draft.steps.map((s) => <StepRow key={s.id} s={s} />)}</div>

          <div className="flex items-center gap-2">
            <button onClick={launch} disabled={busy} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">Valider et lancer</button>
            <button onClick={() => setDraft(null)} className="text-sm text-gray-500 px-3 py-2">Annuler</button>
            <span className="text-[11px] text-gray-400 ml-auto">Les étapes « validation requise » te redemanderont confirmation.</span>
          </div>
        </div>
      )}

      {/* Missions */}
      {missions.length === 0 && !draft ? (
        <div className="card p-8 text-center"><p className="text-sm text-gray-500">Aucune mission pour l'instant.</p><p className="text-xs text-gray-400 mt-1">Décris un objectif ci-dessus — Jarvis prépare le plan, tu gardes la main.</p></div>
      ) : (
        <div className="space-y-3">
          {missions.map((m) => {
            const open = openId === m.id
            const doneCount = m.steps.filter((s) => s.status === 'done').length
            return (
              <div key={m.id} className="card overflow-hidden">
                <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={() => setOpenId(open ? null : m.id)}>
                  <span className="w-9 h-9 rounded-xl gradient-brand flex items-center justify-center text-white flex-shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900 truncate">{m.title}</p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${MI_STYLE[m.status]}`}>{MI_LABEL[m.status]}</span>
                    </div>
                    <p className="text-xs text-gray-400">{doneCount}/{m.steps.length} étapes · {new Date(m.createdAt).toLocaleDateString('fr-FR')}</p>
                  </div>
                  {(m.status === 'paused' || m.status === 'running') && (
                    <button onClick={(e) => { e.stopPropagation(); drive(m.id, m.status === 'paused') }} disabled={busy} className="text-xs font-semibold gradient-brand text-white px-3 py-1.5 rounded-lg disabled:opacity-40 flex-shrink-0">{busy ? '…' : m.status === 'paused' ? 'Valider & continuer' : 'Continuer'}</button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setToDelete(m) }} className="text-gray-300 hover:text-red-500 flex-shrink-0"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                </div>
                {open && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-3">
                    <p className="text-xs text-gray-500 italic">« {m.request} »</p>
                    <div className="space-y-1.5">
                      {m.steps.map((s, i) => (
                        <StepRow key={s.id} s={s} awaiting={!!awaiting && m.cursor === i && m.status === 'paused'} busy={busy} onApprove={() => drive(m.id, true)} />
                      ))}
                    </div>
                    {m.context?.listId && <Link href="/lists" className="text-xs font-medium text-indigo-600 hover:underline">Voir la liste créée →</Link>}
                    {m.context?.sequenceId && <Link href="/sequences" className="text-xs font-medium text-indigo-600 hover:underline ml-3">Voir la séquence →</Link>}
                    {m.log.length > 0 && (
                      <div className="bg-white rounded-xl border border-gray-100 p-2.5">
                        <p className="text-[10px] font-semibold text-gray-400 mb-1">Journal (preuves)</p>
                        <div className="space-y-0.5">{m.log.map((l, i) => <p key={i} className="text-[11px] text-gray-500"><span className="text-gray-300">{new Date(l.at).toLocaleTimeString('fr-FR')}</span> · {l.text}</p>)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {toDelete && <ConfirmDialog title="Supprimer la mission" message={`« ${toDelete.title} » — les leads/listes créés sont conservés.`} confirmLabel="Supprimer" danger onConfirm={() => remove(toDelete)} onCancel={() => setToDelete(null)} />}
    </>
  )
}
