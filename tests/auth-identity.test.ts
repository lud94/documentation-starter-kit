// SEC-AUTH-0 — LA RACINE D'IDENTITÉ.
//
// Identity → TenantContext → Policy → Context → Action.
// Si Identity peut être forgée, tout ce qui suit perd sa valeur. Les lots
// précédents ont durci le tenant, les canaux, l'extension — tous en aval de
// cette racine. Elle était ouverte.
//
// SEPT DÉFAUTS, tous de la même famille : une valeur par défaut, une absence,
// ou une panne, traitées comme une autorisation.
//
//   1. `APP_SESSION_SECRET || 'prospector-dev-secret-change-me'` — une clé
//      d'administration PUBLIÉE dans le dépôt ;
//   2. `role === 'admin' || !claims.role` — pas de rôle = administrateur ;
//   3. `/api/auth/setup` public : le premier venu prenait le compte ;
//   4. `if (!ref.startsWith('$2')) return pw === ref` — mot de passe admin en
//      clair, comparé par `===` ;
//   5. réinitialisation sans fournisseur d'email → le lien était RENDU dans la
//      réponse HTTP ;
//   6. lien construit depuis `Origin` / `Host`, donc depuis l'attaquant ;
//   7. jeton de réinitialisation stocké EN CLAIR dans les réglages.
//
// ⚠️ Ce fichier n'importe volontairement AUCUN symbole créé par ce lot. Il
// n'exerce que des surfaces qui existaient déjà au SHA e214e7d, pour que chaque
// test puisse MORDRE le code d'avant — c'est la condition d'un contrôle négatif
// qui veut dire quelque chose.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useTestSessionSecret, forgeSession, futureExp,
  TEST_SESSION_SECRET, ANCIEN_SECRET_PUBLIC,
} from './helpers/session'

// ── Keystore en mémoire pure : aucune base, aucun réseau ────────────────────
vi.mock('../lib/supabase/settings', () => ({
  loadAllSettings: async () => ({}),
  saveSetting: async () => true,
}))

const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
}
let clientAuth: any = null
vi.mock('../lib/supabase/workspaces', () => ({
  authClient: async () => clientAuth,
  getWorkspaceById: async (id: string) => WORKSPACES[id] ?? null,
  listWorkspaces: async () => Object.values(WORKSPACES),
}))

import { createSessionToken, readSession, verifySessionToken, SESSION_COOKIE } from '../lib/auth/session'
import { checkCredentials, isSetup, setCredentials, resetPassword, getEmail } from '../lib/prospector/auth'
// SEC-AUTH-0.1 : l'autorité de réinitialisation a quitté le keystore pour une
// ligne de `prospector_store`, et se consomme atomiquement. Les tests
// l'inspectent là où elle vit désormais.
import { getItemStrict, deleteItem } from '../lib/supabase/store'
import { RESET_KIND, RESET_ID, RESET_NS } from '../lib/auth/resetAuthority'
import { getKey } from '../lib/prospector/keystore'
import loginHandler from '../pages/api/auth/login'
import setupHandler from '../pages/api/auth/setup'
import resetRequestHandler from '../pages/api/auth/reset-request'
import resetHandler from '../pages/api/auth/reset'

// Mot de passe de TEST et son empreinte, produite par `scripts/hash-password.mjs`.
// Aucune valeur en dehors de cette suite : ce n'est le secret de personne.
const PASSWORD = 'motdepasse-de-test'
const BCRYPT_OK = '$2b$12$fkD49MEtVKouKJOaqKJ8DeWo5go6KIUgxel2Dnx.CABnPqk2khrIO'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  r.end = () => r
  return r
}
const post = (body: any, headers: Record<string, string> = {}) =>
  ({ method: 'POST', headers, body, cookies: {}, query: {} } as any)

/** Le magasin de clés vit sur `globalThis` : on le vide entre chaque test. */
function resetKeystore() {
  const g = globalThis as any
  g.__prospectorKeys?.clear?.()
  g.__prospectorHydrated = undefined
  for (const k of ['APP_EMAIL', 'APP_PASSWORD', 'APP_RESET_TOKEN', 'APP_RESET_TOKEN_HASH', 'APP_RESET_EXP']) {
    delete process.env[k]
  }
}

