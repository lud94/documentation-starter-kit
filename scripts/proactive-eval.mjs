// EVAL-RUNNER-001a — CLI DU RUNNER OFFLINE.
//
//   npm run proactive:eval -- chemin/vers/cas.json
//
// ── CE QUE CE PROCESSUS NE FAIT PAS ─────────────────────────────────────────
// Aucun réseau, aucune base, aucun CRM, aucun LLM, aucune persistance, aucune
// action métier. Il ne touche `persistEvaluation()` d'aucune façon. Ses seules
// entrées/sorties sont : lire UN fichier, écrire sur stdout, écrire sur stderr.
//
// ── DISCIPLINE DES FLUX ─────────────────────────────────────────────────────
// stdout ne reçoit QUE le JSON de résultat, et seulement en cas de succès.
// Toute erreur part sur stderr avec un code de sortie non nul. C'est ce qui
// permet `npm run proactive:eval -- cas.json > sortie.json` sans qu'un
// diagnostic vienne polluer le fichier — et surtout ce qui empêche qu'une
// évaluation partielle soit prise pour un résultat valide.
// ── PRÉREQUIS D'EXÉCUTION ───────────────────────────────────────────────────
// Cette commande exige **Node ≥ 22.6** (`--experimental-strip-types`, pour
// exécuter le TypeScript du dépôt sans le compiler) et **Node ≥ 22.15**
// (`module.registerHooks`, utilisé par `./ts-resolve-hook.mjs`).
//
// C'est une exigence de CET OUTIL, pas du produit : `npm test`, `npm run build`
// et `npm run typecheck` n'en dépendent en rien, et le contrat d'exécution de
// Prospector est inchangé. Sur un Node plus ancien la commande échoue
// immédiatement sur le drapeau inconnu — bruyamment, jamais en silence.
//
// Aucune dépendance npm n'a été ajoutée pour cela : `tsx`/`ts-node` ne sont pas
// déclarés dans ce dépôt, et `esbuild` n'y est présent que comme dépendance
// TRANSITIVE de Vitest.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateEvalCase } from '../lib/prospector/proactive/eval/caseSchema.ts'
import { runEvalCase, serializeEvalOutput } from '../lib/prospector/proactive/eval/runCase.ts'

/** Codes de sortie DISTINCTS : un script appelant doit pouvoir les distinguer. */
const EXIT = {
  OK: 0,
  USAGE: 2,
  UNREADABLE: 3,
  JSON_INVALID: 4,
  CASE_INVALID: 5,
}

function echec(code, titre, details) {
  process.stderr.write(`proactive:eval — ${titre}\n`)
  for (const ligne of details) process.stderr.write(`  ${ligne}\n`)
  process.exit(code)
}

const chemin = process.argv[2]

if (!chemin) {
  echec(EXIT.USAGE, 'aucun fichier de cas fourni.', [
    'Usage : npm run proactive:eval -- chemin/vers/cas.json',
    'Prérequis : Node >= 22.15 (exécution TypeScript native).',
    `Node détecté : ${process.version}.`,
  ])
}

let brut
try {
  brut = readFileSync(resolve(chemin), 'utf8')
} catch (error) {
  echec(EXIT.UNREADABLE, `fichier illisible : ${chemin}`, [String(error && error.message)])
}

let donnees
try {
  donnees = JSON.parse(brut)
} catch (error) {
  // Un JSON invalide n'est jamais « réparé » : le fichier est refusé en bloc.
  echec(EXIT.JSON_INVALID, `JSON invalide : ${chemin}`, [String(error && error.message)])
}

const validation = validateEvalCase(donnees)

if (!validation.ok) {
  echec(
    EXIT.CASE_INVALID,
    `cas invalide (${validation.errors.length} erreur(s)) : ${chemin}`,
    validation.errors.map((e) => `[${e.code}] ${e.path} — ${e.message}`),
  )
}

// Succès : stdout ne contient que le résultat.
process.stdout.write(serializeEvalOutput(runEvalCase(validation.case)))
process.exit(EXIT.OK)
