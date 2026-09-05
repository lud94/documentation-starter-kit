// EVAL-RUNNER-001b — MÉTRIQUES GOLDEN. FONCTIONS PURES.
//
// ── CE MODULE MESURE, IL NE CALIBRE PAS ─────────────────────────────────────
// Une métrique rouge est un RÉSULTAT. Ce n'est pas une autorisation de modifier
// un seuil, une famille, un EvidenceType ou une assertion Golden pour la rendre
// verte. Le harness observe le moteur ; il ne le corrige jamais.
//
// ── LE MODÈLE DE SLOT ───────────────────────────────────────────────────────
// Tout se mesure sur des SLOTS D'ASSERTION :
//
//     (caseId, SituationType)  →  REQUIRED | FORBIDDEN | UNSPECIFIED
//
// Jamais sur le texte d'un `rationale`, jamais sur un `behavior` historique,
// jamais sur le NOMBRE d'objets Situation produits. Un moteur qui produirait
// trois `space_contraction` pour un slot REQUIRED satisfait ce slot une fois :
// l'oracle porte sur la PRÉSENCE d'un type, pas sur un décompte.
//
// ── `UNSPECIFIED` N'EST PAS UN NÉGATIF ──────────────────────────────────────
// C'est une ABSTENTION EXPLICITE. Elle ne compte ni comme correcte, ni comme
// incorrecte, ni comme vrai négatif. Une Situation produite sur un slot
// `UNSPECIFIED` est enregistrée SANS NOTE dans `observed_outside_oracle` — la
// traiter comme un faux positif reviendrait à inventer un oracle que personne
// n'a signé.
//
// ── AUCUNE RÉIMPLÉMENTATION DU MOTEUR ───────────────────────────────────────
// Ni seuil, ni famille, ni fraîcheur, ni contradiction, ni éligibilité, ni
// logique de recommandation. Ce module reçoit un `EvalOutput` DÉJÀ produit par
// `runEvalCase` → `evaluateEvidence`, et le compare aux attentes APRÈS coup.
import type { GoldenCase, SituationAssertion } from './goldenSchema'
import type { EvalOutput } from './runCase'

/** Sens de lecture d'un ratio. Un rapport sans direction est illisible. */
export type MetricDirection = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER'

/**
 * Contrat de ratio — TOUJOURS accompagné de ses comptes bruts.
 *
 * ⚠️ `ratio` vaut `null` lorsque le dénominateur est nul. Jamais `100%`, jamais
 * `NaN`, jamais `Infinity` : sur un corpus pilote, « 100 % » sans dénominateur
 * est la façon la plus efficace de faire passer deux cas pour une preuve.
 */
export interface MetricRatio {
  numerator: number
  denominator: number
  ratio: number | null
  direction: MetricDirection
  supportingCaseIds: string[]
  failingCaseIds: string[]
}

export function ratio(
  numerator: number,
  denominator: number,
  direction: MetricDirection,
  supportingCaseIds: string[],
  failingCaseIds: string[],
): MetricRatio {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
    direction,
    supportingCaseIds: [...supportingCaseIds].sort(),
    failingCaseIds: [...failingCaseIds].sort(),
  }
}

/** Un slot d'assertion fermé, tel qu'il sera noté. */
export interface ClosedSlot {
  caseId: string
  situationType: string
  assertion: Exclude<SituationAssertion, 'UNSPECIFIED'>
  /** La Situation de ce type a-t-elle été produite par le moteur ? */
  produced: boolean
  correct: boolean
}

export interface OutsideOracleObservation {
  caseId: string
  situationType: string
}

export interface TraceabilityFailure {
  caseId: string
  situationId: string
  evidenceId: string
  reason: 'empty' | 'unknown'
}

export interface WhyNowFailure {
  caseId: string
  recommendationId: string
}

/** Le résultat d'exécution d'UN cas exécutable, déjà obtenu du kernel. */
export interface ExecutedCase {
  golden: GoldenCase
  output: EvalOutput
}

/** Erreur de contrat de corpus — pas une métrique, un refus. */
export interface CorpusContractError {
  caseId: string
  code: string
  message: string
}

