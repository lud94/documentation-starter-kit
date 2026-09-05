// SEC-AUTH-2 — LE PLAN DE CONTRÔLE N'EST PAS OUVERT À TOUTE SESSION.
//
// SEC-AUTH-0 a fermé la racine d'identité : le middleware prouve désormais
// qu'une session est VALIDE, et qu'elle porte un rôle explicite. Mais « session
// valide » n'est pas « administrateur autorisé », et huit surfaces de plan de
// contrôle ne vérifiaient rien de plus.
//
// Ce que pouvait faire une session CLIENT au SHA 594a713 :
//
//   • écraser le secret TOTP de l'administrateur, le RECEVOIR dans la réponse,
//     et désactiver son second facteur au passage ;
//   • désactiver la MFA de l'administrateur d'un POST vide ;
//   • déclencher quatre appels Anthropic réels sur la clé PLATEFORME, imputés
//     au tenant système — donc à personne ;
//   • désactiver le masquage PII de TOUTE la plateforme ;
//   • lire la consommation et le budget GLOBAUX (tous espaces confondus) ;
//   • lancer une authentification hébergée Unipile sur le compte plateforme.
//
// ⚠️ Ces tests exercent les ROUTES, avec de vraies sessions signées, et
// n'importent aucun symbole créé par ce lot — c'est ce qui leur permet de
// mordre le code d'avant.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTestSessionSecret } from './helpers/session'

// ── Doubles : aucune base, aucun réseau ─────────────────────────────────────
vi.mock('../lib/supabase/settings', () => ({
  loadAllSettings: async () => ({}),
  saveSetting: async () => true,
}))
const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
}
vi.mock('../lib/supabase/workspaces', () => ({
  authClient: async () => null,
  getWorkspaceById: async (id: string) => WORKSPACES[id] ?? null,
  listWorkspaces: async () => Object.values(WORKSPACES),
}))

// Compteurs d'effets privilégiés. Un 403 qui a DÉJÀ muté n'est pas un refus.
const stageTotpSecret = vi.fn(async () => {})
const enableMfa = vi.fn(async () => {})
const disableMfa = vi.fn(async () => {})
const setKeys = vi.fn(async () => {})
const getUsageAll = vi.fn(async () => ({ 'ai:calls': 42, 'pappers:calls': 7 }))
const budgetLeft = vi.fn(async () => ({ anthropic: 20, spent: 3 }))
const generateSecret = vi.fn(() => 'SECRETTOTPDETESTAAAAAAAAAAAAAAAA')
const anthropicPost = vi.fn(async () => ({ ok: true, status: 200, data: { content: [] }, text: '' }))


type FakeTotpState = 'absent' | 'staged' | 'active' | 'revoked'
let fakeTotpState: FakeTotpState = 'absent'
let fakeTotpVersion = 0
let fakeTotpValue = ''

let fakeTelegramBotToken = ''
let fakeTelegramWebhookValue = ''

const readTelegramBotToken = vi.fn(async () =>
  fakeTelegramBotToken
    ? {
        ok: true as const,
        value: fakeTelegramBotToken,
        version: 1,
        status: 'active' as const,
      }
    : {
        ok: false as const,
        reason: 'not_configured' as const,
      }
)

const readTelegramWebhookSecret = vi.fn(async () =>
  fakeTelegramWebhookValue
    ? {
        ok: true as const,
        value: fakeTelegramWebhookValue,
        version: 1,
        status: 'active' as const,
      }
    : {
        ok: false as const,
        reason: 'not_configured' as const,
      }
)

const putTelegramWebhookPending = vi.fn(async (value: string) => {
  fakeTelegramWebhookValue = value

  return {
    ok: true as const,
    outcome: 'created' as const,
    version: 1,
  }
})

const confirmTelegramWebhookActive = vi.fn(async (_expectedVersion: number) => ({
  ok: true as const,
  outcome: 'promoted' as const,
  version: 1,
}))


