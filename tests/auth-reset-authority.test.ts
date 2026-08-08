// SEC-AUTH-0.1 — L'AUTORITÉ DE RÉINITIALISATION : ATOMIQUE, ET EN BASE.
//
// SEC-AUTH-0 a fermé sept portes. Deux propriétés restaient fausses, et toutes
// deux concernent la même chose : QUI fait autorité sur un bearer consommable.
//
//   1. CONSOMMATION NON ATOMIQUE. `resetPassword` faisait
//      `checkResetToken → setCredentials → invalidateResetToken`. Vingt
//      requêtes portant le même lien passaient toutes la vérification avant la
//      première invalidation. « Usage unique » n'était vrai que séquentiellement.
//
//   2. L'AUTORITÉ VIVAIT DANS LE KEYSTORE, dont la lecture retombe sur
//      `process.env`. Une empreinte posée en variable d'environnement
//      SURVIVAIT à toute invalidation — un artefact périmé redevenait le
//      pouvoir de changer le mot de passe administrateur.
//
// ⚠️ Ce fichier n'exerce que des surfaces qui existent AUSSI au SHA 4491304 —
// `resetPassword`, les deux routes — précisément pour pouvoir mordre le code
// d'avant. Il n'importe rien de créé par ce lot.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../lib/supabase/settings', () => ({
  loadAllSettings: async () => ({}),
  saveSetting: async () => true,
}))

// Supabase n'est pas configuré : `prospector_store` utilise son repli mémoire,
// qui offre la même garantie d'exclusion (aucune interruption entre le test et
// la suppression). La preuve contre PostgreSQL RÉEL est dans
// `tests/integration/reset-authority-pg.test.ts` — un repli mémoire ne prouve
// pas ce que fait la base.
import { setCredentials, resetPassword, checkCredentials } from '../lib/prospector/auth'
import { getKey } from '../lib/prospector/keystore'
import resetRequestHandler from '../pages/api/auth/reset-request'
import resetHandler from '../pages/api/auth/reset'

const PASSWORD = 'motdepasse-de-test'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  return r
}
const post = (body: any) => ({ method: 'POST', headers: {}, body, cookies: {}, query: {} } as any)

const ENV = ['APP_ENV', 'NEXT_PUBLIC_APP_ENV', 'RESEND_API_KEY', 'APP_BASE_URL', 'APP_RESET_TOKEN', 'APP_RESET_TOKEN_HASH', 'APP_RESET_EXP', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
let saved: Record<string, string | undefined> = {}

/** Vide le keystore ET l'autorité de réinitialisation, où qu'elle vive. */
async function toutEffacer() {
  const g = globalThis as any
  g.__prospectorKeys?.clear?.()
  g.__prospectorHydrated = undefined
  // Le magasin `prospector_store` garde sa mémoire d'un test à l'autre : on
  // consomme l'autorité éventuelle en boucle jusqu'à ce qu'il n'en reste plus.
  const { deleteItem } = await import('../lib/supabase/store')
  await deleteItem('authreset', 'admin', '_auth')
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  await toutEffacer()
  vi.restoreAllMocks()
  // SEC-AUTH-0.2 : le repli mémoire de l'autorité n'est plus implicite. Ces
  // tests sont, par nature, un développement local — ils le DÉCLARENT.
  process.env.APP_ENV = 'development'
  process.env.RESEND_API_KEY = 'clef-de-test-non-reelle'
  process.env.APP_BASE_URL = 'https://app.prospector-test.invalid'
  await setCredentials('boss@smart.ai', PASSWORD)
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await toutEffacer()
})

/** Remplace `fetch` ; rend le jeton réellement envoyé dans l'email. */
function email(reply: { ok: boolean; status?: number } | 'throw') {
  const vus: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
    vus.push(String(JSON.parse(init.body).html))
    if (reply === 'throw') throw new Error('réseau injoignable')
    return { ok: reply.ok, status: reply.status ?? 200, json: async () => ({}) }
  }))
  return { jeton: () => (vus[vus.length - 1]?.match(/reset=([0-9a-f]+)/) || [])[1] }
}

/** Demande une réinitialisation et rend le bearer émis. */
async function demander(reply: { ok: boolean; status?: number } | 'throw' = { ok: true }) {
  const e = email(reply)
  const res = mockRes()
  await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
  return { token: e.jeton(), res }
}