const MULTI_TARGET =
  'golden_metric_multi_target_unsupported'

/**
 * `expected.situations` n'est PAS adressé par cible.
 *
 * ⚠️ Les sept cas pilotes ont exactement une cible chacun, et c'est la seule
 * raison pour laquelle un slot `(caseId, SituationType)` suffit. Le jour où un
 * cas Golden portera deux cibles, « quelle cible cette attente concerne-t-elle »
 * n'aura plus de réponse déductible — et deviner serait pire que refuser.
 *
 * C'est une LIMITE DU HARNESS, pas une demande de changement du kernel.
 */
export function verifierCibleUnique(golden: GoldenCase): CorpusContractError | null {
  const n = golden.executionContext?.targets?.length ?? 0
  if (n === 1) return null
  return {
    caseId: golden.caseId,
    code: MULTI_TARGET,
    message:
      `Le cas porte ${n} cible(s). Les attentes Golden ne sont pas adressées par cible : ` +
      'le harness refuse de deviner à quelle cible une attente s’applique.',
  }
}

/** Types de Situation réellement produits par le moteur pour ce cas. */
function typesProduits(output: EvalOutput): Set<string> {
  return new Set(output.situations.map((s) => s.type))
}

/**
 * Extrait les slots FERMÉS d'un cas exécuté et les note.
 *
 *     REQUIRED  + présent   → correct
 *     REQUIRED  + absent    → incorrect
 *     FORBIDDEN + absent    → correct
 *     FORBIDDEN + présent   → incorrect
 *     UNSPECIFIED           → EXCLU, jamais noté
 */
export function slotsFermes(executes: readonly ExecutedCase[]): ClosedSlot[] {
  const slots: ClosedSlot[] = []

  for (const { golden, output } of executes) {
    const produits = typesProduits(output)

    for (const [situationType, attente] of Object.entries(golden.expected.situations)) {
      if (attente.assertion === 'UNSPECIFIED') continue

      const produced = produits.has(situationType)
      slots.push({
        caseId: golden.caseId,
        situationType,
        assertion: attente.assertion,
        produced,
        correct: attente.assertion === 'REQUIRED' ? produced : !produced,
      })
    }
  }

  // Ordre déterministe : caseId puis situationType.
  slots.sort((a, b) => {
    if (a.caseId !== b.caseId) return a.caseId < b.caseId ? -1 : 1
    return a.situationType < b.situationType ? -1 : a.situationType > b.situationType ? 1 : 0
  })

  return slots
}

/**
 * Accord avec l'oracle fermé ACTUELLEMENT ADJUGÉ, sur les cas exécutables.
 *
 * ⚠️ CE N'EST PAS « la précision du produit », ni « la qualité du moteur » au
 * sens global. C'est l'accord avec quatre assertions signées par un humain sur
 * quatre cas. Le nommer autrement transformerait un échantillon en KPI.
 */
export function closedOracleAgreement(slots: readonly ClosedSlot[]): MetricRatio {
  const corrects = slots.filter((s) => s.correct)
  const rates = slots.filter((s) => !s.correct)
  return ratio(
    corrects.length,
    slots.length,
    'HIGHER_IS_BETTER',
    corrects.map((s) => s.caseId),
    rates.map((s) => s.caseId),
  )
}

/** Slots REQUIRED dont la Situation est ABSENTE. */
export function requiredMissRate(slots: readonly ClosedSlot[]): MetricRatio {
  const requis = slots.filter((s) => s.assertion === 'REQUIRED')
  const manques = requis.filter((s) => !s.produced)
  return ratio(
    manques.length,
    requis.length,
    'LOWER_IS_BETTER',
    requis.filter((s) => s.produced).map((s) => s.caseId),
    manques.map((s) => s.caseId),
  )
}

/**
 * Slots FORBIDDEN dont la Situation est PRÉSENTE.
 *
 * ⚠️ Ce n'est PAS `weak_signal_overcall`. Aucune classe « signal faible »
 * lisible par machine n'existe dans le corpus ; l'inférer du texte des
 * `rationale` fabriquerait une donnée. La vraie métrique reste différée.
 */
