import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'

// Tests d'INTÉGRATION — lot SEC-SECRETS-0C.1. LE COFFRE DE PLATEFORME.
//
// ── POURQUOI LES TESTS UNITAIRES NE SUFFISENT PAS ICI ───────────────────────
// `tests/platform-vault.test.ts` éprouve la couche applicative contre une base
// SIMULÉE. Il prouve que le code respecte le contrat. Il ne prouve rien de ce
// qui compte le plus dans ce lot :
//
//   * qu'une CHECK REFUSE réellement une enveloppe sans `kid` — et la sémantique
//     SQL est piégeuse : une CHECK qui s'évalue à UNKNOWN PASSE ;
//   * que `service_role` ne peut PAS écrire en direct — la baseline contient
//     `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO service_role`, donc la
//     table NAÎT ouverte en écriture et seul un REVOKE la referme ;
//   * qu'un compare-and-swap concurrent ne désigne qu'UN gagnant.
//
// Aucune de ces trois propriétés n'est vérifiable ailleurs qu'ici :
//
//   TypeScript → supabase-js → PostgREST → PostgreSQL → contraintes et privilèges
//
// ⚠️ LE TEST DE PRIVILÈGES EST EXÉCUTÉ, PAS LU. Vérifier la présence du REVOKE
// dans le fichier SQL prouverait seulement que la ligne est écrite — pas qu'elle
// produit l'effet attendu après les GRANT par défaut de la baseline.
//
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON = process.env.SUPABASE_TEST_ANON_KEY || ''

/**
 * REFUS DE PERMISSION — assertion DISCRIMINANTE (0C.1.1, defaut D2).
 *
 * `expect(error).toBeTruthy()` acceptait n'importe quel echec : cache de schema
 * perime, route inconnue, charge utile invalide, faute de frappe dans un nom de
 * colonne. Un tel test reste vert le jour ou le REVOKE disparait, pourvu qu'autre
 * chose casse — c'est-a-dire exactement quand il devrait devenir rouge.
 *
 * On exige donc le code que PostgreSQL emet pour un refus de privilege, et lui
 * seul : 42501 (`insufficient_privilege`), relaye tel quel par PostgREST.
 */
function refusPermission(error: any, contexte: string) {
  expect(error, `${contexte} : aucune erreur — l'operation a ete AUTORISEE`).toBeTruthy()
  expect(error.code, `${contexte} : refuse, mais pas pour cause de privilege (${error.code} — ${error.message})`)
    .toBe('42501')
}

/**
 * REFUS D'EXECUTION D'UNE FONCTION — liste BORNEE de deux codes, et pourquoi.
 *
 * PostgREST ne publie dans son cache de schema que les fonctions sur lesquelles
 * le role possede EXECUTE. Une fonction correctement revoquee est donc, de son
 * point de vue, INTROUVABLE : il repond `PGRST202`, pas `42501`. Les deux codes
 * attestent la meme chose ici — la fonction n'est pas atteignable — et aucun
 * autre ne convient.
 *
 * ⚠️ La CONTREPARTIE de cette tolerance : `PGRST202` serait aussi la reponse a un
 * nom mal orthographie. C'est pourquoi la preuve d'ACL au niveau SQL
 * (`has_function_privilege`) reste la reference, et ce test son corollaire.
 */
const CODES_NON_EXECUTABLE = ['42501', 'PGRST202']

/**
 * REFUS DE VALIDATION — le schema ou une RPC a dit non, et on exige POURQUOI.
 *
 * `P0001` = `raise exception` de plpgsql (nom inconnu, enveloppe malformee,
 * version absurde). `23514` = violation de CHECK cote table. Toute autre valeur
 * signifierait que le rejet vient d'ailleurs — et qu'on ne prouve pas ce qu'on
 * croit prouver.
 */