const platformSecretStatus = vi.fn(async (name: string) => {
  if (name === 'telegram_webhook_secret') {
    if (!fakeTelegramWebhookValue) {
      return { kind: 'absent' as const }
    }

    return {
      kind: 'present' as const,
      status: 'active' as const,
      version: 1,
      kid: 'test-kid',
    }
  }

  if (name !== 'admin_totp_secret' || fakeTotpState === 'absent') {
    return { kind: 'absent' as const }
  }

  return {
    kind: 'present' as const,
    status: fakeTotpState,
    version: fakeTotpVersion,
    kid: 'test-kid',
  }
})

const stageAdminTotpSecret = vi.fn(async (value: string) => {
  if (fakeTotpState !== 'absent') {
    return { ok: false as const, outcome: 'exists' as const }
  }

  fakeTotpValue = value
  fakeTotpVersion = 1
  fakeTotpState = 'staged'

  return {
    ok: true as const,
    outcome: 'created' as const,
    version: fakeTotpVersion,
  }
})

const replacePlatformSecretValue = vi.fn(async (
  _name: string,
  value: string,
  expectedVersion: number,
) => {
  if (fakeTotpState !== 'revoked' || expectedVersion !== fakeTotpVersion) {
    return { ok: false as const, outcome: 'stale' as const }
  }

  fakeTotpValue = value
  fakeTotpVersion += 1
  fakeTotpState = 'staged'

  return {
    ok: true as const,
    outcome: 'replaced' as const,
    version: fakeTotpVersion,
  }
})

const readStagedAdminTotpSecret = vi.fn(async () => {
  if (fakeTotpState === 'staged') {
    return {
      ok: true as const,
      value: fakeTotpValue,
      version: fakeTotpVersion,
      status: 'staged' as const,
    }
  }

  return {
    ok: false as const,
    reason:
      fakeTotpState === 'absent'
        ? 'not_configured'
        : fakeTotpState === 'revoked'
          ? 'revoked'
          : 'wrong_state',
  }
})

const promoteAdminTotpSecret = vi.fn(async (expectedVersion: number) => {
  if (fakeTotpState !== 'staged' || expectedVersion !== fakeTotpVersion) {
    return { ok: false as const, outcome: 'stale' as const }
  }

  fakeTotpState = 'active'

  return {
    ok: true as const,
    outcome: 'promoted' as const,
    version: fakeTotpVersion,
  }
})

const revokeAdminTotpSecret = vi.fn(async (expectedVersion: number) => {
  if (
    (fakeTotpState !== 'staged' && fakeTotpState !== 'active') ||
    expectedVersion !== fakeTotpVersion
  ) {
    return { ok: false as const, outcome: 'stale' as const }
  }

  fakeTotpState = 'revoked'
  fakeTotpVersion += 1
  fakeTotpValue = ''

  return {
    ok: true as const,
    outcome: 'revoked' as const,
    version: fakeTotpVersion,
  }
})

vi.mock('../lib/secrets/platformVault', () => ({
  platformSecretStatus: (...a: any[]) => (platformSecretStatus as any)(...a),

  stageAdminTotpSecret: (...a: any[]) => (stageAdminTotpSecret as any)(...a),
  replacePlatformSecretValue: (...a: any[]) => (replacePlatformSecretValue as any)(...a),
  readStagedAdminTotpSecret: (...a: any[]) => (readStagedAdminTotpSecret as any)(...a),
  promoteAdminTotpSecret: (...a: any[]) => (promoteAdminTotpSecret as any)(...a),
  revokeAdminTotpSecret: (...a: any[]) => (revokeAdminTotpSecret as any)(...a),

  readTelegramBotToken: (...a: any[]) => (readTelegramBotToken as any)(...a),
  readTelegramWebhookSecret: (...a: any[]) => (readTelegramWebhookSecret as any)(...a),
  putTelegramWebhookPending: (...a: any[]) => (putTelegramWebhookPending as any)(...a),
  confirmTelegramWebhookActive: (...a: any[]) => (confirmTelegramWebhookActive as any)(...a),
}))

