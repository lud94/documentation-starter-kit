import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import type { LeadDetail, LeadStatus, Stage, Sequence } from '../../types/prospector'
import { STAGE_META, STATUS_META } from '../../types/prospector'
import { getLeadDetail, enrichAll, setLeadStatus, setLeadStage, enrollInSequence, getSequences, addLeadTag, removeLeadTag, refreshDossier } from '../../lib/prospector/capabilities'
import RedactionModal from '../../components/RedactionModal'

const STATUS_ORDER: LeadStatus[] = ['chaud', 'tiede', 'froid', 'converti', 'perdu']
const STAGE_ORDER: Stage[] = ['to_invite', 'invited', 'connected', 'in_sequence', 'responded', 'meeting', 'closed']

const BAND_STYLE: Record<string, string> = {
  HOT: 'bg-red-50 text-red-600',
  WARM: 'bg-amber-50 text-amber-600',
  COLD: 'bg-sky-50 text-sky-600',
}

function scoreColor(score: number) {
  if (score >= 80) return '#059669'
  if (score >= 65) return '#f59e0b'
  return '#94a3b8'
}

function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200) }}
      className="text-gray-300 hover:text-indigo-500 transition-colors"
      title="Copier"
    >
      {ok ? (
        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      )}
    </button>
  )
}

function SectionLabel({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} /></svg>
      {children}
    </div>
  )
}