const CODES_VALIDATION = ['P0001', '23514']
function refusValidation(error: any, contexte: string) {
  expect(error, `${contexte} : aucune erreur — l'ecriture a ete ACCEPTEE`).toBeTruthy()
  expect(CODES_VALIDATION, `${contexte} : rejet pour une autre raison (${error.code} — ${error.message})`)
    .toContain(error.code)
}
function refusExecution(error: any, contexte: string) {
  expect(error, `${contexte} : aucune erreur — la fonction a ete EXECUTEE`).toBeTruthy()
  expect(CODES_NON_EXECUTABLE, `${contexte} : erreur sans rapport avec l'interdiction (${error.code} — ${error.message})`)
    .toContain(error.code)
}

const TABLE = 'prospector_platform_secrets'
const NOMS = ['admin_totp_secret', 'telegram_webhook_secret', 'telegram_bot_token'] as const

let sb: any

/**
 * Enveloppe de TEST — forme seule.
 *
 * ⚠️ Ce n'est PAS un chiffré : ces tests éprouvent le SCHÉMA, qui ne déchiffre
 * rien et n'a pas de clef. Fabriquer ici un vrai scellé exigerait un trousseau,
 * donc une clef, dans un fichier de test — pour ne rien prouver de plus. La
 * cryptographie réelle est éprouvée dans `tests/platform-vault.test.ts`.
 */
function env(kid = 'k1'): string {
  return JSON.stringify({
    envelopeVersion: 1, alg: 'A256GCM', kid,
    iv: randomBytes(12).toString('base64url'),
    ciphertext: randomBytes(24).toString('base64url'),
    tag: randomBytes(16).toString('base64url'),
  })
}

beforeAll(() => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  // ⚠️ 0C.1.1 (défaut D3) — PLUS DE SAUT SILENCIEUX. La preuve que `anon`
  // n'atteint ni la table ni les RPC était auparavant contournée par un `return`
  // lorsque la clé manquait : la suite affichait alors du vert sans avoir rien
  // éprouvé. Un secret de plateforme lisible par `anon` est le pire défaut que
  // ce lot puisse avoir ; sa preuve ne peut pas être facultative.
  if (!ANON) {
    throw new Error(
      'SUPABASE_TEST_ANON_KEY absente. Elle est OBLIGATOIRE : sans elle, le refus '
      + 'opposé au rôle anonyme n\'est pas prouvé, et la suite serait verte pour rien.',
    )
  }
  sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
})

/**
 * RÉVOQUE LES GÉNÉRATIONS VIVANTES. NE REMET RIEN À L'ÉTAT VIERGE.
 *
 * ⚠️ CE HELPER S'APPELAIT `purge()`, ET CE NOM MENTAIT — au point de produire
 * deux faux négatifs sur la vraie pile (0C.1.2). `service_role` n'a pas le droit
 * de SUPPRIMER : c'est exactement la garantie que ce lot établit. Ce qui reste
 * après son passage n'est donc pas une table vide, mais une table de PIERRES
 * TOMBALES — des lignes qui AFFIRMENT l'absence, portent une version, et
 * interdisent toute adoption héritée.
 *
 * Conséquence pour qui écrit un cas ici : ne JAMAIS assimiler « après nettoyage »
 * à « aucune ligne ». Seul `supabase db reset` rend le magasin vierge, et cela
 * n'arrive qu'UNE fois, avant la suite entière. Un test qui exige l'absence
 * d'une ligne doit donc s'exécuter avant que quiconque ait créé ce secret — et
 * le dire par une précondition explicite, pas par confiance dans l'ordre.
 */
async function revokeLiveSecrets() {
  for (const nom of NOMS) {
    for (let i = 0; i < 5; i++) {
      const { data } = await sb.from(TABLE).select('secret_version, status').eq('secret_name', nom).maybeSingle()
      if (!data || data.status === 'revoked') break
      await sb.rpc('prospector_platform_secret_revoke', { p_name: nom, p_expected_version: data.secret_version })
    }
  }
}
beforeEach(revokeLiveSecrets)
afterAll(revokeLiveSecrets)