const KEYS: Record<string, string> = {}
vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (n: string) => KEYS[n] || undefined,
  hasKey: (n: string) => !!KEYS[n],
  keySource: () => 'app',
  setKeys: (...a: any[]) => (setKeys as any)(...a),
  MANAGED_KEYS: ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_NAME', 'PII_MASKING'],
}))
vi.mock('../lib/prospector/auth', () => ({
  stageTotpSecret: (...a: any[]) => (stageTotpSecret as any)(...a),
  enableMfa: (...a: any[]) => (enableMfa as any)(...a),
  disableMfa: (...a: any[]) => (disableMfa as any)(...a),
  getTotpSecret: () => KEYS.APP_TOTP_SECRET,
}))
vi.mock('../lib/auth/totp', () => ({
  generateSecret: (...a: any[]) => (generateSecret as any)(...a),
  otpauthUri: () => 'otpauth://totp/x',
  verifyTotp: async () => true,
}))
vi.mock('../lib/prospector/llm', () => ({
  anthropicPost: (...a: any[]) => (anthropicPost as any)(...a),
  pickModel: () => 'claude-sonnet-5',
  budgetLeft: (...a: any[]) => (budgetLeft as any)(...a),
}))
vi.mock('../lib/supabase/pappersCache', () => ({
  getUsageAll: (...a: any[]) => (getUsageAll as any)(...a),
}))
vi.mock('../lib/prospector/anonymize', () => ({
  maskPII: (t: string) => ({ masked: t, map: {} }),
  countPII: () => ({}),
}))

import { createSessionToken, SESSION_COOKIE } from '../lib/auth/session'
import mfaSetup from '../pages/api/auth/mfa/setup'
import mfaEnable from '../pages/api/auth/mfa/enable'
import mfaDisable from '../pages/api/auth/mfa/disable'
import diagnose from '../pages/api/ai/diagnose'
import anonymize from '../pages/api/config/anonymize'
import usage from '../pages/api/config/usage'
import unipileConnect from '../pages/api/unipile/connect'
import telegramSetup from '../pages/api/channels/telegram-setup'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  r.end = () => r
  return r
}

const ENV = ['APP_SESSION_SECRET', 'APP_BASE_URL', 'APP_ENV', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV']
let saved: Record<string, string | undefined> = {}
let fetchSpy: ReturnType<typeof vi.fn>

/** En-têtes HOSTILES, présents sur CHAQUE requête — y compris celles d'admin. */
const HOSTILES = {
  host: 'attacker.example',
  origin: 'https://attacker.example',
  'x-forwarded-host': 'attacker.example',
  'x-forwarded-proto': 'http',
  referer: 'https://attacker.example/piege',
}

async function req(method: string, cookie?: string, body: any = {}, query: any = {}) {
  return {
    method, body, query,
    headers: { ...HOSTILES },
    cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
  } as any
}
const admin = () => createSessionToken('boss@smart.ai', 3600, { role: 'admin' })
const client = () => createSessionToken('c@fabel.fr', 3600, { role: 'client', ws: 'ws_fabel' })

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  useTestSessionSecret()
  process.env.APP_ENV = 'development'
  process.env.APP_BASE_URL = 'https://app.prospector-test.invalid'
  for (const k of Object.keys(KEYS)) delete KEYS[k]
  fakeTotpState = 'absent'
  fakeTotpVersion = 0
  fakeTotpValue = ''
  fakeTelegramBotToken = ''
  fakeTelegramWebhookValue = ''
  vi.clearAllMocks()
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'bot' }, url: 'https://unipile.invalid/lien' }) }))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  vi.unstubAllGlobals()
})