// ══ §20 A–N ════════════════════════════════════════════════════════════════
describe('SEC-AUTH-0.1 — le bearer de réinitialisation se consomme, il ne se vérifie pas', () => {
  it('A/B — jeton absent, vide ou faux → DENY', async () => {
    await demander()
    for (const t of ['', '   ', 'x', 'a'.repeat(48)]) {
      expect(await resetPassword(t, 'nouveau-mot-de-passe')).toBe(false)
    }
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)
  })

  it('C — jeton expiré → DENY, et l\'autorité est tout de même consommée', async () => {
    const { token } = await demander()
    const vraiNow = Date.now
    Date.now = () => vraiNow() + 31 * 60 * 1000
    try {
      expect(await resetPassword(token!, 'nouveau-mot-de-passe')).toBe(false)
    } finally { Date.now = vraiNow }
    // La ligne a été réclamée : un lien périmé n'a aucune raison de rester
    // réclamable, même une fois l'horloge revenue.
    expect(await resetPassword(token!, 'nouveau-mot-de-passe')).toBe(false)
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)
  })

  it('D/E — un succès, puis rejeu séquentiel refusé', async () => {
    const { token } = await demander()
    expect(await resetPassword(token!, 'premier-nouveau-mdp')).toBe(true)
    expect(await resetPassword(token!, 'second-nouveau-mdp')).toBe(false)
    expect(checkCredentials('boss@smart.ai', 'premier-nouveau-mdp')).toBe(true)
    expect(checkCredentials('boss@smart.ai', 'second-nouveau-mdp')).toBe(false)
  })

  it('F — DÉFAUT : 20 consommations SIMULTANÉES → exactement UNE réussit', async () => {
    // Le cœur du lot. `check → agir → supprimer` laissait les vingt appels
    // franchir la vérification avant la première invalidation ; ils écrivaient
    // ensuite tous leur mot de passe, et le dernier arrivé gagnait le compte.
    const { token } = await demander()
    const resultats = await Promise.all(
      Array.from({ length: 20 }, (_, i) => resetPassword(token!, `mot-de-passe-concurrent-${i}`)),
    )
    expect(resultats.filter((r) => r === true)).toHaveLength(1)
    expect(resultats.filter((r) => r === false)).toHaveLength(19)

    // Et le mot de passe effectif est celui du SEUL gagnant.
    const gagnant = resultats.indexOf(true)
    expect(checkCredentials('boss@smart.ai', `mot-de-passe-concurrent-${gagnant}`)).toBe(true)
    for (let i = 0; i < 20; i++) {
      if (i === gagnant) continue
      expect(checkCredentials('boss@smart.ai', `mot-de-passe-concurrent-${i}`)).toBe(false)
    }
  })

  it('F bis — 20 consommations simultanées via la ROUTE : un seul 200', async () => {
    const { token } = await demander()
    const reponses = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const res = mockRes()
      await resetHandler(post({ token, password: `mot-de-passe-route-${i}` }), res)
      return res.statusCode
    }))
    expect(reponses.filter((c) => c === 200)).toHaveLength(1)
    expect(reponses.filter((c) => c === 400)).toHaveLength(19)
  })

  it('I/J — DÉFAUT : APP_RESET_TOKEN_HASH et APP_RESET_EXP en environnement n\'ont AUCUN pouvoir', async () => {
    // Le scénario : une empreinte VALIDE et une expiration future posées en
    // variables d'environnement, mais aucune autorité en base. Hier, `getKey`
    // retombait sur `process.env` et ce jeton changeait le mot de passe.
    const brut = 'ab'.repeat(24)
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(brut))
    process.env.APP_RESET_TOKEN_HASH = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
    process.env.APP_RESET_EXP = String(Date.now() + 30 * 60 * 1000)
    process.env.APP_RESET_TOKEN = brut     // et l'artefact hérité, tant qu'à faire

    expect(await resetPassword(brut, 'mot-de-passe-pirate')).toBe(false)
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)

    // Une VRAIE autorité, elle, fonctionne — l'environnement stale ne la gêne pas.
    const { token } = await demander()
    expect(await resetPassword(token!, 'nouveau-mot-de-passe')).toBe(true)
  })

  it('l\'environnement stale ne survit pas non plus à une consommation légitime', async () => {
    const { token } = await demander()
    expect(await resetPassword(token!, 'nouveau-mot-de-passe')).toBe(true)
    // Après usage, rien ne ressuscite le bearer — pas même un keystore garni.
    expect(await resetPassword(token!, 'encore-un-mot-de-passe')).toBe(false)
    expect(getKey('APP_RESET_TOKEN')).toBeFalsy()
  })

  it('K/M — DÉFAUT : l\'échec d\'envoi de A ne détruit PAS l\'autorité de B', async () => {
    // A crée son autorité mais son email part en erreur ; B en crée une autre
    // et la reçoit. Une invalidation INCONDITIONNELLE tuait celle de B :
    // provoquer des échecs d'envoi suffisait à empêcher indéfiniment la
    // réinitialisation d'autrui — un déni de service sur la seule voie de
    // récupération du compte.
    //
    // On force l'ordre : A crée, B crée, PUIS l'email de A échoue.
    let relacherA: () => void = () => {}
    const attenteA = new Promise<void>((r) => { relacherA = r })
    let premier = true
    const html: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      html.push(String(JSON.parse(init.body).html))
      if (premier) { premier = false; await attenteA; return { ok: false, status: 500, json: async () => ({}) } }
      return { ok: true, status: 200, json: async () => ({}) }
    }))

    const appelA = resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())
    await new Promise((r) => setTimeout(r, 5))          // A a écrit son autorité
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), mockRes())  // B remplace
    relacherA()                                          // l'email de A échoue MAINTENANT
    await appelA

    const jetonA = (html[0].match(/reset=([0-9a-f]+)/) || [])[1]
    const jetonB = (html[1].match(/reset=([0-9a-f]+)/) || [])[1]
    expect(jetonA).not.toBe(jetonB)

    // A n'est plus valable — il a été remplacé par B, c'est voulu.
    expect(await resetPassword(jetonA, 'mot-de-passe-par-A')).toBe(false)
    // ⚠️ ET B EST INTACT : c'est précisément ce que l'invalidation globale cassait.
    expect(await resetPassword(jetonB, 'mot-de-passe-par-B')).toBe(true)
    expect(checkCredentials('boss@smart.ai', 'mot-de-passe-par-B')).toBe(true)
  })

  it('L — A puis B, l\'email de A arrive plus tard : A reste INVALIDE', async () => {
    // Une seule autorité courante. Un email de A parti avec succès mais après
    // la création de B ne ressuscite pas A : la sécurité prime sur l'ordre
    // d'arrivée des messages, et on l'assume plutôt qu'on ne l'ignore.
    const a = await demander()
    const b = await demander()
    expect(a.token).not.toBe(b.token)
    expect(await resetPassword(a.token!, 'mot-de-passe-par-A')).toBe(false)
    expect(await resetPassword(b.token!, 'mot-de-passe-par-B')).toBe(true)
  })

  it('G/H — base absente sur un DÉPLOIEMENT → création et consommation refusées', async () => {
    // Le repli mémoire de `prospector_store` est par INSTANCE. Sur du
    // serverless, chaque instance porterait sa propre notion d'usage unique :
    // le même lien servirait une fois par instance. Une autorité ne peut pas
    // vivre dans une mémoire qui n'est partagée par personne.
    const { token } = await demander()
    process.env.VERCEL_ENV = 'production'                // déployé, sans Supabase
    expect(await resetPassword(token!, 'mot-de-passe-pirate')).toBe(false)

    const res = mockRes()
    await resetRequestHandler(post({ email: 'boss@smart.ai' }), res)
    expect(res.body).toEqual({ sent: true })            // réponse inchangée
    expect(checkCredentials('boss@smart.ai', PASSWORD)).toBe(true)
  })

  it('N — aucune réponse HTTP ne contient jeton, empreinte ni lien', async () => {
    for (const reply of [{ ok: true }, { ok: false, status: 500 }, 'throw'] as const) {
      const { res } = await demander(reply)
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ sent: true })
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{32}|link|token|hash|reset=/i)
    }
  })

  it('l\'autorité stockée ne contient QUE l\'empreinte et l\'expiration', async () => {
    const { token } = await demander()
    const { getItemStrict } = await import('../lib/supabase/store')
    const r = await getItemStrict<any>('authreset', 'admin', '_auth')
    expect(r.ok).toBe(true)
    const data = r.ok ? r.value : null
    expect(Object.keys(data).sort()).toEqual(['exp', 'hash'])
    // Ni le bearer, ni un mot de passe, ni un secret de session.
    expect(JSON.stringify(data)).not.toContain(token!)
    expect(JSON.stringify(data)).not.toContain(PASSWORD)
  })
})
