import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import CreateLeadModal from './CreateLeadModal'
import { getNotifications, markNotificationsRead } from '../lib/prospector/capabilities'
import type { Notification } from '../lib/prospector/capabilities'

const NOTIF_ICON: Record<Notification['type'], string> = {
  reply: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4-.8L3 20l.8-3.2A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  meeting: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  task: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7l2 2 4-4',
  system: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  return now
}

type NavItem = {
  href: string
  label: string
  icon: JSX.Element
  ready?: boolean
  badge?: number
}

const icon = (d: string) => (
  <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={d} />
  </svg>
)

const NAV: NavItem[] = [
  { href: '/actions', label: 'Actions du jour', ready: true, icon: icon('M13 10V3L4 14h7v7l9-11h-7z') },
  { href: '/', label: 'Tableau de bord', ready: true, icon: icon('M4 5a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM14 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3z') },
  { href: '/sourcing', label: 'Sourcing', ready: true, icon: icon('M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z') },
  { href: '/pipeline', label: 'Pipeline & Leads', ready: true, icon: icon('M3 7h18M3 12h18M3 17h18') },
  { href: '/sequences', label: 'Séquences', ready: true, icon: icon('M4 6h16M4 12h10M4 18h7') },
  { href: '/inbox', label: 'Inbox', ready: true, icon: icon('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z') },
  { href: '/planning', label: 'Planning', ready: true, icon: icon('M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z') },
  { href: '/brain', label: 'Cerveau IA', ready: true, icon: icon('M9.5 3a3 3 0 013 3v12a3 3 0 01-6 0V6a3 3 0 013-3zM14.5 6a3 3 0 016 0v9a3 3 0 01-6 0') },
  { href: '/admin', label: 'Admin', ready: true, icon: icon('M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z') },
]

