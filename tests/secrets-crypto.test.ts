// SEC-SECRETS-0B — LA SERRURE, AVANT D'Y METTRE LES SECRETS.
//
// Ce lot ne migre AUCUN secret réel : il construit et éprouve la primitive qui
// les protégera. La propriété centrale n'est pas « c'est chiffré » — c'est :
//
//     un chiffré scellé pour un contexte A ne s'ouvre JAMAIS sous un contexte B,
//     même pour qui peut écrire dans la base.
//
// Sans cela, recopier une ligne suffirait à faire utiliser à Client-B la clé
// Anthropic de Fabel, et le chiffrement aurait « parfaitement fonctionné »
// pendant que l'isolation échouait.
//
// ⚠️ AUCUNE CLÉ RÉELLE ICI. Toutes les clés sont engendrées dans le test.
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  sealSecret, openSecret, parseEnvelope, isCurrentKid,
  ENVELOPE_VERSION, ALG, IV_BYTES, TAG_BYTES, SECRET_SCOPES,
  type SecretContext,
} from '../lib/secrets/crypto'
import {
  parseKeyring, loadKeyringFromEnv, keyringConfigured, keyringKids,
  assertSafeKeyringTransition, KEYRING_ENV, KEY_BYTES, type Keyring,
} from '../lib/secrets/keyring'
import { SecretCryptoError, isSecretCryptoError } from '../lib/secrets/errors'

// ── Matériel de TEST, engendré ici, jamais commité ──────────────────────────
const cleTest = () => randomBytes(KEY_BYTES).toString('base64url')
const trousseau = (currentKid: string, kids: string[]): Keyring =>
  parseKeyring(JSON.stringify({
    currentKid,
    keys: Object.fromEntries(kids.map((k) => [k, cleTest()])),
  }))

const SECRET = 'sk-ant-valeur-de-test-uniquement-0123456789'

const CTX: SecretContext = {
  scope: 'tenant',
  secretName: 'provider_api_key',
  workspaceId: 'ws_fabel',
  provider: 'anthropic',
  credentialId: 'cred_1',
  secretVersion: 1,
}

/** Capture le code d'erreur d'un appel qui doit échouer. */
function codeErreur(fn: () => unknown): string {
  try { fn(); return 'AUCUNE_ERREUR' } catch (e) {
    if (!isSecretCryptoError(e)) return `ERREUR_ETRANGERE:${String(e)}`
    return e.code
  }
}

/** Réécrit un champ de l'enveloppe sérialisée. */
function retoucher(serialisee: string, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(serialisee), ...patch })
}

/** Inverse un bit d'un champ base64url. */
function bitInverse(b64: string): string {
  const buf = Buffer.from(b64, 'base64url')
  buf[0] ^= 0x01
  return buf.toString('base64url')
}

