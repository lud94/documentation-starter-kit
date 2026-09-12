// EVAL-RUNNER-001b — ASSEMBLAGE DU RAPPORT GOLDEN. PUR ET DÉTERMINISTE.
//
// ── LE CHEMIN DE DÉCISION UNIQUE, ET RIEN D'AUTRE ───────────────────────────
//
//     projectGoldenCase()  →  validateEvalCase()  →  runEvalCase()
//                                                        ↓
//                                                 evaluateEvidence()
//
// `expected` n'entre JAMAIS dans ce chemin. Il n'est lu qu'APRÈS le retour de
// `runEvalCase`, pour comparer. Un harness qui glisserait l'attente dans
// l'entrée mesurerait sa propre boucle.
//
// ── LES CAS BLOQUÉS NE TOUCHENT JAMAIS LE MOTEUR ────────────────────────────
// `runEvalCase` et `evaluateEvidence` ne sont appelés pour aucun cas bloqué. Le
// contrôle `blocked_case_fail_closed` vérifie le REFUS et la préservation des
// blockers — pas une sortie de moteur qui n'existe pas.
//
// ── AUCUN SCORE GLOBAL ──────────────────────────────────────────────────────
// Pas de moyenne pondérée, pas de note sur 100. Le corpus pilote porte QUATRE
// assertions fermées : un score agrégé y transformerait un échantillon en KPI
// produit, ce que ce lot existe précisément pour empêcher.
import { validateEvalCase } from './caseSchema'
import { validateGoldenCaseStructure } from './goldenSchema'
import { projectGoldenCase } from './goldenToEvalCase'
import { runEvalCase } from './runCase'
import {
  closedOracleAgreement,
  evidenceTraceability,
  forbiddenOvercallRate,
  observedOutsideOracle,
  ratio,
  requiredMissRate,
  slotsFermes,
  verifierCibleUnique,
  whyNowPresence,
  type CorpusContractError,
  type ExecutedCase,
} from './metrics'
import type { CorpusGolden } from './goldenCorpus'
import type { GoldenCase } from './goldenSchema'

export const GOLDEN_REPORT_VERSION = 'proactive-golden-report-v1'

const AVERTISSEMENT_ECHANTILLON =
  'Pilot corpus only; metrics are regression evidence, not product KPIs.'

/** Échec du contrôle fail-closed sur un cas bloqué. */
export interface FailClosedFailure {
  caseId: string
  reason: string
}

/**
 * Un cas BLOQUÉ respecte-t-il le fail-closed ?
 *
 * Deux conditions CUMULATIVES, chacune DÉLÉGUÉE à son propriétaire :
 *
 *   1. `validateGoldenCaseStructure` — cohérence des blockers avec les causes
 *      que les claims imposent, à l'identité complète près
 *      `(kind, rawEvidenceId, claimIndex)`, exception `EXPECTATION_AMBIGUOUS`
 *      comprise. Ce module NE REFAIT PAS ce calcul.
 *   2. `projectGoldenCase` — le refus de projection : le moteur ne doit jamais
 *      tourner sur un cas dont on sait le jeu de faits incomplet.
 *
 * ⚠️ AUCUNE RÈGLE N'EST RÉÉCRITE ICI. Une seconde implémentation de la même
 * invariante ne la renforce pas : elle crée une seconde source de vérité, qui
 * dérivera de la première le jour où l'une des deux sera corrigée seule.
 *
 * ⚠️ CE CONTRÔLE EST VOLONTAIREMENT REDONDANT DANS LA CLI. `chargerCorpusGolden`
 * a déjà soumis chaque cas à `validateGoldenCaseStructure` et écarté ceux qui
 * échouent. La redondance est assumée : elle rend le rapport auto-portant — un
 * lecteur y voit l'invariante affirmée, sans avoir à croire le chargeur sur
 * parole — et elle protège `construireRapport` d'un appelant qui, lui, ne
 * passerait pas par le chargeur.
 */
function verifierFailClosed(golden: GoldenCase): FailClosedFailure | null {
  const structure = validateGoldenCaseStructure(golden)
  if (structure.ok === false) {
    return {
      caseId: golden.caseId,
      reason: structure.errors.map((e) => `[${e.code}] ${e.path} — ${e.message}`).join(' | '),
    }
  }

  const projection = projectGoldenCase(golden)
  if (projection.ok === true) {
    return {
      caseId: golden.caseId,
      reason:
        'La projection a RÉUSSI sur un cas bloqué : le moteur pourrait être exécuté sur un jeu ' +
        'de faits que l’on sait incomplet.',
    }
  }

  return null
}

export interface GoldenReport {
  reportVersion: string
  corpus: {
    datasetPath: string
    datasetSha256: string
    replayNow: string | null
    integrity: {
      ok: boolean
      problems: CorpusGolden['problemes']
    }
  }
  sample: {
    goldenCases: number
    executableCases: number
    blockedCases: number
    closedExecutableAssertions: number
    requiredAssertions: number
    forbiddenAssertions: number
    warning: string
  }
  contractErrors: CorpusContractError[]
  metrics: {
    closed_oracle_agreement: ReturnType<typeof ratio>
    required_miss_rate: ReturnType<typeof ratio>
    forbidden_overcall_rate: ReturnType<typeof ratio>
    blocked_case_fail_closed: ReturnType<typeof ratio>
  }
  slots: ReturnType<typeof slotsFermes>
  observed_outside_oracle: ReturnType<typeof observedOutsideOracle>
  integrityControls: {
    evidence_traceability: ReturnType<typeof evidenceTraceability>
    why_now_presence: ReturnType<typeof whyNowPresence>
    golden_corpus_integrity: { ok: boolean; casesValidated: number }
    blocked_fail_closed_failures: FailClosedFailure[]
  }
}

