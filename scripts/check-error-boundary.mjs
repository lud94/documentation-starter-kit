#!/usr/bin/env node
// Garde-fou CI — SEC-LOG-01. AUCUN CONTENU D'ERREUR NE FRANCHIT UNE FRONTIÈRE.
//
// POURQUOI. Le lot SEC-LOG-01 a fermé une chaîne complète : réponse d'un
// fournisseur → `Error.message` → `console.error` et corps de réponse HTTP. La
// correction tient tant que personne ne réintroduit le motif — or il est
// spontané : interpoler `e.message` dans un log est le premier réflexe de
// débogage, et rien dans le langage ne signale que ce message peut porter un
// fragment de prompt ou une ligne de base.
//
// CE QU'IL N'EST PAS. Ce n'est pas une analyse sémantique : il lit du texte. Un
// message passé par une variable intermédiaire lui échappe. C'est un filet, pas
// une preuve — la preuve est dans `tests/sec-log-01-*.test.ts`.
//
// Usage : node scripts/check-error-boundary.mjs   (sortie 1 si violation)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tolererDisparitionDeFixture } from './lib/transient-fixtures.mjs'

const ROOT = process.cwd()
const SCANNED = ['lib', 'pages', 'components']
const EXT = /\.(ts|tsx|mjs|js)$/

// ─── Exceptions explicites ───────────────────────────────────────────────────
// Toute entrée ajoutée ici doit être justifiée en revue.
const ALLOWED = new Set([
  // Le module d'assainissement lui-même : c'est LUI qui décide ce qui sort. Il
  // ne lit jamais `message`, et ses propres tests le prouvent contre neuf formes
  // de valeurs jetées.
  'lib/observability/safeError.ts',
])

// Les tests manipulent délibérément des messages porteurs de canaris : c'est
// leur objet même. Les inclure produirait un échec permanent qui ferait
// désactiver le garde.
const ALLOWED_PREFIXES = ['tests/']

// ─── Motifs interdits ────────────────────────────────────────────────────────
//
// ⚠️ Cette liste vise des FORMES SYNTAXIQUES de propagation, pas des mots
// « sensibles ». On n'essaie pas de deviner ce qu'un texte contient — on
// interdit les gestes qui laissent un texte non maîtrisé franchir une frontière.
const MOTIFS = [
  {
    id: 'log_error_message',
    // console.error(..., e.message) — sous toutes ses formes usuelles.
    re: /console\.(?:error|warn|log|info|debug)\s*\([^)]*\b(?:e|err|error|ex|exception)\s*\??\.\s*message\b/,
    quoi: 'message d\'exception journalisé',
  },
  {
    id: 'log_stringify_error',
    re: /console\.(?:error|warn|log|info|debug)\s*\([^)]*JSON\.stringify\s*\(\s*(?:e|err|error|ex|exception)\b/,
    quoi: 'exception sérialisée dans un journal',
  },
  {
    id: 'log_string_error',
    re: /console\.(?:error|warn|log|info|debug)\s*\([^)]*\bString\s*\(\s*(?:e|err|error|ex|exception)\s*\)/,
    quoi: 'String(erreur) journalisé',
  },
  {
    id: 'http_error_message',
    // res.json({ error: e.message }) et variantes.
    re: /\.(?:json|send)\s*\([^)]*\b(?:e|err|error|ex|exception)\s*\??\.\s*message\b/,
    quoi: 'message d\'exception renvoyé au client',
  },
  {
    id: 'http_string_error',
    re: /\.(?:json|send)\s*\([^)]*\bString\s*\(\s*(?:e|err|error|ex|exception)\s*\)/,
    quoi: 'String(erreur) renvoyé au client',
  },
  {
    id: 'http_stack',
    // Une pile d'exécution n'a jamais sa place dans une réponse.
    re: /\.(?:json|send)\s*\([^)]*\bstack\b/,
    quoi: 'pile d\'exécution exposée au client',
  },
  {
    id: 'throw_provider_body',
    // throw new Error(`… ${res.status} … ${body|text} …`) — le motif d'origine.
    re: /throw\s+new\s+Error\s*\([^)]*\$\{[^}]*\b(?:body|text|responseBody|payload)\b[^}]*\}/,
    quoi: 'corps de réponse fournisseur dans un Error',
  },
  {
    id: 'throw_await_text',
    re: /throw\s+new\s+Error\s*\([^)]*await\s+\w+\.text\s*\(\s*\)/,
    quoi: 'corps de réponse (await .text()) dans un Error',
  },
]

function fichiers(dir) {
  const out = []
  let entrees
  try { entrees = readdirSync(dir) } catch { return out }
  for (const nom of entrees) {
    if (nom === 'node_modules' || nom === '.next' || nom.startsWith('.')) continue
    const chemin = join(dir, nom)
    // Une fixture de test peut disparaître ENTRE l'énumération et ce `stat`.
    const st = tolererDisparitionDeFixture(relative(ROOT, chemin).split(sep).join('/'), () => statSync(chemin))
    if (!st.present) continue
    if (st.valeur.isDirectory()) out.push(...fichiers(chemin))
    else if (EXT.test(nom)) out.push(chemin)
  }
  return out
}

/**
 * Retire commentaires et littéraux de chaîne avant analyse.
 *
 * Sans ce dépouillement, un fichier qui DOCUMENTE l'interdiction — « ne jamais
 * journaliser `e.message` » — se dénoncerait lui-même. Le garde deviendrait alors
 * une raison de ne pas écrire de commentaires, ce qui serait un mauvais échange.
 */
function codeSeul(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n')
    .replace(/\/\/[^\n]*/g, '')
}

const violations = []
let analyses = 0

for (const racine of SCANNED) {
  for (const chemin of fichiers(join(ROOT, racine))) {
    const rel = relative(ROOT, chemin).split(sep).join('/')
    if (ALLOWED.has(rel)) continue
    if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue

    // ⚠️ La fixture est bien ANALYSÉE si elle est là — elle n'est pas exclue du
    // scan. Seule sa disparition en cours de route est tolérée.
    const src = tolererDisparitionDeFixture(rel, () => readFileSync(chemin, 'utf8'))
    if (!src.present) continue

    analyses++
    const lignes = codeSeul(src.valeur).split('\n')

    lignes.forEach((ligne, i) => {
      for (const motif of MOTIFS) {
        if (motif.re.test(ligne)) {
          violations.push({ rel, ligne: i + 1, motif: motif.id, quoi: motif.quoi, extrait: ligne.trim().slice(0, 120) })
        }
      }
    })
  }
}

if (violations.length) {
  console.error(`\n✖ ${violations.length} frontière(s) d'erreur non assainie(s) :\n`)
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.ligne}  [${v.motif}] ${v.quoi}`)
    console.error(`    ${v.extrait}`)
  }
  console.error(
    '\nUtiliser lib/observability/safeError.ts :'
    + '\n  • journaux  → logSafeError(tag, e, { provider, operation })'
    + '\n  • réponse   → PUBLIC_ERROR (message public déterministe)'
    + '\n  • stockage  → storageFailure(e) (code de classe, jamais le texte)'
    + '\n  • throw     → new ProviderError({ code, provider, operation, status })\n',
  )
  process.exit(1)
}

console.log(`OK — aucune frontière d'erreur non assainie (${analyses} fichiers analysés).`)