// ══ A/B — LE CONTRAT NOMINAL ═══════════════════════════════════════════════
describe('A/B — sceller puis ouvrir, et jamais deux fois le même chiffré', () => {
  it('A — aller-retour fidèle, y compris sur du texte non trivial', () => {
    const k = trousseau('v1', ['v1'])
    for (const clair of [SECRET, 'a', 'é@#|\\"\n\t{}', 'x'.repeat(4096), '🔐 clé unicode']) {
      expect(openSecret(sealSecret(clair, CTX, k), CTX, k)).toBe(clair)
    }
  })

  it('un secret VIDE est refusé — un secret absent se supprime, il ne se scelle pas', () => {
    // Sceller le vide produirait une ligne d'apparence normale qui ferait
    // passer un secret non renseigné pour CONFIGURÉ.
    const k = trousseau('v1', ['v1'])
    expect(codeErreur(() => sealSecret('', CTX, k))).toBe('secret_context_invalid')
  })

  it('B — deux scellements du MÊME secret sous le MÊME contexte diffèrent', () => {
    // Un chiffrement déterministe révélerait l'égalité de deux secrets — donc,
    // par exemple, que deux espaces partagent la même clé fournisseur.
    const k = trousseau('v1', ['v1'])
    const a = sealSecret(SECRET, CTX, k)
    const b = sealSecret(SECRET, CTX, k)
    expect(a).not.toBe(b)
    expect(parseEnvelope(a).ciphertext).not.toBe(parseEnvelope(b).ciphertext)
    expect(parseEnvelope(a).iv).not.toBe(parseEnvelope(b).iv)
    expect(openSecret(a, CTX, k)).toBe(SECRET)
    expect(openSecret(b, CTX, k)).toBe(SECRET)
  })

  it('la forme de l\'enveloppe est celle annoncée', () => {
    const k = trousseau('v1', ['v1'])
    const e = parseEnvelope(sealSecret(SECRET, CTX, k))
    expect(e.envelopeVersion).toBe(ENVELOPE_VERSION)
    expect(e.alg).toBe(ALG)
    expect(e.kid).toBe('v1')
    expect(Buffer.from(e.iv, 'base64url')).toHaveLength(IV_BYTES)
    expect(Buffer.from(e.tag, 'base64url')).toHaveLength(TAG_BYTES)
    // Le clair n'apparaît nulle part dans ce qui sera stocké.
    expect(JSON.stringify(e)).not.toContain(SECRET)
  })
})

// ══ C–H — ANTI-PERMUTATION : LE CŒUR DU LOT ════════════════════════════════
describe('C–H — un chiffré ne s\'ouvre que sous SON contexte', () => {
  const k = trousseau('v1', ['v1'])
  const scelle = sealSecret(SECRET, CTX, k)

  const VARIANTES: Array<[string, SecretContext]> = [
    ['C — autre workspace', { ...CTX, workspaceId: 'ws_client_b' }],
    ['C bis — workspace retiré', { ...CTX, workspaceId: null }],
    ['D — autre secretName', { ...CTX, secretName: 'autre_secret' }],
    ['E — autre provider', { ...CTX, provider: 'openai' }],
    ['E bis — provider retiré', { ...CTX, provider: null }],
    ['F — autre credentialId', { ...CTX, credentialId: 'cred_2' }],
    ['G — autre secretVersion', { ...CTX, secretVersion: 2 }],
    ['G bis — version retirée', { ...CTX, secretVersion: null }],
    ['scope différent', { ...CTX, scope: 'platform' }],
  ]

  for (const [nom, ctx] of VARIANTES) {
    it(`${nom} → secret_decrypt_failed`, () => {
      expect(codeErreur(() => openSecret(scelle, ctx, k))).toBe('secret_decrypt_failed')
    })
  }

  it('H — le SCÉNARIO RÉEL : un chiffré recopié d\'une ligne vers une autre', () => {
    // Fabel et Client-B ont chacun leur credential Anthropic. Quelqu'un qui
    // peut écrire dans la base recopie le chiffré de Fabel dans la ligne de
    // Client-B — sans toucher au chiffrement, juste en déplaçant des octets.
    const fabel: SecretContext = { scope: 'tenant', secretName: 'provider_api_key', workspaceId: 'ws_fabel', provider: 'anthropic', credentialId: 'c1', secretVersion: 1 }
    const clientB: SecretContext = { ...fabel, workspaceId: 'ws_client_b' }
    const deFabel = sealSecret('cle-anthropic-de-fabel-TEST', fabel, k)
    const deB = sealSecret('cle-anthropic-de-client-b-TEST', clientB, k)

    // Chacun lit le sien.
    expect(openSecret(deFabel, fabel, k)).toBe('cle-anthropic-de-fabel-TEST')
    expect(openSecret(deB, clientB, k)).toBe('cle-anthropic-de-client-b-TEST')

    // ⚠️ La permutation échoue DANS LES DEUX SENS. C'est la propriété qui fait
    // que la base ne peut pas mentir sur l'appartenance d'un secret.
    expect(codeErreur(() => openSecret(deFabel, clientB, k))).toBe('secret_decrypt_failed')
    expect(codeErreur(() => openSecret(deB, fabel, k))).toBe('secret_decrypt_failed')
  })

  it('le contexte est CANONIQUE : l\'ordre des propriétés n\'a aucun effet', () => {
    // Deux appelants décrivant le même contexte doivent produire le même AAD —
    // sinon leurs chiffrés seraient mutuellement illisibles, sans raison.
    const desordre = {
      secretVersion: 1, provider: 'anthropic', scope: 'tenant' as const,
      credentialId: 'cred_1', secretName: 'provider_api_key', workspaceId: 'ws_fabel',
    }
    expect(openSecret(scelle, desordre, k)).toBe(SECRET)
    // Et `undefined` vaut `null` : « champ absent » n'a qu'une seule écriture.
    const sansWs = sealSecret('x', { scope: 'platform', secretName: 'n' }, k)
    expect(openSecret(sansWs, { scope: 'platform', secretName: 'n', workspaceId: null, provider: null, credentialId: null, secretVersion: null }, k)).toBe('x')
  })

  it('un contexte hors nomenclature est refusé, jamais interprété', () => {
    expect(codeErreur(() => sealSecret('x', { ...CTX, scope: 'root' as any }, k))).toBe('secret_context_invalid')
    expect(codeErreur(() => sealSecret('x', { ...CTX, secretName: '  ' }, k))).toBe('secret_context_invalid')
    expect(codeErreur(() => sealSecret('x', { ...CTX, workspaceId: 42 as any }, k))).toBe('secret_context_invalid')
    expect(codeErreur(() => sealSecret('x', { ...CTX, secretVersion: 1.5 }, k))).toBe('secret_context_invalid')
    expect(codeErreur(() => sealSecret('x', { ...CTX, secretVersion: -1 }, k))).toBe('secret_context_invalid')
    // Les quatre portées prévues fonctionnent.
    for (const scope of SECRET_SCOPES) {
      expect(openSecret(sealSecret('x', { scope, secretName: 'n' }, k), { scope, secretName: 'n' }, k)).toBe('x')
    }
  })
})

