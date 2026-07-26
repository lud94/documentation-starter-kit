import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Lead, Stage, LeadStatus } from '../types/prospector'
import { STAGE_META, STATUS_META } from '../types/prospector'
import { getLeads, enrichEmails, enrichAll, setLeadStatus, promoteDirigeant, getAccountDetail, addAccountContact, verifyLeadCompany, isAccountLead, PERSONAS } from '../lib/prospector/capabilities'
import type { AccountDetail } from '../lib/prospector/capabilities'
import EnrichModal from '../components/EnrichModal'

const STAGE_ORDER: Stage[] = ['to_invite', 'invited', 'connected', 'in_sequence', 'responded', 'meeting', 'closed']
const STATUS_ORDER: LeadStatus[] = ['chaud', 'tiede', 'froid', 'converti', 'perdu']

function scoreColor(s: number) { return s >= 80 ? '#059669' : s >= 65 ? '#f59e0b' : '#94a3b8' }

function EnrichDots({ lead }: { lead: Lead }) {
  return (
    <span className="flex items-center gap-1">
      <span title={lead.email ?? 'Email manquant'} className="inline-flex">
        <svg className={`w-3.5 h-3.5 ${lead.email ? 'text-emerald-500' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
      </span>
      <span title={lead.phone ?? 'Téléphone manquant'} className="inline-flex">
        <svg className={`w-3.5 h-3.5 ${lead.phone ? 'text-emerald-500' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
      </span>
    </span>
  )
}

function MultiFilter({ label, options, selected, onToggle, onClear }: {
  label: string
  options: { value: string; label: string }[]
  selected: Set<string>
  onToggle: (v: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-1.5">
        {label}
        {selected.size > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full gradient-brand text-white">{selected.size}</span>}
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-2 w-52 card p-1.5 z-40">
            {options.map((o) => {
              const on = selected.has(o.value)
              return (
                <button key={o.value} onClick={() => onToggle(o.value)} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 text-sm text-gray-700 text-left">
                  <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'gradient-brand border-transparent' : 'border-gray-300'}`}>
                    {on && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                  </span>
                  {o.label}
                </button>
              )
            })}
            {selected.size > 0 && <button onClick={onClear} className="w-full text-xs text-gray-400 hover:text-gray-600 px-2.5 py-1.5 text-left">Effacer</button>}
          </div>
        </>
      )}
    </div>
  )
}

function LeadCard({ lead }: { lead: Lead }) {
  const initials = `${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()
  const sm = STATUS_META[lead.status]
  return (
    <Link href={`/leads/${lead.id}`} className="block bg-white rounded-xl border border-gray-100 p-3 hover:shadow-sm hover:border-gray-200 transition-all">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{initials}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</p>
          <p className="text-xs text-gray-400 truncate">{lead.title}</p>
        </div>
        {lead.score > 0
          ? <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style={{ backgroundColor: scoreColor(lead.score) }}>{lead.score}</span>
          : <span className="w-7 h-7 rounded-full flex items-center justify-center text-gray-300 text-xs flex-shrink-0 border border-gray-200">—</span>}
      </div>
      <div className="flex items-center justify-between mt-2.5">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sm.bg}`}>{sm.label}</span>
        <EnrichDots lead={lead} />
      </div>
    </Link>
  )
}

// ── Vue COMPTES : une ligne = une entreprise, dépliable vers ses contacts ──────
// Un compte SANS personne reste ici (jamais dans « à inviter »). « Sélectionner
// tout le compte » puis « Enrôler » = N actions INDIVIDUELLES (une par personne).
const fmtEuro = (n?: number) => (typeof n === 'number' ? new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(n) + ' €' : null)

function AccountCard({ company, account, contacts, onChanged }: { company: string; account?: Lead; contacts: Lead[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [detail, setDetail] = useState<AccountDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [cf, setCf] = useState({ firstName: '', lastName: '', title: '', persona: '', email: '', linkedinUrl: '' })
  // Métadonnées entreprise : le lead-compte, sinon le 1er contact porteur d'un SIREN.
  const meta = account || contacts.find((c) => c.siren) || contacts[0]
  const hasDirigeantContact = contacts.some((c) => (meta?.dirigeant || '').toLowerCase().includes((c.lastName || '').toLowerCase()) && c.lastName)
  const loadDetail = async () => { if (!detail && meta?.siren) { setLoadingDetail(true); const d = await getAccountDetail(meta.siren); setDetail(d); setLoadingDetail(false) } }
  const expand = async () => { const next = !open; setOpen(next); if (next) loadDetail() }
  const flash = (m: string) => { setMsg(m); onChanged(); setTimeout(() => setMsg(null), 3000) }
  const promote = async () => { if (!account) return; setBusy(true); await promoteDirigeant(account.id); setBusy(false); flash('Dirigeant ajouté comme contact.') }
  const verify = async () => {
    if (!account) return
    setBusy(true); const r = await verifyLeadCompany(account.id); setBusy(false); setDetail(null); await loadDetail()
    flash(r?.found ? 'Entreprise vérifiée (data.gouv).' : 'Entreprise introuvable sur data.gouv — précise le nom.')
  }
  const addContact = async () => {
    if (!account || (!cf.firstName.trim() && !cf.lastName.trim())) return
    setBusy(true); await addAccountContact(account.id, cf); setBusy(false)
    setCf({ firstName: '', lastName: '', title: '', persona: '', email: '', linkedinUrl: '' }); setAddOpen(false)
    flash('Contact ajouté au compte → il entre dans « à inviter ».')
  }
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={expand}>
        <span className="w-9 h-9 rounded-xl gradient-brand flex items-center justify-center text-white text-sm font-bold flex-shrink-0">{company.slice(0, 2).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 truncate">{company}</p>
            {meta?.siren
              ? <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.active === false ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600'}`}>{meta.active === false ? 'Radiée' : 'Active'}</span>
              : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Non vérifiée</span>}
            {meta?.siren && <span className="text-[10px] text-gray-400 font-mono">SIREN {meta.siren}</span>}
            {contacts.length === 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">Compte seul · 0 contact</span>}
          </div>
          <p className="text-xs text-gray-400 truncate mt-0.5">
            {[meta?.dirigeant && `Dirigeant : ${meta.dirigeant}`, meta?.city, meta?.effectif && `${meta.effectif} sal.`, meta?.website].filter(Boolean).join(' · ') || 'Infos entreprise à enrichir'}
          </p>
        </div>
        <span className="text-xs font-semibold text-gray-500 bg-gray-100 rounded-full px-2.5 py-1 flex-shrink-0">{contacts.length} contact{contacts.length > 1 ? 's' : ''}</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </div>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-3">
          {/* Fiche compte (data.gouv) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { k: 'Effectif', v: (detail?.effectif || meta?.effectif) ? `${detail?.effectif || meta?.effectif} sal.` : '—' },
              { k: 'Chiffre d\'affaires', v: (detail?.finances && fmtEuro(detail.finances.ca)) ? `${fmtEuro(detail!.finances!.ca)} (${detail!.finances!.year})` : (loadingDetail ? '…' : 'non publié') },
              { k: 'Dirigeants', v: detail ? String(detail.dirigeants.length || (meta?.dirigeant ? 1 : 0)) : (loadingDetail ? '…' : (meta?.dirigeant ? '1' : '—')) },
              { k: 'Secteur (NAF)', v: detail?.naf || meta?.naf || '—' },
            ].map((s) => (
              <div key={s.k} className="bg-white rounded-lg border border-gray-100 px-2.5 py-2">
                <p className="text-[10px] font-semibold text-gray-400">{s.k}</p>
                <p className="text-xs font-medium text-gray-700 truncate">{s.v}</p>
              </div>
            ))}
          </div>
          {detail && detail.dirigeants.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {detail.dirigeants.map((d, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-600">
                  {d.name}{d.role ? ` · ${d.role}` : ''}{d.type === 'morale' ? ' (pers. morale)' : ''}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-400">Site web / email ne sont pas exposés par data.gouv (SIRENE). {meta?.website ? <>Site : <a href={`https://${meta.website}`} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">{meta.website}</a></> : 'À compléter via Unipile/web (manuel).'}</p>

          {/* Actions compte */}
          {account && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={verify} disabled={busy} className="text-xs font-medium text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-white disabled:opacity-40 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                {meta?.siren ? 'Revérifier l\'entreprise' : 'Vérifier l\'entreprise'}
              </button>
              {meta?.dirigeant && !hasDirigeantContact && <button onClick={promote} disabled={busy} className="text-xs font-medium text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-white disabled:opacity-40">+ Dirigeant en contact</button>}
              <button onClick={() => setAddOpen((v) => !v)} className="text-xs font-semibold gradient-brand text-white px-2.5 py-1.5 rounded-lg">+ Renseigner un contact / persona</button>
            </div>
          )}

          {/* Formulaire ajout contact */}
          {addOpen && account && (
            <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input value={cf.firstName} onChange={(e) => setCf({ ...cf, firstName: e.target.value })} placeholder="Prénom" className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400" />
                <input value={cf.lastName} onChange={(e) => setCf({ ...cf, lastName: e.target.value })} placeholder="Nom" className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400" />
                <input value={cf.title} onChange={(e) => setCf({ ...cf, title: e.target.value })} placeholder="Titre (ex: Head of Sales)" className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400" />
                <select value={cf.persona} onChange={(e) => setCf({ ...cf, persona: e.target.value })} className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400 text-gray-600">
                  <option value="">Persona…</option>{PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} placeholder="Email (optionnel)" className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400" />
                <input value={cf.linkedinUrl} onChange={(e) => setCf({ ...cf, linkedinUrl: e.target.value })} placeholder="URL LinkedIn (optionnel)" className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-400" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setAddOpen(false)} className="text-xs text-gray-400 px-2.5 py-1.5">Annuler</button>
                <button onClick={addContact} disabled={busy || (!cf.firstName.trim() && !cf.lastName.trim())} className="text-xs font-semibold gradient-brand text-white px-3 py-1.5 rounded-lg disabled:opacity-40">Ajouter le contact</button>
              </div>
            </div>
          )}

          {/* Contacts rattachés */}
          {contacts.length === 0 ? (
            <p className="text-xs text-gray-400">Aucun contact rattaché. Renseigne une personne (ci-dessus) ou résous les personas via Unipile — rien n'est inventé.</p>
          ) : (
            <div className="space-y-1.5">
              {contacts.map((c) => {
                const sm = STAGE_META[c.stage]
                return (
                  <Link key={c.id} href={`/leads/${c.id}`} className="flex items-center gap-2.5 bg-white rounded-lg border border-gray-100 px-3 py-2 hover:border-gray-200">
                    <span className="w-7 h-7 rounded-lg gradient-brand flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">{`${(c.firstName[0] || '')}${(c.lastName[0] || '')}`.toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-800 truncate">{c.firstName} {c.lastName}</span>
                      <span className="block text-xs text-gray-400 truncate">{c.title}{c.persona ? ` · ${c.persona}` : ''}</span>
                    </span>
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full text-white flex-shrink-0" style={{ backgroundColor: sm.color }}>{sm.label}</span>
                  </Link>
                )
              })}
            </div>
          )}
          {msg && <p className="text-[11px] text-emerald-600">{msg}</p>}
        </div>
      )}
    </div>
  )
}

function AccountsView({ leads, onChanged }: { leads: Lead[]; onChanged: () => void }) {
  const groups = new Map<string, { account?: Lead; contacts: Lead[] }>()
  for (const l of leads) {
    const k = l.company || '—'
    if (!groups.has(k)) groups.set(k, { contacts: [] })
    const g = groups.get(k)!
    if (isAccountLead(l)) g.account = l
    else g.contacts.push(l)
  }
  const entries = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  if (entries.length === 0) return <p className="text-sm text-gray-400 text-center py-12">Aucun compte. Importe des entreprises depuis Sourcing.</p>
  return (
    <div className="space-y-3">
      {entries.map(([company, g]) => <AccountCard key={company} company={company} account={g.account} contacts={g.contacts} onChanged={onChanged} />)}
    </div>
  )
}

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'kanban' | 'table'>('kanban')
  const [mainView, setMainView] = useState<'contacts' | 'comptes'>('contacts')
  const [query, setQuery] = useState('')
  const [statusF, setStatusF] = useState<Set<string>>(new Set())
  const [stageF, setStageF] = useState<Set<string>>(new Set())
  const [personaF, setPersonaF] = useState<Set<string>>(new Set())
  const [enrichF, setEnrichF] = useState<'all' | 'enriched' | 'no_email' | 'no_phone'>('all')
  const [importOpen, setImportOpen] = useState(false)
  const [enrichOpen, setEnrichOpen] = useState(false)

  const refresh = () => getLeads().then((l) => { setLeads(l); setLoading(false) })
  useEffect(() => { refresh() }, [])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n)
  }

  const q = query.trim().toLowerCase()
  const filtered = leads.filter((l) => {
    if (q && !`${l.firstName} ${l.lastName} ${l.company} ${l.title}`.toLowerCase().includes(q)) return false
    if (statusF.size > 0 && !statusF.has(l.status)) return false
    if (stageF.size > 0 && !stageF.has(l.stage)) return false
    if (personaF.size > 0 && !personaF.has(l.persona ?? 'Autre')) return false
    if (enrichF === 'enriched' && !(l.email && l.phone)) return false
    if (enrichF === 'no_email' && l.email) return false
    if (enrichF === 'no_phone' && l.phone) return false
    return true
  })
  // La vue Contacts n'affiche QUE des personnes (les comptes seuls restent en vue Comptes).
  const contactLeads = filtered.filter((l) => !isAccountLead(l))
  const byStage = (s: Stage) => contactLeads.filter((l) => l.stage === s)
  const hasFilter = query || statusF.size || stageF.size || personaF.size || enrichF !== 'all'

  const changeStatus = async (id: string, status: LeadStatus) => { await setLeadStatus(id, status); refresh() }
  const doEnrich = async (ids: string[], mode: 'email' | 'full') => {
    if (mode === 'email') await enrichEmails(ids); else await enrichAll(ids)
    setEnrichOpen(false); refresh()
  }

  const exportCsv = () => {
    const rows = [['Nom', 'Titre', 'Entreprise', 'Statut', 'Stage', 'Score', 'Email', 'Téléphone'],
      ...filtered.map((l) => [`${l.firstName} ${l.lastName}`, l.title, l.company, STATUS_META[l.status].label, STAGE_META[l.stage].label, l.score, l.email ?? '', l.phone ?? ''])]
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = 'prospector-pipeline.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const btn = 'text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2'

  return (
    <>
      <Head><title>Prospector · Pipeline & Leads</title></Head>

      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline &amp; Leads</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {loading ? 'Chargement…'
              : mainView === 'comptes' ? `${new Set(filtered.map((l) => l.company)).size} comptes · ${contactLeads.length} contacts`
              : hasFilter ? `${contactLeads.length} contacts filtrés` : `${contactLeads.length} contacts dans votre base`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {([['contacts', 'Contacts'], ['comptes', 'Comptes']] as const).map(([v, label]) => (
              <button key={v} onClick={() => setMainView(v)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${mainView === v ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{label}</button>
            ))}
          </div>
          <button onClick={() => setEnrichOpen(true)} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Enrichir un lot
          </button>
          <button onClick={() => setImportOpen(true)} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Importer CSV
          </button>
          <button onClick={exportCsv} className={btn}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 4h16v16H4z" /></svg>
            Exporter
          </button>
        </div>
      </div>

      {/* Filtres */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher par nom, entreprise, titre…" className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-white border border-gray-200 focus:outline-none focus:border-indigo-400 transition-all" />
        </div>
        <MultiFilter label="Statut" options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label }))} selected={statusF} onToggle={(v) => toggle(statusF, setStatusF, v)} onClear={() => setStatusF(new Set())} />
        <MultiFilter label="Stage" options={STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))} selected={stageF} onToggle={(v) => toggle(stageF, setStageF, v)} onClear={() => setStageF(new Set())} />
        <MultiFilter label="Persona" options={PERSONAS.map((p) => ({ value: p, label: p }))} selected={personaF} onToggle={(v) => toggle(personaF, setPersonaF, v)} onClear={() => setPersonaF(new Set())} />
        <select value={enrichF} onChange={(e) => setEnrichF(e.target.value as typeof enrichF)} className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-2 rounded-xl focus:outline-none focus:border-indigo-400">
          <option value="all">Enrichissement : tous</option>
          <option value="enriched">Enrichis (email + tél)</option>
          <option value="no_email">Email manquant</option>
          <option value="no_phone">Téléphone manquant</option>
        </select>
        {mainView === 'contacts' && (
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['kanban', 'table'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${view === v ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{v === 'kanban' ? 'Kanban' : 'Table'}</button>
            ))}
          </div>
        )}
        {hasFilter && <button onClick={() => { setQuery(''); setStatusF(new Set()); setStageF(new Set()); setPersonaF(new Set()); setEnrichF('all') }} className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>Effacer</button>}
      </div>

      {/* Comptes (entreprises) */}
      {mainView === 'comptes' && <AccountsView leads={filtered} onChanged={refresh} />}

      {/* Table */}
      {mainView === 'contacts' && view === 'table' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-gray-100 text-left">
                {['Contact', 'Entreprise', 'Persona', 'Stage', 'Statut', 'Enrich.', 'Score'].map((h) => <th key={h} className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>)}
              </tr></thead>
              <tbody>
                {[...contactLeads].sort((a, b) => b.score - a.score).map((lead) => {
                  const sm = STAGE_META[lead.stage]
                  return (
                    <tr key={lead.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${lead.id}`} className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{`${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()}</span>
                          <span className="min-w-0"><span className="block text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</span><span className="block text-xs text-gray-400 truncate">{lead.title}</span></span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{lead.company}</td>
                      <td className="px-4 py-3">{lead.persona && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{lead.persona}</span>}</td>
                      <td className="px-4 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: sm.color }}>{sm.label}</span></td>
                      <td className="px-4 py-3">
                        <select value={lead.status} onChange={(e) => changeStatus(lead.id, e.target.value as LeadStatus)} className="text-xs font-medium bg-transparent border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-400">
                          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3"><EnrichDots lead={lead} /></td>
                      <td className="px-4 py-3">{lead.score > 0 ? <span className="w-7 h-7 rounded-full inline-flex items-center justify-center text-white text-[11px] font-bold" style={{ backgroundColor: scoreColor(lead.score) }}>{lead.score}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Kanban */}
      {mainView === 'contacts' && view === 'kanban' && (
        <div className="overflow-x-auto pb-4 -mx-6 px-6">
          <div className="flex gap-3 min-w-max">
            {STAGE_ORDER.map((stage) => {
              const meta = STAGE_META[stage]
              const items = byStage(stage)
              return (
                <div key={stage} className="w-60 flex-shrink-0">
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl" style={{ backgroundColor: `${meta.color}14` }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
                    <span className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="text-xs font-bold ml-auto" style={{ color: meta.color }}>{items.length}</span>
                  </div>
                  <div className="bg-gray-50/70 rounded-2xl p-2 space-y-2 min-h-[120px]">
                    {items.map((lead) => <LeadCard key={lead.id} lead={lead} />)}
                    {items.length === 0 && <p className="text-xs text-gray-300 text-center py-6">Vide</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {enrichOpen && <EnrichModal leads={filtered} onClose={() => setEnrichOpen(false)} onConfirm={doEnrich} />}

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setImportOpen(false)} />
          <div className="relative card p-6 max-w-md w-full">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Importer des prospects</h2>
            <p className="text-sm text-gray-500 mb-4">Chargez un CSV (nom, entreprise, titre, email…). Le mapping des colonnes se fera à l'import.</p>
            <label className="block border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-300 transition-colors mb-4">
              <input type="file" accept=".csv" className="hidden" />
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              <span className="text-sm text-gray-400">Glissez un fichier CSV ou cliquez</span>
            </label>
            <button onClick={() => setImportOpen(false)} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity">Importer</button>
          </div>
        </div>
      )}
    </>
  )
}
