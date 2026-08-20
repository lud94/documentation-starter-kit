#!/usr/bin/env node
// Garde-fou CI — aucun contexte système hors de la liste blanche (lot MT-0).
//
// POURQUOI. Le contexte système contourne l'imputation à un espace client :
// une dépense qui l'emprunte n'est facturable à personne. Le type force déjà un
// tenant à chaque site d'appel, et `systemTenant()` refuse une étiquette non
// listée — mais rien n'empêcherait un chemin métier d'appeler `systemTenant()`
// avec une étiquette valide pour se soustraire à l'imputation.
//
// CE QU'IL N'EST PAS. Il lit du texte. Un appel construit dynamiquement lui
// échappe. C'est un filet qui rend l'ajout VISIBLE en revue, pas une preuve.
//
// Usage : node scripts/check-tenant-context.mjs   (sortie 1 si violation)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tolererDisparitionDeFixture } from './lib/transient-fixtures.mjs'

const ROOT = process.cwd()
const SCANNED = ['lib', 'pages', 'components']
const EXT = /\.(ts|tsx)$/

// ─── Fichiers autorisés à ouvrir un contexte système ─────────────────────────
// Toute addition ici doit être justifiée en revue : elle crée un chemin de
// dépense non imputable à un client. Un chemin MÉTIER n'y a pas sa place.
const ALLOWED = new Set([
  'lib/prospector/tenant.ts',              // définit le contexte et sa liste blanche
  'pages/api/ai/diagnose.ts',              // sondes de capacité, Admin uniquement
])

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const full = join(dir, name)
    // Une fixture de test peut disparaître ENTRE l'énumération et ce `stat`.
    const st = tolererDisparitionDeFixture(relative(ROOT, full).split(sep).join('/'), () => statSync(full))
    if (!st.present) continue
    if (st.valeur.isDirectory()) walk(full, acc)
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
  // La fixture reste ANALYSÉE si elle est là ; seule sa disparition est tolérée.
  const lu = tolererDisparitionDeFixture(rel, () => readFileSync(full, 'utf8'))
  if (!lu.present) continue
  const src = lu.valeur
  src.split('\n').forEach((line, i) => {
    if (/\bsystemTenant\s*\(/.test(line) && !line.trim().startsWith('//')) {
      violations.push({ file: rel, line: i + 1, what: 'systemTenant()' })
    }
    // Un tenant fabriqué à la main court-circuite les deux résolveurs.
    if (/\bkind:\s*'system'/.test(line) && !line.trim().startsWith('//')) {
      violations.push({ file: rel, line: i + 1, what: "kind: 'system' littéral" })
    }
  })
}

if (violations.length === 0) {
  console.log(`OK — aucun contexte système hors des ${ALLOWED.size} fichiers autorisés (${scanned} fichiers analysés).`)
  process.exit(0)
}

console.error('Contexte système ouvert hors de la liste blanche :\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`)
console.error(`
${violations.length} occurrence(s). Deux issues possibles :
  • résoudre un VRAI espace client (resolveTenantFromRequest ou
    tenantFromVerifiedWorkspace) — c'est le cas de tout chemin métier ;
  • si le chemin est réellement système, l'ajouter à ALLOWED dans
    scripts/check-tenant-context.mjs AVEC sa justification, et référencer son
    étiquette dans SYSTEM_TAGS (lib/prospector/tenant.ts).
`)
process.exit(1)