export default function LeadDetailPage() {
  const router = useRouter()
  const { id } = router.query
  const [d, setD] = useState<LeadDetail | null | undefined>(null)
  const [redactionOpen, setRedactionOpen] = useState(false)
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [seqOpen, setSeqOpen] = useState(false)
  const [enrolledMsg, setEnrolledMsg] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [iceCopied, setIceCopied] = useState(false)

  const reload = () => { if (typeof id === 'string') getLeadDetail(id).then(setD) }
  useEffect(() => { reload() /* eslint-disable-next-line */ }, [id])

  useEffect(() => { getSequences().then(setSequences) }, [])

  const enrichThis = async () => { if (typeof id === 'string') { await enrichAll([id]); reload() } }
  const changeStatus = async (s: LeadStatus) => { if (typeof id === 'string') { await setLeadStatus(id, s); reload() } }
  const changeStage = async (s: Stage) => { if (typeof id === 'string') { await setLeadStage(id, s); reload() } }
  const enroll = async (seq: Sequence) => {
    if (typeof id === 'string') { await enrollInSequence(id); reload() }
    setSeqOpen(false); setEnrolledMsg(`Ajouté à « ${seq.name} »`)
  }
  const addTag = async () => { if (typeof id === 'string' && newTag.trim()) { await addLeadTag(id, newTag); setNewTag(''); reload() } }
  const removeTag = async (t: string) => { if (typeof id === 'string') { await removeLeadTag(id, t); reload() } }
  const refreshDoss = async () => { if (typeof id === 'string') { await refreshDossier(id); reload() } }

  if (d === undefined) return <p className="text-gray-400 text-sm">Lead introuvable.</p>
  if (!d) return <p className="text-gray-400 text-sm">Chargement…</p>

  const { lead, scoring, company, dossier } = d
  const initials = `${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()
  const stageMeta = STAGE_META[lead.stage]
  const recommendedId = sequences.length
    ? (lead.status === 'chaud' || lead.status === 'converti'
        ? [...sequences].sort((a, b) => b.responseRate - a.responseRate)[0].id
        : (sequences.find((s) => /réchauff|nurtur/i.test(s.name)) ?? sequences[0]).id)
    : null

  return (
    <>
      <Head><title>Prospector · {lead.firstName} {lead.lastName}</title></Head>

      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors mb-4">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Retour au pipeline
      </Link>

      {/* Header */}
      <div className="card p-5 mb-4">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-16 h-16 rounded-2xl gradient-brand flex items-center justify-center text-white font-bold text-xl flex-shrink-0">{initials}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{lead.firstName} {lead.lastName}</h1>
              {d.premium && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">👑 Premium</span>}
              {d.openProfile && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Open Profile</span>}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${BAND_STYLE[scoring.band]}`}>{scoring.band === 'HOT' ? 'Chaud 🔥' : scoring.band === 'WARM' ? 'Tiède' : 'Froid'}</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: stageMeta.color }}>{stageMeta.label}</span>
            </div>
            <p className="text-sm text-gray-500 mt-1">{d.headline}</p>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-xs text-gray-400 bg-gray-50 border border-gray-100 px-2 py-0.5 rounded-full">{d.connectionDegree}</span>
              {d.tags.map((t) => (
                <span key={t} className="text-xs text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                  {t}
                  <button onClick={() => removeTag(t)} className="hover:text-indigo-700">×</button>
                </span>
              ))}
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addTag() }}
                placeholder="+ tag"
                className="text-xs w-16 px-2 py-0.5 rounded-full bg-white border border-gray-200 focus:outline-none focus:border-indigo-400 focus:w-28 transition-all"
              />
            </div>
          </div>
          <div className="flex flex-col items-center flex-shrink-0">
            <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold" style={{ backgroundColor: scoreColor(lead.score) }}>{lead.score}</div>
            <span className="text-xs text-gray-400 mt-1">Score</span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <button onClick={() => setRedactionOpen(true)} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            Envoyer un message
          </button>
          <button className="text-sm font-medium text-gray-600 bg-gray-50 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors">LinkedIn</button>
          <button onClick={() => setHandoffOpen(true)} className="text-sm font-medium text-violet-600 bg-violet-50 px-3 py-2 rounded-xl hover:bg-violet-100 transition-colors flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
            Ouvrir dans Prospector Lab
          </button>
          {/* Ajouter à séquence */}
          <div className="relative">
            <button onClick={() => setSeqOpen((v) => !v)} className="text-sm font-medium text-gray-600 bg-gray-50 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors flex items-center gap-1.5">
              + Ajouter à séquence
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {seqOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setSeqOpen(false)} />
                <div className="absolute left-0 mt-2 w-72 card p-1.5 z-40">
                  {sequences.map((s) => (
                    <button key={s.id} onClick={() => enroll(s)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 text-left transition-colors">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-800 truncate">{s.name}</span>
                        <span className="block text-xs text-gray-400">{s.enrolled} leads · {s.responseRate}% réponses</span>
                      </span>
                      {s.id === recommendedId && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white flex-shrink-0">Recommandée</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Stage */}
          <select value={lead.stage} onChange={(e) => changeStage(e.target.value as Stage)} className="text-sm font-medium text-gray-600 bg-gray-50 px-3 py-2 rounded-xl focus:outline-none focus:border-indigo-400 border border-transparent cursor-pointer">
            {STAGE_ORDER.map((s) => <option key={s} value={s}>Étape : {STAGE_META[s].label}</option>)}
          </select>

          {/* Statut */}
          <select value={lead.status} onChange={(e) => changeStatus(e.target.value as LeadStatus)} className="text-sm font-medium text-gray-600 bg-gray-50 px-3 py-2 rounded-xl focus:outline-none focus:border-indigo-400 border border-transparent cursor-pointer">
            {STATUS_ORDER.map((s) => <option key={s} value={s}>Statut : {STATUS_META[s].label}</option>)}
          </select>
          <button onClick={() => setDeleteOpen(true)} className="text-sm font-medium text-red-400 px-3 py-2 rounded-xl hover:bg-red-50 transition-colors ml-auto">Supprimer</button>
        </div>
        {enrolledMsg && (
          <div className="mt-3 flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50 px-3 py-2 rounded-xl">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            {enrolledMsg}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Colonne gauche */}
        <div className="space-y-4">
          {/* Signal & accroche (issus de la recherche par signal) */}
          {(lead.signal || lead.icebreaker) && (
            <div className="card p-4 border-indigo-100 bg-indigo-50/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-lg gradient-brand text-white text-[11px] font-bold flex items-center justify-center">✦</span>
                <span className="text-xs font-semibold text-gray-700">Signal détecté</span>
              </div>
              {lead.signal && <p className="text-xs text-gray-500 mb-2">📌 {lead.signal}</p>}
              {lead.icebreaker && (
                <>
                  <div className="bg-white border border-indigo-100 rounded-lg p-2.5 mb-2">
                    <p className="text-xs text-gray-700 italic">« {lead.icebreaker} »</p>
                  </div>
                  <button
                    onClick={() => { navigator.clipboard?.writeText(lead.icebreaker || ''); setIceCopied(true); setTimeout(() => setIceCopied(false), 1500) }}
                    className="text-xs font-medium text-indigo-600 hover:underline"
                  >
                    {iceCopied ? '✓ Accroche copiée' : "Copier l'accroche"}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Prochaine action */}
          {d.nextAction && (
            <div className="card p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl icon-bg-blue flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <div>
                <p className="text-xs text-gray-400">Prochaine action</p>
                <p className="text-sm font-semibold text-gray-800">{d.nextAction.label} <span className="text-gray-400 font-normal">· {d.nextAction.when}</span></p>
              </div>
            </div>
          )}

          {/* Scoring */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-700">Scoring</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${BAND_STYLE[scoring.band]}`}>{scoring.band}</span>
                <span className="text-xs text-gray-400">({scoring.confidence})</span>
                {scoring.edgeCase && <span className="text-xs font-medium text-amber-500">Cas limite</span>}
              </div>
              <button className="text-xs text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Rescorer
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[{ l: 'Fit', v: scoring.fit, m: 40 }, { l: 'Intent', v: scoring.intent, m: 40 }, { l: 'Timing', v: scoring.timing, m: 20 }].map((x) => (
                <div key={x.l} className="bg-gray-50 rounded-xl p-2.5 text-center">
                  <p className="text-xs text-gray-400 mb-0.5">{x.l}</p>
                  <p className="text-sm font-bold text-gray-800">{x.v}<span className="text-gray-300 font-normal">/{x.m}</span></p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mb-1">Segment : <span className="font-semibold text-gray-600">{scoring.segment}</span></p>
            <p className="text-xs text-gray-500 leading-relaxed italic">{scoring.rationale}</p>
            {scoring.aiAdjustment > 0 && <p className="text-xs text-gray-400 mt-1">Ajustement IA : +{scoring.aiAdjustment}</p>}
          </div>

          {/* Coordonnées */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-2">
              <SectionLabel icon="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z">Coordonnées</SectionLabel>
              {(!lead.email || !lead.phone) && (
                <button onClick={enrichThis} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1.5 mb-2">
                  <span className="gradient-text font-semibold">✦</span> Enrichir
                </button>
              )}
            </div>
            <div className="space-y-2">
              {/* Email */}
              <div className="flex items-center gap-2 text-sm">
                <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                {lead.email ? <a href={`mailto:${lead.email}`} className="text-indigo-500 hover:underline break-all">{lead.email}</a> : <span className="text-gray-300 italic">Email à enrichir</span>}
              </div>
              {/* Téléphone */}
              <div className="flex items-center gap-2 text-sm">
                <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                {lead.phone ? <a href={`tel:${lead.phone}`} className="text-indigo-500 hover:underline">{lead.phone}</a> : <span className="text-gray-300 italic">Téléphone à enrichir</span>}
              </div>
              {/* LinkedIn */}
              <div className="flex items-center gap-2 text-sm">
                <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14zM8 17v-7H6v7h2zM7 8a1 1 0 100-2 1 1 0 000 2zm11 9v-4c0-2-1-3-2.5-3S13 11 13 12v5h2v-4c0-.5.5-1 1-1s1 .5 1 1v4h1z" /></svg>
                <a href={`https://${d.linkedinUrl}`} target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline break-all">{d.linkedinUrl}</a>
              </div>
            </div>
          </div>

          {/* Entreprise */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <SectionLabel icon="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2M5 21H3m2-14h2m6 0h2m-8 4h2m6 0h2m-8 4h2m6 0h2">Entreprise</SectionLabel>
              <button className="text-xs text-indigo-500 hover:text-indigo-700 flex items-center gap-1 mb-2">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                Enrichir
              </button>
            </div>
            <p className="font-semibold text-gray-800 text-sm">{company.name}</p>
            <p className="text-xs text-gray-500 mt-1">{company.size} · {company.location}</p>
            <a href={`https://${company.website}`} target="_blank" rel="noreferrer" className="text-xs text-indigo-500 hover:underline">{company.website}</a>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-xs text-gray-400">Secteur</p>
                <p className="text-xs font-medium text-gray-700">{company.sector}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-xs text-gray-400">Funding</p>
                <p className="text-xs font-medium text-gray-700">{company.funding}</p>
              </div>
            </div>
            <p className="text-xs text-gray-400 italic mt-3 leading-relaxed">{company.description}</p>
          </div>
        </div>

        {/* Colonne droite — Dossier d'attaque */}
        <div className="lg:col-span-2 space-y-4">
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                <h2 className="text-sm font-bold text-gray-800">Dossier d'attaque</h2>
              </div>
              <div className="flex items-center gap-2">
                {dossier.stale ? (
                  <>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">⚠ À rafraîchir · {dossier.ageLabel}</span>
                    <button onClick={refreshDoss} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full hover:bg-indigo-100 transition-colors flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      Rafraîchir
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{dossier.status === 'solide' ? '✓ Solide' : 'Moyen'}</span>
                    <span className="text-xs text-gray-400">{dossier.ageLabel}</span>
                  </>
                )}
              </div>
            </div>

            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Mécanisme</p>
            <p className="text-sm text-gray-700 mb-4">{dossier.mecanisme}</p>

            {/* Accroche pivot */}
            <SectionLabel icon="M13 10V3L4 14h7v7l9-11h-7z">Accroche pivot</SectionLabel>
            <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl px-4 py-3 mb-4 flex items-start justify-between gap-3">
              <p className="text-sm text-gray-700 italic leading-relaxed">« {dossier.accrochePivot} »</p>
              <Copy text={dossier.accrochePivot} />
            </div>

            <SectionLabel icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z">Pourquoi maintenant</SectionLabel>
            <p className="text-sm text-gray-600 bg-gray-50 rounded-xl px-4 py-3 mb-4 leading-relaxed">{dossier.pourquoiMaintenant}</p>

            <SectionLabel icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z">Preuves vérifiables</SectionLabel>
            <ul className="space-y-1.5 mb-4">
              {dossier.preuves.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                  <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {p}
                </li>
              ))}
            </ul>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <SectionLabel icon="M5 13l4 4L19 7">À intégrer</SectionLabel>
                <ul className="space-y-1.5">
                  {dossier.aIntegrer.map((x, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="text-emerald-500 mt-0.5">✓</span>{x}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <SectionLabel icon="M6 18L18 6M6 6l12 12">À éviter</SectionLabel>
                <ul className="space-y-1.5">
                  {dossier.aEviter.map((x, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="text-red-400 mt-0.5">✕</span>{x}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <SectionLabel icon="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z">Question à poser</SectionLabel>
            <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl px-4 py-3 mb-4 flex items-start justify-between gap-3">
              <p className="text-sm text-gray-700 italic leading-relaxed">« {dossier.questionAPoser} »</p>
              <Copy text={dossier.questionAPoser} />
            </div>

            <SectionLabel icon="M9 5l7 7-7 7">Objectif de réponse</SectionLabel>
            <p className="text-sm text-gray-600 mb-4">{dossier.objectifReponse}</p>

            <SectionLabel icon="M12 19l9 2-9-18-9 18 9-2zm0 0v-8">Canal recommandé</SectionLabel>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold px-2 py-1 rounded-lg bg-indigo-50 text-indigo-600">{dossier.canalRecommande}</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed mb-4">{dossier.canalRationale}</p>

            {/* Réserves — honnêteté épistémique, mise en évidence */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 mb-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                Réserves — ce qu'on ne sait pas encore
              </div>
              <ul className="space-y-1">
                {dossier.reserves.map((r, i) => (
                  <li key={i} className="text-xs text-amber-800 leading-relaxed">{i + 1}. {r}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* Notes */}
          <div className="card p-5">
            <SectionLabel icon="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z">Notes</SectionLabel>
            <p className="text-sm text-gray-400 italic">Aucune note pour ce lead.</p>
          </div>

          {/* Historique */}
          <div className="card p-5">
            <SectionLabel icon="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z">Historique des interactions</SectionLabel>
            {d.interactions.length === 0 ? (
              <p className="text-sm text-gray-400 italic">Aucune interaction enregistrée.</p>
            ) : (
              <div className="space-y-2">
                {d.interactions.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 text-sm">
                    <span className="w-1.5 h-1.5 rounded-full gradient-brand" />
                    <span className="text-gray-600">{it.text}</span>
                    <span className="text-xs text-gray-400 ml-auto">{it.date}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {redactionOpen && <RedactionModal detail={d} onClose={() => setRedactionOpen(false)} />}

      {handoffOpen && (() => {
        const dispositif = `# DISPOSITIF DE RÉDACTION — ${lead.company} / ${lead.firstName} ${lead.lastName}

## Destinataire
- Nom + titre : ${lead.firstName} ${lead.lastName}, ${lead.title} ${lead.company}
- LinkedIn URL : https://${d.linkedinUrl}
- Profil de lecture : ${dossier.canalRationale}

## Angle du message
- **Mécanisme rhétorique** : ${dossier.mecanisme}
- **Accroche pivot** (15-25 mots MAX) : ${dossier.accrochePivot}
- **Signal déclencheur** : ${dossier.pourquoiMaintenant}

## Preuves vérifiables
${dossier.preuves.map((p) => `- ${p}`).join('\n')}

## À éviter
${dossier.aEviter.map((p) => `- ${p}`).join('\n')}
`
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setHandoffOpen(false)} />
            <div className="relative card w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-gray-900">Handoff vers Prospector Lab</h2>
                  <p className="text-xs text-gray-400">Le Dossier d'attaque converti en Dispositif V7.2 — à coller dans le Lab pour le craft du message.</p>
                </div>
                <button onClick={() => setHandoffOpen(false)} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
              <div className="p-5 overflow-y-auto">
                <pre className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-xl p-4 whitespace-pre-wrap leading-relaxed font-mono">{dispositif}</pre>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
                <button onClick={() => { navigator.clipboard?.writeText(dispositif); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="text-sm font-medium text-gray-600 bg-gray-50 px-4 py-2 rounded-xl hover:bg-gray-100 transition-colors">
                  {copied ? '✓ Copié' : 'Copier le Dispositif'}
                </button>
                <a href="https://claude.ai/public/artifacts/df4372aa-c12e-44c8-a8bb-e4341814d718" target="_blank" rel="noreferrer" className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-2">
                  Ouvrir Prospector Lab
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
            </div>
          </div>
        )
      })()}

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setDeleteOpen(false)} />
          <div className="relative card p-6 max-w-sm w-full">
            <div className="w-11 h-11 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center mb-3">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </div>
            <h2 className="text-base font-bold text-gray-900 mb-1">Supprimer ce lead ?</h2>
            <p className="text-sm text-gray-500 mb-4">{lead.firstName} {lead.lastName} ({lead.company}) sera retiré de votre base. Cette action est irréversible.</p>
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => setDeleteOpen(false)} className="text-sm font-medium text-gray-600 bg-gray-50 px-4 py-2 rounded-xl hover:bg-gray-100 transition-colors">Annuler</button>
              <Link href="/pipeline" className="text-sm font-semibold text-white bg-red-500 px-4 py-2 rounded-xl hover:bg-red-600 transition-colors">Supprimer</Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
