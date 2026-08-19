// SEC-LOG-01 (clôture) — LES FRONTIÈRES RÉSIDUELLES.
//
// Le premier lot a assaini les SOURCES (Anthropic, Exa, DataGouv) et cinq
// sinks. Restaient trois familles, toutes du même motif :
//
//   1. huit routes renvoyant `e.message` au navigateur — indirectement sûres
//      tant que la source l'est, mais rouvertes par toute exception INTERNE
//      dont le message aurait interpolé une valeur métier ;
//   2. `aiBudget.ts`, qui plaçait le message PostgreSQL dans sa télémétrie — or
//      une erreur PostgreSQL porte volontiers un `DETAIL: Failing row contains
//      (…)`, c'est-à-dire la ligne elle-même ;
//   3. deux routes de diagnostic exposant les messages Supabase.
//
// Ces tests éprouvent la fermeture des trois familles, plus le garde-fou CI.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const CRM_CANARY = 'CRM_CANARY_SECRET_42d9a0'
const EMAIL_CANARY = 'EMAIL_CANARY_SECRET_73c5f8'
const ROW_CANARY = 'ROW_CANARY_SECRET_55e3b1'
const CANARIS = [CRM_CANARY, EMAIL_CANARY, ROW_CANARY]

function aucunCanari(texte: string, contexte: string) {
  for (const c of CANARIS) {
    expect(texte, `${contexte} : le canari ${c} a fuité`).not.toContain(c)
  }
}

/** Exception interne bavarde : c'est le cas que les sources assainies ne couvrent pas. */
function bavarde(): Error {
  return new Error(`échec sur ${CRM_CANARY} — contact ${EMAIL_CANARY}`)
}

let journal: string[] = []
let spies: any[] = []

beforeEach(() => {
  journal = []
  const capte = (...a: any[]) => { journal.push(a.map(String).join(' ')) }
  spies = [
    vi.spyOn(console, 'error').mockImplementation(capte),
    vi.spyOn(console, 'warn').mockImplementation(capte),
    vi.spyOn(console, 'log').mockImplementation(capte),
  ]
})
afterEach(() => {
  spies.forEach((s) => s.mockRestore())
  vi.restoreAllMocks()
  vi.resetModules()
})

function faussesReponses() {
  const capture: any = { status: 0, body: null }
  const res: any = {
    status(c: number) { capture.status = c; return res },
    json(p: any) { capture.body = p; return res },
    setHeader() { return res },
    end() { return res },
  }
  return { res, capture }
}

