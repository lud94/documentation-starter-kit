import { useEffect, useRef, useState } from 'react'

// Panneau Jarvis in-app (⌘K). Adaptateur mince : il affiche, le serveur décide et
// exécute — MÊME cerveau que l'extension et Telegram (mêmes capacités partout).
//
// SEC-JARVIS-APP-01 : aucune action exécutable ne transite par le navigateur.
// Une écriture en attente est représentée uniquement par un nonce opaque.
interface Msg {
  role: 'user' | 'assistant'
  content: string
  confirmationId?: string
  done?: boolean
  result?: string
  q?: string
}

// Sortie d'exploration : ouvre la question dans l'abonnement de l'utilisateur
// (aucun token Prospector). Complément de la réponse Jarvis, pas remplacement.
const EXTERNAL: Record<string, (q: string) => string> = {
  Claude: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  ChatGPT: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  Perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
}

const SUGGESTIONS = [
  'Mes chiffres',
  'Trouve des ESN de 51-100 salariés à Paris',
  'Crée une liste des dirigeants',
  'Que sait-on de Redsen ?',
]

export default function Jarvis({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [msgs, busy])

  const call = (payload: any) =>
    fetch('/api/jarvis/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json())

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return

    setInput('')
    setMsgs((m) => [...m, { role: 'user', content: q }])
    setBusy(true)

    try {
      const d = await call({ message: q })
      const content = [d.reply, d.result].filter(Boolean).join('\n\n') || '…'

      setMsgs((m) => [
        ...m,
        {
          role: 'assistant',
          content,
          confirmationId: d.needsConfirm ? d.confirmationId : undefined,
          q,
        },
      ])
    } catch {
      setMsgs((m) => [
        ...m,
        { role: 'assistant', content: 'Erreur — réessaie.' },
      ])
    } finally {
      setBusy(false)
    }
  }

  const confirmAction = async (idx: number, confirmationId: string) => {
    setBusy(true)

    try {
      // Le navigateur ne renvoie QUE le nonce.
      const d = await call({ confirmationId })

      setMsgs((m) =>
        m.map((x, i) =>
          i === idx
            ? { ...x, done: true, result: d.reply }
            : x,
        ),
      )
    } catch {
      setMsgs((m) =>
        m.map((x, i) =>
          i === idx
            ? { ...x, done: true, result: "Échec de l'action." }
            : x,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const cancelAction = async (idx: number, confirmationId: string) => {
    setBusy(true)

    try {
      // L'annulation consomme elle aussi l'attente côté serveur.
      const d = await call({ cancel: confirmationId })

      setMsgs((m) =>
        m.map((x, i) =>
          i === idx
            ? { ...x, done: true, result: d.reply || 'Annulé.' }
            : x,
        ),
      )
    } catch {
      setMsgs((m) =>
        m.map((x, i) =>
          i === idx
            ? { ...x, done: true, result: "Échec de l'annulation." }
            : x,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-gray-900/20" onClick={onClose} />

      <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <span className="w-8 h-8 rounded-xl gradient-brand flex items-center justify-center text-white font-bold">
            ✦
          </span>

          <div className="flex-1">
            <p className="text-sm font-bold text-gray-900">Jarvis</p>
            <p className="text-[11px] text-gray-400">
              Copilote Prospector · pilote ta plateforme
            </p>
          </div>

          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto p-4 space-y-3">
          {msgs.length === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">
                Demande-moi d'analyser tes données ou d'agir. Exemples :
              </p>

              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="block w-full text-left text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg hover:bg-indigo-100"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={`max-w-[85%] text-sm rounded-2xl px-3.5 py-2 whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'gradient-brand text-white'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                {m.content}

                {m.confirmationId && !m.done && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => confirmAction(i, m.confirmationId!)}
                      disabled={busy}
                      className="text-xs font-semibold bg-white text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 disabled:opacity-40"
                    >
                      Confirmer
                    </button>

                    <button
                      onClick={() => cancelAction(i, m.confirmationId!)}
                      disabled={busy}
                      className="text-xs text-gray-400 px-2 disabled:opacity-40"
                    >
                      Annuler
                    </button>
                  </div>
                )}

                {m.result && (
                  <p className="mt-1.5 text-[12px] font-medium text-emerald-700 whitespace-pre-wrap">
                    {m.result}
                  </p>
                )}

                {m.role === 'assistant' && m.q && !m.confirmationId && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-400">
                    <span>Approfondir :</span>

                    {Object.keys(EXTERNAL).map((k) => (
                      <a
                        key={k}
                        href={EXTERNAL[k](m.q!)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-500 hover:underline"
                      >
                        {k} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {busy && <p className="text-xs text-gray-400">Jarvis réfléchit…</p>}
        </div>

        <div className="p-3 border-t border-gray-100 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(input)}
            placeholder="Demande à Jarvis…"
            className="flex-1 px-3 py-2 text-sm rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400"
          />

          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 disabled:opacity-40"
          >
            Envoyer
          </button>
        </div>
      </div>
    </div>
  )
}