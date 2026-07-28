import { useState } from 'react'

// Dialogues in-app (remplacent confirm()/prompt() natifs qui affichent l'URL).
export function ConfirmDialog({ title, message, confirmLabel = 'Confirmer', danger, onConfirm, onCancel }: {
  title: string; message?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative card p-6 max-w-sm w-full">
        <h2 className="text-base font-bold text-gray-900 mb-1">{title}</h2>
        {message && <p className="text-sm text-gray-500 mb-4">{message}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <button onClick={onCancel} className="text-sm text-gray-500 px-3 py-2">Annuler</button>
          <button onClick={onConfirm} className={`text-white text-sm font-semibold px-4 py-2 rounded-xl ${danger ? 'bg-red-500 hover:bg-red-600' : 'gradient-brand hover:opacity-90'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function PromptDialog({ title, message, defaultValue = '', placeholder, submitLabel = 'Valider', onSubmit, onCancel }: {
  title: string; message?: string; defaultValue?: string; placeholder?: string; submitLabel?: string; onSubmit: (v: string) => void; onCancel: () => void
}) {
  const [v, setV] = useState(defaultValue)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative card p-6 max-w-sm w-full">
        <h2 className="text-base font-bold text-gray-900 mb-1">{title}</h2>
        {message && <p className="text-sm text-gray-500 mb-3">{message}</p>}
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSubmit(v.trim())} placeholder={placeholder} className="w-full px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 mb-4" />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-sm text-gray-500 px-3 py-2">Annuler</button>
          <button onClick={() => v.trim() && onSubmit(v.trim())} disabled={!v.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40">{submitLabel}</button>
        </div>
      </div>
    </div>
  )
}
