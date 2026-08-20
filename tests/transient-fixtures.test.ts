// TEST-ROBUST-03 — LES GARDES SURVIVENT AUX FIXTURES QUI S'ÉVAPORENT.
//
// ── LA COURSE ────────────────────────────────────────────────────────────────
// Un garde parcourt le dépôt en trois temps — `readdir`, `stat`, `readFile` —
// et plusieurs centaines de millisecondes séparent le premier du dernier.
// Pendant ce temps, un AUTRE fichier de test, exécuté en parallèle par Vitest,
// dépose puis supprime sa fixture dans une racine scannée. Le garde énumère un
// chemin qui n'existe plus quand il y arrive : `ENOENT`.
//
// Observé : le garde des mutations Supabase tombant sur
// `lib/__sec_log_01_tmp__.ts`. La course est SYMÉTRIQUE — le garde des
// frontières d'erreur peut tout aussi bien tomber sur
// `lib/__check_robust_01_tmp__/fixture.ts`.
//
// ── CE QUI EST VÉRIFIÉ ICI ───────────────────────────────────────────────────
// La tolérance est DOUBLEMENT BORNÉE, et les deux bornes comptent autant :
//
//   • un `ENOENT` sur une fixture réservée est toléré ;
//   • un `ENOENT` sur un fichier source normal REMONTE ;
//   • une fixture PRÉSENTE reste analysée normalement — elle n'est pas exclue du
//     scan. Cette dernière propriété est tenue par les suites existantes, qui
//     déposent des fixtures fautives et exigent un refus ; voir la note avant le
//     bloc D.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  estFixtureTransitoire,
  tolererDisparitionDeFixture,
} from '../scripts/lib/transient-fixtures.mjs'

function disparu(code = 'ENOENT') {
  const e: any = new Error('boom')
  e.code = code
  return e
}

describe('A. Le nom réservé identifie les fixtures, et rien d\'autre', () => {
  it('reconnaît les deux fixtures réellement utilisées dans le dépôt', () => {
    expect(estFixtureTransitoire('lib/__sec_log_01_tmp__.ts')).toBe(true)
    expect(estFixtureTransitoire('lib/__check_robust_01_tmp__/fixture.ts')).toBe(true)
  })

  it('ne reconnaît AUCUN fichier source réel', () => {
    for (const chemin of [
      'lib/prospector/capabilities.ts',
      'lib/prospector/leadKind.ts',
      'lib/observability/safeError.ts',
      'pages/api/leads/index.ts',
      'lib/__init__.ts',          // doubles tirets bas, mais pas le suffixe
      'lib/tmp.ts',               // « tmp », mais pas le nom réservé
      'lib/__sec_log_01_tmp.ts',  // un seul tiret bas final
      'lib/sec_log_01_tmp__.ts',  // pas de préfixe
    ]) {
      expect(estFixtureTransitoire(chemin), chemin).toBe(false)
    }
  })
})

describe('B. La tolérance est bornée aux deux extrémités', () => {
  it('une fixture évanouie rend « absente », sans lever', () => {
    const r = tolererDisparitionDeFixture('lib/__sec_log_01_tmp__.ts', () => {
      throw disparu()
    })
    expect(r.present).toBe(false)
  })

  // ⚠️ LA BORNE QUI COMPTE LE PLUS. Un fichier source qui disparaît en cours de
  // scan est un fait anormal — dépôt réécrit, `checkout` concurrent, disque
  // défaillant. Le taire ferait passer un garde pour vert alors qu'il n'a rien
  // analysé.
  it('un ENOENT sur un fichier SOURCE remonte tel quel', () => {
    expect(() =>
      tolererDisparitionDeFixture('lib/prospector/capabilities.ts', () => {
        throw disparu()
      }),
    ).toThrow('boom')
  })

  it('une erreur NON-ENOENT remonte, même sur une fixture', () => {
    expect(() =>
      tolererDisparitionDeFixture('lib/__sec_log_01_tmp__.ts', () => {
        throw disparu('EACCES')
      }),
    ).toThrow('boom')
  })

  it('un accès qui réussit rend sa valeur', () => {
    expect(tolererDisparitionDeFixture('lib/x.ts', () => 42)).toEqual({
      present: true,
      valeur: 42,
    })
  })
})

// ── POURQUOI AUCUN TEST ICI NE DÉPOSE DE FIXTURE FAUTIVE ─────────────────────
//
// La contrainte inverse de la tolérance est essentielle : une fixture PRÉSENTE
// doit rester analysée, faute de quoi les tests qui en déposent une pour prouver
// qu'un garde REFUSE deviendraient incapables d'échouer — une course échangée
// contre un test mort.
//
// Cette propriété est déjà tenue, et de la seule façon qui vaille : par les
// suites existantes elles-mêmes. `tests/check-supabase-mutations.test.ts` et
// `tests/sec-log-01-residuals.test.ts` déposent des fixtures fautives et exigent
// un REFUS. Exclure les chemins réservés du scan les ferait toutes virer au vert
// — vérifié : le mutant correspondant en casse huit.
//
// Un test de plus ici serait redondant, et surtout NUISIBLE : déposer une
// fixture fautive pendant que ces suites tournent en parallèle ferait échouer
// leurs assertions de verdict propre. Ce serait recréer, depuis ce fichier
// même, la course que le lot corrige.

describe('D. Chaque garde corrigé va au bout de son parcours', () => {
  // ⚠️ CE BLOC N'ASSERTE PAS « le dépôt est propre ». Il ne le peut pas : d'autres
  // fichiers de test, exécutés en parallèle, déposent légitimement des fixtures
  // fautives dans les racines scannées. Un garde qui les REFUSE à cet instant
  // fait exactement son travail — l'assertion « OK » serait donc elle-même une
  // course, et c'est la faute que ce lot corrige, pas celle qu'il commet.
  //
  // Ce qui est vérifié est ce dont ce lot répond : le parcours va à son terme,
  // sans jamais casser sur un accès au système de fichiers. Le verdict de
  // sécurité sur un arbre stable, lui, est couvert par `npm run check:*`.
  for (const script of [
    'scripts/check-supabase-mutations.mjs',
    'scripts/check-error-boundary.mjs',
    'scripts/check-anthropic-gateway.mjs',
    'scripts/check-tenant-context.mjs',
  ]) {
    it(`${script} ne casse jamais sur un accès fichier`, () => {
      let sortie: string
      try {
        sortie = execFileSync('node', [script], { cwd: process.cwd(), encoding: 'utf8' })
      } catch (err: any) {
        sortie = String(err.stdout || '') + String(err.stderr || '')
        // Un refus (code 1) est un verdict ; un plantage n'en est pas un.
        expect(err.status, sortie).toBe(1)
      }
      expect(sortie, sortie).not.toContain('ENOENT')
      expect(sortie, sortie).not.toContain('Error: ')
    })
  }
}, 20_000)