// ══ I–L — ALTÉRATION DE L'ENVELOPPE ════════════════════════════════════════
describe('I–L — toute retouche fait échouer l\'authentification', () => {
  const k = trousseau('v2', ['v1', 'v2'])
  const scelle = sealSecret(SECRET, CTX, k)
  const env = parseEnvelope(scelle)

  it('I — un bit du chiffré', () => {
    const altere = retoucher(scelle, { ciphertext: bitInverse(env.ciphertext) })
    expect(codeErreur(() => openSecret(altere, CTX, k))).toBe('secret_decrypt_failed')
  })

  it('J — un bit du tag', () => {
    const altere = retoucher(scelle, { tag: bitInverse(env.tag) })
    expect(codeErreur(() => openSecret(altere, CTX, k))).toBe('secret_decrypt_failed')
  })

  it('K — un bit de l\'IV', () => {
    const altere = retoucher(scelle, { iv: bitInverse(env.iv) })
    expect(codeErreur(() => openSecret(altere, CTX, k))).toBe('secret_decrypt_failed')
  })

  it('L — le kid substitué par une AUTRE clé du trousseau', () => {
    // `v1` existe : il ne s'agit donc pas d'une clé manquante, mais d'une
    // substitution de métadonnée. Le kid étant DANS l'AAD, elle est détectée.
    const altere = retoucher(scelle, { kid: 'v1' })
    expect(codeErreur(() => openSecret(altere, CTX, k))).toBe('secret_decrypt_failed')
  })

  it('L bis — le kid substitué par une clé inconnue', () => {
    const altere = retoucher(scelle, { kid: 'v9' })
    expect(codeErreur(() => openSecret(altere, CTX, k))).toBe('secret_key_missing')
  })

  it('L ter — le kid est AUTHENTIFIÉ, pas seulement « utilisé pour choisir la clé »', () => {
    // ⚠️ CE TEST EXISTE PARCE QUE « L » NE PROUVAIT RIEN À LUI SEUL. Substituer
    // un kid change la clé, donc l'échec s'explique par la mauvaise clé, pas par
    // le liage de la tête d'enveloppe. Ici, DEUX kid partagent DÉLIBÉRÉMENT la
    // même clé : seule la présence du kid dans l'AAD peut encore détecter la
    // substitution. Sans ce liage, la retouche passerait inaperçue.
    const meme = cleTest()
    const jumeaux = parseKeyring(JSON.stringify({ currentKid: 'v1', keys: { v1: meme, v2: meme } }))
    const scelle2 = sealSecret(SECRET, CTX, jumeaux)
    expect(parseEnvelope(scelle2).kid).toBe('v1')
    expect(openSecret(scelle2, CTX, jumeaux)).toBe(SECRET)
    expect(codeErreur(() => openSecret(retoucher(scelle2, { kid: 'v2' }), CTX, jumeaux)))
      .toBe('secret_decrypt_failed')
  })

  it('l\'enveloppe n\'est pas ouvrable par un AUTRE trousseau', () => {
    const autre = trousseau('v2', ['v1', 'v2'])   // mêmes kid, autres clés
    expect(codeErreur(() => openSecret(scelle, CTX, autre))).toBe('secret_decrypt_failed')
  })
})

