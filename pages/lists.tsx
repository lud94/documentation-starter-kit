import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import type { Lead, Sequence } from '../types/prospector'
import { STATUS_META } from '../types/prospector'
import { ConfirmDialog, PromptDialog } from '../components/Dialog'
import {
  getLists, createList, deleteList, renameList, getListLeads, removeFromList,
  buildCsv, CSV_PRESETS, deployListToSequence, getSequences, isAccountLead, reconcileCollections,
  type LeadList, type CsvColumn,
} from '../lib/prospector/capabilities'

function download(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}

function ExportPanel({ leads, listName, onClose }: { leads: Lead[]; listName: string; onClose: () => void }) {
  const [preset, setPreset] = useState(CSV_PRESETS[0].key)
  const active = CSV_PRESETS.find((p) => p.key === preset)!
  const [cols, setCols] = useState<CsvColumn[]>(active.columns)
  const pickPreset = (k: string) => { setPreset(k); setCols(CSV_PRESETS.find((p) => p.key === k)!.columns) }
  const toggle = (c: CsvColumn) => setCols((cur) => cur.some((x) => x.field === c.field) ? cur.filter((x) => x.field !== c.field) : [...cur, c])
  // Univers de colonnes = union de tous les presets, dédupliqué par champ.
  const all: CsvColumn[] = []
  CSV_PRESETS.forEach((p) => p.columns.forEach((c) => { if (!all.some((x) => x.field === c.field)) all.push(c) }))
  const doExport = () => { download(buildCsv(leads, cols), `${listName.replace(/\s+/g, '-').toLowerCase()}.csv`); onClose() }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card p-6 max-w-lg w-full">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Exporter « {listName} »</h2>
        <p className="text-sm text-gray-500 mb-4">{leads.length} lignes · choisis un format puis ajuste les colonnes.</p>
        <div className="flex gap-2 mb-4 flex-wrap">
          {CSV_PRESETS.map((p) => (
            <button key={p.key} onClick={() => pickPreset(p.key)} title={p.desc} className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${preset === p.key ? 'gradient-brand text-white border-transparent' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{p.label}</button>
          ))}
        </div>
        <p className="text-xs font-semibold text-gray-400 mb-2">Colonnes ({cols.length})</p>
        <div className="flex flex-wrap gap-1.5 mb-5 max-h-40 overflow-y-auto">
          {all.map((c) => {
            const on = cols.some((x) => x.field === c.field)
            return (
              <button key={String(c.field)} onClick={() => toggle(c)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${on ? 'bg-indigo-50 text-indigo-600 border-indigo-200' : 'text-gray-400 border-gray-200'}`}>{c.header}</button>
            )
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-gray-500 px-3 py-2">Annuler</button>
          <button onClick={doExport} disabled={cols.length === 0} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">Télécharger le CSV</button>
        </div>
      </div>
    </div>
  )
}

export default function ListsPage() {
  const [lists, setLists] = useState<LeadList[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [leadsCache, setLeadsCache] = useState<Record<string, Lead[]>>({})
  const [exportFor, setExportFor] = useState<{ leads: Lead[]; name: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = () => getLists().then((l) => { setLists(l); setLoading(false) })
  useEffect(() => { reconcileCollections().then(refresh); getSequences().then(setSequences) }, [])

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000) }
  const create = async () => { if (!newName.trim()) return; await createList(newName); setNewName(''); refresh() }
  const loadLeads = async (list: LeadList) => {
    if (leadsCache[list.id]) return leadsCache[list.id]
    const leads = await getListLeads(list); setLeadsCache((m) => ({ ...m, [list.id]: leads })); return leads
  }
  const toggleOpen = async (list: LeadList) => { const next = openId === list.id ? null : list.id; setOpenId(next); if (next) await loadLeads(list) }
  const exportList = async (list: LeadList) => { const leads = await loadLeads(list); setExportFor({ leads, name: list.name }) }
  const deploy = async (list: LeadList, seqId: string) => {
    if (!seqId) return
    const r = await deployListToSequence(list, seqId)
    flash(`${r.enrolled} contact(s) déployé(s) dans la séquence.`)
    getSequences().then(setSequences)
  }
  const [toDelete, setToDelete] = useState<LeadList | null>(null)
  const [toRename, setToRename] = useState<LeadList | null>(null)
  const remove = (list: LeadList) => setToDelete(list)
  const rename = (list: LeadList) => setToRename(list)
  const unlink = async (list: LeadList, leadId: string) => { await removeFromList(list.id, leadId); setLeadsCache((m) => { const n = { ...m }; delete n[list.id]; return n }); await loadLeads(list); refresh() }

  return (
    <>
      <Head><title>Prospector · Listes</title></Head>
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Listes</h1>
          <p className="text-gray-400 text-sm mt-0.5">Regroupe des leads en listes réutilisables → export CSV (CRM) ou déploiement en séquence.</p>
        </div>
      </div>

      <div className="card p-4 mb-5 flex items-center gap-2 max-w-xl">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="Nom de la liste (ex: Head of Sales · cybersécurité)" className="flex-1 px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
        <button onClick={create} disabled={!newName.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">Créer</button>
      </div>

      {msg && <p className="text-sm text-emerald-600 mb-3">{msg}</p>}

      {loading ? <p className="text-sm text-gray-400">Chargement…</p>
      : lists.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-500 mb-1">Aucune liste pour l'instant.</p>
          <p className="text-xs text-gray-400">Crée-en une ici, ou depuis <Link href="/pipeline" className="text-indigo-600 hover:underline">Pipeline</Link> (par persona) / <Link href="/sourcing" className="text-indigo-600 hover:underline">Sourcing</Link> (depuis un signal).</p>
        </div>
      ) : (
        <div className="space-y-3">
          {lists.map((list) => {
            const leads = leadsCache[list.id] || []
            const contacts = leads.filter((l) => !isAccountLead(l))
            return (
              <div key={list.id} className="card overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <button onClick={() => toggleOpen(list)} className="w-9 h-9 rounded-xl gradient-brand flex items-center justify-center text-white flex-shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h10" /></svg>
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{list.name}</p>
                    <p className="text-xs text-gray-400">{list.leadIds.length} lead{list.leadIds.length > 1 ? 's' : ''}{list.source ? ` · ${list.source}` : ''}</p>
                  </div>
                  <button onClick={() => exportList(list)} className="text-xs font-semibold text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-50">Exporter CSV</button>
                  <select onChange={(e) => { deploy(list, e.target.value); e.target.value = '' }} defaultValue="" className="text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-400">
                    <option value="" disabled>Déployer en séquence…</option>
                    {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button onClick={() => rename(list)} title="Renommer" className="text-gray-300 hover:text-gray-600"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg></button>
                  <button onClick={() => remove(list)} title="Supprimer" className="text-gray-300 hover:text-red-500"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                </div>
                {openId === list.id && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3">
                    {leads.length === 0 ? <p className="text-xs text-gray-400">Liste vide. Ajoute des leads depuis Pipeline ou Sourcing.</p> : (
                      <>
                        <p className="text-[11px] text-gray-400 mb-2">{contacts.length} contact(s) enrôlable(s) · {leads.length - contacts.length} compte(s)</p>
                        <div className="space-y-1.5">
                          {leads.map((l) => (
                            <div key={l.id} className="flex items-center gap-2.5 bg-white rounded-lg border border-gray-100 px-3 py-2">
                              <Link href={`/leads/${l.id}`} className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-gray-800 truncate">{isAccountLead(l) ? l.company : `${l.firstName} ${l.lastName}`}</span>
                                <span className="block text-xs text-gray-400 truncate">{isAccountLead(l) ? 'Compte' : `${l.title} · ${l.company}`}</span>
                              </Link>
                              {!isAccountLead(l) && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${STATUS_META[l.status].bg}`}>{STATUS_META[l.status].label}</span>}
                              <button onClick={() => unlink(list, l.id)} title="Retirer de la liste" className="text-gray-300 hover:text-red-500"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {exportFor && <ExportPanel leads={exportFor.leads} listName={exportFor.name} onClose={() => setExportFor(null)} />}
      {toDelete && <ConfirmDialog title="Supprimer la liste" message={`« ${toDelete.name} » — les leads ne sont pas supprimés.`} confirmLabel="Supprimer" danger onConfirm={async () => { await deleteList(toDelete.id); setToDelete(null); refresh() }} onCancel={() => setToDelete(null)} />}
      {toRename && <PromptDialog title="Renommer la liste" defaultValue={toRename.name} onSubmit={async (n) => { await renameList(toRename.id, n); setToRename(null); refresh() }} onCancel={() => setToRename(null)} />}
    </>
  )
}
