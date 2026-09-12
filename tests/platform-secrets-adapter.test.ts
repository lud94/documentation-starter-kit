// SEC-SECRETS-0C.1.1 — L'INCERTITUDE N'EST JAMAIS UNE ABSENCE.
//
// ── POURQUOI CE FICHIER EXISTE SÉPARÉMENT ───────────────────────────────────
// `tests/platform-vault.test.ts` SIMULE l'adaptateur pour éprouver le coffre.
// Il ne peut donc rien prouver de l'adaptateur lui-même. Ici c'est l'inverse :
// l'adaptateur est RÉEL, et c'est le client Supabase qui est simulé — le seul
// montage qui permette de produire à volonté les quatre issues d'une lecture.
//
// ── LE DÉFAUT AUDITÉ (D1) ───────────────────────────────────────────────────
// `readPlatformSecretRow()` rendait `null` pour quatre situations distinctes :
// requête réussie sans ligne, Supabase non câblé, erreur de transport ou de
// permission, ligne structurellement invalide. Une seule signifie « il n'y a
// rien » ; les trois autres signifient « je ne sais pas ». Un futur
// `mfaEnabled()` écrit comme `status === 'active'` aurait donc désactivé le
// second facteur pendant une panne réseau — fail-open sur l'authentification.
import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Ce que le faux client Supabase doit répondre au prochain appel. */
let REPONSE: { data: any; error: any } = { data: null, error: null }
/** `null` simule « Supabase non configuré ». */
let CLIENT_PRESENT = true
/** Simule une exception jetée par le transport (fetch mort, JSON illisible…). */
let JETTE = false
let REPONSE_LISTE: { data: any; error: any } = { data: [], error: null }

function requete(final: () => { data: any; error: any }) {
  // Chaînable comme supabase-js : `.select().eq().maybeSingle()` et
  // `.select().not()`. `then` est fourni pour la forme awaitable directe.
  const chaine: any = {
    select: () => chaine,
    eq: () => chaine,
    not: () => Promise.resolve(REPONSE_LISTE),
    limit: () => chaine,
    maybeSingle: async () => {
      if (JETTE) throw new Error('transport mort')
      return final()
    },
  }
  return chaine
}