// ══ M–R — ENVELOPPE MALFORMÉE ══════════════════════════════════════════════
describe('M–R — l\'analyse de l\'enveloppe refuse tout écart', () => {
  const k = trousseau('v1', ['v1'])
  const scelle = sealSecret(SECRET, CTX, k)

  it('M — version d\'enveloppe inconnue → refus, jamais de déclassement', () => {
    for (const v of [0, 2, 99, '1', null, undefined]) {
      expect(codeErreur(() => openSecret(retoucher(scelle, { envelopeVersion: v }), CTX, k)))
        .toBe('secret_envelope_invalid')
    }
  })

  it('N — algorithme inconnu → refus', () => {
    // ⚠️ Un parseur indulgent ici serait une attaque par déclassement : il
    // suffirait d'annoncer un algorithme plus faible pour être servi.
    for (const a of ['A128GCM', 'A256CBC', 'none', '', null]) {
      expect(codeErreur(() => openSecret(retoucher(scelle, { alg: a }), CTX, k)))
        .toBe('secret_envelope_invalid')
    }
  })

  it('O — base64url malformé → refus, sans décodage indulgent', () => {
    // `Buffer.from(s,'base64url')` IGNORE les caractères invalides : sans
    // validation d'alphabet, « !!!! » deviendrait un tampon vide.
    for (const champ of ['iv', 'ciphertext', 'tag']) {
      for (const v of ['!!!!', 'ab cd', 'ab+cd/ef', '', null, 42]) {
        expect(codeErreur(() => openSecret(retoucher(scelle, { [champ]: v }), CTX, k)))
          .toBe('secret_envelope_invalid')
      }
    }
  })

  it('P/Q — IV et tag de longueur inattendue → refus', () => {
    for (const n of [8, 11, 13, 16, 32]) {
      if (n === IV_BYTES) continue
      expect(codeErreur(() => openSecret(retoucher(scelle, { iv: randomBytes(n).toString('base64url') }), CTX, k)))
        .toBe('secret_envelope_invalid')
    }
    for (const n of [8, 12, 15, 17, 32]) {
      if (n === TAG_BYTES) continue
      expect(codeErreur(() => openSecret(retoucher(scelle, { tag: randomBytes(n).toString('base64url') }), CTX, k)))
        .toBe('secret_envelope_invalid')
    }
  })

  it('champs manquants, JSON illisible, valeurs étrangères → refus', () => {
    for (const mauvais of ['', '{', 'null', '[]', '"texte"', '{}', JSON.stringify({ envelopeVersion: 1 })]) {
      expect(codeErreur(() => openSecret(mauvais, CTX, k))).toBe('secret_envelope_invalid')
    }
    expect(codeErreur(() => openSecret(retoucher(scelle, { kid: '' }), CTX, k))).toBe('secret_envelope_invalid')
  })

  it('R — clé inconnue du trousseau → secret_key_missing', () => {
    const autre = trousseau('vz', ['vz'])
    expect(codeErreur(() => openSecret(scelle, CTX, autre))).toBe('secret_key_missing')
  })
})

