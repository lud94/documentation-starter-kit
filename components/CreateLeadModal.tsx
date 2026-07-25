import { useState } from 'react'
import { useRouter } from 'next/router'
import { addLead, addLeadsFromCsv } from '../lib/prospector/capabilities'

type Mode = 'linkedin' | 'manual' | 'csv'
const field = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

export default function CreateLeadModal({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const router = useRouter()
  const [f, setF] = useState({ firstName: '', lastName: '', title: '', company: '', email: '', linkedinUrl: '' })
  const [csv, setCsv] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  const title = mode === 'linkedin' ? 'Ajouter depuis LinkedIn' : mode === 'manual' ? 'Ajouter un lead' : 'Importer un CSV'

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      if (mode === 'csv') {
        const { added } = await addLeadsFromCsv(csv)
        setMsg(`${added} lead(s) importé(s).`)
        if (added > 0) setTimeout(() => { onClose(); router.push('/pipeline') }, 700)
      } else {
        const lead = await addLead(f)
        setMsg('Lead ajouté.')
        setTimeout(() => { onClose(); router.push(`/leads/${lead.id}`) }, 500)
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        {mode === 'linkedin' && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">URL du profil LinkedIn</label>
              <input value={f.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} className={field} placeholder="https://www.linkedin.com/in/..." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} className={field} placeholder="Prénom" />
              <input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} className={field} placeholder="Nom" />
            </div>
            <input value={f.company} onChange={(e) => set('company', e.target.value)} className={field} placeholder="Entreprise" />
            <p className="text-[11px] text-amber-600">⚠️ Au câblage Unipile, l'URL suffira : nom, titre et entreprise seront récupérés automatiquement. Pour l'instant, complète à la main.</p>
          </div>
        )}

        {mode === 'manual' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} className={field} placeholder="Prénom" />
              <input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} className={field} placeholder="Nom" />
            </div>
            <input value={f.title} onChange={(e) => set('title', e.target.value)} className={field} placeholder="Titre (ex: Head of Sales)" />
            <input value={f.company} onChange={(e) => set('company', e.target.value)} className={field} placeholder="Entreprise" />
            <input value={f.email} onChange={(e) => set('email', e.target.value)} className={field} placeholder="Email (optionnel)" />
          </div>
        )}

        {mode === 'csv' && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-500">Colle tes lignes CSV <span className="font-normal text-gray-400">— prénom,nom,titre,entreprise,email</span></label>
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} className={`${field} h-36 resize-none font-mono text-xs`} placeholder={"Camille,Roux,VP Sales,Fivory,camille@fivory.com\nHugo,Martin,CEO,Kairos AI,"} />
          </div>
        )}

        {msg && <p className="text-xs text-emerald-600 mt-3">{msg}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm font-medium text-gray-500 px-3 py-2 rounded-xl hover:bg-gray-50">Annuler</button>
          <button onClick={submit} disabled={busy || (mode === 'csv' ? !csv.trim() : !f.firstName && !f.company)} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
            {busy ? '…' : mode === 'csv' ? 'Importer' : 'Ajouter'}
          </button>
        </div>
      </div>
    </div>
  )
}
