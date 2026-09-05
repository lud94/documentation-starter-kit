// FACTUAL_MEMORY_TEST_HARNESS_001 — CLI DU HARNAIS DE MÉMOIRE FACTUELLE.
//
//   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs \
//        scripts/factual-harness.mjs <cas> [--json] [--verbose] [--memory] \
//        [--input fichier.json] [--cleanup]
//
// (ou : npm run factual:test -- <cas> ; ou : .\scripts\factual-test.ps1 <cas>)
//
// ── PRÉREQUIS ───────────────────────────────────────────────────────────────
// Node ≥ 22.15 (strip-types + registerHooks), comme `proactive:eval`. Aucune
// dépendance npm ajoutée. Persistance : Supabase LOCAL détecté par ses
// variables d'environnement (les valeurs ne sont jamais imprimées) ; sans base
// locale, le mode par défaut rend BLOCKED — `--memory` est le mode unitaire
// EXPLICITE, annoncé comme non persistant.
//
// ── DRAPEAUX DE FONCTIONNALITÉ ──────────────────────────────────────────────
// SIGNAL_ARCH_V1_SOURCE_ASSERTIONS et SIGNAL_ARCH_V1_CANONICAL_FACTS sont
// activés POUR CE PROCESSUS UNIQUEMENT, ci-dessous, avant tout import du
// pipeline. Aucun fichier .env n'est modifié, rien n'est persisté, Vercel
// n'est pas touché.
//
// ── CODES DE SORTIE ─────────────────────────────────────────────────────────
//   0 = PASS   1 = FAIL fonctionnel   2 = BLOCKED (environnement/prérequis)
//   3 = entrée manuelle / cas invalide
//
// ── CYCLE DE VIE (FACTUAL_MEMORY_TEST_HARNESS_RUNTIME_FIX_001) ──────────────
// AUCUN `process.exit()` : après un travail asynchrone contre la vraie base,
// des poignées libuv (sockets keep-alive de supabase-js) sont encore en cours
// de fermeture, et `process.exit()` les tue en plein vol — c'est l'assertion
// Windows `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c) observée
// au premier run réel. On pose `process.exitCode` et on laisse Node fermer
// ses poignées naturellement.
process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS = process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS || '1'
process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS = process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS || '1'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, INVALID_INPUT: 3 }

async function main() {

  const args = process.argv.slice(2)
  const drapeau = (nom) => args.includes(nom)
  const valeurDe = (nom) => {
    const i = args.indexOf(nom)
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined
  }
  const cas = args.find((a) => !a.startsWith('--') && a !== valeurDe('--input'))

  const { runFactualCase, cleanupHarnessWorkspace, HARNESS_CASES } =
    await import('../lib/prospector/proactive/harness/factualHarness.ts')

  if (drapeau('--cleanup')) {
    const r = await cleanupHarnessWorkspace()
    if (r.ok === false) { console.error(`CLEANUP BLOCKED — ${r.reason}`); return EXIT.BLOCKED }
    console.log(`CLEANUP OK — ${r.deleted} enregistrement(s) supprimé(s) de l'espace du harnais`)
    return EXIT.PASS
  }

  if (!cas || cas === 'help') {
    console.error('Usage : factual-test <cas> [--json] [--verbose] [--memory] [--input fichier.json]')
    console.error(`Cas    : ${Object.keys(HARNESS_CASES).join(', ')}, manual, --cleanup`)
    return EXIT.INVALID_INPUT
  }

  let manualCase
  if (cas === 'manual') {
    const fichier = valeurDe('--input')
    if (!fichier) { console.error('MANUAL_INVALID: --input fichier.json requis'); return EXIT.INVALID_INPUT }
    try {
      manualCase = JSON.parse(readFileSync(resolve(fichier), 'utf8'))
    } catch (e) {
      console.error(`MANUAL_INVALID: fichier illisible ou JSON invalide (${e?.code ?? 'parse'})`)
      return EXIT.INVALID_INPUT
    }
  }

  const resultat = await runFactualCase(cas, { allowMemory: drapeau('--memory'), manualCase })

  if (drapeau('--json')) {
    console.log(JSON.stringify(resultat, null, 2))
    return EXIT[resultat.verdict] ?? EXIT.FAIL
  }

  // ── SORTIE HUMAINE ──────────────────────────────────────────────────────────
  const ligne = '='.repeat(50)
  const champ = (nom, valeur) => `${(nom + ' ').padEnd(22, '.')} ${valeur}`
  console.log(ligne)
  console.log('PROSPECTOR FACTUAL MEMORY TEST')
  console.log(`CASE: ${resultat.caseName.toUpperCase()}`)
  if (resultat.environment) {
    console.log(`ENVIRONMENT: ${resultat.environment.environment} (${resultat.environment.mode})`)
    console.log(`WORKSPACE: ${resultat.environment.workspace}`)
    console.log(`DATABASE: ${resultat.environment.database}`)
    console.log(`SOURCE_ASSERTIONS: ${resultat.environment.sourceAssertions}`)
    console.log(`CANONICAL_FACTS: ${resultat.environment.canonicalFacts}`)
  }
  console.log(ligne)
  if (resultat.reason) console.log(`REASON ................ ${resultat.reason}`)
  if (resultat.input && Object.keys(resultat.input).length > 0) {
    console.log('\nINPUT')
    console.log(champ('Company', resultat.input.company ?? '-'))
    console.log(champ('Account', resultat.input.account ?? '-'))
    for (const s of resultat.input.sources ?? []) console.log(champ('Source', s))
  }
  if (resultat.steps.length > 0) {
    console.log('\nPIPELINE')
    for (const s of resultat.steps) {
      console.log(champ(s.name, (s.ok ? 'PASS' : 'FAIL') + (s.detail ? ` — ${s.detail}` : '')))
    }
  }
  if (resultat.table) {
    console.log('\nDAY          OPENINGS   METHOD                ASSERTION                              SNAPSHOT')
    for (const r of resultat.table) {
      console.log(`${String(r.day).padEnd(12)} ${String(r.openings).padEnd(10)} ${String(r.method).padEnd(21)} ${String(r.assertion).padEnd(38)} ${r.snapshot}`)
    }
  }
  if (resultat.persisted.length > 0) {
    console.log('\nPERSISTED (relu et vérifié)')
    const parKind = new Map()
    for (const p of resultat.persisted) parKind.set(p.kind, (parKind.get(p.kind) ?? 0) + 1)
    for (const [k, n] of parKind) console.log(champ(k, n))
    if (drapeau('--verbose')) for (const p of resultat.persisted) console.log(`  ${p.kind}  ${p.id}  ${p.summary}`)
  }
  console.log('')
  console.log(champ('VERDICT', resultat.verdict))
  console.log(ligne)
  return EXIT[resultat.verdict] ?? EXIT.FAIL
}

// ⚠️ `exitCode`, jamais `exit()` — voir l'en-tête. Le code 0/1/2/3 est préservé.
process.exitCode = await main()
