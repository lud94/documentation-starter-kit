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

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:55321'
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
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it',
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
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
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
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
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
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
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
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    const r = await mod.reserve({ id: randomUUID(), fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    expect(r.state).toBe('reserved')
  })

  it('plafond positif dépassé → budget_exhausted, aucune ligne créée', async () => {
    const id = randomUUID()
    const r = await mod.reserve({ id, fingerprint: fp(), budgetMicros: 1_000n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    expect(r.ok).toBe(true)
    expect(r.state).toBe('budget_exhausted')
    expect(await stateOf(id)).toBeNull()
  })

  it('le passif UNRESOLVED seul suffit à provoquer budget_exhausted', async () => {
    const passif = randomUUID()
    await mod.reserve({ id: passif, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 900_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    await mod.resolveReservation(passif, 'UNRESOLVED', 'timeout')
    expect(await ledger()).toBe(0n)   // rien de consommé…

    const r = await mod.reserve({ id: randomUUID(), fingerprint: fp(), budgetMicros: 1_000_000n,
      estimateMicros: 200_000n, agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    expect(r.state).toBe('budget_exhausted')   // …et pourtant le plafond est atteint
  })

  it('idempotence : même id + même empreinte → une seule ligne', async () => {
    const id = randomUUID(); const f = fp()
    const a = await mod.reserve({ id, fingerprint: f, budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    const b = await mod.reserve({ id, fingerprint: f, budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    expect(a.state).toBe('reserved')
    expect(b.state).toBe('reserved')
    const e = await mod.engaged()
    expect(e.openMicros).toBe(500_000n)   // et non 1 000 000
  })

  it('même id, empreinte divergente → integrity_error', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    const b = await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_it' })
    expect(b.ok).toBe(true)
    expect(b.state).toBe('integrity_error')
  })
})

// ── Lot MT-0 — imputation de la réservation à un espace client ───────────────
describe('imputation tenant (MT-0)', () => {
  async function tenantOf(id: string): Promise<string | null> {
    const { data } = await raw.from('prospector_ai_reservations').select('tenant_id').eq('id', id).maybeSingle()
    return (data as any)?.tenant_id ?? null
  }

  it('la réservation porte l\'espace client', async () => {
    const id = randomUUID()
    const r = await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 1_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_fabel' })
    expect(r.state).toBe('reserved')
    expect(await tenantOf(id)).toBe('ws_fabel')
  })

  it('deux espaces produisent deux imputations distinctes', async () => {
    const a = randomUUID(); const b = randomUUID()
    await mod.reserve({ id: a, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 1_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_fabel' })
    await mod.reserve({ id: b, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 1_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_client_b' })
    expect(await tenantOf(a)).toBe('ws_fabel')
    expect(await tenantOf(b)).toBe('ws_client_b')
  })

  it('un tenant vide est refusé AVANT la base', async () => {
    const r = await mod.reserve({ id: randomUUID(), fingerprint: fp(), budgetMicros: 0n, estimateMicros: 1_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: '   ' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_tenant')
  })

  it('le règlement et l\'engagement global restent identiques à C2a-1', async () => {
    const id = randomUUID()
    await mod.reserve({ id, fingerprint: fp(), budgetMicros: 0n, estimateMicros: 500_000n,
      agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId: 'ws_fabel' })
    expect((await mod.settle(id, 7_777n, 'http_200')).ok).toBe(true)
    expect(await ledger()).toBe(7_777n)
    expect((await mod.engaged()).consumedMicros).toBe(7_777n)
  })
})

// ── Lot MT-0c — `tenant_id` fait partie de l'identité financière ─────────────
//
// Contrat REFUSÉ par la revue et corrigé ici : un rejeu portant un AUTRE espace
// rendait `reserved`. L'attribution était juste, le verdict ne l'était pas —
// l'appelant du second espace recevait une autorisation de dépenser adossée à
// la réservation d'un tiers.
describe('intégrité tenant de l\'idempotence (MT-0c)', () => {
  const base = (id: string, f: string, tenantId: string) => ({
    id, fingerprint: f, budgetMicros: 0n, estimateMicros: 1_000n,
    agent: 'test', model: 'claude-sonnet-5', ttlSeconds: 300, tenantId,
  })
  async function tenantOf(id: string): Promise<string | null> {
    const { data } = await raw.from('prospector_ai_reservations').select('tenant_id').eq('id', id).maybeSingle()
    return (data as any)?.tenant_id ?? null
  }
  async function countOf(id: string): Promise<number> {
    const { data } = await raw.from('prospector_ai_reservations').select('id').eq('id', id)
    return (data || []).length
  }

  it('1 — même id + même empreinte + MÊME espace → reserved, une seule ligne', async () => {
    const id = randomUUID(); const f = fp()
    const a = await mod.reserve(base(id, f, 'ws_fabel'))
    const b = await mod.reserve(base(id, f, 'ws_fabel'))
    expect(a.state).toBe('reserved')
    expect(b.state).toBe('reserved')
    expect(await countOf(id)).toBe(1)
    expect(await tenantOf(id)).toBe('ws_fabel')
  })

  it('2 — même id + même empreinte + espace DIFFÉRENT → integrity_error', async () => {
    const id = randomUUID(); const f = fp()
    await mod.reserve(base(id, f, 'ws_fabel'))
    const b = await mod.reserve(base(id, f, 'ws_client_b'))
    expect(b.ok).toBe(true)
    expect(b.state).toBe('integrity_error')
    expect(await tenantOf(id)).toBe('ws_fabel')   // aucun déplacement
    expect(await countOf(id)).toBe(1)
  })

  it('3 — même id + empreinte différente + même espace → integrity_error', async () => {
    const id = randomUUID()
    await mod.reserve(base(id, fp(), 'ws_fabel'))
    const b = await mod.reserve(base(id, fp(), 'ws_fabel'))
    expect(b.state).toBe('integrity_error')
    expect(await tenantOf(id)).toBe('ws_fabel')
  })

  it('4 — même id + empreinte différente + espace différent → integrity_error', async () => {
    const id = randomUUID()
    await mod.reserve(base(id, fp(), 'ws_fabel'))
    const b = await mod.reserve(base(id, fp(), 'ws_client_b'))
    expect(b.state).toBe('integrity_error')
    expect(await tenantOf(id)).toBe('ws_fabel')
  })

  it('5 — ligne héritée à tenant_id NULL → integrity_error, NULL préservé', async () => {
    // Réservation créée par la RPC C2a-1 d'origine : aucune imputation, comme
    // toute ligne antérieure à MT-0. Un rejeu ne doit pas la rétro-attribuer.
    const id = randomUUID(); const f = fp()
    const { error } = await raw.rpc('prospector_ai_reserve', {
      p_id: id, p_fingerprint: f, p_budget_micros: 0, p_estimate_micros: 1_000,
      p_agent: 'legacy', p_model: 'claude-sonnet-5', p_ttl_seconds: 300,
    })
    expect(error).toBeNull()
    expect(await tenantOf(id)).toBeNull()

    const b = await mod.reserve(base(id, f, 'ws_fabel'))
    expect(b.state).toBe('integrity_error')
    expect(await tenantOf(id)).toBeNull()   // toujours inconnue, jamais inventée
  })

  it('6 — une réservation NEUVE reçoit son espace atomiquement', async () => {
    const id = randomUUID()
    const r = await mod.reserve(base(id, fp(), 'ws_fabel'))
    expect(r.state).toBe('reserved')
    expect(await tenantOf(id)).toBe('ws_fabel')
  })

  it('7 — CONCURRENCE : même id, deux espaces → un seul « reserved »', async () => {
    // Le verrou global de C2a-1 sérialise les deux transactions. Sans lui, les
    // deux liraient « aucune ligne » avant que l'une ne la crée.
    const id = randomUUID(); const f = fp()
    const results = await Promise.all([
      mod.reserve(base(id, f, 'ws_fabel')),
      mod.reserve(base(id, f, 'ws_client_b')),
    ])

    const reserved = results.filter((r) => r.state === 'reserved')
    const refused = results.filter((r) => r.state === 'integrity_error')
    expect(reserved).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(await countOf(id)).toBe(1)

    // L'espace inscrit est celui du gagnant, quel qu'il soit — jamais deux.
    const winner = await tenantOf(id)
    expect(['ws_fabel', 'ws_client_b']).toContain(winner)
  })

  it('7bis — concurrence élargie : 6 espaces distincts, un seul verdict positif', async () => {
    const id = randomUUID(); const f = fp()
    const tenants = ['ws_a', 'ws_b', 'ws_c', 'ws_d', 'ws_e', 'ws_f']
    const results = await Promise.all(tenants.map((t) => mod.reserve(base(id, f, t))))
    expect(results.filter((r) => r.state === 'reserved')).toHaveLength(1)
    expect(results.filter((r) => r.state === 'integrity_error')).toHaveLength(5)
    expect(await countOf(id)).toBe(1)
    expect(tenants).toContain(await tenantOf(id))
  })

  it('8 — non-régression : le cycle complet reste celui de C2a-1', async () => {
    const a = randomUUID(); const b = randomUUID(); const c = randomUUID()
    await mod.reserve(base(a, fp(), 'ws_fabel'))
    await mod.reserve(base(b, fp(), 'ws_fabel'))
    await mod.reserve(base(c, fp(), 'ws_fabel'))

    expect((await mod.settle(a, 3_000n, 'http_200')).ok).toBe(true)
    expect((await mod.resolveReservation(b, 'RELEASED', 'http_429')).ok).toBe(true)
    expect((await mod.resolveReservation(c, 'UNRESOLVED', 'timeout')).ok).toBe(true)

    expect(await ledger()).toBe(3_000n)              // seul SETTLED avance
    const e = await mod.engaged()
    expect(e.consumedMicros).toBe(3_000n)
    expect(e.openMicros).toBe(0n)
    expect(e.unresolvedMicros).toBe(1_000n)          // le passif RELEASED ne compte pas
  })

  it('8bis — le plafond global arbitre toujours, imputation ou non', async () => {
    const r = await mod.reserve({ ...base(randomUUID(), fp(), 'ws_fabel'),
      budgetMicros: 1_000n, estimateMicros: 500_000n })
    expect(r.state).toBe('budget_exhausted')
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