export function forbiddenOvercallRate(slots: readonly ClosedSlot[]): MetricRatio {
  const interdits = slots.filter((s) => s.assertion === 'FORBIDDEN')
  const exces = interdits.filter((s) => s.produced)
  return ratio(
    exces.length,
    interdits.length,
    'LOWER_IS_BETTER',
    interdits.filter((s) => !s.produced).map((s) => s.caseId),
    exces.map((s) => s.caseId),
  )
}

/**
 * Situations produites sur un slot `UNSPECIFIED`.
 *
 * ⚠️ SANS NOTE. Ni correct, ni incorrect, ni faux positif, ni excès. Le corpus
 * ne s'est pas prononcé ; le harness non plus.
 */
export function observedOutsideOracle(
  executes: readonly ExecutedCase[],
): OutsideOracleObservation[] {
  const obs: OutsideOracleObservation[] = []

  for (const { golden, output } of executes) {
    for (const type of typesProduits(output)) {
      const attente = golden.expected.situations[type]
      if (attente && attente.assertion === 'UNSPECIFIED') {
        obs.push({ caseId: golden.caseId, situationType: type })
      }
    }
  }

  obs.sort((a, b) => {
    if (a.caseId !== b.caseId) return a.caseId < b.caseId ? -1 : 1
    return a.situationType < b.situationType ? -1 : a.situationType > b.situationType ? 1 : 0
  })

  return obs
}

// ── CONTRÔLES D'INTÉGRITÉ — JAMAIS DES KPI MÉTIER ──────────────────────────

/**
 * Toute Situation produite cite des evidences RÉELLEMENT soumises au moteur.
 *
 * ⚠️ CONTRÔLE D'INTÉGRITÉ, pas une mesure de qualité métier. Il ne dit pas si
 * l'interprétation est juste ; il dit qu'elle est traçable. Une Situation dont
 * `evidenceIds` serait vide ou citerait un identifiant absent de l'entrée
 * rendrait l'auditabilité mensongère alors même que le verdict pourrait être bon.
 */
export function evidenceTraceability(
  executes: readonly ExecutedCase[],
): { checked: number; failures: TraceabilityFailure[] } {
  const failures: TraceabilityFailure[] = []
  let checked = 0

  for (const { golden, output } of executes) {
    const connus = new Set(output.evidence.map((e) => e.id))

    for (const situation of output.situations) {
      checked += 1

      if (!Array.isArray(situation.evidenceIds) || situation.evidenceIds.length === 0) {
        failures.push({
          caseId: golden.caseId,
          situationId: situation.id,
          evidenceId: '',
          reason: 'empty',
        })
        continue
      }

      for (const id of situation.evidenceIds) {
        if (!connus.has(id)) {
          failures.push({
            caseId: golden.caseId,
            situationId: situation.id,
            evidenceId: id,
            reason: 'unknown',
          })
        }
      }
    }
  }

  failures.sort((a, b) => {
    const ka = `${a.caseId}|${a.situationId}|${a.evidenceId}`
    const kb = `${b.caseId}|${b.situationId}|${b.evidenceId}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  return { checked, failures }
}

/**
 * Toute recommandation `recommend` porte un `whyNow` non vide.
 *
 * ⚠️ PRÉSENCE UNIQUEMENT. La QUALITÉ du why-now n'est adjugée par aucun oracle
 * Golden — Rail S n'affirme que des Situations. Et surtout : aucun second calcul
 * de fraîcheur n'est fait ici, sous peine de mesurer le harness au lieu du moteur.
 */
export function whyNowPresence(
  executes: readonly ExecutedCase[],
): { checked: number; failures: WhyNowFailure[] } {
  const failures: WhyNowFailure[] = []
  let checked = 0

  for (const { golden, output } of executes) {
    for (const reco of output.recommendations) {
      if (reco.decision !== 'recommend') continue
      checked += 1

      if (typeof reco.whyNow !== 'string' || reco.whyNow.trim().length === 0) {
        failures.push({ caseId: golden.caseId, recommendationId: reco.id })
      }
    }
  }

  failures.sort((a, b) => {
    const ka = `${a.caseId}|${a.recommendationId}`
    const kb = `${b.caseId}|${b.recommendationId}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  return { checked, failures }
}
