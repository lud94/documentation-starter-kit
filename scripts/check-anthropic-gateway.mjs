#!/usr/bin/env node
// Garde-fou CI — un seul point d'appel vers Anthropic.
//
// POURQUOI. Le garde-fou budgétaire (lib/prospector/llm.ts) ne protège que les
// appels qui passent par la passerelle. Un `fetch('https://api.anthropic.com/…')`
// écrit ailleurs dépense sans plafond et sans comptage, silencieusement — c'était
// exactement le cas de pages/api/ai/diagnose.ts avant le lot C2a-0.
//
// Ce contrôle lit du texte : un appel construit dynamiquement lui échappe. C'est
// un filet, pas une preuve.
//
// Usage : node scripts/check-anthropic-gateway.mjs   (sortie 1 si violation)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SCANNED = ['lib', 'pages', 'components', 'scripts', 'tests']
const EXT = /\.(ts|tsx|mjs|js)$/
const HOST = 'api.anthropic.com'

// ─── Liste d'exceptions explicite ────────────────────────────────────────────
// Une seule entrée, et c'est le but : la passerelle. Toute addition ici rouvre
// le trou que ce contrôle existe pour fermer — elle doit être justifiée en revue.
const ALLOWED = new Set([
  'lib/prospector/llm.ts',                  // anthropicPost() — la passerelle
  'scripts/check-anthropic-gateway.mjs',    // ce fichier décrit le motif
])

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (EXT.test(name)) acc.push(full)
  }
  return acc
}

const violations = []
let scanned = 0
for (const full of SCANNED.flatMap((d) => walk(join(ROOT, d)))) {
  const rel = relative(ROOT, full).split(sep).join('/')
  if (ALLOWED.has(rel)) continue
  scanned++
  const src = readFileSync(full, 'utf8')
  src.split('\n').forEach((line, i) => {
    if (line.includes(HOST)) violations.push({ file: rel, line: i + 1 })
  })
}

if (violations.length === 0) {
  console.log(`OK — aucun appel Anthropic hors passerelle (${scanned} fichiers analysés).`)
  process.exit(0)
}

console.error('Appel Anthropic hors de la passerelle unique :\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}`)
console.error(`
${violations.length} occurrence(s). Passer par anthropicPost() ou callClaude()
(lib/prospector/llm.ts) : c'est le seul point où le plafond budgétaire et le
comptage de consommation s'appliquent.
`)
process.exit(1)
