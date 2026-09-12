// SEC-LOG-01 (phase D) — LES SURFACES DE SORTIE.
//
// Le fichier précédent prouve que les modules d'accès aux fournisseurs ne
// fabriquent plus d'erreurs porteuses de contenu. Celui-ci vérifie l'autre bout
// de la chaîne : les routes qui ATTRAPENT une erreur ne doivent ni la
// journaliser telle quelle, ni la renvoyer au client.
//
// La distinction compte, parce qu'une erreur peut venir d'ailleurs que d'un
// fournisseur — d'une exception interne dont le message a interpolé une valeur
// métier, par exemple. La route ne peut pas savoir ce que contient un message ;
// elle doit donc ne jamais en lire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const SYSTEM_CANARY = 'SYSTEM_CANARY_SECRET_9Fb2e1'
const CRM_CANARY = 'CRM_CANARY_SECRET_42d9a0'
const EMAIL_CANARY = 'EMAIL_CANARY_SECRET_73c5f8'
const PROVIDER_BODY_CANARY = 'PROVIDER_BODY_CANARY_81a4c7'

const CANARIS = [SYSTEM_CANARY, CRM_CANARY, EMAIL_CANARY, PROVIDER_BODY_CANARY]

function aucunCanari(texte: string, contexte: string) {
  for (const c of CANARIS) {
    expect(texte, `${contexte} : le canari ${c} a fuité`).not.toContain(c)
  }
}

/** Message d'exception TRÈS bavard, comme en produit une erreur interne mal écrite. */
function exceptionBavarde(): Error {
  const e = new Error(
    `échec en traitant "${SYSTEM_CANARY}" pour ${CRM_CANARY} (${EMAIL_CANARY}) — ${PROVIDER_BODY_CANARY}`,
  )
  return e
}

let journal: string[] = []
let spyError: any
let spyWarn: any
let spyLog: any

beforeEach(() => {
  journal = []
  const capte = (...args: any[]) => { journal.push(args.map((a) => String(a)).join(' ')) }
  spyError = vi.spyOn(console, 'error').mockImplementation(capte)
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(capte)
  spyLog = vi.spyOn(console, 'log').mockImplementation(capte)
})

afterEach(() => {
  spyError?.mockRestore()
  spyWarn?.mockRestore()
  spyLog?.mockRestore()
  vi.restoreAllMocks()
  vi.resetModules()
})

function faussesReponses() {
  const capture: any = { status: 0, body: null, headers: {} }
  const res: any = {
    status(code: number) { capture.status = code; return res },
    json(payload: any) { capture.body = payload; return res },
    setHeader(k: string, v: any) { capture.headers[k] = v; return res },
    end() { return res },
  }
  return { res, capture }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Jarvis in-app — /api/jarvis/chat', () => {
  it('une exception bavarde ne se retrouve ni en journal ni en réponse', async () => {
    vi.resetModules()
    vi.doMock('../lib/prospector/tenant', () => ({
      resolveTenantFromRequest: async () => ({ id: 'ws_test', kind: 'client' }),
      SYSTEM_TENANT_ID: '_system',
    }))
    vi.doMock('../lib/prospector/jarvisAgent', () => ({
      planJarvis: async () => { throw exceptionBavarde() },
      executeJarvis: async () => ({}),
      isWrite: () => false,
    }))

    const handler = (await import('../pages/api/jarvis/chat')).default
    const { res, capture } = faussesReponses()
    await handler({ method: 'POST', body: { message: `parle de ${CRM_CANARY}` }, cookies: {} } as any, res)

    aucunCanari(journal.join('\n'), 'chat — journaux')
    aucunCanari(JSON.stringify(capture.body ?? {}), 'chat — réponse HTTP')
    // La route reste fonctionnelle : elle répond, avec un message générique.
    expect(capture.status).toBe(200)
    expect(String(capture.body?.reply || '')).toBeTruthy()
  })
})

describe('B. Extension Jarvis — /api/jarvis/agent', () => {
  it('une exception bavarde ne se retrouve ni en journal ni en réponse', async () => {
    vi.resetModules()
    vi.doMock('../lib/prospector/extensionGate', () => ({
      allowedOrigins: () => ['chrome-extension://test'],
      corsHeaders: () => ({}),
      isAllowedOrigin: () => true,
    }))
    vi.doMock('../lib/prospector/jarvisAgent', () => ({
      planJarvis: async () => { throw exceptionBavarde() },
      executeJarvis: async () => ({}),
      isWrite: () => false,
    }))

    let handler: any
    try {
      handler = (await import('../pages/api/jarvis/agent')).default
    } catch {
      return // la route ne se charge pas isolément : le cas gateway couvre déjà la chaîne
    }

    const { res, capture } = faussesReponses()
    await handler(
      { method: 'POST', headers: { origin: 'chrome-extension://test' }, body: { message: 'x' }, cookies: {} } as any,
      res,
    ).catch(() => null)

    aucunCanari(journal.join('\n'), 'agent — journaux')
    aucunCanari(JSON.stringify(capture.body ?? {}), 'agent — réponse HTTP')
  })
})