type CreateAction = 'sourcing' | 'linkedin' | 'manual' | 'csv'
const CREATE_MENU: { key: CreateAction; label: string; desc: string; path: string }[] = [
  { key: 'sourcing', label: 'Sourcer des leads', desc: 'data.gouv + gate signal', path: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { key: 'linkedin', label: 'Ajouter depuis LinkedIn', desc: 'URL de profil → Unipile', path: 'M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z' },
  { key: 'manual', label: 'Ajouter un lead', desc: 'Saisie manuelle', path: 'M18 9v6m3-3h-6M13 7a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3z' },
  { key: 'csv', label: 'Importer un CSV', desc: 'Liste existante', path: 'M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z' },
]

export default function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { pathname } = router
  const [createOpen, setCreateOpen] = useState(false)
  const [modal, setModal] = useState<CreateAction | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [role, setRole] = useState<'admin' | 'client'>('admin')
  const [perms, setPerms] = useState<any>(null)
  const [wsName, setWsName] = useState<string | null>(null)
  const [notifs, setNotifs] = useState<Notification[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const now = useClock()

  // Sélecteur d'espace
  const [wsOpen, setWsOpen] = useState(false)
  const [wsCurrent, setWsCurrent] = useState('admin')
  const [wsCanSwitch, setWsCanSwitch] = useState(false)
  const [wsOptions, setWsOptions] = useState<{ id: string; name: string }[]>([])
  const wsCurrentName = wsOptions.find((o) => o.id === wsCurrent)?.name || null
  useEffect(() => {
    fetch('/api/workspaces/active').then((r) => r.json()).then((d) => { setWsCurrent(d.current || 'admin'); setWsCanSwitch(!!d.canSwitch); setWsOptions(d.options || []) }).catch(() => {})
  }, [])
  const switchWs = async (id: string) => {
    setWsOpen(false)
    await fetch('/api/workspaces/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws: id }) })
    window.location.href = '/pipeline' // recharge dans le nouvel espace
  }
  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => { setEmail(d.email); setRole(d.role || 'admin'); setPerms(d.permissions || null); setWsName(d.workspaceName || null) }).catch(() => {})
  }, [])
  useEffect(() => { getNotifications().then(setNotifs) }, [])
  const unreadCount = notifs.filter((n) => n.unread).length
  const openNotifs = () => { setNotifOpen((v) => !v); if (!notifOpen && unreadCount) markNotificationsRead().then(setNotifs) }

  const onCreate = (key: CreateAction) => {
    setCreateOpen(false)
    if (key === 'sourcing') router.push('/sourcing')
    else setModal(key)
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-100 flex flex-col fixed inset-y-0 left-0 z-40">
        {/* Logo + workspace */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-50">
          <Link href="/actions" className="flex items-center gap-2.5 mb-4">
            <div className="w-8 h-8 rounded-full gradient-brand flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <span className="font-bold text-gray-900 text-base">Prospector</span>
          </Link>

          {/* Sélecteur d'espace */}
          <div className="relative">
            <button onClick={() => wsCanSwitch && setWsOpen((v) => !v)} className={`w-full flex items-center justify-between px-3 py-2 rounded-xl bg-gray-50 border border-gray-100 text-sm text-gray-700 transition-colors ${wsCanSwitch ? 'hover:bg-gray-100' : 'cursor-default'}`}>
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-5 h-5 rounded-md gradient-brand text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">{(wsCurrentName || 'M')[0].toUpperCase()}</span>
                <span className="truncate">{wsCurrentName || 'Mon espace'}</span>
              </span>
              {wsCanSwitch && <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>}
            </button>
            {wsOpen && wsCanSwitch && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setWsOpen(false)} />
                <div className="absolute left-0 right-0 mt-1 card p-1.5 z-40 max-h-72 overflow-y-auto">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase px-2 py-1">Basculer d'espace</p>
                  {wsOptions.map((o) => (
                    <button key={o.id} onClick={() => switchWs(o.id)} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-left transition-colors ${o.id === wsCurrent ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}>
                      <span className="w-5 h-5 rounded-md gradient-brand text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">{o.name[0].toUpperCase()}</span>
                      <span className="truncate">{o.name}</span>
                      {o.id === wsCurrent && <svg className="w-3.5 h-3.5 ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {NAV.filter((item) => {
            if (role === 'admin') return true
            // Vue client : filtrée par permissions, zones admin masquées.
            const p = perms || {}
            switch (item.href) {
              case '/admin': case '/brain': return false
              case '/actions': return !!p.validate
              case '/sourcing': case '/pipeline': return !!p.leads
              case '/sequences': return !!p.sequences
              case '/inbox': return !!p.messaging
              default: return true // /, /planning
            }
          }).map((item) => {
            const active = pathname === item.href
            const base = 'w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors'
            if (!item.ready) {
              return (
                <div key={item.href} className={`${base} text-gray-300 cursor-not-allowed justify-between`}>
                  <span className="flex items-center gap-3">{item.icon}{item.label}</span>
                  <span className="text-[10px] font-semibold text-gray-300 bg-gray-50 px-1.5 py-0.5 rounded">bientôt</span>
                </div>
              )
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${base} justify-between ${active ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'}`}
              >
                <span className="flex items-center gap-3">{item.icon}{item.label}</span>
                {item.badge ? (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${active ? 'bg-indigo-600 text-white' : 'gradient-brand text-white'}`}>
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            )
          })}
        </nav>

        {/* Aperçu client — admin uniquement */}
        {role === 'admin' && <Link href="/client" className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-indigo-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          Aperçu espace client
        </Link>}

        {/* User */}
        <div className="px-4 py-3 border-t border-gray-50 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full gradient-brand flex items-center justify-center text-white text-xs font-bold">{email ? email[0].toUpperCase() : 'N'}</div>
          <div className="text-xs min-w-0">
            <div className="font-semibold text-gray-700 truncate">{email ? email.split('@')[0] : 'Admin'}</div>
            <div className="text-gray-400 truncate">{role === 'client' ? (wsName || 'Espace client') : (email || 'Smart.AI')}</div>
          </div>
          <button
            onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login' }}
            title="Se déconnecter"
            className="ml-auto text-gray-300 hover:text-red-500 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 ml-60 flex flex-col min-h-screen">
        {/* Barre Jarvis (omniprésente, inerte pour l'instant) */}
        <header className="h-14 bg-white/80 backdrop-blur border-b border-gray-100 sticky top-0 z-30 flex items-center px-6 gap-4">
          <button className="flex-1 max-w-xl flex items-center gap-3 px-4 py-2 rounded-xl bg-gray-50 border border-gray-100 text-sm text-gray-400 hover:bg-gray-100 transition-colors text-left">
            <span className="gradient-text font-semibold">✦</span>
            Demandez à Jarvis…
            <span className="ml-auto text-[10px] font-semibold text-gray-400 bg-white border border-gray-200 px-1.5 py-0.5 rounded">⌘K · bientôt</span>
          </button>

          {/* Horloge date + heure (planification) */}
          <div className="ml-auto hidden md:flex flex-col items-end leading-tight mr-1">
            <span className="text-xs font-semibold text-gray-700 capitalize">
              {now ? now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '—'}
            </span>
            <span className="text-[11px] text-gray-400 tabular-nums">
              {now ? now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
            </span>
          </div>

          {/* Cloche de notifications */}
          <div className="relative">
            <button onClick={openNotifs} className="relative w-9 h-9 rounded-xl border border-gray-200 bg-white flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors">
              <svg className="w-4.5 h-4.5 w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
              {unreadCount > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{unreadCount}</span>}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} />
                <div className="absolute right-0 mt-2 w-80 card p-0 z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-800">Notifications</span>
                    <Link href="/planning" onClick={() => setNotifOpen(false)} className="text-xs text-indigo-600 hover:underline">Planning</Link>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifs.length === 0 ? <p className="text-sm text-gray-400 text-center py-6">Rien de neuf.</p> : notifs.map((n) => (
                      <Link key={n.id} href={n.href || '#'} onClick={() => setNotifOpen(false)} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0">
                        <span className="w-7 h-7 rounded-lg icon-bg-blue flex items-center justify-center flex-shrink-0 mt-0.5">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={NOTIF_ICON[n.type]} /></svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-gray-700 leading-snug">{n.text}</span>
                          <span className="block text-[11px] text-gray-400 mt-0.5">{n.when}</span>
                        </span>
                        {n.unread && <span className="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0 mt-1.5" />}
                      </Link>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Bouton + global — masqué pour un client sans droit "leads" */}
          {(role === 'admin' || perms?.leads) && <div className="relative">
            <button
              onClick={() => setCreateOpen((v) => !v)}
              className="gradient-brand text-white text-sm font-semibold px-3.5 py-2 rounded-xl hover:opacity-90 transition-opacity flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v16m8-8H4" /></svg>
              Nouveau
            </button>
            {createOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setCreateOpen(false)} />
                <div className="absolute right-0 mt-2 w-64 card p-1.5 z-40">
                  {CREATE_MENU.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => onCreate(m.key)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors text-left"
                    >
                      <span className="w-8 h-8 rounded-lg icon-bg-blue flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={m.path} /></svg>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-800">{m.label}</span>
                        <span className="block text-xs text-gray-400">{m.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>}
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="max-w-6xl mx-auto">{children}</div>
        </main>
      </div>

      {modal && modal !== 'sourcing' && <CreateLeadModal mode={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
