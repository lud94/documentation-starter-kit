import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from './lib/auth/session'

// Routes publiques (pas de session requise).
const PUBLIC = ['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/setup', '/api/auth/status']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next()

  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (await verifySessionToken(token)) return NextResponse.next()

  // API → 401 JSON ; pages → redirection vers le portail.
  if (pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.searchParams.set('from', pathname)
  return NextResponse.redirect(url)
}

// Exclut les assets Next et les fichiers statiques.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
