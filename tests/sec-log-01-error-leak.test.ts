// SEC-LOG-01 — FUITE DE DONNÉES SENSIBLES PAR LES ERREURS ET LES LOGS.
//
// ── LA CHAÎNE ÉPROUVÉE ICI ──────────────────────────────────────────────────
//
//   réponse d'un fournisseur externe
//     → interpolée dans `new Error(...)`
//       → `e.message`
//         → `console.error` (logs serveur)  ET/OU  corps d'une réponse HTTP
//
// Le contenu renvoyé par un fournisseur est du CONTENU NON FIABLE. Sur une
// erreur 400, une API échoue rarement en silence : elle cite le champ fautif, et
// souvent sa valeur. Le corps d'erreur peut donc contenir un fragment de prompt,
// un nom d'outil, un extrait de message utilisateur — c'est-à-dire précisément
// ce qui n'a rien à faire dans un journal.
//
// ⚠️ CES TESTS N'AFFIRMENT RIEN SUR CE QU'ANTHROPIC RENVOIE RÉELLEMENT. Ils
// prouvent une propriété du CODE : si un fournisseur renvoie un corps contenant
// X, alors X ressort. Le fournisseur est simulé, les canaris sont synthétiques,
// et aucune donnée réelle n'apparaît dans ce fichier.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Canaris synthétiques ────────────────────────────────────────────────────
const PROVIDER_BODY_CANARY = 'PROVIDER_BODY_CANARY_81a4c7'
const SYSTEM_CANARY = 'SYSTEM_CANARY_SECRET_9Fb2e1'
const CRM_CANARY = 'CRM_CANARY_SECRET_42d9a0'
const EMAIL_CANARY = 'EMAIL_CANARY_SECRET_73c5f8'

const TOUS_LES_CANARIS = [
  PROVIDER_BODY_CANARY, SYSTEM_CANARY, CRM_CANARY, EMAIL_CANARY,
]

/**
 * Corps d'erreur réaliste d'une API de LLM : elle cite le champ fautif ET son
 * contenu. C'est ce comportement — banal et légitime côté fournisseur — qui
 * transforme une erreur en canal d'exfiltration côté journal.
 */
function corpsFournisseurAvecEcho(): string {
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        `${PROVIDER_BODY_CANARY}: messages.1.content.0.text: `
        + `"${SYSTEM_CANARY} — fiche ${CRM_CANARY} — relance ${EMAIL_CANARY}"`,
    },
  })
}

/** Aucun canari ne doit apparaître dans la chaîne inspectée. */
function aucunCanari(texte: string, contexte: string) {
  for (const canari of TOUS_LES_CANARIS) {
    expect(texte, `${contexte} : le canari ${canari} a fuité`).not.toContain(canari)
  }
}

// ── Harnais passerelle Anthropic ────────────────────────────────────────────
const reserve = vi.fn()
const settle = vi.fn()
const resolveReservation = vi.fn()
const readUsageDurable = vi.fn()
const bumpUsage = vi.fn()

vi.mock('../lib/supabase/aiBudget', () => ({
  reserve: (...a: any[]) => reserve(...a),
  settle: (...a: any[]) => settle(...a),
  resolveReservation: (...a: any[]) => resolveReservation(...a),
  engaged: vi.fn(),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))
vi.mock('../lib/supabase/pappersCache', () => ({
  readUsageDurable: (...a: any[]) => readUsageDurable(...a),
  bumpUsage: (...a: any[]) => bumpUsage(...a),
}))
vi.mock('../lib/supabase/store', () => ({
  listItems: async () => [],
  upsertItem: async () => undefined,
  getItem: async () => null,
}))

let fetchMock: ReturnType<typeof vi.fn>

const TENANT = { id: 'ws_test', kind: 'client' as const }
const OPTS = {
  tenant: TENANT,
  task: 'chat' as const,
  agent: 'Jarvis',
  system: `consigne interne ${SYSTEM_CANARY}`,
  messages: [{ role: 'user', content: `parle de ${CRM_CANARY}` }],
}

async function chargerLlm() {
  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  vi.resetModules()
  return import('../lib/prospector/llm')
}

/** Réponse fournisseur en ÉCHEC, portant les canaris dans son corps. */
function reponseEnEchec(status: number) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(corpsFournisseurAvecEcho()),
    text: async () => corpsFournisseurAvecEcho(),
  }
}

