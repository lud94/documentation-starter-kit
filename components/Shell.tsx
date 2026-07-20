import Link from 'next/link'
import { useRouter } from 'next/router'

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
  { href: '/actions', label: 'Actions du jour', ready: true, badge: 6, icon: icon('M13 10V3L4 14h7v7l9-11h-7z') },
  { href: '/', label: 'Tableau de bord', ready: true, icon: icon('M4 5a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM14 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3z') },
  { href: '/pipeline', label: 'Pipeline & Leads', icon: icon('M3 7h18M3 12h18M3 17h18') },
  { href: '/sequences', label: 'Séquences', icon: icon('M4 6h16M4 12h10M4 18h7') },
  { href: '/inbox', label: 'Inbox', icon: icon('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z') },
  { href: '/brain', label: 'Cerveau IA', icon: icon('M9.5 3a3 3 0 013 3v12a3 3 0 01-6 0V6a3 3 0 013-3zM14.5 6a3 3 0 016 0v9a3 3 0 01-6 0') },
  { href: '/admin', label: 'Admin', icon: icon('M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z') },
]

export default function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useRouter()

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
        </header>

        <main className="flex-1 px-6 py-8">
          <div className="max-w-6xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  )
}
