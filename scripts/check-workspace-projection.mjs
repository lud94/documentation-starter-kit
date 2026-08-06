#!/usr/bin/env node
// Garde-fou CI — isolation des espaces clients (lot SEC-0).
//
// POURQUOI. `GET /api/workspaces` a rendu la liste globale des espaces à tout
// client authentifié, parce que le branchement de méthode précédait le garde
// admin. La correction est d'une ligne ; sa DURABILITÉ ne l'est pas. Ce script
// vérifie deux propriétés que la relecture laisse passer :
//
//   1. toute route sous pages/api/workspaces/ appelle `isAdminRequest` ou
//      lit `claims.role` — donc décide quelque chose du rôle ;
//   2. aucune de ces routes ne sérialise un objet d'espace en bloc.
//
// CE QU'IL N'EST PAS. Il lit du texte. Il ne prouve pas que le garde est placé
// AVANT le branchement, ni que la projection est complète — ce sont les tests
// qui le font. Il rend l'ajout d'une route non gardée VISIBLE en revue.
//
// Usage : node scripts/check-workspace-projection.mjs   (sortie 1 si violation)

// ── SEC-0b : plus aucun repli sur « admin » sur un chemin métier ─────────────
// Second volet. Trois formes ont été supprimées des routes métier :
//   claims?.ws || 'admin'          un client sans espace lisait celui de l'admin
//   !claims || role === 'admin'    une requête SANS session valait admin
//   cookie ps_active_ws non vérifié  un espace inexistant ou suspendu passait
// Elles sont interdites partout sous pages/api, hors liste blanche.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const DIR = join(ROOT, 'pages', 'api', 'workspaces')
const API = join(ROOT, 'pages', 'api')
const EXT = /\.(ts|tsx)$/

// Formes de repli « admin ». Volontairement textuelles et étroites : le but est
// de rendre une réapparition VISIBLE en revue, pas d'analyser des flux.
const FALLBACK = [
  { re: /\bclaims\s*\??\.\s*ws\s*\|\|\s*['"]admin['"]/, what: "repli `claims.ws || 'admin'`" },
  { re: /!\s*claims\s*\|\|[^\n]*['"]admin['"]/, what: '`!claims` traité comme admin' },
  { re: /ACTIVE_WS_COOKIE\s*\]\s*\|\|\s*['"]admin['"]/, what: "cookie d'espace actif non vérifié" },
  { re: /\bcookies\s*\??\.\s*\[\s*['"]ps_active_ws['"]\s*\]\s*\|\|\s*['"]admin['"]/, what: "cookie d'espace actif non vérifié" },
]

// Seuls fichiers autorisés à décider d'un espace « admin » sans le résolveur.
// `active.ts` EST le sélecteur : il lit le cookie par définition, et sa branche
// admin le republie sans l'imposer à une lecture de données.
const FALLBACK_ALLOWED = new Set([
  'pages/api/workspaces/active.ts',
])

// Sérialisation en bloc : la ligne, ou l'objet serveur, part tel quel. C'est le
// pattern qui publierait `credential_ref` (SEC-1) ou `budget_micros` (MT-1) le
// jour où ils existeront, sans que personne ne l'ait décidé.
const BULK = [
  { re: /\.\.\.\s*(ws|w|workspace|row|r)\b/, what: 'copie en bloc (...objet)' },
  { re: /json\s*\(\s*\{[^}]*\b(workspaces?|ws)\s*:\s*(await\s+)?(listWorkspaces|getWorkspaceById)\s*\(/, what: 'liste/ligne rendue sans projection' },
  { re: /select\s*\(\s*['"`]\*/, what: "select('*') dans une route d'espace" },
]

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (EXT.test(name)) acc.push(full)
  }
  return acc
}

const violations = []
const files = walk(DIR)
for (const full of files) {
  const rel = relative(ROOT, full).split(sep).join('/')
  const src = readFileSync(full, 'utf8')
  const lines = src.split('\n')

  // 1. La route décide-t-elle quelque chose du rôle ?
  if (!/\bisAdminRequest\s*\(/.test(src) && !/claims[?.]*\.role/.test(src)) {
    violations.push({ file: rel, line: 1, what: 'aucun contrôle de rôle (isAdminRequest / claims.role)' })
  }

  // 2. Sérialisation en bloc.
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
    for (const b of BULK) {
      if (b.re.test(line)) violations.push({ file: rel, line: i + 1, what: b.what })
    }
  })
}

// ── Volet SEC-0b : aucun repli « admin » sous pages/api ─────────────────────
const apiFiles = walk(API)
for (const full of apiFiles) {
  const rel = relative(ROOT, full).split(sep).join('/')
  if (FALLBACK_ALLOWED.has(rel)) continue
  readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    for (const f of FALLBACK) {
      if (f.re.test(line)) violations.push({ file: rel, line: i + 1, what: f.what })
    }
  })
}

if (violations.length === 0) {
  console.log(
    `OK — ${files.length} routes d'espace projettent explicitement ; `
    + `aucun repli « admin » dans les ${apiFiles.length} routes d'API.`,
  )
  process.exit(0)
}

console.error('Isolation des espaces clients — violations :\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`)
console.error(`
${violations.length} occurrence(s). Rappel du contrat SEC-0 :
  • une route d'espace décide du rôle AVANT de brancher sur la méthode ;
  • un objet d'espace ne part jamais tel quel vers le navigateur — il passe par
    une vue de lib/prospector/workspaceView.ts, dont les champs sont énumérés ;
  • une route métier authentifiée résout son espace avec
    resolveTenantFromRequest (lib/prospector/tenant.ts) et REFUSE sur null.
    « admin » est un espace métier réel, jamais une valeur de secours.
`)
process.exit(1)
