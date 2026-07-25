import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { getTasks, addTask, toggleTask, deleteTask } from '../lib/prospector/capabilities'
import type { Task } from '../lib/prospector/capabilities'

const CH_DOT: Record<string, string> = { linkedin: 'bg-blue-500', email: 'bg-emerald-500', whatsapp: 'bg-green-500' }
const field = 'px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

// Regroupe par échéance (mot-clé simple sur le libellé).
function bucket(due: string): 'today' | 'tomorrow' | 'later' {
  const d = due.toLowerCase()
  if (d.includes("aujourd")) return 'today'
  if (d.includes('demain')) return 'tomorrow'
  return 'later'
}

export default function PlanningPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState('')
  const [due, setDue] = useState("Aujourd'hui")

  useEffect(() => { getTasks().then(setTasks) }, [])

  const add = async () => {
    if (!title.trim()) return
    await addTask({ title, due })
    setTitle(''); getTasks().then(setTasks)
  }
  const toggle = async (id: string) => setTasks(await toggleTask(id))
  const remove = async (id: string) => setTasks(await deleteTask(id))

  const pending = tasks.filter((t) => !t.done)
  const done = tasks.filter((t) => t.done)
  const groups: { key: string; label: string; items: Task[] }[] = [
    { key: 'today', label: "Aujourd'hui", items: pending.filter((t) => bucket(t.due) === 'today') },
    { key: 'tomorrow', label: 'Demain', items: pending.filter((t) => bucket(t.due) === 'tomorrow') },
    { key: 'later', label: 'À venir', items: pending.filter((t) => bucket(t.due) === 'later') },
  ]

  const Row = (t: Task) => (
    <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition-colors">
      <button onClick={() => toggle(t.id)} className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${t.done ? 'gradient-brand border-transparent' : 'border-gray-300 hover:border-indigo-400'}`}>
        {t.done && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${t.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{t.title}</p>
        <p className="text-xs text-gray-400 flex items-center gap-1.5">
          {t.channel && <span className={`w-1.5 h-1.5 rounded-full ${CH_DOT[t.channel]}`} />}
          {t.leadName ? <Link href={`/leads/${t.leadId}`} className="hover:text-indigo-500">{t.leadName}</Link> : 'Général'} · {t.due}
        </p>
      </div>
      <button onClick={() => remove(t.id)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
    </div>
  )

  return (
    <>
      <Head><title>Prospector · Planning</title></Head>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Planning</h1>
        <p className="text-gray-400 text-sm mt-0.5">Vos tâches et rappels de prospection — relances, préparations, suivis.</p>
      </div>

      {/* Ajout rapide */}
      <div className="card p-4 mb-5 flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nouvelle tâche</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className={`${field} w-full`} placeholder="ex: Relancer Camille après la démo" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1.5">Échéance</label>
          <select value={due} onChange={(e) => setDue(e.target.value)} className={field}>
            <option>Aujourd'hui</option><option>Demain</option><option>Cette semaine</option><option>La semaine prochaine</option>
          </select>
        </div>
        <button onClick={add} disabled={!title.trim()} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">Ajouter</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {groups.map((g) => (
          <div key={g.key} className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-700">{g.label}</h2>
              <span className="text-xs font-bold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{g.items.length}</span>
            </div>
            {g.items.length === 0 ? <p className="text-xs text-gray-400 text-center py-6">Rien de prévu.</p> : <div className="space-y-2">{g.items.map(Row)}</div>}
          </div>
        ))}
      </div>

      {done.length > 0 && (
        <div className="card p-4 mt-4">
          <h2 className="text-sm font-semibold text-gray-500 mb-3">Terminées ({done.length})</h2>
          <div className="space-y-2">{done.map(Row)}</div>
        </div>
      )}
    </>
  )
}