// ══ S–V — LE TROUSSEAU ═════════════════════════════════════════════════════
describe('S–V — le trousseau se valide entièrement, ou il est refusé', () => {
  it('S — une clé qui ne fait pas exactement 32 octets est refusée', () => {
    for (const n of [0, 1, 16, 31, 33, 64]) {
      const json = JSON.stringify({ currentKid: 'v1', keys: { v1: randomBytes(n).toString('base64url') } })
      expect(codeErreur(() => parseKeyring(json))).toBe('secret_keyring_invalid')
    }
    // ⚠️ Une clé courte n'est ni complétée, ni dérivée, ni étirée : un
    // chiffrement qui « a l'air » de fonctionner sur une clé faible est pire
    // qu'un refus, parce qu'il ne se remarque pas.
    const bonne = JSON.stringify({ currentKid: 'v1', keys: { v1: randomBytes(KEY_BYTES).toString('base64url') } })
    expect(keyringKids(parseKeyring(bonne))).toEqual(['v1'])
  })

  it('T — variable d\'environnement absente → fail closed', () => {
    expect(codeErreur(() => loadKeyringFromEnv({} as any))).toBe('secret_crypto_unavailable')
    expect(codeErreur(() => loadKeyringFromEnv({ [KEYRING_ENV]: '   ' } as any))).toBe('secret_crypto_unavailable')
    expect(keyringConfigured({} as any)).toBe(false)
  })

  it('U — JSON invalide → fail closed', () => {
    for (const v of ['{', 'pas du json', '[]', 'null', '"x"', '42']) {
      expect(codeErreur(() => loadKeyringFromEnv({ [KEYRING_ENV]: v } as any))).toBe('secret_keyring_invalid')
    }
  })

  it('V — currentKid absent, mal formé, ou absent de keys → fail closed', () => {
    const cle32 = randomBytes(KEY_BYTES).toString('base64url')
    const cas = [
      { keys: { v1: cle32 } },                                   // pas de currentKid
      { currentKid: 'v2', keys: { v1: cle32 } },                 // désigne le vide
      { currentKid: '', keys: { v1: cle32 } },
      { currentKid: 'V1', keys: { v1: cle32 } },                 // majuscule hors format
      { currentKid: 'v 1', keys: { 'v 1': cle32 } },             // espace
      { currentKid: 'v1', keys: {} },                            // aucune clé
      { currentKid: 'v1' },                                      // pas de keys
      { currentKid: 'v1', keys: [] },                            // keys mal typé
    ]
    for (const c of cas) {
      expect(codeErreur(() => loadKeyringFromEnv({ [KEYRING_ENV]: JSON.stringify(c) } as any)))
        .toBe('secret_keyring_invalid')
    }
    // Une variable correcte se charge : le refus n'est pas systématique.
    const bon = JSON.stringify({ currentKid: 'v1', keys: { v1: cle32 } })
    expect(loadKeyringFromEnv({ [KEYRING_ENV]: bon } as any).currentKid).toBe('v1')
    expect(keyringConfigured({ [KEYRING_ENV]: bon } as any)).toBe(true)
  })
})

