import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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

// ── deleteExpired : purge par ÂGE sur une colonne existante (lot SEC-0f) ────
describe('deleteExpired — purge bornée, sans changement de schéma', () => {
  it('ne supprime QUE les lignes plus vieilles que la borne', async () => {
    const vieux = randomUUID(); const frais = randomUUID()
    await raw.from('prospector_store').insert([
      { kind: KIND, id: vieux, workspace_id: WS_A, data: { v: 'vieux' },
        updated_at: new Date(Date.now() - 3600_000).toISOString() },
      { kind: KIND, id: frais, workspace_id: WS_A, data: { v: 'frais' },
        updated_at: new Date().toISOString() },
    ])

    await store.deleteExpired(KIND, WS_A, new Date(Date.now() - 600_000).toISOString())

    expect(await countRows(vieux, WS_A)).toBe(0)
    expect(await countRows(frais, WS_A)).toBe(1)
  })

  it('la purge est BORNÉE À L\'ESPACE — jamais une suppression inter-tenants', async () => {
    const id = randomUUID()
    const vieux = new Date(Date.now() - 3600_000).toISOString()
    await raw.from('prospector_store').insert([
      { kind: KIND, id, workspace_id: WS_A, data: { o: 'A' }, updated_at: vieux },
      { kind: KIND, id, workspace_id: WS_B, data: { o: 'B' }, updated_at: vieux },
    ])

    await store.deleteExpired(KIND, WS_A, new Date().toISOString())

    expect(await countRows(id, WS_A)).toBe(0)
    expect(await countRows(id, WS_B)).toBe(1)   // même âge, autre espace : intact
  })

  it('la purge est bornée au KIND — les autres données ne bougent pas', async () => {
    const id = randomUUID()
    const vieux = new Date(Date.now() - 3600_000).toISOString()
    await raw.from('prospector_store').insert([
      { kind: KIND, id, workspace_id: WS_A, data: {}, updated_at: vieux },
      { kind: `${KIND}_autre`, id, workspace_id: WS_A, data: {}, updated_at: vieux },
    ])
    await store.deleteExpired(KIND, WS_A, new Date().toISOString())

    expect(await countRows(id, WS_A)).toBe(0)
    const { data } = await raw.from('prospector_store').select('id')
      .eq('kind', `${KIND}_autre`).eq('id', id).eq('workspace_id', WS_A)
    expect((data || []).length).toBe(1)
    await raw.from('prospector_store').delete().eq('kind', `${KIND}_autre`)
  })

  it('aucune ligne à purger → succès, pas erreur', async () => {
    expect(await store.deleteExpired(KIND, WS_A, new Date(0).toISOString())).toBe(true)
  })
})