/** Les huit surfaces, avec leur invocation minimale. */
const SURFACES: Array<[string, any, string, any]> = [
  ['mfa/setup', mfaSetup, 'POST', {}],
  ['mfa/enable', mfaEnable, 'POST', { code: '123456' }],
  ['mfa/disable', mfaDisable, 'POST', {}],
  ['ai/diagnose', diagnose, 'POST', {}],
  ['config/anonymize', anonymize, 'POST', { enabled: false }],
  ['config/usage', usage, 'GET', {}],
  ['unipile/connect', unipileConnect, 'GET', {}],
  ['channels/telegram-setup', telegramSetup, 'POST', {}],
]

// ══ §18 A–H — LE CLIENT EST REFUSÉ, ET RIEN N'A ÉTÉ FAIT ═══════════════════
describe('§18 — une session CLIENT est refusée sur les huit surfaces privilégiées', () => {
  it('les huit rendent 403 à un client, et 403 aussi sans session', async () => {
    for (const [nom, h, method, body] of SURFACES) {
      const c = mockRes()
      await h(await req(method, (await client())!, body), c)
      expect(c.statusCode, `${nom} — session client`).toBe(403)

      const anon = mockRes()
      await h(await req(method, undefined, body), anon)
      expect(anon.statusCode, `${nom} — sans session`).toBe(403)
    }
  })

  it('A — MFA setup : ni secret généré, ni secret écrit, ni secret rendu', async () => {
    const res = mockRes()
    await mfaSetup(await req('POST', (await client())!), res)
    expect(res.statusCode).toBe(403)
    // ⚠️ La garde doit précéder la GÉNÉRATION : un secret produit puis jeté
    // aurait tout de même été produit, et `stageTotpSecret` l'aurait écrit.
    expect(generateSecret).not.toHaveBeenCalled()
    expect(platformSecretStatus).not.toHaveBeenCalled()
    expect(stageAdminTotpSecret).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toMatch(/secret|otpauth/i)
  })

  it('B — MFA enable : aucune activation', async () => {
    KEYS.APP_TOTP_SECRET = 'SECRETENATTENTE'
    const res = mockRes()
    await mfaEnable(await req('POST', (await client())!, { code: '123456' }), res)
    expect(res.statusCode).toBe(403)
    expect(readStagedAdminTotpSecret).not.toHaveBeenCalled()
    expect(promoteAdminTotpSecret).not.toHaveBeenCalled()
  })

  it('C — MFA disable : le second facteur de l\'admin est intact', async () => {
    const res = mockRes()
    await mfaDisable(await req('POST', (await client())!), res)
    expect(res.statusCode).toBe(403)
    expect(platformSecretStatus).not.toHaveBeenCalled()
    expect(revokeAdminTotpSecret).not.toHaveBeenCalled()
  })

  it('D — diagnose : EXACTEMENT ZÉRO appel fournisseur', async () => {
    KEYS.ANTHROPIC_API_KEY = 'clef-anthropic-de-test'
    const res = mockRes()
    await diagnose(await req('POST', (await client())!), res)
    expect(res.statusCode).toBe(403)
    expect(anthropicPost).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('E — anonymize : PII_MASKING global inchangé', async () => {
    for (const body of [{ enabled: false }, { enabled: true }, { text: 'Jean Dupont' }]) {
      const res = mockRes()
      await anonymize(await req('POST', (await client())!, body), res)
      expect(res.statusCode).toBe(403)
    }
    expect(setKeys).not.toHaveBeenCalled()
    // Le GET est fermé au même titre : il décrit l'état global de la plateforme.
    const g = mockRes()
    await anonymize(await req('GET', (await client())!), g)
    expect(g.statusCode).toBe(403)
  })

  it('F — usage : aucun compteur global lu', async () => {
    const res = mockRes()
    await usage(await req('GET', (await client())!), res)
    expect(res.statusCode).toBe(403)
    expect(getUsageAll).not.toHaveBeenCalled()
    expect(budgetLeft).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toMatch(/budget|calls|cost/i)
  })

  it('G — unipile : aucune clé lue, aucun appel réseau', async () => {
    KEYS.UNIPILE_DSN = 'api-x.unipile.invalid'
    KEYS.UNIPILE_API_KEY = 'clef-unipile-de-test'
    const res = mockRes()
    await unipileConnect(await req('GET', (await client())!, {}, { provider: 'linkedin' }), res)
    expect(res.statusCode).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain('unipile.invalid')
  })

  it('H — telegram-setup : ni secret, ni écriture, ni setWebhook', async () => {
    fakeTelegramBotToken = '123:jeton-de-test'
    const res = mockRes()
    await telegramSetup(await req('POST', (await client())!), res)
    expect(res.statusCode).toBe(403)
    expect(setKeys).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ══ §18 I — L'ADMINISTRATEUR GARDE SES CAPACITÉS ═══════════════════════════
describe('§18 I — le comportement administrateur reste fonctionnel', () => {
  it('MFA : setup -> enable -> disable', async () => {
    const s = mockRes()
    await mfaSetup(await req('POST', (await admin())!), s)

    expect(s.statusCode).toBe(200)
    expect(s.body.secret).toBeTruthy()
    expect(stageAdminTotpSecret).toHaveBeenCalledTimes(1)
    expect(fakeTotpState).toBe('staged')

    const e = mockRes()
    await mfaEnable(
      await req('POST', (await admin())!, { code: '123456' }),
      e,
    )

    expect(e.statusCode).toBe(200)
    expect(readStagedAdminTotpSecret).toHaveBeenCalledTimes(1)
    expect(promoteAdminTotpSecret).toHaveBeenCalledTimes(1)
    expect(fakeTotpState).toBe('active')

    const d = mockRes()
    await mfaDisable(await req('POST', (await admin())!), d)

    expect(d.statusCode).toBe(200)
    expect(revokeAdminTotpSecret).toHaveBeenCalledTimes(1)
    expect(fakeTotpState).toBe('revoked')
  })

  it('usage et anonymize répondent à l\'administrateur', async () => {
    const u = mockRes()
    await usage(await req('GET', (await admin())!), u)
    expect(u.statusCode).toBe(200)
    expect(getUsageAll).toHaveBeenCalled()

    const a = mockRes()
    await anonymize(await req('POST', (await admin())!, { enabled: false }), a)
    expect(a.statusCode).toBe(200)
    expect(setKeys).toHaveBeenCalledWith({ PII_MASKING: '0' })
  })

  it('diagnose administrateur : la clé est lue et les sondes partent', async () => {
    KEYS.ANTHROPIC_API_KEY = 'clef-anthropic-de-test'
    const res = mockRes()
    await diagnose(await req('POST', (await admin())!), res)
    expect(res.statusCode).toBe(200)
    expect(anthropicPost).toHaveBeenCalledTimes(4)
  })
})

// ══ §19 — ORIGINES HOSTILES ════════════════════════════════════════════════
describe('§19 — Host, Origin et X-Forwarded-* ne construisent AUCUNE URL sortante', () => {
  it('unipile : les redirections viennent d\'APP_BASE_URL, jamais de la requête', async () => {
    KEYS.UNIPILE_DSN = 'api-x.unipile.invalid'
    KEYS.UNIPILE_API_KEY = 'clef-unipile-de-test'
    const res = mockRes()
    await unipileConnect(await req('GET', (await admin())!, {}, { provider: 'linkedin' }), res)
    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const envoye = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body)
    expect(envoye.success_redirect_url).toBe('https://app.prospector-test.invalid/admin?connected=linkedin')
    expect(envoye.failure_redirect_url).toBe('https://app.prospector-test.invalid/admin?failed=linkedin')
    expect(JSON.stringify(envoye)).not.toContain('attacker.example')
  })

  it('telegram : l\'URL déclarée à Telegram vient d\'APP_BASE_URL', async () => {
    fakeTelegramBotToken = '123:jeton-de-test'
    const res = mockRes()
    await telegramSetup(await req('POST', (await admin())!), res)
    expect(res.statusCode).toBe(200)
    const envoye = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body)
    expect(envoye.url).toBe('https://app.prospector-test.invalid/api/channels/telegram')
    expect(envoye.url).not.toContain('attacker.example')
    // Sinon toutes les mises à jour du bot seraient parties chez l'attaquant.
    expect(JSON.stringify(res.body)).not.toContain('attacker.example')
  })

  it('APP_BASE_URL absente → FAIL CLOSED, aucun appel sortant', async () => {
    delete process.env.APP_BASE_URL
    KEYS.UNIPILE_DSN = 'api-x.unipile.invalid'
    KEYS.UNIPILE_API_KEY = 'clef-unipile-de-test'
    fakeTelegramBotToken = '123:jeton-de-test'

    const u = mockRes()
    await unipileConnect(await req('GET', (await admin())!, {}, { provider: 'linkedin' }), u)
    expect(u.body.error).toBe('app_base_url_missing')

    const t = mockRes()
    await telegramSetup(await req('POST', (await admin())!), t)
    expect(t.body.error).toMatch(/APP_BASE_URL/)

    expect(fetchSpy).not.toHaveBeenCalled()
    // Et aucun secret de webhook n'a été engendré pour rien.
    expect(setKeys).not.toHaveBeenCalled()
  })
})

// ══ §12 — ALLOWLIST DE PROVIDER ════════════════════════════════════════════
describe('§12 — le provider Unipile est allowlisté, jamais deviné', () => {
  it('les trois valeurs connues passent, les autres sont refusées', async () => {
    KEYS.UNIPILE_DSN = 'api-x.unipile.invalid'
    KEYS.UNIPILE_API_KEY = 'clef-unipile-de-test'
    for (const p of ['linkedin', 'whatsapp', 'email']) {
      const res = mockRes()
      await unipileConnect(await req('GET', (await admin())!, {}, { provider: p }), res)
      expect(res.statusCode).toBe(200)
    }
    // ⚠️ Aucune valeur inconnue ne retombe silencieusement sur LINKEDIN : une
    // erreur d'appel se lisait alors comme un succès sur le mauvais canal.
    for (const p of ['LINKEDIN', 'slack', 'x', '../../etc', '']) {
      const res = mockRes()
      await unipileConnect(await req('GET', (await admin())!, {}, { provider: p }), res)
      if (p === '') { expect(res.statusCode).toBe(200); continue }   // défaut documenté
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_provider' })
    }
  })
})

// ══ §20 — ERREURS FOURNISSEURS ═════════════════════════════════════════════
describe('§20 — aucun corps d\'erreur de tiers ne ressort, ni en réponse ni en journal', () => {
  const POISON = 'sk-secret-test X-API-KEY: Bearer abc token=123 https://tenant-sensitive.example'

  /** Capture tout ce que le code écrit sur la console pendant l'appel. */
  async function sansFuite(fn: () => Promise<any>) {
    const vus: string[] = []
    const espion = (...a: any[]) => { vus.push(a.map((x) => String(x)).join(' ')) }
    const log = vi.spyOn(console, 'log').mockImplementation(espion as any)
    const err = vi.spyOn(console, 'error').mockImplementation(espion as any)
    const warn = vi.spyOn(console, 'warn').mockImplementation(espion as any)
    try { return { res: await fn(), journal: vus.join('\n') } }
    finally { log.mockRestore(); err.mockRestore(); warn.mockRestore() }
  }

  const INTERDITS = ['sk-secret-test', 'X-API-KEY', 'Bearer abc', 'token=123', 'tenant-sensitive.example']

  it('unipile : un corps d\'erreur empoisonné ne ressort nulle part', async () => {
    KEYS.UNIPILE_DSN = 'api-x.unipile.invalid'
    KEYS.UNIPILE_API_KEY = 'clef-unipile-de-test'
    for (const mode of ['http', 'throw'] as const) {
      fetchSpy = vi.fn(async () => {
        if (mode === 'throw') throw new Error(POISON)
        return { ok: false, status: 401, json: async () => ({ detail: POISON }) }
      })
      vi.stubGlobal('fetch', fetchSpy)
      const { res, journal } = await sansFuite(async () => {
        const r = mockRes()
        await unipileConnect(await req('GET', (await admin())!, {}, { provider: 'linkedin' }), r)
        return r
      })
      expect(res.body).toEqual({ configured: true, error: 'unipile_connection_failed' })
      const tout = JSON.stringify(res.body) + journal
      for (const i of INTERDITS) expect(tout).not.toContain(i)
      // La clé et le DSN de la plateforme non plus.
      expect(tout).not.toContain('clef-unipile-de-test')
    }
  })

  it('telegram : la description d\'erreur de Telegram n\'est pas relayée', async () => {
    fakeTelegramBotToken = '123:jeton-de-test'
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: POISON }) }))
    vi.stubGlobal('fetch', fetchSpy)
    const { res, journal } = await sansFuite(async () => {
      const r = mockRes()
      await telegramSetup(await req('POST', (await admin())!), r)
      return r
    })
    const tout = JSON.stringify(res.body) + journal
    for (const i of INTERDITS) expect(tout).not.toContain(i)
    expect(tout).not.toContain('jeton-de-test')
  })

  it('diagnose : le corps d\'erreur d\'Anthropic devient une CATÉGORIE', async () => {
    KEYS.ANTHROPIC_API_KEY = 'clef-anthropic-de-test'
    anthropicPost.mockResolvedValue({ ok: false, status: 401, data: null, text: POISON } as any)
    const { res, journal } = await sansFuite(async () => {
      const r = mockRes()
      await diagnose(await req('POST', (await admin())!), r)
      return r
    })
    const tout = JSON.stringify(res.body) + journal
    for (const i of INTERDITS) expect(tout).not.toContain(i)
    expect(tout).not.toContain('clef-anthropic-de-test')
    // Mais l'administrateur apprend tout de même ce qui s'est passé.
    expect(JSON.stringify(res.body)).toContain('401')
  })
})