const ENV_KEYS = ['APP_SESSION_SECRET', 'RESEND_API_KEY', 'APP_BASE_URL', 'ALLOW_LOCAL_AUTH_SETUP', 'APP_ENV', 'VERCEL_ENV', 'NEXT_PUBLIC_APP_ENV', 'NEXT_PUBLIC_VERCEL_ENV']
let saved: Record<string, string | undefined> = {}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  resetKeystore()
  // L'autorité de réinitialisation vit maintenant dans `prospector_store`, dont
  // le repli mémoire survit d'un test à l'autre.
  await deleteItem(RESET_KIND, RESET_ID, RESET_NS)
  clientAuth = null
  // SEC-AUTH-0.2 : l'autorité de réinitialisation n'accepte le repli mémoire
  // que sur un environnement de développement DÉCLARÉ.
  process.env.APP_ENV = 'development'
  useTestSessionSecret()
  vi.restoreAllMocks()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  resetKeystore()
})

// ══ §23 — SESSION ═══════════════════════════════════════════════════════════
describe('§23 A–L — le jeton de session, canonique et fail-closed', () => {
  it('A — secret absent → aucune session lue, aucune émise', async () => {
    const t = (await createSessionToken('a@b.c', 3600, { role: 'admin' }))!
    expect(t).toBeTruthy()
    delete process.env.APP_SESSION_SECRET
    expect(await readSession(t)).toBeNull()
    expect(await verifySessionToken(t)).toBe(false)
    expect(await createSessionToken('a@b.c', 3600, { role: 'admin' })).toBeNull()
  })

  it('B — secret plus court que le minimum → traité comme absent', async () => {
    process.env.APP_SESSION_SECRET = 'a'.repeat(31)
    expect(await createSessionToken('a@b.c', 3600, { role: 'admin' })).toBeNull()
    // Et un jeton signé AVEC ce secret trop court n'est pas accepté non plus.
    const faible = await forgeSession({ sub: 'a@b.c', role: 'admin', exp: futureExp() }, 'a'.repeat(31))
    expect(await readSession(faible)).toBeNull()
  })

  it('C — DÉFAUT : le secret public du dépôt ne forge plus rien', async () => {
    // Le scénario réel : une instance sans `APP_SESSION_SECRET`. Hier, ce jeton
    // était un administrateur valide sur cette instance.
    const forge = await forgeSession({ sub: 'pirate@evil.example', role: 'admin', exp: futureExp() }, ANCIEN_SECRET_PUBLIC)
    delete process.env.APP_SESSION_SECRET
    expect(await readSession(forge)).toBeNull()
    // Et même avec un vrai secret posé, le littéral public ne signe rien.
    useTestSessionSecret()
    expect(await readSession(forge)).toBeNull()
  })

  it('D — un segment supplémentaire → DENY', async () => {
    const t = (await createSessionToken('a@b.c', 3600, { role: 'admin' }))!
    expect(await readSession(t)).not.toBeNull()
    // `split('.')` déstructuré en deux ignorait purement et simplement la queue.
    expect(await readSession(`${t}.enplus`)).toBeNull()
    expect(await readSession(`${t}.`)).toBeNull()
  })

  it('E — DÉFAUT : rôle absent → DENY (et non « administrateur »)', async () => {
    const sansRole = await forgeSession({ sub: 'admin@x.fr', exp: futureExp() })
    expect(await readSession(sansRole)).toBeNull()
  })

  it('F — rôle inconnu → DENY, jamais rapproché d\'un rôle connu', async () => {
    for (const role of ['superadmin', 'ADMIN', 'root', '', 0, null, { role: 'admin' }]) {
      expect(await readSession(await forgeSession({ sub: 'x@y.z', role, exp: futureExp() }))).toBeNull()
    }
  })

  it('G — client sans espace → DENY', async () => {
    expect(await readSession(await forgeSession({ sub: 'c@x.fr', role: 'client', exp: futureExp() }))).toBeNull()
    expect(await readSession(await forgeSession({ sub: 'c@x.fr', role: 'client', ws: '   ', exp: futureExp() }))).toBeNull()
    expect(await createSessionToken('c@x.fr', 3600, { role: 'client' })).toBeNull()
  })

  it('H — client revendiquant l\'espace `admin` → DENY', async () => {
    expect(await readSession(await forgeSession({ sub: 'c@x.fr', role: 'client', ws: 'admin', exp: futureExp() }))).toBeNull()
    expect(await createSessionToken('c@x.fr', 3600, { role: 'client', ws: 'admin' })).toBeNull()
  })

  it('I — client revendiquant `_system` → DENY', async () => {
    expect(await readSession(await forgeSession({ sub: 'c@x.fr', role: 'client', ws: '_system', exp: futureExp() }))).toBeNull()
    expect(await createSessionToken('c@x.fr', 3600, { role: 'client', ws: '_system' })).toBeNull()
  })

  it('J — administrateur explicite → valide', async () => {
    const t = (await createSessionToken('admin@smart.ai', 3600, { role: 'admin' }))!
    expect(await readSession(t)).toMatchObject({ sub: 'admin@smart.ai', role: 'admin' })
  })

  it('K — client explicite avec un espace valide → valide', async () => {
    const t = (await createSessionToken('c@fabel.fr', 3600, { role: 'client', ws: 'ws_fabel' }))!
    expect(await readSession(t)).toMatchObject({ role: 'client', ws: 'ws_fabel' })
  })

  it('L — signature altérée, payload altéré, jeton vide → DENY', async () => {
    const t = (await createSessionToken('a@b.c', 3600, { role: 'admin' }))!
    const [body, sig] = t.split('.')
    expect(await readSession(`${body}.${sig.slice(0, -1)}X`)).toBeNull()
    // Élever un client en administrateur sans toucher à la signature.
    const escalade = Buffer.from(JSON.stringify({ sub: 'c@x.fr', role: 'admin', exp: futureExp() }))
      .toString('base64url')
    expect(await readSession(`${escalade}.${sig}`)).toBeNull()
    for (const t2 of ['', '.', 'abc', 'abc.', '.abc']) expect(await readSession(t2)).toBeNull()
  })

  it('expiration : un jeton échu reste refusé, exp non numérique aussi', async () => {
    expect(await readSession((await createSessionToken('a@b.c', -10, { role: 'admin' }))!)).toBeNull()
    for (const exp of ['9999999999', Infinity, NaN, null, undefined]) {
      expect(await readSession(await forgeSession({ sub: 'a@b.c', role: 'admin', exp }))).toBeNull()
    }
  })

  it('`sub` vide → DENY : une identité sans sujet n\'est pas une identité', async () => {
    expect(await readSession(await forgeSession({ sub: '  ', role: 'admin', exp: futureExp() }))).toBeNull()
  })
})