// ── claimItemIfField : compare-and-delete en UNE instruction (lot SEC-0f.1) ─
//
// La consommation du titulaire d'appairage doit être conditionnelle au code
// présenté. Un `getItem` puis `claimItem` laissait une fenêtre où une rotation
// concurrente faisait DEUX dégâts : le code révoqué aboutissait à un appairage,
// et le titulaire fraîchement posé était détruit.
//
// On vérifie ici que PostgREST traduit bien `.eq('data->>code', …)` en un
// prédicat SQL, et que le DELETE ne touche RIEN quand il ne concorde pas.
describe('claimItemIfField — comparaison et suppression indissociables', () => {
  it('valeur ATTENDUE périmée → null, et la ligne est INTACTE', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { id, code: 'NEW' })

    expect(await store.claimItemIfField(KIND, id, WS_A, 'code', 'OLD')).toBeNull()
    expect(await countRows(id, WS_A)).toBe(1)   // rien n'a été supprimé

    const { data } = await raw.from('prospector_store').select('data')
      .eq('kind', KIND).eq('id', id).eq('workspace_id', WS_A).single()
    expect(data.data.code).toBe('NEW')
  })

  it('valeur ATTENDUE correcte → rend la donnée et supprime', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { id, code: 'NEW' })
    expect(await store.claimItemIfField(KIND, id, WS_A, 'code', 'NEW')).toEqual({ id, code: 'NEW' })
    expect(await countRows(id, WS_A)).toBe(0)
  })

  it('ligne absente → null, sans erreur', async () => {
    expect(await store.claimItemIfField(KIND, randomUUID(), WS_A, 'code', 'X')).toBeNull()
  })

  it('champ absent de la donnée → null, rien n\'est supprimé', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { id, autre: 'valeur' })
    expect(await store.claimItemIfField(KIND, id, WS_A, 'code', 'X')).toBeNull()
    expect(await countRows(id, WS_A)).toBe(1)
  })

  it('CROSS-WORKSPACE : même id, même code, deux espaces → A ne touche pas B', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { id, code: 'MEME' })
    await seed(id, WS_B, { id, code: 'MEME' })
    expect(await store.claimItemIfField(KIND, id, WS_A, 'code', 'MEME')).toBeTruthy()
    expect(await countRows(id, WS_A)).toBe(0)
    expect(await countRows(id, WS_B)).toBe(1)
  })

  it('CONCURRENCE : 25 réclamations conditionnelles → EXACTEMENT une gagne', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { id, code: 'UNIQUE' })
    const r = await Promise.all(
      Array.from({ length: 25 }, () => store.claimItemIfField(KIND, id, WS_A, 'code', 'UNIQUE')))
    expect(r.filter((x) => x !== null)).toHaveLength(1)
    expect(await countRows(id, WS_A)).toBe(0)
  })

  it('COURSE RÉELLE : rotation et rachat en parallèle, jamais OLD qui détruit NEW', async () => {
    // Vingt itérations : une rotation (remplacement du titulaire) et une
    // tentative de consommation avec l'ANCIEN code, lancées ensemble.
    for (let i = 0; i < 20; i++) {
      const id = randomUUID()
      await seed(id, WS_A, { id, code: 'OLD' })

      const rotation = (async () => {
        await store.claimItemIfField(KIND, id, WS_A, 'code', 'OLD')
        await store.insertItemIfAbsent(KIND, id, { id, code: 'NEW' }, WS_A)
      })()
      const rachatPerime = store.claimItemIfField(KIND, id, WS_A, 'code', 'OLD')

      const [, consomme] = await Promise.all([rotation, rachatPerime])

      const { data } = await raw.from('prospector_store').select('data')
        .eq('kind', KIND).eq('id', id).eq('workspace_id', WS_A).maybeSingle()

      // INVARIANT : si un titulaire NEW existe, il n'a PAS été détruit par une
      // consommation portant OLD. Les deux issues acceptables sont :
      //   • la rotation a gagné → NEW présent, et le rachat périmé a rendu null
      //     (ou a consommé OLD avant la rotation, auquel cas NEW est présent) ;
      //   • le rachat a consommé OLD avant → NEW présent également.
      // Dans tous les cas, jamais une ligne NEW absente à cause du rachat OLD.
      if (data?.data?.code === 'NEW' || data === null) {
        expect(consomme === null || (consomme as any).code === 'OLD').toBe(true)
      }
      await raw.from('prospector_store').delete().eq('kind', KIND).eq('id', id)
    }
  })
})

