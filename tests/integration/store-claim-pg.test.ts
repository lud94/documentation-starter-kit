import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

// Tests d'INTÉGRATION — lot SEC-0e. Primitives d'exclusion de `store.ts`.
//
// ── CE QUE CES CAS PROUVENT, ET POURQUOI UN MODÈLE NE SUFFIT PAS ────────────
// `claimItem` et `insertItemIfAbsent` portent tout le contrat « au plus un » de
// l'appairage : usage unique du code, et quota de tentatives. Les tests
// unitaires MODÉLISENT le comportement PostgreSQL — ils prouvent que la logique
// appelante est correcte SI la primitive tient sa promesse. Ils ne prouvent pas
// la promesse elle-même.
//
// Ici, rien n'est simulé. Chaque cas traverse toute la pile :
//
//   TypeScript → supabase-js → PostgREST → PostgreSQL → DELETE/INSERT réels
//
// C'est la seule façon de vérifier que `.delete().eq(…).select()` fait bien ce
// qu'on croit, que le filtre porte sur la clé primaire COMPLÈTE, et qu'un
// conflit d'unicité remonte bien en erreur plutôt qu'en écrasement silencieux.
//
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const KIND = 'security_test_claim'
const WS_A = '_sec0e_ws_a'
const WS_B = '_sec0e_ws_b'

let store: typeof import('../../lib/supabase/store')
let raw: any

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  // Le module lit sa configuration depuis l'environnement, comme en production.
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
  process.env.APP_ENV = 'development'
  delete process.env.APP_ENV_STRICT

  raw = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  store = await import('../../lib/supabase/store')
})

async function purge() {
  await raw.from('prospector_store').delete().eq('kind', KIND)
}
beforeEach(purge)
afterAll(purge)

async function seed(id: string, ws: string, data: any = { marker: 'sentinelle' }) {
  const { error } = await raw.from('prospector_store')
    .insert({ kind: KIND, id, workspace_id: ws, data, updated_at: new Date().toISOString() })
  expect(error).toBeNull()
}
async function countRows(id: string, ws: string): Promise<number> {
  const { data } = await raw.from('prospector_store').select('id')
    .eq('kind', KIND).eq('id', id).eq('workspace_id', ws)
  return (data || []).length
}

// ── claimItem : DELETE … RETURNING, un seul gagnant ─────────────────────────
describe('claimItem — exclusion réelle par PostgreSQL', () => {
  it.each([2, 10, 25])('%i réclamations concurrentes → EXACTEMENT une gagne', async (n) => {
    const id = randomUUID()
    await seed(id, WS_A, { marker: 'UNIQUE-7392' })

    const results = await Promise.all(
      Array.from({ length: n }, () => store.claimItem(KIND, id, WS_A)))

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toEqual({ marker: 'UNIQUE-7392' })
    expect(results.filter((r) => r === null)).toHaveLength(n - 1)
    // La ligne n'existe plus : le gagnant l'a bien consommée.
    expect(await countRows(id, WS_A)).toBe(0)
  })

  it('ligne absente → null, sans erreur (le cas zéro ligne est un refus, pas une panne)', async () => {
    expect(await store.claimItem(KIND, randomUUID(), WS_A)).toBeNull()
  })

  it('la réclamation rend bien la DONNÉE, pas la ligne entière', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { ws: WS_A, at: 1234, nested: { ok: true } })
    expect(await store.claimItem(KIND, id, WS_A)).toEqual({ ws: WS_A, at: 1234, nested: { ok: true } })
  })

  // ── §7 — le filtre porte sur la clé primaire COMPLÈTE ─────────────────────
  it('CROISS-WORKSPACE : même kind, même id, deux espaces → A ne touche JAMAIS B', async () => {
    const id = randomUUID()   // le MÊME identifiant dans les deux espaces
    await seed(id, WS_A, { owner: 'A' })
    await seed(id, WS_B, { owner: 'B' })

    const got = await store.claimItem(KIND, id, WS_A)
    expect(got).toEqual({ owner: 'A' })

    // La ligne de B est intacte — c'est `workspace_id` dans le filtre qui le
    // garantit, pas une convention d'appelant.
    expect(await countRows(id, WS_A)).toBe(0)
    expect(await countRows(id, WS_B)).toBe(1)
    expect(await store.claimItem(KIND, id, WS_B)).toEqual({ owner: 'B' })
  })

  it('concurrence CROISÉE : A et B réclament le même id en parallèle', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { owner: 'A' })
    await seed(id, WS_B, { owner: 'B' })

    const [a, b] = await Promise.all([
      store.claimItem(KIND, id, WS_A), store.claimItem(KIND, id, WS_B),
    ])
    // Les deux réussissent : ce sont deux lignes DISTINCTES. Aucune ne vole
    // l'autre, et aucune n'est bloquée par l'autre.
    expect(a).toEqual({ owner: 'A' })
    expect(b).toEqual({ owner: 'B' })
  })
})

// ── insertItemIfAbsent : la clé primaire tranche ────────────────────────────
describe('insertItemIfAbsent — un seul insérant par clé', () => {
  it.each([2, 10, 25])('%i insertions concurrentes de la MÊME clé → une seule réussit', async (n) => {
    const id = randomUUID()
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => store.insertItemIfAbsent(KIND, id, { attempt: i }, WS_A)))

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter((r) => r === false)).toHaveLength(n - 1)
    // Une seule ligne existe, et elle n'a pas été écrasée n fois.
    expect(await countRows(id, WS_A)).toBe(1)
  })

  it('une clé déjà prise n\'ÉCRASE PAS la donnée existante', async () => {
    const id = randomUUID()
    expect(await store.insertItemIfAbsent(KIND, id, { v: 'premier' }, WS_A)).toBe(true)
    expect(await store.insertItemIfAbsent(KIND, id, { v: 'second' }, WS_A)).toBe(false)
    const { data } = await raw.from('prospector_store').select('data')
      .eq('kind', KIND).eq('id', id).eq('workspace_id', WS_A).single()
    expect(data.data).toEqual({ v: 'premier' })
  })

  it('la même clé dans DEUX espaces réussit deux fois — l\'exclusion est par espace', async () => {
    const id = randomUUID()
    expect(await store.insertItemIfAbsent(KIND, id, { owner: 'A' }, WS_A)).toBe(true)
    expect(await store.insertItemIfAbsent(KIND, id, { owner: 'B' }, WS_B)).toBe(true)
  })

  // Le quota d'appairage repose exactement là-dessus : MAX_FAILURES jetons
  // nommés, et au plus MAX_FAILURES gagnants quel que soit le parallélisme.
  it('SIMULATION DU QUOTA : 100 concurrents, 5 jetons → exactement 5 passent', async () => {
    const chat = `tg:${randomUUID()}`
    const SLOTS = 5
    const attempt = async () => {
      for (let i = 0; i < SLOTS; i++) {
        if (await store.insertItemIfAbsent(KIND, `${chat}:${i}`, { i }, WS_A)) return true
      }
      return false
    }
    const results = await Promise.all(Array.from({ length: 100 }, attempt))
    expect(results.filter(Boolean)).toHaveLength(SLOTS)
    expect(results.filter((r) => r === false)).toHaveLength(95)
  })
})
