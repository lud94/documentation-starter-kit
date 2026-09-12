// EVAL-RUNNER-001b — CLI DU HARNESS GOLDEN.
//
//   npm run proactive:golden
//
// ── POURQUOI UNE SECONDE CLI, ET NON UNE OPTION DE LA PREMIÈRE ──────────────
// `npm run proactive:eval` a un contrat arrêté : UN fichier de cas → UN
// `EvalOutput`. Y greffer un mode « corpus » changerait la signification de sa
// sortie selon un drapeau, et casserait tout appelant qui la redirige déjà vers
// un fichier. Deux outils, deux contrats, aucun des deux ambigu.
//
// ── CE QUE CE PROCESSUS NE FAIT PAS ─────────────────────────────────────────
// Aucun réseau, aucune base, aucun LLM, aucune persistance, aucune action
// métier, aucune horloge système. Il lit `fixtures/golden/`, écrit sur stdout,
// écrit sur stderr. Le temps de rejeu vient d'`assumptions.now.value`.
//
// ── DISCIPLINE DES FLUX ─────────────────────────────────────────────────────
// stdout ne reçoit QUE le JSON du rapport. Tout diagnostic part sur stderr avec
// un code de sortie non nul — sans quoi `npm run proactive:golden > rapport.json`
// produirait un fichier mêlant mesure et erreur.
//
// ⚠️ UNE MÉTRIQUE ROUGE N'EST PAS UNE ERREUR. Le processus sort en 0 tant que le
// corpus est intègre et le contrat respecté : mesurer un moteur imparfait est le
// TRAVAIL de cet outil, pas sa panne. Seuls un corpus corrompu ou une violation
// de contrat produisent un code non nul.
import { chargerCorpusGolden } from '../lib/prospector/proactive/eval/goldenCorpus.ts'
import {
  construireRapport,
  serializeGoldenReport,
} from '../lib/prospector/proactive/eval/report.ts'

/** Codes de sortie DISTINCTS : un script appelant doit pouvoir les distinguer. */
const EXIT = {
  OK: 0,
  CORPUS_INVALID: 6,
  CONTRACT_ERROR: 7,
  UNEXPECTED: 8,
}

function echec(code, titre, details) {
  process.stderr.write(`proactive:golden — ${titre}\n`)
  for (const ligne of details) process.stderr.write(`  ${ligne}\n`)
  process.exit(code)
}

const racine = process.cwd()

let rapport
try {
  const corpus = chargerCorpusGolden(racine)
  rapport = construireRapport(corpus)
} catch (e) {
  echec(EXIT.UNEXPECTED, 'échec inattendu du harness.', [
    e?.message ?? String(e),
    'Prérequis : Node >= 22.15 (exécution TypeScript native).',
    `Node détecté : ${process.version}.`,
  ])
}

if (!rapport.corpus.integrity.ok) {
  echec(
    EXIT.CORPUS_INVALID,
    'corpus Golden non intègre — aucune métrique n’est publiée.',
    rapport.corpus.integrity.problems.map(
      (p) => `${p.fichier} [${p.code}] ${p.message}`,
    ),
  )
}

if (rapport.contractErrors.length > 0) {
  echec(
    EXIT.CONTRACT_ERROR,
    'violation du contrat de corpus — aucune métrique n’est publiée.',
    rapport.contractErrors.map((e) => `${e.caseId} [${e.code}] ${e.message}`),
  )
}

process.stdout.write(serializeGoldenReport(rapport))
process.exit(EXIT.OK)