async function etat(nom: string) {
  const { data } = await sb.from(TABLE).select('secret_name, envelope, kid, secret_version, status')
    .eq('secret_name', nom).maybeSingle()
  return data
}
/** Pose une génération vivante quel que soit l'historique (pierre tombale comprise). */
async function poser(nom: string, e = env()): Promise<number> {
  const courant = await etat(nom)
  if (!courant) {
    const { data } = await sb.rpc('prospector_platform_secret_create', { p_name: nom, p_envelope: e })
    expect(data).toBe('created')
    return 1
  }
  const { data } = await sb.rpc('prospector_platform_secret_replace',
    { p_name: nom, p_envelope: e, p_expected_version: courant.secret_version })
  expect(data).toBe('replaced')
  return courant.secret_version + 1
}

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ CE BLOC DOIT RESTER LE PREMIER DU FICHIER.
//
// C'est le SEUL moment où le magasin est vierge : `supabase db reset` précède la
// suite, et rien ne peut le reproduire ensuite — `service_role` n'a pas le droit
// de supprimer, donc la moindre création laisse une pierre tombale définitive.
// L'adoption héritée n'ayant de sens qu'en l'absence TOTALE de ligne, elle ne
// peut être éprouvée qu'ici.
//
// La précondition ci-dessous n'est pas décorative : elle rend le fichier ROUGE si
// un jour un cas est déclaré au-dessus et touche `admin_totp_secret`. Sans elle,
// le test se contenterait de `exists` et passerait pour une preuve — c'est
// exactement le faux négatif que 0C.1.2 corrige.
//
// Vitest exécute les cas dans l'ordre de déclaration : ni `sequence.shuffle`, ni
// `.concurrent` ne sont utilisés ici, et `fileParallelism` est désactivé.
describe('0. MAGASIN VIERGE — adoption du sceau TOTP hérité', () => {
  it('adopte un sceau hérité, ACTIF d\'emblée, et une seule fois', async () => {
    // PRÉCONDITION EXPLICITE. Pas « on suppose » : on constate.
    expect(await etat('admin_totp_secret'),
      'le magasin n\'est pas vierge : un cas déclaré plus haut a touché admin_totp_secret').toBeFalsy()

    expect((await sb.rpc('prospector_platform_secret_adopt_legacy_totp',
      { p_envelope: env() })).data).toBe('adopted')

    // ACTIF d'emblée, et c'est délibéré : le téléphone de l'administrateur génère
    // déjà des codes valides. Migrer un secret n'est pas le faire tourner.
    expect(await etat('admin_totp_secret')).toMatchObject({ status: 'active', secret_version: 1 })

    // Rejouée, l'adoption n'écrase rien.
    expect((await sb.rpc('prospector_platform_secret_adopt_legacy_totp',
      { p_envelope: env('k2') })).data).toBe('exists')
    expect(await etat('admin_totp_secret')).toMatchObject({ status: 'active', secret_version: 1, kid: 'k1' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Le schéma refuse ce que l\'application ne doit jamais écrire', () => {
  it('une enveloppe JSON VALIDE mais SANS kid est REJETÉE', async () => {
    const sansKid = JSON.stringify({ envelopeVersion: 1, alg: 'A256GCM', iv: 'a', ciphertext: 'b', tag: 'c' })
    const { data, error } = await sb.rpc('prospector_platform_secret_create',
      { p_name: 'telegram_bot_token', p_envelope: sansKid })
    refusValidation(error, 'enveloppe sans kid')
    expect(data).toBeNull()
    expect(await etat('telegram_bot_token')).toBeFalsy()
  })

  it('un kid de forme invalide est REJETÉ', async () => {
    for (const mauvais of ['MAJUSCULE', '-tiret-en-tete', 'a'.repeat(33), '', 'avec espace']) {
      const { error } = await sb.rpc('prospector_platform_secret_create',
        { p_name: 'telegram_bot_token', p_envelope: JSON.stringify({ kid: mauvais }) })
      refusValidation(error, `kid « ${mauvais} »`)
    }
  })

  it('une enveloppe non JSON, vide ou absente est REJETÉE', async () => {
    for (const mauvais of ['pas du json', '', '   ', '[]', '"chaine"', null]) {
      const { error } = await sb.rpc('prospector_platform_secret_create',
        { p_name: 'telegram_bot_token', p_envelope: mauvais })
      refusValidation(error, `enveloppe ${JSON.stringify(mauvais)}`)
    }
  })

  it('un nom hors des trois est REJETÉ', async () => {
    for (const nom of ['anthropic_api_key', 'APP_SESSION_SECRET', 'admin_totp', '']) {
      const { error } = await sb.rpc('prospector_platform_secret_create', { p_name: nom, p_envelope: env() })
      refusValidation(error, `nom « ${nom} »`)
    }
  })

  it('le kid est DÉRIVÉ de l\'enveloppe, jamais fourni', async () => {
    await poser('telegram_bot_token', env('abc1'))
    expect((await etat('telegram_bot_token')).kid).toBe('abc1')
  })
})

describe('B. Privilèges — EXÉCUTÉS, pas lus dans le SQL', () => {
  it('service_role peut LIRE', async () => {
    const { error } = await sb.from(TABLE).select('secret_name').limit(1)
    expect(error).toBeFalsy()
  })

  // ⚠️ Les trois cas suivants sont le cœur du lot. La baseline accorde ALL sur
  // les tables nouvelles à service_role ; sans REVOKE explicite, ils PASSERAIENT.
  // ⚠️ CES TROIS CAS PROUVENT L'INVARIANCE, PAS L'ABSENCE (0C.1.2).
  //
  // L'ancienne rédaction exigeait `expect(etat(...)).toBeFalsy()` — c'est-à-dire
  // « aucune ligne ». Elle a échoué sur la vraie pile, et elle avait tort :
  // `revokeLiveSecrets()` laisse des pierres tombales, donc une ligne PEUT
  // légitimement préexister. Surtout, l'absence n'est pas ce qu'on cherche à
  // établir. Ce qui compte est qu'une opération interdite NE CHANGE RIEN, que la
  // ligne visée soit absente, vivante ou déjà tombale. On photographie donc
  // l'état avant, et on exige l'égalité après.
  it('service_role ne peut PAS insérer en direct', async () => {
    const avant = await etat('telegram_bot_token')
    // Colonnes VALIDES et charge utile complète : si l'insertion échoue, ce ne
    // peut être ni la forme ni le schéma — seulement le privilège.
    const { error } = await sb.from(TABLE).insert({
      secret_name: 'telegram_bot_token', envelope: env(), secret_version: 1, status: 'active',
    })
    refusPermission(error, 'INSERT direct par service_role')
    expect(await etat('telegram_bot_token')).toEqual(avant)
  })

  it('service_role ne peut PAS mettre à jour en direct', async () => {
    const v = await poser('admin_totp_secret')
    const avant = await etat('admin_totp_secret')
    const { error } = await sb.from(TABLE).update({ status: 'active' }).eq('secret_name', 'admin_totp_secret')
    refusPermission(error, 'UPDATE direct par service_role')
    // Rien n'a bougé — et en particulier un sceau non prouvé n'est pas devenu
    // l'autorité, ce que l'égalité stricte couvre mieux qu'un `toMatchObject`.
    expect(await etat('admin_totp_secret')).toEqual(avant)
    expect(avant).toMatchObject({ status: 'staged', secret_version: v })
  })

  it('service_role ne peut PAS supprimer en direct', async () => {
    await poser('telegram_bot_token')
    const avant = await etat('telegram_bot_token')
    const { error } = await sb.from(TABLE).delete().eq('secret_name', 'telegram_bot_token')
    refusPermission(error, 'DELETE direct par service_role')
    expect(await etat('telegram_bot_token')).toEqual(avant)
    expect(avant).toBeTruthy()
  })

  it('les fonctions internes ne sont exécutables par personne', async () => {
    for (const fn of ['prospector_platform_secret_assert_envelope', 'prospector_platform_secret_initial_status']) {
      const { error } = await sb.rpc(fn, fn.endsWith('status') ? { p_name: 'telegram_bot_token' } : { p_envelope: env() })
      refusExecution(error, `fonction interne ${fn}`)
    }
  })

  it('anon n\'atteint ni la table ni les RPC', async () => {
    const sbAnon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
    refusPermission((await sbAnon.from(TABLE).select('secret_name')).error, 'SELECT par anon')
    refusExecution((await sbAnon.rpc('prospector_platform_secret_create',
      { p_name: 'telegram_bot_token', p_envelope: env() })).error, 'RPC create par anon')
    refusExecution((await sbAnon.rpc('prospector_platform_secret_adopt_legacy_totp',
      { p_envelope: env() })).error, 'RPC adopt par anon')
  })
})

describe('C. Machine à états — imposée par la base', () => {
  it('chaque secret naît dans SON état initial', async () => {
    await poser('admin_totp_secret')
    await poser('telegram_webhook_secret')
    await poser('telegram_bot_token')
    expect((await etat('admin_totp_secret')).status).toBe('staged')
    expect((await etat('telegram_webhook_secret')).status).toBe('pending_provider')
    expect((await etat('telegram_bot_token')).status).toBe('active')
  })

  it('le jeton de bot n\'a AUCUNE promotion', async () => {
    const v = await poser('telegram_bot_token')
    const { error } = await sb.rpc('prospector_platform_secret_promote',
      { p_name: 'telegram_bot_token', p_expected_version: v })
    refusValidation(error, 'promotion du jeton de bot')
  })

  it('promouvoir conserve la version ; rejouer rend « stale »', async () => {
    const v = await poser('admin_totp_secret')
    expect((await sb.rpc('prospector_platform_secret_promote',
      { p_name: 'admin_totp_secret', p_expected_version: v })).data).toBe('promoted')
    expect(await etat('admin_totp_secret')).toMatchObject({ status: 'active', secret_version: v })
    expect((await sb.rpc('prospector_platform_secret_promote',
      { p_name: 'admin_totp_secret', p_expected_version: v })).data).toBe('stale')
  })

  it('révoquer efface l\'enveloppe ET le kid, et incrémente la version', async () => {
    const v = await poser('telegram_bot_token')
    expect((await sb.rpc('prospector_platform_secret_revoke',
      { p_name: 'telegram_bot_token', p_expected_version: v })).data).toBe('revoked')
    expect(await etat('telegram_bot_token'))
      .toMatchObject({ envelope: null, kid: null, secret_version: v + 1, status: 'revoked' })
  })

  it('replace ACCEPTE la pierre tombale — pour les TROIS secrets — sans revenir à 1', async () => {
    for (const nom of NOMS) {
      const v = await poser(nom)
      await sb.rpc('prospector_platform_secret_revoke', { p_name: nom, p_expected_version: v })
      const { data } = await sb.rpc('prospector_platform_secret_replace',
        { p_name: nom, p_envelope: env('k2'), p_expected_version: v + 1 })
      expect(data, `${nom} doit pouvoir ressusciter`).toBe('replaced')
      const apres = await etat(nom)
      expect(apres.secret_version).toBe(v + 2)
      expect(apres.secret_version).toBeGreaterThan(1)
    }
  })

  it('rewrap garde la version, exige le kid source, et refuse une pierre tombale', async () => {
    const v = await poser('telegram_bot_token', env('k1'))
    expect((await sb.rpc('prospector_platform_secret_rewrap',
      { p_name: 'telegram_bot_token', p_expected_version: v, p_old_kid: 'zz', p_envelope: env('k2') })).data).toBe('stale')
    expect((await sb.rpc('prospector_platform_secret_rewrap',
      { p_name: 'telegram_bot_token', p_expected_version: v, p_old_kid: 'k1', p_envelope: env('k2') })).data).toBe('rewrapped')
    expect(await etat('telegram_bot_token')).toMatchObject({ kid: 'k2', secret_version: v })

    await sb.rpc('prospector_platform_secret_revoke', { p_name: 'telegram_bot_token', p_expected_version: v })
    expect((await sb.rpc('prospector_platform_secret_rewrap',
      { p_name: 'telegram_bot_token', p_expected_version: v + 1, p_old_kid: 'k2', p_envelope: env('k3') })).data).toBe('stale')
  })

  it('UNE PIERRE TOMBALE N\'EST PAS UN SECRET JAMAIS CONFIGURÉ', async () => {
    // L'invariant que le faux négatif de 0C.1.1 a mis au jour, désormais éprouvé
    // pour lui-même. Un sceau TOTP révoqué l'a été DÉLIBÉRÉMENT ; permettre à
    // l'adoption héritée de le ressusciter rendrait la révocation réversible par
    // le chemin le plus discret du coffre — celui qui écrit `active` d'emblée,
    // sans aucune preuve.
    const v = await poser('admin_totp_secret')
    expect((await sb.rpc('prospector_platform_secret_revoke',
      { p_name: 'admin_totp_secret', p_expected_version: v })).data).toBe('revoked')
    const tombe = await etat('admin_totp_secret')
    expect(tombe).toMatchObject({ status: 'revoked', envelope: null, kid: null })

    expect((await sb.rpc('prospector_platform_secret_adopt_legacy_totp',
      { p_envelope: env('k2') })).data).toBe('exists')
    // Et la tombe n'a pas bougé d'un octet.
    expect(await etat('admin_totp_secret')).toEqual(tombe)
  })

  it('l\'adoption n\'accepte AUCUN paramètre de nom', async () => {
    // Aucun secret Telegram ne peut emprunter ce chemin pour devenir actif sans
    // la confirmation de son fournisseur : la signature ne le permet pas.
    refusExecution((await sb.rpc('prospector_platform_secret_adopt_legacy_totp',
      { p_name: 'telegram_webhook_secret', p_envelope: env() })).error,
      'adoption avec un p_name — cette signature n\'existe pas')
  })

  it('une version attendue absente ou nulle est refusée, pas interprétée', async () => {
    for (const v of [0, -1, null]) {
      const { error } = await sb.rpc('prospector_platform_secret_replace',
        { p_name: 'telegram_bot_token', p_envelope: env(), p_expected_version: v })
      refusValidation(error, `version attendue ${v}`)
    }
  })
})

describe('D. Compare-and-swap sous concurrence RÉELLE', () => {
  it('vingt remplacements simultanés ne désignent qu\'UN gagnant', async () => {
    const v = await poser('telegram_bot_token')
    const issues = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      sb.rpc('prospector_platform_secret_replace',
        { p_name: 'telegram_bot_token', p_envelope: env(`k${i % 9}`), p_expected_version: v })
        .then((r: any) => r.data)))
    expect(issues.filter((x) => x === 'replaced')).toHaveLength(1)
    expect(issues.filter((x) => x === 'stale')).toHaveLength(19)
    expect((await etat('telegram_bot_token')).secret_version).toBe(v + 1)
  })

  it('vingt révocations simultanées ne posent qu\'UNE pierre tombale', async () => {
    const v = await poser('admin_totp_secret')
    const issues = await Promise.all(Array.from({ length: 20 }, () =>
      sb.rpc('prospector_platform_secret_revoke', { p_name: 'admin_totp_secret', p_expected_version: v })
        .then((r: any) => r.data)))
    expect(issues.filter((x) => x === 'revoked')).toHaveLength(1)
    expect((await etat('admin_totp_secret')).secret_version).toBe(v + 1)
  })
})

describe('E. Aucun clair, nulle part', () => {
  it('la table ne porte que des enveloppes — aucune colonne de commodité', async () => {
    await poser('telegram_bot_token')
    const { data } = await sb.from(TABLE).select('*').eq('secret_name', 'telegram_bot_token').maybeSingle()
    expect(Object.keys(data).sort())
      .toEqual(['created_at', 'envelope', 'kid', 'secret_name', 'secret_version', 'status', 'updated_at'])
  })
})
