import { useState } from 'react'
import { useRouter } from 'next/router'
import { addLead, addLeadsFromCsv } from '../lib/prospector/capabilities'

type Mode = 'linkedin' | 'manual' | 'csv'
const field = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

export default function CreateLeadModal({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const router = useRouter()
  const [f, setF] = useState({ firstName: '', lastName: '', title: '', company: '', email: '', linkedinUrl: '', dirigeant: '' })
  const [siren, setSiren] = useState('')
  const [sirenBusy, setSirenBusy] = useState(false)
  const [sirenState, setSirenState] = useState<'found' | 'notfound' | null>(null)
  const verifySiren = async () => {
    setSirenBusy(true); setSirenState(null)
    try {
      const d = await fetch(`/api/company/verify?siren=${siren}`).then((r) => r.json())
      if (d.found) { setF((p) => ({ ...p, company: d.name || p.company, dirigeant: d.dirigeant || '' })); setSirenState('found') }
      else setSirenState('notfound')
    } finally { setSirenBusy(false) }
  }
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
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
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">SIREN de l'entreprise <span className="font-normal text-gray-400">— vérifie l'existence (évite les faux leads)</span></label>
              <div className="flex gap-2">
                <input value={siren} onChange={(e) => { setSiren(e.target.value.replace(/[^\d]/g, '').slice(0, 9)); setSirenState(null) }} className={`${field} flex-1`} placeholder="9 chiffres" />
                <button onClick={verifySiren} disabled={siren.length !== 9 || sirenBusy} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50">{sirenBusy ? '…' : 'Vérifier'}</button>
              </div>
              {sirenState === 'found' && <p className="text-[11px] text-emerald-600 mt-1">✓ Entreprise vérifiée · {f.company}{f.dirigeant ? ` · dir. ${f.dirigeant}` : ''}</p>}
              {sirenState === 'notfound' && <p className="text-[11px] text-red-600 mt-1">Aucune entreprise trouvée pour ce SIREN.</p>}
            </div>
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
            <label className="block text-xs font-semibold text-gray-500">Fichier CSV <span className="font-normal text-gray-400">— colonnes : prénom, nom, titre, entreprise, email</span></label>
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-6 cursor-pointer hover:border-indigo-300 hover:bg-gray-50/50 transition-colors">
              <svg className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
              <span className="text-sm text-gray-600">{fileName || 'Choisir un fichier .csv'}</span>
              <span className="text-[11px] text-gray-400">ou glisser-déposer</span>
              <input
                type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setFileName(f.name); const r = new FileReader(); r.onload = () => setCsv(String(r.result || '')); r.readAsText(f) }}
              />
            </label>
            <details className="text-xs">
              <summary className="text-gray-400 cursor-pointer hover:text-gray-600">…ou coller le texte manuellement</summary>
              <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setFileName('') }} className={`${field} h-24 resize-none font-mono text-xs w-full mt-2`} placeholder={"Camille,Roux,VP Sales,Fivory,camille@fivory.com"} />
            </details>
            {csv && <p className="text-[11px] text-emerald-600">{csv.split(/\r?\n/).filter((l) => l.trim()).length} ligne(s) détectée(s).</p>}
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
