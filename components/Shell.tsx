import Link from 'next/link'
import { useRouter } from 'next/router'
import { useState } from 'react'

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
  { href: '/actions', label: 'Actions du jour', ready: true, badge: 8, icon: icon('M13 10V3L4 14h7v7l9-11h-7z') },
  { href: '/', label: 'Tableau de bord', ready: true, icon: icon('M4 5a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM14 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3z') },
  { href: '/sourcing', label: 'Sourcing', ready: true, icon: icon('M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z') },
  { href: '/pipeline', label: 'Pipeline & Leads', ready: true, icon: icon('M3 7h18M3 12h18M3 17h18') },
  { href: '/sequences', label: 'Séquences', ready: true, icon: icon('M4 6h16M4 12h10M4 18h7') },
  { href: '/inbox', label: 'Inbox', ready: true, badge: 2, icon: icon('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z') },
  { href: '/brain', label: 'Cerveau IA', ready: true, icon: icon('M9.5 3a3 3 0 013 3v12a3 3 0 01-6 0V6a3 3 0 013-3zM14.5 6a3 3 0 016 0v9a3 3 0 01-6 0') },
  { href: '/admin', label: 'Admin', ready: true, icon: icon('M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z') },
]

const CREATE_MENU = [
  { label: 'Sourcer des leads', desc: 'DataGoov + gate signal', path: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { label: 'Ajouter depuis LinkedIn', desc: 'URL de profil → Unipile', path: 'M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z' },
  { label: 'Ajouter un lead', desc: 'Saisie manuelle', path: 'M18 9v6m3-3h-6M13 7a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3z' },
  { label: 'Importer un CSV', desc: 'Liste existante', path: 'M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z' },
]

export default function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useRouter()
  const [createOpen, setCreateOpen] = useState(false)

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

          {/* Workspace switcher (inerte) */}
          <button className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-gray-50 border border-gray-100 text-sm text-gray-700 hover:bg-gray-100 transition-colors">
            <span className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-md gradient-brand text-white text-[10px] font-bold flex items-center justify-center">A</span>
              Client : Acme
            </span>
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4M8 15l4 4 4-4" />
            </svg>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {NAV.map((item) => {
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

        {/* Aperçu client */}
        <Link href="/client" className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-indigo-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          Aperçu espace client
        </Link>

        {/* User */}
        <div className="px-4 py-3 border-t border-gray-50 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full gradient-brand flex items-center justify-center text-white text-xs font-bold">N</div>
          <div className="text-xs">
            <div className="font-semibold text-gray-700">Ludwig</div>
            <div className="text-gray-400">Admin · Smart.AI</div>
          </div>
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

          {/* Bouton + global (raccourci disponible partout) */}
          <div className="relative ml-auto">
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
                      key={m.label}
                      onClick={() => setCreateOpen(false)}
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
          </div>
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="max-w-6xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  )
}
