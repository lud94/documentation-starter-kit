import { useEffect, useState } from 'react'
import { getLists, createList, addToList, type LeadList } from '../lib/prospector/capabilities'

// Modale « Ajouter à une liste » : cocher des listes existantes et/ou en créer une.
// Réutilisable (fiche contact, sélection pipeline…). `leadIds` = leads à ajouter.
export default function AddToListModal({ leadIds, label, onClose, onDone }: {
  leadIds: string[]
  label?: string
  onClose: () => void
  onDone?: (msg: string) => void
}) {
  const [lists, setLists] = useState<LeadList[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { getLists().then((l) => { setLists(l); setLoading(false) }) }, [])
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const confirm = async () => {
    if (sel.size === 0 && !newName.trim()) return
    setBusy(true)
    let added = 0
    for (const id of Array.from(sel)) { await addToList(id, leadIds); added++ }
    if (newName.trim()) { await createList(newName, leadIds, 'depuis fiche'); added++ }
    setBusy(false)
    onDone?.(`Ajouté à ${added} liste${added > 1 ? 's' : ''}.`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card p-6 max-w-md w-full">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Ajouter à une liste</h2>
        <p className="text-sm text-gray-500 mb-4">{label || `${leadIds.length} lead(s)`} → choisis des listes ou crée-en une.</p>

        {loading ? <p className="text-sm text-gray-400 mb-3">Chargement…</p> : lists.length === 0 ? (
          <p className="text-sm text-gray-400 mb-3">Aucune liste existante — crée la première ci-dessous.</p>
        ) : (
          <div className="space-y-1.5 mb-4 max-h-52 overflow-y-auto">
            {lists.map((l) => {
              const on = sel.has(l.id)
              return (
                <button key={l.id} onClick={() => toggle(l.id)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-50 text-left">
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'gradient-brand border-transparent' : 'border-gray-300'}`}>
                    {on && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-800 truncate">{l.name}</span>
                    <span className="block text-xs text-gray-400">{l.leadIds.length} lead(s)</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex items-center gap-2 mb-4">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirm()} placeholder="Ou nouvelle liste…" className="flex-1 px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-gray-500 px-3 py-2">Annuler</button>
          <button onClick={confirm} disabled={busy || (sel.size === 0 && !newName.trim())} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">{busy ? '…' : 'Ajouter'}</button>
        </div>
      </div>
    </div>
  )
}