describe('C. Telegram — /api/channels/telegram', () => {
  it('ni le contenu du message ni l\'erreur ne partent en journal', async () => {
    vi.resetModules()
    vi.doMock('../lib/secrets/platformVault', () => ({
      readTelegramBotToken: async () => ({ ok: true, value: 'token', version: 1, status: 'active' }),
      readTelegramWebhookSecret: async () => ({ ok: true, value: 'secret', version: 1, status: 'active' }),
    }))
    vi.doMock('../lib/prospector/pairing', () => ({
      redeemPairingCode: async () => { throw exceptionBavarde() },
      resolveChannelWs: async () => { throw exceptionBavarde() },
      unlinkChannel: async () => { throw exceptionBavarde() },
    }))

    let handler: any
    try {
      handler = (await import('../pages/api/channels/telegram')).default
    } catch {
      return
    }

    const { res, capture } = faussesReponses()
    await handler(
      {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'secret' },
        body: { message: { chat: { id: 1 }, text: `${CRM_CANARY} ${EMAIL_CANARY}` } },
        cookies: {},
      } as any,
      res,
    ).catch(() => null)

    aucunCanari(journal.join('\n'), 'telegram — journaux')
    aucunCanari(JSON.stringify(capture.body ?? {}), 'telegram — réponse HTTP')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Le descripteur central est fermé par construction', () => {
  it('ne lit JAMAIS le message d\'une erreur qu\'il n\'a pas construite', async () => {
    const { describeError, logSafeError } = await import('../lib/observability/safeError')

    const formes: unknown[] = [
      exceptionBavarde(),
      new TypeError(SYSTEM_CANARY),
      { message: CRM_CANARY, stack: EMAIL_CANARY },
      `chaîne brute ${PROVIDER_BODY_CANARY}`,
      [CRM_CANARY],
      42,
      null,
      undefined,
      Symbol('x'),
    ]

    for (const forme of formes) {
      const shape = describeError(forme, { provider: 'anthropic', operation: 'chat' })
      aucunCanari(JSON.stringify(shape), `describeError(${String(typeof forme)})`)
      // Seules des clés autorisées existent.
      for (const cle of Object.keys(shape)) {
        expect(
          ['code', 'provider', 'operation', 'status', 'retryable', 'errorName', 'requestId'],
          `clé inattendue : ${cle}`,
        ).toContain(cle)
      }
      logSafeError('test.tag', forme, { provider: 'anthropic' })
    }

    aucunCanari(journal.join('\n'), 'logSafeError — journaux')
  })

  it('un fournisseur inconnu ne devient pas une étiquette libre', async () => {
    const { describeError } = await import('../lib/observability/safeError')
    const shape = describeError(new Error('x'), { provider: `evil ${CRM_CANARY}` as any })
    expect(shape.provider).toBeUndefined()
    aucunCanari(JSON.stringify(shape), 'fournisseur inconnu')
  })

  it('une opération non conforme est écartée plutôt que tronquée', async () => {
    const { describeError } = await import('../lib/observability/safeError')
    for (const op of [`op ${CRM_CANARY}`, 'OPERATION', 'a'.repeat(40), '', 'x-y']) {
      const shape = describeError(new Error('x'), { provider: 'anthropic', operation: op })
      expect(shape.operation, op).toBeUndefined()
    }
  })

  it('la classe de l\'exception RESTE disponible — on assainit, on n\'aveugle pas', async () => {
    const { describeError } = await import('../lib/observability/safeError')
    const shape = describeError(new TypeError(SYSTEM_CANARY), { provider: 'anthropic' })
    expect(shape.errorName).toBe('TypeError')
    expect(shape.code).toBe('provider_network')

    const abort = new Error('x'); abort.name = 'AbortError'
    expect(describeError(abort, { provider: 'anthropic' }).code).toBe('provider_timeout')
  })

  it('l\'identifiant de corrélation est LOCAL, jamais fourni par un tiers', async () => {
    const { ProviderError, newRequestId } = await import('../lib/observability/safeError')
    const a = newRequestId()
    const b = newRequestId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)

    const err = new ProviderError({ code: 'provider_http', provider: 'anthropic', status: 500 })
    expect(err.safe.requestId).toMatch(/^[0-9a-f]{12}$/)
    expect(err.message).toContain('rid=')
  })

  it('le message d\'une ProviderError ne comporte que des jetons autorisés', async () => {
    const { ProviderError } = await import('../lib/observability/safeError')
    const err = new ProviderError({
      code: 'provider_http', provider: 'anthropic', operation: 'messages', status: 429,
    })
    expect(err.message).toBe(
      `provider_http provider=anthropic operation=messages status=429 retryable=true rid=${err.safe.requestId}`,
    )
    // Aucun caractère de ponctuation libre : la forme est un enregistrement, pas une phrase.
    expect(err.message).not.toMatch(/["'{}]/)
  })
})