vi.mock('../lib/supabase/client', () => ({
  supabaseConfigured: () => CLIENT_PRESENT,
  supabase: () => (CLIENT_PRESENT ? { from: () => requete(() => REPONSE) } : null),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

import { readPlatformSecret, referencedPlatformKidsRaw } from '../lib/supabase/platformSecrets'

const LIGNE_VALIDE = {
  secret_name: 'admin_totp_secret',
  envelope: '{"envelopeVersion":1,"alg":"A256GCM","kid":"k1","iv":"a","ciphertext":"b","tag":"c"}',
  kid: 'k1',
  secret_version: 2,
  status: 'active',
}

beforeEach(() => {
  CLIENT_PRESENT = true
  JETTE = false
  REPONSE = { data: null, error: null }
  REPONSE_LISTE = { data: [], error: null }
})

describe('A. Les quatre issues d\'une lecture sont quatre issues distinctes', () => {
  it('CAS A — requête réussie, aucune ligne ⇒ `absent`, et rien d\'autre ne l\'est', async () => {
    REPONSE = { data: null, error: null }
    expect(await readPlatformSecret('admin_totp_secret')).toEqual({ kind: 'absent' })
  })

  it('CAS B — Supabase non configuré ⇒ erreur, JAMAIS `absent`', async () => {
    CLIENT_PRESENT = false
    const r = await readPlatformSecret('admin_totp_secret')
    expect(r).toEqual({ kind: 'error', reason: 'storage_unconfigured' })
    expect(r.kind).not.toBe('absent')
  })

  it('CAS C — erreur de requête ou de permission ⇒ `storage_error`, JAMAIS `absent`', async () => {
    // Forme exacte d'un refus PostgREST : `data` nul ET `error` posée. C'est ce
    // couple qui ressemblait trait pour trait à une absence.
    REPONSE = { data: null, error: { code: '42501', message: 'permission denied for table prospector_platform_secrets' } }
    const r = await readPlatformSecret('admin_totp_secret')
    expect(r).toEqual({ kind: 'error', reason: 'storage_error' })
    expect(r.kind).not.toBe('absent')
  })

  it('CAS C bis — exception de transport ⇒ `storage_error`', async () => {
    JETTE = true
    expect(await readPlatformSecret('admin_totp_secret')).toEqual({ kind: 'error', reason: 'storage_error' })
  })

  it('CAS D — ligne présente mais invalide ⇒ `invalid_row`, JAMAIS `absent`', async () => {
    const invalides: any[] = [
      { ...LIGNE_VALIDE, status: 'inconnu' },
      { ...LIGNE_VALIDE, secret_version: 0 },
      { ...LIGNE_VALIDE, secret_version: 'deux' },
      { ...LIGNE_VALIDE, secret_name: 'anthropic_api_key' },
      // active sans enveloppe : la base l'interdit, mais une base mal migrée non.
      { ...LIGNE_VALIDE, envelope: null, kid: null },
      // pierre tombale qui porte encore une enveloppe : incohérence de contenu.
      { ...LIGNE_VALIDE, status: 'revoked' },
    ]
    for (const data of invalides) {
      REPONSE = { data, error: null }
      const r = await readPlatformSecret('admin_totp_secret')
      expect(r, JSON.stringify(data)).toEqual({ kind: 'error', reason: 'invalid_row' })
    }
  })

  it('ligne valide ⇒ `found` avec la ligne projetée', async () => {
    REPONSE = { data: LIGNE_VALIDE, error: null }
    expect(await readPlatformSecret('admin_totp_secret')).toEqual({
      kind: 'found',
      row: {
        secretName: 'admin_totp_secret',
        envelope: LIGNE_VALIDE.envelope,
        kid: 'k1',
        secretVersion: 2,
        status: 'active',
      },
    })
  })

  it('pierre tombale valide ⇒ `found`, pas `absent` — elle AFFIRME l\'absence', async () => {
    REPONSE = { data: { ...LIGNE_VALIDE, envelope: null, kid: null, status: 'revoked', secret_version: 3 }, error: null }
    const r = await readPlatformSecret('admin_totp_secret')
    expect(r.kind).toBe('found')
    expect(r.kind === 'found' && r.row.status).toBe('revoked')
  })

  it('un nom hors des trois est une erreur, pas une absence', async () => {
    expect(await readPlatformSecret('anthropic_api_key' as any)).toEqual({ kind: 'error', reason: 'invalid_row' })
  })
})

describe('B. Aucune erreur brute ne franchit l\'adaptateur', () => {
  it('un message SQL portant l\'enveloppe et un DETAIL ne ressort pas', async () => {
    // Reproduction fidèle de ce que PostgreSQL joint à une violation de CHECK :
    // la ligne fautive, enveloppe comprise.
    const brut = {
      code: '23514',
      message: 'new row for relation "prospector_platform_secrets" violates check constraint',
      details: 'Failing row contains (admin_totp_secret, {"kid":"k1","ciphertext":"SECRET-EN-CHIFFRE"}, k1, 1, active).',
      hint: 'un indice interne',
    }
    REPONSE = { data: null, error: brut }
    const r = await readPlatformSecret('admin_totp_secret')

    expect(r).toEqual({ kind: 'error', reason: 'storage_error' })
    const serialise = JSON.stringify(r)
    expect(serialise).not.toContain('Failing row')
    expect(serialise).not.toContain('SECRET-EN-CHIFFRE')
    expect(serialise).not.toContain('23514')
    expect(serialise).not.toContain('indice interne')
    // Aucune clef de propagation d'erreur ne survit à la frontière.
    expect(Object.keys(r).sort()).toEqual(['kind', 'reason'])
  })
})

describe('C. Inventaire des kid — aucune incertitude ne devient complete:true', () => {
  it('lecture RÉUSSIE sans aucune ligne ⇒ complete:true, ensemble vide', async () => {
    REPONSE_LISTE = { data: [], error: null }
    expect(await referencedPlatformKidsRaw()).toEqual({ complete: true, kids: [] })
  })

  it('lecture réussie ⇒ kid dédupliqués', async () => {
    REPONSE_LISTE = { data: [{ kid: 'k1' }, { kid: 'k2' }, { kid: 'k1' }], error: null }
    expect(await referencedPlatformKidsRaw()).toEqual({ complete: true, kids: ['k1', 'k2'] })
  })

  it('Supabase non configuré ⇒ complete:false', async () => {
    CLIENT_PRESENT = false
    expect(await referencedPlatformKidsRaw()).toEqual({ complete: false })
  })

  it('erreur de requête ⇒ complete:false, jamais une liste vide', async () => {
    REPONSE_LISTE = { data: null, error: { code: '42501', message: 'permission denied' } }
    expect(await referencedPlatformKidsRaw()).toEqual({ complete: false })
  })

  it('ligne malformée ⇒ complete:false — on ne devine pas un kid', async () => {
    for (const data of [[{ kid: null }], [{ kid: 42 }], [{ kid: '' }], [{ autre: 'x' }], [{ kid: 'k1' }, { kid: null }]]) {
      REPONSE_LISTE = { data, error: null }
      expect(await referencedPlatformKidsRaw(), JSON.stringify(data)).toEqual({ complete: false })
    }
  })

  it('réponse non tabulaire ⇒ complete:false', async () => {
    REPONSE_LISTE = { data: { kid: 'k1' } as any, error: null }
    expect(await referencedPlatformKidsRaw()).toEqual({ complete: false })
  })
})