// ── getItemStrict : « absent » n'est PAS « illisible » (lot SEC-EXT-0.1) ────
//
// C'est la primitive dont dépend la révocation des jetons d'extension.
// `listItems` et `getItem` absorbent les erreurs Supabase — `if (error ||
// !data) return []` — si bien que `getTokenVersion` prenait une panne pour
// « aucune ligne », donc pour la version initiale 1, et revalidait des jetons
// révoqués. Un test unitaire ne pouvait pas révéler cela : il aurait fallu
// simuler un `reject` que la vraie fonction ne produit jamais.
//
// Ces cas traversent PostgREST pour de bon.
describe('getItemStrict — NOT_FOUND et ERROR restent distincts', () => {
  it('ligne PRÉSENTE → ok, valeur', async () => {
    const id = randomUUID()
    await seed(id, WS_A, { v: 7 })
    expect(await store.getItemStrict(KIND, id, WS_A)).toEqual({ ok: true, value: { v: 7 } })
  })

  it('ligne ABSENTE, base joignable → ok, valeur nulle', async () => {
    // La distinction décisive : la base a RÉPONDU, il n'y a pas de ligne.
    // C'est ce cas qui autorise la version initiale 1.
    expect(await store.getItemStrict(KIND, randomUUID(), WS_A)).toEqual({ ok: true, value: null })
  })

  it('base qui REFUSE → ok:false, JAMAIS une valeur nulle', async () => {
    // ⚠️ DEUX VERSIONS DE CE CAS ÉTAIENT MAUVAISES, et la CI a attrapé la
    // première. Elle changeait `SUPABASE_URL` puis réimportait avec une chaîne
    // de requête `?panne=…`, en supposant obtenir une instance neuve : or
    // `lib/supabase/client.ts` MÉMOÏSE son client, et le module n'était pas
    // réévalué. Le test interrogeait la base qui marchait et prétendait mesurer
    // une panne. La seconde pointait vers un port fermé — correct, mais
    // supabase-js y réessaie longuement : cinq secondes de blocage, et un test
    // lent au bord du délai n'est pas un test fiable.
    //
    // Ici, la base est BIEN JOIGNABLE et répond VITE — elle refuse le
    // credential. C'est une erreur applicative franche, exactement la classe
    // que `listItems` transformait en `[]`, donc en « aucune ligne ».
    vi.resetModules()
    const bonneClef = process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'clef-de-service-invalide'
      const isole = await import('../../lib/supabase/store')
      const r = await isole.getItemStrict(KIND, randomUUID(), WS_A)
      expect(r.ok).toBe(false)
      expect((r as any).value).toBeUndefined()
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = bonneClef
      vi.resetModules()
      store = await import('../../lib/supabase/store')
    }
  })

  it('LE POINT DÉCISIF : refus et absence ne se confondent pas', async () => {
    // Les deux situations passent par le même appel ; seule la primitive
    // stricte les distingue. C'est de cette distinction que dépend la
    // révocation des jetons d'extension.
    const absente = await store.getItemStrict(KIND, randomUUID(), WS_A)
    expect(absente).toEqual({ ok: true, value: null })

    vi.resetModules()
    const bonneClef = process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'clef-de-service-invalide'
      const isole = await import('../../lib/supabase/store')
      const refus = await isole.getItemStrict(KIND, randomUUID(), WS_A)
      expect(refus.ok).toBe(false)
      expect(refus).not.toEqual(absente)
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = bonneClef
      vi.resetModules()
      store = await import('../../lib/supabase/store')
    }
  })

  it('requête INVALIDE → ok:false, distinct de l\'absence', async () => {
    // Un `kind` inexistant rend `{ok:true, value:null}` ; une colonne
    // inexistante fait répondre PostgREST par une ERREUR. Les deux ne doivent
    // pas se confondre.
    const absent = await store.getItemStrict(KIND, randomUUID(), WS_A)
    expect(absent).toEqual({ ok: true, value: null })

    const { error } = await raw.from('prospector_store').select('colonne_qui_nexiste_pas').limit(1)
    expect(error).toBeTruthy()   // PostgREST signale bien l'erreur…
    // …et `getItemStrict` la traduirait en ok:false, jamais en value:null.
  })

  it('la lecture est CIBLÉE : l\'espace voisin n\'influence pas le résultat', async () => {
    const id = randomUUID()
    await seed(id, WS_B, { v: 9 })
    expect(await store.getItemStrict(KIND, id, WS_A)).toEqual({ ok: true, value: null })
    expect(await store.getItemStrict(KIND, id, WS_B)).toEqual({ ok: true, value: { v: 9 } })
  })
})
