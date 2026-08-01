import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

// Tests d'INTÉGRATION — lot C2a-1, RPC de réservation budgétaire.
//
// Ils exercent les fonctions PostgreSQL DIRECTEMENT, sans appeler Anthropic :
// c'est la logique d'arbitrage qu'on valide, pas le fournisseur. Les dix cas
// ci-dessous ne dépensent pas un centime.
//
// Ils valident ce que les tests mémoire ne PEUVENT PAS valider :
//   • l'atomicité réelle sous `select … for update` ;
//   • l'absence de sur-réservation quand N appels concurrents se disputent une
//     marge qui ne suffit pas pour tous ;
//   • l'idempotence par identifiant et le refus d'intégrité sur empreinte divergente.
//
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`
// (la baseline A3b + la migration C2a-1). Docker requis.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let sb: SupabaseClient
const FP = 'f'.repeat(64)

async function reserve(id: string, estimate: number, budget: number, fingerprint = FP, ttl = 900) {
  const { data, error } = await sb.rpc('prospector_ai_reserve', {
    p_id: id, p_fingerprint: fingerprint,
    p_budget_micros: budget, p_estimate_micros: estimate,
    p_agent: 'test', p_model: 'claude-sonnet-5', p_ttl_seconds: ttl,
  })
  if (error) throw new Error(`reserve: ${error.message}`)
  return (Array.isArray(data) ? data[0] : data) as { state: string; engaged_micros: number }
}
const settle = (id: string, micros: number, outcome = 'http_200') =>
  sb.rpc('prospector_ai_settle', { p_id: id, p_settled_micros: micros, p_outcome: outcome })
const resolve_ = (id: string, state: string, outcome: string) =>
  sb.rpc('prospector_ai_resolve', { p_id: id, p_state: state, p_outcome: outcome })

async function engaged() {
  const { data, error } = await sb.rpc('prospector_ai_engaged')
  if (error) throw new Error(`engaged: ${error.message}`)
  const r = (Array.isArray(data) ? data[0] : data) as any
  return {
    consumed: Number(r.consumed_micros),
    open: Number(r.open_micros),
    unresolved: Number(r.unresolved_micros),
  }
}

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  sb = createClient(URL_, KEY)
  const probe = await sb.from('prospector_ai_ledger').select('key').limit(1)
  if (probe.error) {
    throw new Error(`prospector_ai_ledger inaccessible : ${probe.error.message}. `
      + 'La migration C2a-1 est-elle appliquée ? (`npx supabase db reset --local`)')
  }
})

beforeEach(async () => {
  // Isolation stricte entre les cas : ni réservation résiduelle, ni compteur reporté.
  await sb.from('prospector_ai_reservations').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await sb.from('prospector_ai_ledger').update({ micros: 0 }).eq('key', 'ai:usd_micros')
})

describe('incrément atomique', () => {
  it('DÉFAUT P0 — 50 incréments concurrents, aucun perdu', async () => {
    // L'ancien `select` puis `upsert` en perdait : deux écritures simultanées
    // écrivaient chacune `cur + by` et l'une écrasait l'autre.
    await Promise.all(Array.from({ length: 50 }, () =>
      sb.rpc('prospector_ai_bump', { p_key: 'ai:usd_micros', p_delta: 100 })))
    expect((await engaged()).consumed) // exactement 50 × 100
      .toBe(5_000)
  })
})

describe('arbitrage sous concurrence', () => {
  it('marge suffisante : toutes les réservations passent', async () => {
    const r = await Promise.all(Array.from({ length: 10 }, () => reserve(randomUUID(), 1_000, 1_000_000)))
    expect(r.every((x) => x.state === 'reserved')).toBe(true)
  })

  it('DÉFAUT P0 — marge pour 3 sur 10 : exactement 3 passent, AUCUNE sur-réservation', async () => {
    // Le cœur du lot. Sans le verrou de ligne, les dix liraient le même engagé
    // et partiraient toutes.
    const budget = 3_000
    const r = await Promise.all(Array.from({ length: 10 }, () => reserve(randomUUID(), 1_000, budget)))
    expect(r.filter((x) => x.state === 'reserved')).toHaveLength(3)
    expect(r.filter((x) => x.state === 'budget_exhausted')).toHaveLength(7)
    expect((await engaged()).open).toBe(budget) // jamais au-delà du plafond
  })

  it('budget nul = non configuré : aucun plafond opposé', async () => {
    const r = await Promise.all(Array.from({ length: 5 }, () => reserve(randomUUID(), 10_000_000, 0)))
    expect(r.every((x) => x.state === 'reserved')).toBe(true)
  })

  it('règlements concurrents de réservations distinctes : aucun montant perdu', async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID())
    await Promise.all(ids.map((id) => reserve(id, 1_000, 10_000_000)))
    await Promise.all(ids.map((id) => settle(id, 700)))
    expect((await engaged()).consumed).toBe(20 * 700)
  })
})

describe('idempotence et intégrité', () => {
  it('même identifiant, même empreinte : rejeu idempotent, une seule réservation', async () => {
    const id = randomUUID()
    expect((await reserve(id, 1_000, 1_000_000)).state).toBe('reserved')
    expect((await reserve(id, 1_000, 1_000_000)).state).toBe('reserved')
    expect((await engaged()).open).toBe(1_000) // pas 2 000
  })

  it('DÉFAUT ÉVITÉ — même identifiant, empreinte différente : integrity_error', async () => {
    // hash(model + estimation + agent) aurait confondu deux requêtes distinctes
    // et laissé partir la seconde dépense sous couvert d'idempotence.
    const id = randomUUID()
    await reserve(id, 1_000, 1_000_000, 'a'.repeat(64))
    const r = await reserve(id, 1_000, 1_000_000, 'b'.repeat(64))
    expect(r.state).toBe('integrity_error')
    expect((await engaged()).open).toBe(1_000)
  })

  it('double règlement du même identifiant : imputé UNE seule fois', async () => {
    const id = randomUUID()
    await reserve(id, 1_000, 1_000_000)
    await settle(id, 800)
    await settle(id, 800)
    expect((await engaged()).consumed).toBe(800)
  })

  it('un rejeu après règlement rend l’état terminal, pas une nouvelle réservation', async () => {
    const id = randomUUID()
    await reserve(id, 1_000, 1_000_000)
    await settle(id, 500)
    expect((await reserve(id, 1_000, 1_000_000)).state).toBe('already_settled')
  })
})

describe('issues et passif', () => {
  it('RELEASED libère le plafond et n’alimente pas le compteur', async () => {
    const id = randomUUID()
    await reserve(id, 5_000, 1_000_000)
    await resolve_(id, 'RELEASED', 'econnrefused')
    const e = await engaged()
    expect(e.open).toBe(0)
    expect(e.consumed).toBe(0)
  })

  it('UNRESOLVED pèse au budget sans JAMAIS entrer dans la consommation', async () => {
    const id = randomUUID()
    await reserve(id, 5_000, 1_000_000)
    await resolve_(id, 'UNRESOLVED', 'timeout')
    const e = await engaged()
    expect(e.unresolved).toBe(5_000)
    expect(e.consumed).toBe(0)  // le compteur reste la dépense RÉGLÉE et connue
    expect(e.open).toBe(0)
  })

  it('une OPEN expirée devient UNRESOLVED, jamais RELEASED', async () => {
    const id = randomUUID()
    // TTL plancher : la fonction borne à 60 s, donc on force l'échéance en base.
    await reserve(id, 5_000, 1_000_000)
    await sb.from('prospector_ai_reservations')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', id)

    await reserve(randomUUID(), 1_000, 1_000_000)  // déclenche le balayage paresseux

    const { data } = await sb.from('prospector_ai_reservations').select('state,outcome_code').eq('id', id).single()
    expect(data!.state).toBe('UNRESOLVED')
    expect(data!.outcome_code).toBe('expired')
    expect((await engaged()).unresolved).toBe(5_000) // pèse toujours
  })

  it('un passif UNRESOLVED peut à lui seul épuiser le plafond', async () => {
    const id = randomUUID()
    await reserve(id, 3_000, 3_000)
    await resolve_(id, 'UNRESOLVED', 'http_503')
    expect((await reserve(randomUUID(), 1_000, 3_000)).state).toBe('budget_exhausted')
  })

  it('réconciliation opérateur : UNRESOLVED → SETTLED, imputé et tracé', async () => {
    const id = randomUUID()
    await reserve(id, 5_000, 1_000_000)
    await resolve_(id, 'UNRESOLVED', 'timeout')
    const { error } = await sb.rpc('prospector_ai_reconcile', {
      p_id: id, p_state: 'SETTLED', p_settled_micros: 4_200,
      p_resolved_by: 'ludwig', p_resolution_reason: 'facturé, vérifié sur la console Anthropic',
    })
    expect(error).toBeNull()
    const e = await engaged()
    expect(e.consumed).toBe(4_200)
    expect(e.unresolved).toBe(0)
    const { data } = await sb.from('prospector_ai_reservations').select('resolved_by,resolution_reason').eq('id', id).single()
    expect(data!.resolved_by).toBe('ludwig')
  })

  it('la réconciliation exige une traçabilité : resolved_by obligatoire', async () => {
    const id = randomUUID()
    await reserve(id, 5_000, 1_000_000)
    await resolve_(id, 'UNRESOLVED', 'timeout')
    const { error } = await sb.rpc('prospector_ai_reconcile', {
      p_id: id, p_state: 'SETTLED', p_settled_micros: 1, p_resolved_by: '', p_resolution_reason: null,
    })
    expect(error).toBeTruthy()
  })
})

describe('permissions', () => {
  it('la clé anon ne peut PAS engager de dépense', async () => {
    const anonKey = process.env.SUPABASE_TEST_ANON_KEY
    if (!anonKey) return // fourni par le workflow d'intégration ; ignoré en local sans clé
    const anon = createClient(URL_, anonKey)
    const { error } = await anon.rpc('prospector_ai_reserve', {
      p_id: randomUUID(), p_fingerprint: FP, p_budget_micros: 0,
      p_estimate_micros: 1, p_agent: 'x', p_model: 'y', p_ttl_seconds: 900,
    })
    expect(error).toBeTruthy()
  })
})
