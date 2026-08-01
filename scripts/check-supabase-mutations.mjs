#!/usr/bin/env node
// Garde-fou CI — aucune mutation Supabase directe hors des modules autorisés.
//
// POURQUOI. Le contrat d'environnement (lib/env.ts, `writeAllowed()`) et
// l'isolation par espace de travail (lib/supabase/leads.ts) ne protègent que le
// code qui passe par la couche de persistance. Un `sb.from(...).upsert(...)`
// écrit ailleurs contourne les deux silencieusement. Ce contrôle rend cette
// introduction visible en revue, il ne la rend pas impossible.
//
// CE QU'IL N'EST PAS. Ce n'est pas une analyse sémantique : il lit du texte.
// Il détecte les chaînes `.from(...)` suivies d'une méthode de mutation, et
// tout `.rpc(`. Un appel construit dynamiquement (`sb[m](...)`) lui échappe.
// C'est un filet, pas une preuve.
//
// Usage : node scripts/check-supabase-mutations.mjs   (sortie 1 si violation)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SCANNED = ['lib', 'pages', 'components', 'scripts']
const EXT = /\.(ts|tsx|mjs|js)$/

// ─── Liste d'exceptions explicite ────────────────────────────────────────────
// Toute entrée ajoutée ici doit être justifiée en revue. Une exception non
// commentée est un défaut de revue, pas une configuration.
const ALLOWED = new Set([
  // Couche de persistance : seuls modules autorisés à muter. Chacun applique
  // `writeAllowed()` avant écriture (lot A2).
  'lib/supabase/leads.ts',
  'lib/supabase/store.ts',
  'lib/supabase/settings.ts',
  'lib/supabase/workspaces.ts',
  'lib/supabase/pappersCache.ts',

  // ⚠️ DÉROGATION CONNUE — écrit `prospector_settings` sans passer par
  // lib/supabase/settings.ts (route de diagnostic de persistance). À supprimer
  // ou à faire passer par le module lors d'un lot ultérieur ; référencée ici
  // pour que la dérogation soit visible plutôt que tacite.
  'pages/api/config/persistence-test.ts',
])

// Les tests d'intégration manipulent délibérément la base locale (préparation
// et nettoyage des cas). Ils ne s'exécutent que contre `supabase start`.
const ALLOWED_PREFIXES = ['tests/integration/']

// ─── Détection ───────────────────────────────────────────────────────────────
const MUTATIONS = ['insert', 'upsert', 'update', 'delete']
// Fenêtre d'analyse après un `.from(` : couvre les chaînes écrites sur
// plusieurs lignes sans avaler le reste du fichier.
const CHAIN_WINDOW = 400

function stripNoise(src) {
  // Commentaires seulement : les littéraux de chaîne sont conservés, un
  // `.from()` en chaîne de caractères reste préférable à signaler qu'à manquer.
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
            .replace(/\/\/[^\n]*/g, '')
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

function findViolations(file, raw) {
  const src = stripNoise(raw)
  const out = []

  // 1. Chaînes `.from(...)` → méthode de mutation.
  const fromRe = /\.from\s*\(/g
  let m
  while ((m = fromRe.exec(src))) {
    const chain = src.slice(m.index, m.index + CHAIN_WINDOW)
    // La chaîne s'arrête au premier point-virgule ou à la ligne vide suivante.
    const end = Math.min(
      ...[chain.indexOf(';'), chain.indexOf('\n\n')].filter((i) => i >= 0).concat([chain.length]),
    )
    const scope = chain.slice(0, end)
    for (const verb of MUTATIONS) {
      if (new RegExp(`\\.${verb}\\s*\\(`).test(scope)) {
        out.push({ line: lineOf(src, m.index), what: `.from(...).${verb}()` })
        break
      }
    }
  }

  // 2. Appels de procédure : toujours une écriture potentielle, aucun contexte
  //    `.from()` pour les rattacher à une table.
  const rpcRe = /\.rpc\s*\(/g
  while ((m = rpcRe.exec(src))) out.push({ line: lineOf(src, m.index), what: '.rpc()' })

  return out.map((v) => ({ ...v, file }))
}

// ─── Parcours ────────────────────────────────────────────────────────────────
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

const files = SCANNED.flatMap((d) => walk(join(ROOT, d)))
  .concat(walk(join(ROOT, 'tests')))

const violations = []
for (const full of files) {
  const rel = relative(ROOT, full).split(sep).join('/')
  if (ALLOWED.has(rel) || ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
  if (rel === 'scripts/check-supabase-mutations.mjs') continue // ce fichier décrit les motifs
  violations.push(...findViolations(rel, readFileSync(full, 'utf8')))
}

if (violations.length === 0) {
  console.log(`OK — aucune mutation Supabase hors des ${ALLOWED.size} modules autorisés (${files.length} fichiers analysés).`)
  process.exit(0)
}

console.error('Mutation Supabase directe hors des modules autorisés :\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`)
console.error(`
${violations.length} occurrence(s). Deux issues possibles :
  • faire passer l'écriture par un module de lib/supabase/ (il applique
    writeAllowed() et, pour les leads, l'isolation par espace de travail) ;
  • si la dérogation est délibérée, l'ajouter à ALLOWED dans
    scripts/check-supabase-mutations.mjs AVEC sa justification.
`)
process.exit(1)