// ══ §24 — SETUP & IDENTIFIANTS ══════════════════════════════════════════════
describe('§24 M–T — le bootstrap administrateur', () => {
  const setupReq = () => post({ email: 'pirate@evil.example', password: 'motdepasse-pirate' })

  it('M — déploiement sans compte : POST /setup ne crée AUCUN administrateur', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'   // même l'opt-in ne suffit pas ici
    const res = mockRes()
    await setupHandler(setupReq(), res)
    expect(res.statusCode).toBe(403)
    expect(res.headers['Set-Cookie']).toBeUndefined()
    expect(isSetup()).toBe(false)
    expect(getEmail()).toBeUndefined()
  })

  it('N — staging et production déclarés → setup public refusé', async () => {
    for (const env of ['staging', 'production']) {
      resetKeystore()
      process.env.APP_ENV = env
      process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
      const res = mockRes()
      await setupHandler(setupReq(), res)
      expect(res.statusCode).toBe(403)
      expect(isSetup()).toBe(false)
    }
  })

  it('O — local SANS opt-in explicite → refusé', async () => {
    const res = mockRes()
    await setupHandler(setupReq(), res)
    expect(res.statusCode).toBe(403)
    expect(isSetup()).toBe(false)
    // `NODE_ENV !== 'production'` ne protégeait rien : c'est vrai sur une
    // préversion Vercel. L'opt-in est une décision, pas une déduction.
    expect(process.env.NODE_ENV).not.toBe('production')
  })

  it('P/Q — local + opt-in → setup autorisé, et la session porte role=admin', async () => {
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
    const res = mockRes()
    await setupHandler(post({ email: 'boss@smart.ai', password: PASSWORD }), res)
    expect(res.statusCode).toBe(200)
    expect(isSetup()).toBe(true)

    // ⚠️ DÉFAUT : `createSessionToken(email, TTL)` — sans rôle. La session
    // n'était administrateur que par le « pas de rôle = admin » de guard.ts.
    const cookie = String(res.headers['Set-Cookie'])
    const token = cookie.split(';')[0].split('=').slice(1).join('=')
    expect(await readSession(token)).toMatchObject({ sub: 'boss@smart.ai', role: 'admin' })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('R — setup déjà fait → 409, aucun écrasement de l\'administrateur', async () => {
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
    await setCredentials('boss@smart.ai', PASSWORD)
    const empreinte = getKey('APP_PASSWORD')
    const res = mockRes()
    await setupHandler(post({ email: 'pirate@evil.example', password: 'autre-mot-de-passe' }), res)
    expect(res.statusCode).toBe(409)
    expect(getEmail()).toBe('boss@smart.ai')
    expect(getKey('APP_PASSWORD')).toBe(empreinte)
  })

  it('setup sans racine d\'identité → 503, et aucun compte n\'est créé', async () => {
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
    delete process.env.APP_SESSION_SECRET
    const res = mockRes()
    await setupHandler(post({ email: 'boss@smart.ai', password: PASSWORD }), res)
    expect(res.statusCode).toBe(503)
    expect(res.headers['Set-Cookie']).toBeUndefined()
    expect(isSetup()).toBe(false)
  })

  it('S — DÉFAUT : APP_PASSWORD en clair → connexion administrateur REFUSÉE', async () => {
    process.env.APP_EMAIL = 'boss@smart.ai'
    process.env.APP_PASSWORD = PASSWORD          // en clair, comme hier
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(false)
    const res = mockRes()
    await loginHandler(post({ email: 'boss@smart.ai', password: PASSWORD }), res)
    expect(res.statusCode).not.toBe(200)
    expect(res.headers['Set-Cookie']).toBeUndefined()
  })

  it('T — APP_PASSWORD en empreinte bcrypt → connexion administrateur OK', async () => {
    process.env.APP_EMAIL = 'boss@smart.ai'
    process.env.APP_PASSWORD = BCRYPT_OK
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)
    const res = mockRes()
    await loginHandler(post({ email: 'boss@smart.ai', password: PASSWORD }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ role: 'admin' })
    const token = String(res.headers['Set-Cookie']).split(';')[0].split('=').slice(1).join('=')
    expect(await readSession(token)).toMatchObject({ role: 'admin' })
  })

  it('connexion sans racine d\'identité → 503, jamais de cookie', async () => {
    process.env.APP_EMAIL = 'boss@smart.ai'
    process.env.APP_PASSWORD = BCRYPT_OK
    delete process.env.APP_SESSION_SECRET
    const res = mockRes()
    await loginHandler(post({ email: 'boss@smart.ai', password: PASSWORD }), res)
    expect(res.statusCode).toBe(503)
    expect(res.headers['Set-Cookie']).toBeUndefined()
  })

  it('un client authentifié reçoit une session client scellée sur son espace', async () => {
    process.env.APP_EMAIL = 'boss@smart.ai'
    process.env.APP_PASSWORD = BCRYPT_OK
    clientAuth = { id: 'ws_fabel' }
    const res = mockRes()
    await loginHandler(post({ email: 'client@fabel.fr', password: 'peu-importe' }), res)
    expect(res.statusCode).toBe(200)
    const token = String(res.headers['Set-Cookie']).split(';')[0].split('=').slice(1).join('=')
    expect(await readSession(token)).toMatchObject({ role: 'client', ws: 'ws_fabel' })
  })
})