/**
 * Construit le rapport complet à partir d'un corpus DÉJÀ chargé.
 *
 * ⚠️ AUCUNE I/O ICI. `chargerCorpusGolden` a lu le disque ; cette fonction ne
 * fait que calculer. Aucune horloge système non plus : le temps de rejeu vient
 * d'`assumptions.now.value`, projeté dans l'`EvalCase`.
 */
export function construireRapport(corpus: CorpusGolden): GoldenReport {
  const contractErrors: CorpusContractError[] = []
  const executes: ExecutedCase[] = []
  const failClosedFailures: FailClosedFailure[] = []

  let executables = 0
  let bloques = 0

  for (const { golden } of corpus.cas) {
    // ── LIMITE ASSUMÉE : une seule cible ─────────────────────────────────
    const multi = verifierCibleUnique(golden)
    if (multi) {
      contractErrors.push(multi)
      continue
    }

    if (golden.executability !== 'EXECUTABLE') {
      bloques += 1
      const echec = verifierFailClosed(golden)
      if (echec) failClosedFailures.push(echec)
      // ⚠️ Aucun appel à `runEvalCase` / `evaluateEvidence` ici. Jamais.
      continue
    }

    executables += 1

    // ── LE CHEMIN DE DÉCISION UNIQUE ─────────────────────────────────────
    const projection = projectGoldenCase(golden)
    if (projection.ok === false) {
      contractErrors.push({
        caseId: golden.caseId,
        code: 'golden_metric_projection_failed',
        message: projection.reason,
      })
      continue
    }

    const validation = validateEvalCase(projection.evalCase)
    if (validation.ok === false) {
      contractErrors.push({
        caseId: golden.caseId,
        code: 'golden_metric_evalcase_invalid',
        message: validation.errors.map((e) => `${e.path}: ${e.code}`).join(' | '),
      })
      continue
    }

    executes.push({ golden, output: runEvalCase(validation.case) })
  }

  executes.sort((a, b) =>
    a.golden.caseId < b.golden.caseId ? -1 : a.golden.caseId > b.golden.caseId ? 1 : 0,
  )

  const slots = slotsFermes(executes)
  const requis = slots.filter((s) => s.assertion === 'REQUIRED').length
  const interdits = slots.filter((s) => s.assertion === 'FORBIDDEN').length

  const failClosedOk = bloques - failClosedFailures.length

  const premier = corpus.cas[0]?.golden

  return {
    reportVersion: GOLDEN_REPORT_VERSION,
    corpus: {
      datasetPath: corpus.artefact.path,
      datasetSha256: corpus.artefact.sha256,
      // Le temps de rejeu vient du corpus, jamais de l'horloge machine.
      replayNow: premier?.assumptions?.now?.value ?? null,
      integrity: { ok: corpus.problemes.length === 0, problems: corpus.problemes },
    },
    sample: {
      goldenCases: corpus.cas.length,
      executableCases: executables,
      blockedCases: bloques,
      closedExecutableAssertions: slots.length,
      requiredAssertions: requis,
      forbiddenAssertions: interdits,
      warning: AVERTISSEMENT_ECHANTILLON,
    },
    contractErrors,
    metrics: {
      closed_oracle_agreement: closedOracleAgreement(slots),
      required_miss_rate: requiredMissRate(slots),
      forbidden_overcall_rate: forbiddenOvercallRate(slots),
      blocked_case_fail_closed: ratio(
        failClosedOk,
        bloques,
        'HIGHER_IS_BETTER',
        corpus.cas
          .filter(
            (c) =>
              c.golden.executability !== 'EXECUTABLE' &&
              !failClosedFailures.some((f) => f.caseId === c.caseId),
          )
          .map((c) => c.caseId),
        failClosedFailures.map((f) => f.caseId),
      ),
    },
    slots,
    observed_outside_oracle: observedOutsideOracle(executes),
    integrityControls: {
      evidence_traceability: evidenceTraceability(executes),
      why_now_presence: whyNowPresence(executes),
      golden_corpus_integrity: {
        ok: corpus.problemes.length === 0,
        casesValidated: corpus.cas.length,
      },
      blocked_fail_closed_failures: [...failClosedFailures].sort((a, b) =>
        a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0,
      ),
    },
  }
}

/**
 * Sérialisation STABLE.
 *
 * Le tri des clés rend la sortie byte-identique d'une exécution à l'autre, quel
 * que soit l'ordre d'insertion interne. Le formatage humain — pourcentages,
 * couleurs — vit HORS de ce cœur : un `"50%"` dans le JSON empêcherait toute
 * comparaison automatique.
 */
export function serializeGoldenReport(rapport: GoldenReport): string {
  return JSON.stringify(rapport, triCles, 2) + '\n'
}

function triCles(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>
    const trie: Record<string, unknown> = {}
    for (const cle of Object.keys(source).sort()) trie[cle] = source[cle]
    return trie
  }
  return value
}