// ══ W/X — GÉNÉRATIONS DE CLÉS ══════════════════════════════════════════════
describe('W/X — on chiffre avec la courante, on déchiffre avec toutes', () => {
  it('W — un nouveau scellement porte TOUJOURS currentKid', () => {
    const k = trousseau('v3', ['v1', 'v2', 'v3'])
    for (let i = 0; i < 10; i++) {
      expect(parseEnvelope(sealSecret(SECRET, CTX, k)).kid).toBe('v3')
    }
    expect(isCurrentKid(sealSecret(SECRET, CTX, k), k)).toBe(true)
  })

  it('X — un chiffré v1 reste lisible après l\'ajout de v2, et se rechiffre en v2', () => {
    // C'est la migration progressive : sans cette propriété, toute rotation
    // serait un « big bang » qui casserait tout ce qui n'a pas été réécrit.
    const base = parseKeyring(JSON.stringify({ currentKid: 'v1', keys: { v1: cleTest() } }))
    const ancien = sealSecret(SECRET, CTX, base)
    expect(parseEnvelope(ancien).kid).toBe('v1')

    // Rotation : v2 arrive et devient courante, v1 reste pour la lecture.
    const apres = parseKeyring(JSON.stringify({
      currentKid: 'v2',
      keys: {
        v1: Buffer.from(base.keys.get('v1')!).toString('base64url'),
        v2: cleTest(),
      },
    }))
    expect(openSecret(ancien, CTX, apres)).toBe(SECRET)   // toujours lisible
    expect(isCurrentKid(ancien, apres)).toBe(false)       // mais périmé

    // Rechiffrement paresseux : relire, réécrire.
    const neuf = sealSecret(openSecret(ancien, CTX, apres), CTX, apres)
    expect(parseEnvelope(neuf).kid).toBe('v2')
    expect(openSecret(neuf, CTX, apres)).toBe(SECRET)
  })
})

// ══ Y/Z — LE VERROU DE ROTATION ════════════════════════════════════════════
describe('Y/Z — aucune clé encore utilisée ne peut disparaître', () => {
  const v1 = parseKeyring(JSON.stringify({ currentKid: 'v1', keys: { v1: cleTest() } }))
  const v1v2 = parseKeyring(JSON.stringify({ currentKid: 'v2', keys: { v1: cleTest(), v2: cleTest() } }))
  const v2v3 = parseKeyring(JSON.stringify({ currentKid: 'v3', keys: { v2: cleTest(), v3: cleTest() } }))

  it('v1 → v1+v2 : aucun retrait, toujours autorisé', () => {
    expect(() => assertSafeKeyringTransition(v1, v1v2, { complete: true, referencedKids: ['v1'] })).not.toThrow()
    // Même sans inventaire : on n'enlève rien.
    expect(() => assertSafeKeyringTransition(v1, v1v2, { complete: false })).not.toThrow()
  })

  it('Y — v1+v2 → v2+v3 avec v1 ENCORE référencée → secret_rotation_unsafe', () => {
    // C'est la perte de données que le modèle naïf « courante + précédente »
    // provoque à la DEUXIÈME rotation, sans rien signaler.
    expect(codeErreur(() => assertSafeKeyringTransition(v1v2, v2v3, { complete: true, referencedKids: ['v1', 'v2'] })))
      .toBe('secret_rotation_unsafe')
    expect(codeErreur(() => assertSafeKeyringTransition(v1v2, v2v3, { complete: true, referencedKids: ['v1'] })))
      .toBe('secret_rotation_unsafe')
  })

  it('Z — v1+v2 → v2+v3 avec v1 à ZÉRO référence → autorisé', () => {
    expect(() => assertSafeKeyringTransition(v1v2, v2v3, { complete: true, referencedKids: ['v2'] })).not.toThrow()
    expect(() => assertSafeKeyringTransition(v1v2, v2v3, { complete: true, referencedKids: [] })).not.toThrow()
  })

  it('inventaire NON ÉTABLI → tout retrait est refusé', () => {
    // ⚠️ « Je ne sais pas » n'autorise pas. Un inventaire manquant n'est pas un
    // inventaire vide — c'est précisément la confusion qui avait produit le
    // fail-open de `getTokenVersion` (SEC-EXT-0.1).
    expect(codeErreur(() => assertSafeKeyringTransition(v1v2, v2v3, { complete: false })))
      .toBe('secret_rotation_unsafe')
  })

  it('le message de refus nomme la clé, jamais sa valeur', () => {
    try {
      assertSafeKeyringTransition(v1v2, v2v3, { complete: true, referencedKids: ['v1'] })
      throw new Error('aurait dû lever')
    } catch (e) {
      const msg = String((e as SecretCryptoError).message)
      expect(msg).toContain('v1')
      for (const kid of keyringKids(v1v2)) {
        expect(msg).not.toContain(Buffer.from(v1v2.keys.get(kid)!).toString('base64url'))
      }
    }
  })
})