// ══ §25 — RÉINITIALISATION ══════════════════════════════════════════════════
describe('§25 U–AI — la réinitialisation de mot de passe', () => {
  const GENERIC = { sent: true }

  /** Installe un administrateur et une configuration d'envoi complète. */
  async function admin() {
    await setCredentials('boss@smart.ai', PASSWORD)
    process.env.RESEND_API_KEY = 'clef-de-test-non-reelle'
    process.env.APP_BASE_URL = 'https://app.prospector-test.invalid'
  }

  /** Remplace `fetch` et rend le lien réellement envoyé dans l'email. */
  function captureEmail(reply: { ok: boolean; status?: number } | 'throw') {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      calls.push(String(JSON.parse(init.body).html))
      if (reply === 'throw') throw new Error('réseau injoignable')
      return { ok: reply.ok, status: reply.status ?? (reply.ok ? 200 : 500), json: async () => ({}) }
    }))
    return {
      lien: () => (calls[0]?.match(/href="([^"]+)"/) || [])[1],
      jeton: () => (calls[0]?.match(/reset=([0-9a-f]+)/) || [])[1],
      appels: () => calls.length,
    }
  }

  /** Une autorité de réinitialisation existe-t-elle ? (aucun jeton brut nulle part) */
  const aucunResetActif = async () => {
    const r = await getItemStrict<any>(RESET_KIND, RESET_ID, RESET_NS)
    return r.ok === true && r.value === null && !getKey('APP_RESET_TOKEN')
  }

  it('U — email inconnu → réponse générique, aucun jeton créé', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    const res = mockRes()
    await resetRequestHandler(post({ email: 'inconnu@evil.example' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(GENERIC)
    expect(e.appels()).toBe(0)
    expect(await aucunResetActif()).toBe(true)
  })

  it('V — DÉFAUT : sans fournisseur d\'email, la réponse ne contient AUCUN lien', async () => {
    // Hier : `{ sent:true, link, noEmailProvider:true }`. Poster l'email public
    // de l'administrateur suffisait à recevoir un lien de réinitialisation.
    await admin()
    delete process.env.RESEND_API_KEY
    const res = mockRes()
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
    expect(res.body).toEqual(GENERIC)
    expect(JSON.stringify(res.body)).not.toMatch(/link|token|reset=|noEmailProvider/i)
    expect(await aucunResetActif()).toBe(true)
  })

  it('W — le fournisseur lève → même réponse, et le jeton est invalidé', async () => {
    await admin()
    captureEmail('throw')
    const res = mockRes()
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
    expect(res.body).toEqual(GENERIC)
    expect(await aucunResetActif()).toBe(true)
  })

  it('X — DÉFAUT : un 401/500 du fournisseur n\'est PAS un envoi réussi', async () => {
    // `fetch` ne lève pas sur un statut d'erreur : le `try/catch` ne voyait
    // rien, et une réinitialisation restait active que personne n'avait reçue.
    for (const status of [400, 401, 429, 500]) {
      resetKeystore()
      await deleteItem(RESET_KIND, RESET_ID, RESET_NS)
      await admin()
      const e = captureEmail({ ok: false, status })
      const res = mockRes()
      await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
      expect(res.body).toEqual(GENERIC)
      expect(e.appels()).toBe(1)                  // l'appel a bien eu lieu…
      expect(await aucunResetActif()).toBe(true)  // …et pourtant rien ne reste actif
      // Le jeton émis pendant cette tentative ne vaut plus rien.
      expect(await resetPassword(e.jeton() || 'x', 'nouveau-mot-de-passe')).toBe(false)
    }
  })

  it('Y/Z/AC — DÉFAUT : Origin et Host hostiles ne construisent plus le lien', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    const res = mockRes()
    await resetRequestHandler(post({ email: 'boss@smart.ai' }, {
      origin: 'https://evil.example',
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      referer: 'https://evil.example/piege',
    }), res)
    expect(res.body).toEqual(GENERIC)
    const lien = e.lien()!
    // Le lien part vers l'origine CONFIGURÉE, et rien d'autre.
    expect(lien.startsWith('https://app.prospector-test.invalid/login?reset=')).toBe(true)
    expect(lien).not.toContain('evil.example')
  })

  it('AA/AB — APP_BASE_URL absente ou invalide → aucun jeton actif', async () => {
    for (const base of [undefined, '', 'pas-une-url', 'http://evil.example', 'ftp://x.fr', 'javascript:alert(1)']) {
      resetKeystore()
      await deleteItem(RESET_KIND, RESET_ID, RESET_NS)
      await admin()
      if (base === undefined) delete process.env.APP_BASE_URL
      else process.env.APP_BASE_URL = base
      const e = captureEmail({ ok: true })
      const res = mockRes()
      await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
      expect(res.body).toEqual(GENERIC)
      expect(e.appels()).toBe(0)
      expect(await aucunResetActif()).toBe(true)
    }
  })

  it('AD — la réponse ne divulgue jamais l\'état du fournisseur ni l\'existence de l\'email', async () => {
    await admin()
    const reponses: any[] = []
    for (const scenario of ['inconnu', 'ok', 'throw', 'http500', 'sans-cle'] as const) {
      resetKeystore(); await deleteItem(RESET_KIND, RESET_ID, RESET_NS); await admin()
      if (scenario === 'sans-cle') delete process.env.RESEND_API_KEY
      captureEmail(scenario === 'throw' ? 'throw' : { ok: scenario === 'ok', status: 500 })
      const res = mockRes()
      await resetRequestHandler(post({ email: scenario === 'inconnu' ? 'autre@x.fr' : 'boss@smart.ai' }), res)
      reponses.push({ code: res.statusCode, body: res.body })
    }
    // Toutes identiques : rien ne permet de distinguer les cinq situations.
    for (const r of reponses) expect(r).toEqual({ code: 200, body: GENERIC })
  })

  it('AE — DÉFAUT : le jeton n\'est plus stocké en clair, seule son empreinte l\'est', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    const brut = e.jeton()!
    expect(brut).toMatch(/^[0-9a-f]{48}$/)
    // Le jeton porteur ne doit se trouver NULLE PART dans les réglages.
    expect(getKey('APP_RESET_TOKEN')).toBeFalsy()
    expect(getKey('APP_RESET_TOKEN_HASH')).toBeFalsy()
    const r = await getItemStrict<any>(RESET_KIND, RESET_ID, RESET_NS)
    const empreinte = r.ok ? r.value?.hash : null
    expect(empreinte).toBeTruthy()
    expect(empreinte).not.toBe(brut)
    expect(empreinte).toMatch(/^[0-9a-f]{64}$/)
    // Aucune valeur stockée ne contient le jeton.
    const g = (globalThis as any).__prospectorKeys as Map<string, string>
    for (const v of g.values()) expect(v).not.toContain(brut)
  })

  it('AF/AG — jeton valide → mot de passe changé ; rejeu → refusé', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    const brut = e.jeton()!

    const res1 = mockRes()
    await resetHandler(post({ token: brut, password: 'nouveau-mot-de-passe' }), res1)
    expect(res1.statusCode).toBe(200)
    expect(checkCredentials('boss@smart.ai', 'nouveau-mot-de-passe')).toBe(true)
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(false)

    // Usage unique : le même lien ne resert pas.
    const res2 = mockRes()
    await resetHandler(post({ token: brut, password: 'encore-un-autre-mdp' }), res2)
    expect(res2.statusCode).toBe(400)
    expect(checkCredentials('boss@smart.ai', 'nouveau-mot-de-passe')).toBe(true)
  })

  it('AH — jeton expiré → refusé', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    const brut = e.jeton()!
    // On avance au-delà de la fenêtre de 30 minutes.
    const vraiNow = Date.now
    Date.now = () => vraiNow() + 31 * 60 * 1000
    try {
      expect(await resetPassword(brut, 'nouveau-mot-de-passe')).toBe(false)
    } finally { Date.now = vraiNow }
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)
  })

  it('AI — jeton modifié, vide, ou d\'une autre demande → refusé', async () => {
    await admin()
    const e = captureEmail({ ok: true })
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    const brut = e.jeton()!
    const altere = brut.slice(0, -1) + (brut.endsWith('a') ? 'b' : 'a')
    for (const t of ['', 'x', altere, brut.toUpperCase(), brut.slice(0, 10)]) {
      const res = mockRes()
      await resetHandler(post({ token: t, password: 'nouveau-mot-de-passe' }), res)
      expect(res.statusCode).toBe(400)
    }
    // Une nouvelle demande périme la précédente : un seul reset vivant.
    const e2 = captureEmail({ ok: true })
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    expect(await resetPassword(brut, 'nouveau-mot-de-passe')).toBe(false)
    expect(await resetPassword(e2.jeton()!, 'nouveau-mot-de-passe')).toBe(true)
  })

  it('bornes : jeton démesuré et mot de passe hors bornes sont refusés avant bcrypt', async () => {
    await admin()
    for (const body of [
      { token: 'a'.repeat(5000), password: 'nouveau-mot-de-passe' },
      { token: 'abc', password: 'court' },
      { token: 'abc', password: 'p'.repeat(5000) },
    ]) {
      const res = mockRes()
      await resetHandler(post(body), res)
      expect(res.statusCode).toBe(400)
    }
  })

  it('GET sur les routes d\'authentification → 405', async () => {
    for (const h of [loginHandler, setupHandler, resetRequestHandler, resetHandler]) {
      const res = mockRes()
      await h({ method: 'GET', headers: {}, cookies: {}, query: {} } as any, res)
      expect(res.statusCode).toBe(405)
    }
  })
})
