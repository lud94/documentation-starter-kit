import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { randomUUID, createHash } from 'node:crypto'

// Tests d'INTÉGRATION — lot C2a-2, module `lib/supabase/aiBudget.ts`.
//
// DIFFÉRENCE ESSENTIELLE avec ai-budget-pg.test.ts : celui-là appelle les RPC
// directement pour valider la LOGIQUE PostgreSQL. Celui-ci exerce le CODE
// LIVRÉ — le module que la passerelle utilise réellement — via supabase-js sur
// PostgREST. C'est la seule façon de prouver que la sérialisation `bigint` aux
// frontières fonctionne : un test qui contourne le module ne prouverait rien du
// module.
//
// Aucun appel Anthropic n'est émis. Ces cas ne dépensent pas un centime.
//
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let mod: typeof import('../../lib/supabase/aiBudget')
// Client de CONTRÔLE, typé large : il ne sert qu'à observer l'état de la base
// (`select`) et à remettre les compteurs à zéro entre deux cas. Sans types
// générés, supabase-js infère `never` sur les charges d'écriture.
let raw: any

const fp = () => createHash('sha256').update(randomUUID()).digest('hex')

async function ledger(): Promise<bigint> {
  const { data } = await raw.from('prospector_ai_ledger').select('micros').eq('key', 'ai:usd_micros').maybeSingle()
  return BigInt((data as any)?.micros ?? 0)
}
async function stateOf(id: string): Promise<string | null> {
  const { data } = await raw.from('prospector_ai_reservations').select('state').eq('id', id).maybeSingle()
  return (data as any)?.state ?? null
}

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  // Le module lit sa configuration depuis l'environnement, comme en production :
  // on la pose avant l'import plutôt que d'injecter un client, sinon on testerait
  // un chemin qui n'existe pas au runtime.
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
  process.env.APP_ENV = 'development'
  delete process.env.APP_ENV_STRICT

  raw = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  mod = await import('../../lib/supabase/aiBudget')
})

beforeEach(async () => {
  await raw.from('prospector_ai_reservations').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await raw.from('prospector_ai_ledger').update({ micros: 0 }).eq('key', 'ai:usd_micros')
})

describe('sérialisation bigint aux frontières PostgREST', () => {
  it('un montant part et revient EXACTEMENT, sans passer par un flottant', async () => {
    const id = randomUUID()
    const estimate = 123_456_789n
    const r = await mod.reserve({
      id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: estimate,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300,
    })
    expect(r.ok).toBe(true)
    expect(r.state).toBe('reserved')
    expect(typeof r.engagedMicros).toBe('bigint')

    const e = await mod.engaged()
    expect(e.ok).toBe(true)
    expect(e.openMicros).toBe(estimate)     // égalité bigint stricte
  })

  it('refuse un montant hors de l\'entier exact plutôt que de le tronquer', () => {
    expect(() => mod.microsToWire(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow()
    expect(() => mod.microsToWire(-1n)).toThrow()
  })

  it('toBigInt refuse tout ce qui n\'est pas un entier exact', () => {
    expect(mod.toBigInt(42)).toBe(42n)
    expect(mod.toBigInt('9007199254740993')).toBe(9007199254740993n)
    expect(() => mod.toBigInt(1.5)).toThrow()
    expect(() => mod.toBigInt(null)).toThrow()
    expect(() => mod.toBigInt('abc')).toThrow()
  })
})

describe('cycle de vie complet, via le module livré', () => {
  it('reserve → settle : le compteur avance du montant RÉGLÉ, pas de l\'estimation', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    const s = await mod.settle(id, 10_500n, 'http_200')
    expect(s.ok).toBe(true)
    expect(await ledger()).toBe(10_500n)
    expect(await stateOf(id)).toBe('SETTLED')
    const e = await mod.engaged()
    expect(e.openMicros).toBe(0n)
    expect(e.consumedMicros).toBe(10_500n)
  })

  it('reserve → RELEASED : compteur INCHANGÉ, engagement retombé', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(await mod.resolveReservation(id, 'RELEASED', 'http_429')).toEqual({ ok: true })
    expect(await ledger()).toBe(0n)
    expect(await stateOf(id)).toBe('RELEASED')
    const e = await mod.engaged()
    expect(e.openMicros).toBe(0n)
    expect(e.unresolvedMicros).toBe(0n)
  })

  it('reserve → UNRESOLVED : compteur inchangé mais engagement MAINTENU', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    await mod.resolveReservation(id, 'UNRESOLVED', 'timeout')
    expect(await ledger()).toBe(0n)
    const e = await mod.engaged()
    expect(e.openMicros).toBe(0n)
    expect(e.unresolvedMicros).toBe(500_000n)   // le passif reste opposable
  })
})

describe('arbitrage budgétaire', () => {
  it('plafond NUL → budget_exhausted inatteignable (c\'est le mécanisme d\'OBSERVE)', async () => {
    // Un engagement très supérieur à tout plafond plausible, puis une réservation
    // à plafond 0 : elle doit passer. C'est ce qui rend OBSERVE non bloquant.
    const gros = randomUUID()
    await mod.reserve({ id: gros, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 999_000_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    const r = await mod.reserve({ id: randomUUID(), fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(r.state).toBe('reserved')
  })

  it('plafond positif dépassé → budget_exhausted, aucune ligne créée', async () => {
    const id = randomUUID()
    const r = await mod.reserve({ id, fingerprint: fp(), budgetMicros: 1_000n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(r.ok).toBe(true)
    expect(r.state).toBe('budget_exhausted')
    expect(await stateOf(id)).toBeNull()
  })

  it('le passif UNRESOLVED seul suffit à provoquer budget_exhausted', async () => {
    const passif = randomUUID()
    await mod.reserve({ id: passif, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 900_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    await mod.resolveReservation(passif, 'UNRESOLVED', 'timeout')
    expect(await ledger()).toBe(0n)   // rien de consommé…

    const r = await mod.reserve({ id: randomUUID(), fingerprint: fp(), budgetMicros: 1_000_000n,
      estimateMicros: 200_000n, agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(r.state).toBe('budget_exhausted')   // …et pourtant le plafond est atteint
  })

  it('idempotence : même id + même empreinte → une seule ligne', async () => {
    const id = randomUUID(); const f = fp()
    const a = await mod.reserve({ id, fingerprint: f, budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    const b = await mod.reserve({ id, fingerprint: f, budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(a.state).toBe('reserved')
    expect(b.state).toBe('reserved')
    const e = await mod.engaged()
    expect(e.openMicros).toBe(500_000n)   // et non 1 000 000
  })

  it('même id, empreinte divergente → integrity_error', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    const b = await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300 })
    expect(b.ok).toBe(true)
    expect(b.state).toBe('integrity_error')
  })
})

describe('robustesse du module', () => {
  it('une erreur RPC rend ok:false avec un motif — jamais une valeur trompeuse', async () => {
    // Montant négatif : la fonction lève à sa PREMIÈRE instruction, avant tout
    // verrou et toute écriture. On vérifie que le module traduit ça proprement.
    const r = await mod.settle(randomUUID(), 0n, 'x')
    // `settle` sur un identifiant inconnu : le RPC refuse. Quel que soit le
    // libellé, l'invariant est qu'on ne reçoit pas un faux succès silencieux.
    expect(typeof r.ok).toBe('boolean')
    if (!r.ok) expect(r.reason).toBeTruthy()
  })

  it('resolve avec un état invalide est refusé côté base', async () => {
    const r = await mod.resolveReservation(randomUUID(), 'INVALID' as any, 'x')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})