// ══ AA/AB — FUITES ET IV ═══════════════════════════════════════════════════
describe('AA/AB — rien ne fuit, et l\'IV ne se répète pas', () => {
  it('AA — aucune erreur ni journal ne contient la clé, le clair ou le chiffré', () => {
    const cle = randomBytes(KEY_BYTES).toString('base64url')
    const k = parseKeyring(JSON.stringify({ currentKid: 'v1', keys: { v1: cle } }))
    const scelle = sealSecret(SECRET, CTX, k)
    const env = parseEnvelope(scelle)

    const journal: string[] = []
    const espion = (...a: any[]) => { journal.push(a.map(String).join(' ')) }
    const spies = (['log', 'error', 'warn', 'info'] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation(espion as any))

    const messages: string[] = []
    const echecs: Array<() => unknown> = [
      () => openSecret(scelle, { ...CTX, workspaceId: 'autre' }, k),
      () => openSecret(retoucher(scelle, { ciphertext: bitInverse(env.ciphertext) }), CTX, k),
      () => openSecret(retoucher(scelle, { tag: 'zz!!' }), CTX, k),
      () => openSecret(scelle, CTX, trousseau('v1', ['v1'])),
      () => parseKeyring(JSON.stringify({ currentKid: 'v1', keys: { v1: cle.slice(0, 10) } })),
      () => loadKeyringFromEnv({ [KEYRING_ENV]: `{"currentKid":"v1","keys":{"v1":"${cle}"` } as any),
      () => sealSecret(SECRET, { ...CTX, scope: 'inconnu' as any }, k),
    ]
    for (const f of echecs) {
      try { f() } catch (e) {
        messages.push(String((e as Error).message), String((e as Error).stack || ''))
      }
    }
    for (const s of spies) s.mockRestore()

    const tout = messages.join('\n') + '\n' + journal.join('\n')
    // Ni la clé maîtresse, ni le clair, ni le chiffré, ni le tag.
    expect(tout).not.toContain(cle)
    expect(tout).not.toContain(SECRET)
    expect(tout).not.toContain(env.ciphertext)
    expect(tout).not.toContain(env.tag)
    // Et cette couche ne journalise rien du tout.
    expect(journal).toHaveLength(0)
    // Les erreurs restent typées : aucune exception d'OpenSSL ne traverse.
    expect(messages.some((m) => /unable to authenticate|bad decrypt|Unexpected token|wrong final block/i.test(m))).toBe(false)
  })

  it('AB — 1000 scellements : aucun IV répété dans l\'échantillon', () => {
    // ⚠️ CE TEST NE PROUVE RIEN MATHÉMATIQUEMENT. Sur 96 bits d'IV, l'absence
    // de collision sur 1000 tirages est attendue et ne démontre pas la qualité
    // du générateur. Il détecte une régression GROSSIÈRE — un IV constant,
    // dérivé du contenu, ou issu d'un compteur remis à zéro — car réutiliser un
    // IV avec la même clé en GCM révèle le XOR des clairs.
    const k = trousseau('v1', ['v1'])
    const vus = new Set<string>()
    for (let i = 0; i < 1000; i++) vus.add(parseEnvelope(sealSecret(SECRET, CTX, k)).iv)
    expect(vus.size).toBe(1000)
  })
})
