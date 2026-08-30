import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// Tests d'INTÉGRATION — lot SEC-AUTH-0.1. L'AUTORITÉ DE RÉINITIALISATION.
//
// ── POURQUOI LES TESTS UNITAIRES NE SUFFISENT PAS ICI ───────────────────────
// `tests/auth-reset-authority.test.ts` prouve que vingt consommations
// simultanées ne produisent qu'un gagnant — mais contre le repli MÉMOIRE de
// `prospector_store`, où l'exclusion tient à une propriété du moteur
// JavaScript : rien n'interrompt entre la comparaison et le `Map.delete`.
//
// C'est vrai, et ça ne prouve RIEN de la production. Là-bas, les instances sont
// des processus distincts, et l'exclusion doit venir de PostgreSQL : un
// `DELETE … WHERE data->>'hash' = $1 RETURNING`, qui verrouille la ligne pour
// la durée de l'instruction. Un seul appelant repart avec la donnée.
//
// C'est cette promesse-là qu'on éprouve ici, sans rien simuler :
//
//   TypeScript → supabase-js → PostgREST → PostgreSQL → DELETE réel
//
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`.
// AUCUNE migration : la table et sa clé `(kind, id, workspace_id)` existent
// depuis C2a-1.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:55321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// Le vrai espace technique de l'autorité — on éprouve le chemin réel, pas une
// copie décorative. L'identifiant est distinct pour ne pas heurter un
// éventuel état applicatif.
const KIND = 'authreset'
const ID = 'admin_integration_sec_auth_01'
const NS = '_auth'

let store: typeof import('../../lib/supabase/store')
let raw: any

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
  process.env.APP_ENV = 'development'
  delete process.env.APP_ENV_STRICT

  raw = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  store = await import('../../lib/supabase/store')
})

async function purge() {
  await raw.from('prospector_store').delete().eq('kind', KIND).eq('id', ID)
}
beforeEach(purge)
afterAll(purge)

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Pose une autorité, comme le fait `createResetAuthority`. */
async function poser(token: string, ttlMs = 30 * 60 * 1000) {
  const hash = await sha256Hex(token)
  expect(await store.upsertItem(KIND, ID, { hash, exp: Date.now() + ttlMs }, NS)).toBe(true)
  return hash
}

/** Consomme, comme le fait `claimResetAuthority`. */
async function consommer(token: string): Promise<boolean> {
  const row = await store.claimItemIfField<any>(KIND, ID, NS, 'hash', await sha256Hex(token))
  if (!row) return false
  const exp = Number(row.exp)
  return Number.isFinite(exp) && Date.now() < exp
}

async function ligneExiste(): Promise<boolean> {
  const r = await store.getItemStrict(KIND, ID, NS)
  return r.ok === true && r.value !== null
}

describe('autorité de réinitialisation — exclusion par PostgreSQL réel', () => {
  for (const n of [2, 10, 25]) {
    it(`${n} consommations concurrentes du même bearer → EXACTEMENT une gagne`, async () => {
      const token = 'a1'.repeat(24)
      await poser(token)

      const resultats = await Promise.all(Array.from({ length: n }, () => consommer(token)))
      expect(resultats.filter(Boolean)).toHaveLength(1)
      // Et la ligne a disparu : plus rien à réclamer ensuite.
      expect(await ligneExiste()).toBe(false)
      expect(await consommer(token)).toBe(false)
    })
  }

  it('un bearer FAUX ne consomme rien : la ligne survit intacte', async () => {
    const token = 'b2'.repeat(24)
    await poser(token)
    expect(await consommer('c3'.repeat(24))).toBe(false)
    expect(await ligneExiste()).toBe(true)
    // Le vrai bearer fonctionne toujours après la tentative ratée.
    expect(await consommer(token)).toBe(true)
  })

  it('une autorité EXPIRÉE est refusée — et tout de même consommée', async () => {
    const token = 'd4'.repeat(24)
    await poser(token, -1000)                       // déjà périmée
    expect(await consommer(token)).toBe(false)
    expect(await ligneExiste()).toBe(false)         // réclamée quand même
  })

  it('une nouvelle demande REMPLACE l\'autorité : l\'ancien bearer meurt', async () => {
    const a = 'e5'.repeat(24)
    const b = 'f6'.repeat(24)
    await poser(a)
    await poser(b)                                   // même clé primaire → remplace
    expect(await consommer(a)).toBe(false)
    expect(await consommer(b)).toBe(true)
  })

  it('l\'invalidation CONDITIONNELLE de A ne touche pas l\'autorité de B', async () => {
    // Le scénario de déni de service : l'email de A échoue, A veut invalider —
    // mais B est déjà l'autorité courante et a reçu son lien.
    const a = 'a7'.repeat(24)
    const b = 'b8'.repeat(24)
    const hashA = await sha256Hex(a)
    await poser(a)
    await poser(b)                                   // B remplace A

    // A invalide « la sienne » — conditionnée à SON empreinte.
    await store.claimItemIfField(KIND, ID, NS, 'hash', hashA)

    expect(await ligneExiste()).toBe(true)           // B est toujours là
    expect(await consommer(b)).toBe(true)            // et reste utilisable
  })

  it('course RÉELLE : remplacement et consommation en parallèle, un gagnant PAR BEARER', async () => {
    // ⚠️ CORRECTION D'UNE ASSERTION FAUSSE DE MA PART. J'avais d'abord exigé
    // « au plus UN gagnant au total », et la CI l'a mise en défaut (2). Elle
    // avait raison et moi tort : si une réclamation sur A l'emporte AVANT que
    // B ne remplace l'autorité, puis qu'une réclamation sur B l'emporte
    // ensuite, cela fait deux gagnants — et c'est parfaitement correct. Ce sont
    // deux réinitialisations distinctes, consommées chacune une fois.
    //
    // L'invariant réel n'est pas « un gagnant par course », c'est UN GAGNANT
    // PAR BEARER. Un test qui affirme plus que la propriété défendue ne durcit
    // rien : il devient rouge sur du comportement légitime, et on finit par le
    // relâcher au mauvais endroit.
    const a = 'c9'.repeat(24)
    const b = 'd0'.repeat(24)
    await poser(a)
    // 12 tentatives sur A pendant que B remplace l'autorité au milieu.
    const [surA, , surB] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, () => consommer(a))),
      poser(b),
      Promise.all(Array.from({ length: 12 }, () => consommer(b))),
    ])
    expect(surA.filter(Boolean).length).toBeLessThanOrEqual(1)
    expect(surB.filter(Boolean).length).toBeLessThanOrEqual(1)
    // Et aucun des deux ne resert : ce qui a été consommé l'est définitivement.
    if (surA.some(Boolean)) expect(await consommer(a)).toBe(false)
    if (surB.some(Boolean)) expect(await consommer(b)).toBe(false)
    // A ne survit jamais au remplacement par B.
    expect(await consommer(a)).toBe(false)
  })

  it('l\'autorité stockée en base ne contient que l\'empreinte et l\'expiration', async () => {
    const token = 'e1'.repeat(24)
    await poser(token)
    const { data } = await raw.from('prospector_store').select('data')
      .eq('kind', KIND).eq('id', ID).eq('workspace_id', NS).single()
    expect(Object.keys(data.data).sort()).toEqual(['exp', 'hash'])
    // Le bearer brut n'existe nulle part dans la base.
    expect(JSON.stringify(data.data)).not.toContain(token)
  })

  it('l\'espace `_auth` est cloisonné : un autre espace ne réclame rien', async () => {
    const token = 'f2'.repeat(24)
    const hash = await poser(token)
    expect(await store.claimItemIfField(KIND, ID, '_meta', 'hash', hash)).toBeNull()
    expect(await ligneExiste()).toBe(true)
  })
})
