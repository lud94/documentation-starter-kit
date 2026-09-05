// CHECK-ROBUST-01 — LE SCANNER DE MUTATIONS SUPABASE, ÉPROUVÉ.
//
// ── LES DEUX DÉFAUTS FERMÉS ─────────────────────────────────────────────────
//
// 1. `.from(` N'APPARTIENT PAS À SUPABASE. C'est aussi le constructeur statique
//    de plusieurs globales du langage. `Array.from(store.entries())` suivi, plus
//    bas, d'un `store.delete(k)` ressemble alors trait pour trait à
//    `sb.from('t').delete()`.
//
// 2. LE TERMINATEUR DE CHAÎNE ÉTAIT AVEUGLE AU FORMAT WINDOWS. La chaîne
//    analysée s'arrêtait à la première ligne vide, cherchée comme `\n\n` — une
//    séquence qui n'apparaît JAMAIS dans un fichier CRLF, où une ligne vide
//    s'écrit `\r\n\r\n`. La fenêtre s'étendait donc sur 400 caractères et
//    raccrochait le `.from(` à une méthode sans rapport.
//
//    Conséquence : le garde rendait un verdict DIFFÉRENT selon la plateforme —
//    vert sous Linux, rouge sous PowerShell, sur un dépôt identique. Un contrôle
//    de sécurité dont le résultat dépend du `core.autocrlf` de qui l'exécute
//    n'est pas un contrôle.
//
// ⚠️ CE FICHIER NE CONTIENT AUCUN MOTIF LITTÉRAL SURVEILLÉ. Le scanner analyse
// aussi `tests/`, et il conserve délibérément les littéraux de chaîne : y écrire
// `sb.from('x').delete()` en clair ferait échouer le garde sur son propre test.
// Les fixtures sont donc COMPOSÉES à l'exécution.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const DOSSIER = 'lib/__check_robust_01_tmp__'
const F = `fr${'om'}`      // jamais le littéral, pour ne pas se dénoncer
const R = `rp${'c'}`       // idem : `.rpc(` est lui aussi un motif surveillé

function lancer(): { code: number; sortie: string } {
  try {
    const sortie = execFileSync('node', ['scripts/check-supabase-mutations.mjs'], {
      cwd: process.cwd(), encoding: 'utf8',
    })
    return { code: 0, sortie }
  } catch (err: any) {
    return { code: err.status ?? 1, sortie: String(err.stdout || '') + String(err.stderr || '') }
  }
}

/** Dépose une fixture, lance le garde, nettoie quoi qu'il arrive. */
function verdictPour(source: string, finDeLigne: '\n' | '\r\n' = '\n'): { code: number; sortie: string } {
  mkdirSync(DOSSIER, { recursive: true })
  try {
    writeFileSync(`${DOSSIER}/fixture.ts`, source.replace(/\n/g, finDeLigne), 'utf8')
    return lancer()
  } finally {
    rmSync(DOSSIER, { recursive: true, force: true })
  }
}

describe('A. Le motif du faux positif est ACCEPTÉ', () => {
  // Reproduction fidèle de `tests/reminder-runner.test.ts:103` : un
  // `Array.from()` multiligne, puis un `.delete()` sur une Map, plus bas.
  const ARRAY_FROM = `
export function balayer(store: Map<string, any>, prefix: string) {
  for (const [k, value] of Array.${F}(
    store.entries(),
  )) {
    if (!k.startsWith(prefix)) continue
    if (value?.expired) {
      store.delete(k)
    }
  }
}
`

  it('Array.from(...) puis store.delete(...) — LF', () => {
    const r = verdictPour(ARRAY_FROM, '\n')
    expect(r.sortie, r.sortie).toContain('OK')
    expect(r.code).toBe(0)
  })

  // ⚠️ LE CAS QUI ÉCHOUAIT. Même source, fins de ligne Windows.
  it('Array.from(...) puis store.delete(...) — CRLF (le cas PowerShell)', () => {
    const r = verdictPour(ARRAY_FROM, '\r\n')
    expect(r.sortie, r.sortie).toContain('OK')
    expect(r.code).toBe(0)
  })

  // ⚠️ TIMEOUT LOCAL À 15 s (TEST-ROBUST-02) — CE CAS SEUL.
  //
  // Il est le seul du fichier à lancer QUATRE fois le scanner : un processus
  // `node` complet par globale, chacun relisant les ~200 fichiers du dépôt.
  // Isolé il tient en ~2,4 s ; sous la contention CPU du `npm test` complet il
  // monte à ~7,5 s et dépassait la limite par défaut de 5 s.
  //
  // Le défaut est celui du BUDGET, pas du scanner ni des assertions : l'échec
  // dépendait de la charge de la machine, donc de qui exécutait la suite. Les
  // quatre cas sont conservés — les réduire échangerait de la couverture réelle
  // contre du temps d'exécution.
  it('les autres globales à `.from` statique sont écartées de même', () => {
    for (const global of ['Buffer', 'Uint8Array', 'Object', 'String']) {
      const src = `
export function f(store: Map<string, any>) {
  const x = ${global}.${F}(store.entries() as any)
  store.delete('k')
  return x
}
`
      const r = verdictPour(src)
      expect(r.sortie, `${global} : ${r.sortie}`).toContain('OK')
    }
  }, 15_000)
})

describe('B. Les vraies mutations Supabase restent REFUSÉES', () => {
  const MUTATIONS = ['delete', 'update', 'insert', 'upsert']

  for (const verbe of MUTATIONS) {
    it(`sb.from('x').${verbe}(...) sur une seule ligne`, () => {
      const src = `export async function f(sb: any) { await sb.${F}('x').${verbe}({ a: 1 }) }\n`
      const r = verdictPour(src)
      expect(r.code, r.sortie).toBe(1)
      expect(r.sortie).toContain(verbe)
    })
  }

  // ⚠️ NON-RÉGRESSION DE CAPACITÉ. Le correctif ne doit pas rendre le garde
  // aveugle aux chaînes écrites sur plusieurs lignes — la forme la plus
  // courante dans ce dépôt.
  it('chaîne MULTILIGNE — LF', () => {
    const src = `
export async function f(sb: any) {
  const { error } = await sb
    .${F}('prospector_leads')
    .update({ data: {} })
    .eq('id', 'x')
  return error
}
`
    const r = verdictPour(src, '\n')
    expect(r.code, r.sortie).toBe(1)
    expect(r.sortie).toContain('update')
  })

  it('chaîne MULTILIGNE — CRLF (le verdict ne dépend plus de la plateforme)', () => {
    const src = `
export async function f(sb: any) {
  const { error } = await sb
    .${F}('prospector_leads')
    .delete()
    .eq('id', 'x')
  return error
}
`
    const r = verdictPour(src, '\r\n')
    expect(r.code, r.sortie).toBe(1)
    expect(r.sortie).toContain('delete')
  })

  it('un appel de procédure reste refusé', () => {
    const src = `export async function f(sb: any) { await sb.${R}('prospector_ai_bump', { p: 1 }) }\n`
    const r = verdictPour(src)
    expect(r.code, r.sortie).toBe(1)
    expect(r.sortie).toContain(`.${R}()`)
  })
})

describe('C. Le dépôt lui-même passe', () => {
  it('aucune violation sur l\'arbre courant', () => {
    const r = lancer()
    expect(r.sortie, r.sortie).toContain('OK')
    expect(r.code).toBe(0)
  })
})