// ══ §14 — LE SECRET DU WEBHOOK EST CRYPTOGRAPHIQUE ═════════════════════════
describe('§14 — TELEGRAM_WEBHOOK_SECRET vient d\'un CSPRNG', () => {
  it('32 octets hexadécimaux, et jamais deux fois le même', async () => {
    fakeTelegramBotToken = '123:jeton-de-test'
    const vus = new Set<string>()
    for (let i = 0; i < 20; i++) {
      fakeTelegramWebhookValue = ''
      putTelegramWebhookPending.mockClear()
      const res = mockRes()
      await telegramSetup(await req('POST', (await admin())!), res)
      expect(res.statusCode).toBe(200)
      const ecrit = (putTelegramWebhookPending.mock.calls[0] as any)[0]
      // ⚠️ `Math.random().toString(36)` ne peut PAS produire cette forme :
      // il rendait ~20 caractères de l'alphabet base-36, sans borne de longueur
      // garantie — et surtout sans propriété cryptographique.
      expect(ecrit).toMatch(/^[0-9a-f]{64}$/)
      vus.add(ecrit)
    }
    expect(vus.size).toBe(20)
  })

  it('un secret déjà présent n\'est pas régénéré', async () => {
    fakeTelegramBotToken = '123:jeton-de-test'
    fakeTelegramWebhookValue = 'a'.repeat(64)
    const res = mockRes()
    await telegramSetup(await req('POST', (await admin())!), res)
    const envoye = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body)
    expect(envoye.secret_token).toBe('a'.repeat(64))
  })
})