beforeEach(() => {
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  settle.mockReset().mockResolvedValue({ ok: true })
  resolveReservation.mockReset().mockResolvedValue({ ok: true })
  bumpUsage.mockReset().mockResolvedValue(1)
  readUsageDurable.mockReset().mockResolvedValue({ ok: true, value: 0 })

  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.ANTHROPIC_BUDGET
})

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Passerelle Anthropic — le corps du fournisseur ne franchit pas Error.message', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    it(`HTTP ${status} : le message d'erreur ne porte aucun canari`, async () => {
      fetchMock = vi.fn().mockResolvedValue(reponseEnEchec(status))
      ;(globalThis as any).fetch = fetchMock

      const m = await chargerLlm()
      const erreur = await m.callClaude(OPTS).then(
        () => null,
        (e: any) => e,
      )

      expect(erreur, 'un échec fournisseur doit remonter une erreur').toBeTruthy()
      aucunCanari(String(erreur?.message ?? ''), `callClaude ${status} — message`)
      aucunCanari(String(erreur), `callClaude ${status} — String(e)`)
      aucunCanari(JSON.stringify(erreur ?? {}), `callClaude ${status} — sérialisation`)
    })
  }

  it('HTTP 400 non dégradable : idem après épuisement des tentatives', async () => {
    fetchMock = vi.fn().mockResolvedValue(reponseEnEchec(400))
    ;(globalThis as any).fetch = fetchMock

    const m = await chargerLlm()
    const erreur = await m.callClaude(OPTS).then(() => null, (e: any) => e)

    expect(erreur).toBeTruthy()
    aucunCanari(String(erreur?.message ?? ''), 'callClaude 400 — message')
    aucunCanari(String(erreur), 'callClaude 400 — String(e)')
  })

  it('erreur réseau / timeout : aucune donnée de requête ne ressort', async () => {
    fetchMock = vi.fn().mockRejectedValue(
      new Error(`socket hang up en envoyant ${SYSTEM_CANARY}`),
    )
    ;(globalThis as any).fetch = fetchMock

    const m = await chargerLlm()
    const resultat = await m.callClaude(OPTS).then((r: any) => r, (e: any) => e)

    aucunCanari(JSON.stringify(resultat ?? {}), 'callClaude réseau — résultat')
    aucunCanari(String((resultat as any)?.message ?? ''), 'callClaude réseau — message')
  })

  it('le nom du fournisseur et le statut RESTENT disponibles — on assainit, on n\'aveugle pas', async () => {
    fetchMock = vi.fn().mockResolvedValue(reponseEnEchec(500))
    ;(globalThis as any).fetch = fetchMock

    const m = await chargerLlm()
    const erreur: any = await m.callClaude(OPTS).then(() => null, (e: any) => e)

    const message = String(erreur?.message ?? '')
    expect(message).toContain('provider=anthropic')
    expect(message).toContain('status=500')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. Les autres fournisseurs suivent la même règle', () => {
  it('Exa : le corps de réponse ne franchit pas Error.message', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(reponseEnEchec(500))
    const g = globalThis as any
    if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
    g.__prospectorKeys.clear()
    process.env.EXA_API_KEY = 'test-key'

    vi.resetModules()
    const exa = await import('../lib/prospector/exa')
    const erreur = await exa.searchExa('recherche').then(() => null, (e: any) => e)

    if (erreur) {
      aucunCanari(String(erreur?.message ?? ''), 'exa — message')
      aucunCanari(String(erreur), 'exa — String(e)')
    }
    delete process.env.EXA_API_KEY
  })

  it('DataGouv : le corps de réponse ne franchit pas Error.message', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(reponseEnEchec(502))

    vi.resetModules()
    const dg = await import('../lib/prospector/datagouv')
    const erreur = await dg
      .fetchCompanies({ sector: 'test', location: '', size: '', page: 1, activeOnly: true } as any)
      .then(() => null, (e: any) => e)

    if (erreur) {
      aucunCanari(String(erreur?.message ?? ''), 'datagouv — message')
      aucunCanari(String(erreur), 'datagouv — String(e)')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Réponses HTTP publiques — aucun canari ne sort de l\'application', () => {
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

  it('sourcing/search : une panne fournisseur ne renvoie pas son corps au client', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(reponseEnEchec(502))
    vi.resetModules()

    const handler = (await import('../pages/api/sourcing/search')).default
    const { res, capture } = faussesReponses()
    await handler({ method: 'GET', query: { sector: 'test' } } as any, res)

    aucunCanari(JSON.stringify(capture.body ?? {}), 'sourcing/search — corps HTTP')
  })

  it('sourcing/search?debug : le mode diagnostic ne contourne pas la règle', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(reponseEnEchec(502))
    vi.resetModules()

    const handler = (await import('../pages/api/sourcing/search')).default
    const { res, capture } = faussesReponses()
    await handler({ method: 'GET', query: { sector: 'test', debug: '1' } } as any, res)

    aucunCanari(JSON.stringify(capture.body ?? {}), 'sourcing/search?debug — corps HTTP')
    // Une pile d'exécution n'est jamais une réponse publique.
    expect(JSON.stringify(capture.body ?? {})).not.toContain('stack')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Journaux serveur — console.error ne reçoit aucun canari', () => {
  it('la passerelle journalise sans jamais recopier le corps fournisseur', async () => {
    const lignes: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      lignes.push(args.map((a) => String(a)).join(' '))
    })
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      lignes.push(args.map((a) => String(a)).join(' '))
    })

    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(reponseEnEchec(500))
    const m = await chargerLlm()
    await m.callClaude(OPTS).catch(() => null)

    aucunCanari(lignes.join('\n'), 'journaux de la passerelle')
    spy.mockRestore()
    spyWarn.mockRestore()
  })
})