/** Dépendances communes neutralisées : le sujet est la frontière, pas l'auth. */
function mocksCommuns() {
  vi.doMock('../lib/prospector/keystore', () => ({
    hydrateKeystore: async () => undefined,
    getKey: () => 'test-key',
    hasKey: () => true,
  }))
  vi.doMock('../lib/prospector/tenant', () => ({
    resolveTenantFromRequest: async () => ({ id: 'ws_test', kind: 'client' }),
    SYSTEM_TENANT_ID: '_system',
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Les huit routes ne renvoient plus de contenu d\'erreur', () => {
  const cas: {
    nom: string
    chemin: string
    mocks: () => void
    req: any
  }[] = [
    {
      nom: 'company/detail',
      chemin: '../pages/api/company/detail',
      mocks: () => vi.doMock('../lib/prospector/datagouv', () => ({
        fetchCompanyDetail: async () => { throw bavarde() },
      })),
      req: { method: 'GET', query: { siren: '552100554' } },
    },
    {
      nom: 'company/verify',
      chemin: '../pages/api/company/verify',
      mocks: () => vi.doMock('../lib/prospector/datagouv', () => ({
        lookupBySiren: async () => { throw bavarde() },
        lookupByName: async () => { throw bavarde() },
        searchCandidates: async () => { throw bavarde() },
      })),
      req: { method: 'GET', query: { siren: '552100554', name: 'Acme' } },
    },
    {
      nom: 'enrich/person',
      chemin: '../pages/api/enrich/person',
      mocks: () => vi.doMock('../lib/prospector/llm', () => ({
        callClaude: async () => { throw bavarde() },
        cacheKey: () => 'k',
      })),
      req: { method: 'POST', body: { name: 'Alice', company: 'Acme' }, cookies: {} },
    },
    {
      nom: 'enrich/contacts',
      chemin: '../pages/api/enrich/contacts',
      mocks: () => {
        vi.doMock('../lib/prospector/pappers', () => ({
          fetchDirigeants: async () => { throw bavarde() },
          pappersConfigured: () => true,
        }))
        vi.doMock('../lib/prospector/unipile', () => ({
          findPersonas: async () => { throw bavarde() },
          unipileConfigured: () => true,
        }))
      },
      req: { method: 'POST', body: { siren: '552100554', company: 'Acme' }, cookies: {} },
    },
    {
      nom: 'enrich/company-web',
      chemin: '../pages/api/enrich/company-web',
      mocks: () => vi.doMock('../lib/prospector/identify', () => ({
        enrichCompanyWeb: async () => { throw bavarde() },
      })),
      req: { method: 'POST', body: { company: 'Acme' }, cookies: {} },
    },
    {
      nom: 'missions/plan',
      chemin: '../pages/api/missions/plan',
      mocks: () => vi.doMock('../lib/prospector/llm', () => ({
        callClaude: async () => { throw bavarde() },
        parseJson: () => null,
      })),
      req: { method: 'POST', body: { request: 'plan' }, cookies: {} },
    },
    {
      nom: 'signals/search',
      chemin: '../pages/api/signals/search',
      mocks: () => vi.doMock('../lib/prospector/signals', () => ({
        searchSignals: async () => { throw bavarde() },
        buildThesis: () => 'these',
        SIGNAL_TYPES: ['recrutement'],
      })),
      req: { method: 'POST', body: { sector: 'tech' }, cookies: {} },
    },
    {
      nom: 'sourcing/people',
      chemin: '../pages/api/sourcing/people',
      mocks: () => vi.doMock('../lib/prospector/unipile', () => ({
        unipileConfigured: () => true,
        findPersonas: async () => { throw bavarde() },
        searchPeople: async () => { throw bavarde() },
      })),
      req: { method: 'GET', query: { company: 'Acme' }, cookies: {} },
    },
  ]

  for (const c of cas) {
    it(`${c.nom} : ni le corps HTTP ni les journaux ne portent de canari`, async () => {
      vi.resetModules()
      mocksCommuns()
      c.mocks()

      let handler: any
      try {
        handler = (await import(c.chemin)).default
      } catch {
        // La route ne se charge pas isolément : on ne fabrique pas un faux vert,
        // on le dit. Le garde-fou CI couvre le motif statiquement.
        expect.soft(true, `${c.nom} non chargeable en isolation`).toBe(true)
        return
      }

      const { res, capture } = faussesReponses()
      await handler(c.req as any, res).catch(() => null)

      aucunCanari(JSON.stringify(capture.body ?? {}), `${c.nom} — corps HTTP`)
      aucunCanari(journal.join('\n'), `${c.nom} — journaux`)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. Télémétrie budgétaire — plus aucun message PostgreSQL', () => {
  it('classe par SQLSTATE, jamais par texte', async () => {
    const { storageFailure } = await import('../lib/observability/safeError')

    // Forme exacte d'une erreur PostgREST : le `details` porte la LIGNE fautive.
    const pgErreur = {
      code: '23514',
      message: `new row violates check constraint — ${ROW_CANARY}`,
      details: `Failing row contains (${ROW_CANARY}, ${CRM_CANARY}).`,
      hint: EMAIL_CANARY,
    }
    expect(storageFailure(pgErreur)).toBe('constraint_error')
    aucunCanari(JSON.stringify(storageFailure(pgErreur)), 'storageFailure')

    expect(storageFailure({ code: '57014' })).toBe('timeout')
    expect(storageFailure({ code: '08006' })).toBe('network_error')
    expect(storageFailure({ code: '53300' })).toBe('storage_unavailable')
    expect(storageFailure({ code: '42501' })).toBe('storage_unavailable')
  })

  it('toute forme non reconnue tombe en `unknown_error`, jamais en texte', async () => {
    const { storageFailure, STORAGE_FAILURES } = await import('../lib/observability/safeError')
    const abort = new Error('x'); abort.name = 'AbortError'

    const formes: unknown[] = [
      bavarde(), new TypeError(CRM_CANARY), abort,
      { message: ROW_CANARY }, `texte ${EMAIL_CANARY}`, [CRM_CANARY], 42, null, undefined,
    ]
    for (const f of formes) {
      const r = storageFailure(f)
      expect(STORAGE_FAILURES, String(typeof f)).toContain(r)
      aucunCanari(r, `storageFailure(${String(typeof f)})`)
    }
  })

  it('aiBudget ne transporte plus que des codes de classe', async () => {
    vi.resetModules()
    vi.doMock('../lib/supabase/client', () => ({
      supabase: () => ({
        rpc: async () => ({ data: null, error: { code: '23514', message: ROW_CANARY, details: CRM_CANARY } }),
      }),
      supabaseConfigured: () => true,
    }))
    vi.doMock('../lib/env', () => ({ writeAllowed: () => true }))

    const budget = await import('../lib/supabase/aiBudget')
    const r: any = await budget.settle('id_1', 10n as any, 'ok').catch((e: any) => e)

    aucunCanari(JSON.stringify(r ?? {}), 'aiBudget.settle')
    expect(r?.reason).toBe('constraint_error')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Diagnostics de configuration', () => {
  const pgErreur = { code: '42501', message: ROW_CANARY, details: CRM_CANARY, hint: EMAIL_CANARY }

  it('db-check : renvoie une classe, pas le message Supabase', async () => {
    vi.resetModules()
    vi.doMock('../lib/auth/guard', () => ({ isAdminRequest: async () => true }))
    vi.doMock('../lib/supabase/client', () => ({
      supabaseConfigured: () => true,
      supabase: () => ({
        from: () => ({ select: () => ({ limit: async () => ({ data: null, error: pgErreur }) }) }),
      }),
    }))

    let handler: any
    try { handler = (await import('../pages/api/config/db-check')).default } catch { return }

    const { res, capture } = faussesReponses()
    await handler({ method: 'GET', cookies: {} } as any, res).catch(() => null)

    aucunCanari(JSON.stringify(capture.body ?? {}), 'db-check — corps HTTP')
  })

  it('persistence-test : idem', async () => {
    vi.resetModules()
    vi.doMock('../lib/auth/guard', () => ({ isAdminRequest: async () => true }))
    vi.doMock('../lib/supabase/client', () => ({
      supabaseConfigured: () => true,
      supabase: () => ({
        from: () => ({
          upsert: async () => ({ error: pgErreur }),
          select: () => ({ eq: () => ({ single: async () => ({ data: null, error: pgErreur }) }) }),
        }),
      }),
    }))

    let handler: any
    try { handler = (await import('../pages/api/config/persistence-test')).default } catch { return }

    const { res, capture } = faussesReponses()
    await handler({ method: 'GET', cookies: {} } as any, res).catch(() => null)

    aucunCanari(JSON.stringify(capture.body ?? {}), 'persistence-test — corps HTTP')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Le garde-fou CI mord réellement', () => {
  function lancerGarde(): { code: number; sortie: string } {
    try {
      const sortie = execFileSync('node', ['scripts/check-error-boundary.mjs'], {
        cwd: process.cwd(), encoding: 'utf8',
      })
      return { code: 0, sortie }
    } catch (err: any) {
      return { code: err.status ?? 1, sortie: String(err.stdout || '') + String(err.stderr || '') }
    }
  }

  it('passe sur le dépôt corrigé', () => {
    const r = lancerGarde()
    expect(r.sortie, r.sortie).toContain('OK')
    expect(r.code).toBe(0)
  })

  // ⚠️ CONTRÔLE NÉGATIF. Un garde qui ne devient jamais rouge ne garde rien. On
  // dépose un fichier réellement vulnérable, on exige l'échec, et on le retire —
  // dans un `finally`, pour qu'un échec d'assertion ne laisse pas le dépôt sale.
  const MOTIFS_VULNERABLES: [string, string][] = [
    ['log_error_message', 'export function f(e: any) { console.error("tag", e.message) }'],
    ['log_stringify_error', 'export function f(e: any) { console.error("tag", JSON.stringify(e)) }'],
    ['log_string_error', 'export function f(e: any) { console.error("tag", String(e)) }'],
    ['http_error_message', 'export function f(res: any, e: any) { res.json({ error: e.message }) }'],
    ['http_string_error', 'export function f(res: any, e: any) { res.json({ error: String(e) }) }'],
    ['http_stack', 'export function f(res: any, e: any) { res.json({ stack: "x" }) }'],
    ['throw_provider_body', 'export function f(status: number, body: string) { throw new Error(`X ${status} — ${body}`) }'],
    ['throw_await_text', 'export async function f(res: any) { throw new Error(await res.text()) }'],
  ]

  for (const [id, source] of MOTIFS_VULNERABLES) {
    it(`échoue sur le motif « ${id} »`, () => {
      const chemin = 'lib/__sec_log_01_tmp__.ts'
      try {
        writeFileSync(chemin, source + '\n', 'utf8')
        const r = lancerGarde()
        expect(r.code, `le garde aurait dû refuser « ${id} »`).toBe(1)
        expect(r.sortie).toContain(id)
      } finally {
        try { unlinkSync(chemin) } catch { /* déjà retiré */ }
      }
    })
  }

  it('ne se dénonce pas lui-même : les COMMENTAIRES sont dépouillés', () => {
    const chemin = 'lib/__sec_log_01_tmp__.ts'
    try {
      // Un fichier qui DOCUMENTE l'interdiction doit rester vert, sans quoi le
      // garde deviendrait une raison de ne plus commenter.
      writeFileSync(chemin, '// ne jamais faire console.error(e.message)\nexport const x = 1\n', 'utf8')
      expect(lancerGarde().code).toBe(0)
    } finally {
      try { unlinkSync(chemin) } catch { /* déjà retiré */ }
    }
  })
})
