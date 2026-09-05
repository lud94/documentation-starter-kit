// EVAL-RUNNER-001a — DECISION KERNEL.
//
// ── L'INVARIANT QUE CE FICHIER EXISTE POUR TENIR ────────────────────────────
//
//   Prospector runtime          Runner offline
//   Lead[]                      JSON
//     → dataBridge                → EvidenceEvent[]
//         \                      /
//          → evaluateEvidence() ←        UN SEUL chemin de décision
//
// Un runner d'évaluation qui réimplémenterait l'enchaînement
// `evaluateSituations → recommendationDecision` finirait par mesurer SON
// moteur au lieu du moteur de production. C'est la façon la plus courante de
// rendre un harness d'évaluation rassurant et faux. Ce module est donc le seul
// endroit où cet enchaînement existe : `orchestrator.evaluate()` l'appelle, le
// runner l'appelle, et personne ne le recopie.
//
// ── CE QUI RESTE DEHORS, ET POURQUOI ────────────────────────────────────────
// Le kernel reçoit ses cibles DÉJÀ CONSTITUÉES, pertinence comprise. Il ne sait
// pas ce qu'est un `Lead`, ne lit aucun `score`, et n'invente aucune pertinence.
// La dérivation `Lead.score → relevance` est propre à Prospector et reste dans
// `orchestrator.ts` ; le runner, lui, exige la pertinence dans son fichier.
//
// ⚠️ AUCUN REPLI SUR `Lens.relevance()`. Elle est dormante et le reste : s'en
// servir pour compléter une pertinence manquante transformerait une donnée
// absente en donnée inventée, exactement ce que le verrou de non-régression
// `tests/proactive-relevance-lockin.test.ts` interdit.
import { LENS_REGISTRY } from './lens/registry'
import {
  scopeIncludes,
  validateBusinessContext,
  type BusinessContextV0,
} from './lens/context'
import type { ContextValidation } from './lens/context'
import { evaluateSituations } from './situationEngine'
import { recommendationDecision } from './recommendationEngine'
import type { EligibilityContext } from './eligibility'
import type {
  EvidenceEvent,
  Recommendation,
  SignalTemporalAuthority,
  Situation,
} from './types'

/**
 * Cible d'évaluation COMPLÈTE — tout ce dont le kernel a besoin pour décider.
 *
 * `relevance` est OBLIGATOIRE et n'a pas de valeur par défaut : un `0` implicite
 * serait une affirmation (« ce compte n'est pas pertinent ») déguisée en
 * absence de donnée.
 */
export interface KernelTarget {
  accountId: string
  personId?: string
  /** 0..1. Fournie par l'appelant ; jamais dérivée ici. */
  relevance: number
  /** Garde-fous relationnels connus. Ce qui n'est pas fourni n'est pas supposé. */
  eligibility?: Partial<EligibilityContext>
}

export interface KernelInput {
  now: Date
  /** OBLIGATOIRE. Revalidé ici : aucun appelant ne peut sauter cette étape. */
  businessContext: BusinessContextV0
  evidence: readonly EvidenceEvent[]
  targets: readonly KernelTarget[]

  /**
   * SIGNAL_TEMPORAL_WINDOW_V0_001 — autorité temporelle des Signaux externes
   * (side-car du gate canonique en production ; fournie par le cas d'éval côté
   * runner). MÊME chemin de décision des deux côtés : absente pour une
   * evidence externe non datée sous fenêtre déclarée ⇒ fail closed pour cette
   * règle — jamais un repli silencieux sur `observedAt`.
   */
  temporalAuthorityByEvidenceId?: Readonly<Record<string, SignalTemporalAuthority>>
}

export interface KernelOutput {
  situations: Situation[]
  recommendations: Recommendation[]
}

const KERNEL_VIDE: KernelOutput = { situations: [], recommendations: [] }

/**
 * La cible est-elle DANS le périmètre métier ?
 *
 * ⚠️ CE PRÉDICAT ÉTAIT MORT. `scopeIncludes` existait depuis
 * ARCH-RULEPACK-001 mais n'était appelé par AUCUN code de production : le
 * `scope` était validé dans sa FORME puis ignoré. Un champ qui décrit une
 * restriction sans jamais restreindre est pire qu'absent — il donne l'illusion
 * d'un contrôle.
 *
 * ⚠️ CE N'EST PAS DE L'AUTORITÉ. `mode:'workspace'` ne CRÉE aucun droit : le
 * Business Context ne peut que RETRANCHER. L'isolation réelle reste portée par
 * `ws`, exigé à chaque appel de la persistance, et par le Control Plane qui
 * n'existe pas encore. Ce prédicat referme un périmètre, il n'en ouvre aucun.
 */
export function targetInScope(
  target: { accountId: string },
  context: BusinessContextV0,
): boolean {
  return scopeIncludes(context.scope, target.accountId)
}

/**
 * Résolution du Business Context — POINT UNIQUE, partagé.
 *
 * Exposée pour que l'orchestrateur puisse échouer AVANT de construire des
 * evidences, sans recopier la règle de validation. Le kernel la rappelle de
 * toute façon : la validation n'est pas déléguée à la discipline de l'appelant.
 */
export function resolveBusinessContext(context: BusinessContextV0): ContextValidation {
  return validateBusinessContext(context, (id) => LENS_REGISTRY[id].lensVersion)
}

/**
 * Ordre STABLE des cibles.
 *
 * Deux exécutions identiques doivent produire deux sorties identiques, y
 * compris dans l'ordre des tableaux. L'orchestrateur trie déjà ses cibles ; le
 * runner reçoit les siennes dans l'ordre d'un fichier. Trier ICI rend la
 * propriété vraie pour les deux, sans que l'un dépende de la rigueur de l'autre.
 */
function ordreStable(a: KernelTarget, b: KernelTarget): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
  const ap = a.personId ?? ''
  const bp = b.personId ?? ''
  if (ap === bp) return 0
  return ap < bp ? -1 : 1
}

/**
 * LE CHEMIN DE DÉCISION. Pur, déterministe, sans effet de bord.
 *
 * Aucun réseau, aucune base, aucun LLM, aucune persistance, aucune action
 * métier. Le temps vient exclusivement de `input.now` — jamais de `Date.now()`.
 */
export function evaluateEvidence(input: KernelInput): KernelOutput {
  if (!input || !Array.isArray(input.evidence) || !Array.isArray(input.targets)) {
    return KERNEL_VIDE
  }
  if (!input.now || !Number.isFinite(input.now.getTime())) return KERNEL_VIDE

  // ⚠️ FAIL CLOSED. Contexte absent, lens inconnue ou version de lens
  // divergente ⇒ AUCUNE évaluation. Utiliser silencieusement une version plus
  // récente attribuerait des situations à une politique qui ne les a pas
  // produites.
  const validation = resolveBusinessContext(input.businessContext)
  if (!validation.ok) return KERNEL_VIDE

  const ctx = validation.context
  const lens = LENS_REGISTRY[ctx.lensId]

  // ── FAIL CLOSED SUR LE PÉRIMÈTRE ──────────────────────────────────────────
  //
  // ── DETTE ASSUMÉE (EVAL-RUNNER-001a, arbitrée) ────────────────────────────
  // Ce refus est INDISTINGUABLE d'une évaluation légitimement vide : les deux
  // rendent `{situations: [], recommendations: []}`. C'est acceptable
  // AUJOURD'HUI parce qu'aucun appelant runtime ne construit de `scope`
  // account-level — le runner, lui, refuse le cas en amont avec un message qui
  // nomme la cible fautive.
  //
  // Le jour où un `BusinessScope` account-level sera réellement utilisé en
  // runtime, il faudra distinguer explicitement `evaluation empty` de
  // `evaluation rejected / target_out_of_scope`. Cela demandera un type de
  // résultat porteur d'un motif — DÉLIBÉRÉMENT HORS PÉRIMÈTRE de ce lot :
  // l'introduire maintenant changerait la signature du kernel pour un cas qui
  // ne se produit pas encore.
  // Une cible hors périmètre n'est pas SILENCIEUSEMENT ÉCARTÉE : l'évaluation
  // entière est refusée. Écarter en douce reviendrait à rendre un résultat
  // « complet » amputé d'une partie de sa demande — un appelant ne pourrait pas
  // distinguer « ce compte n'a rien produit » de « ce compte n'a jamais été
  // regardé ». Le runner, lui, refuse le cas AVANT d'arriver ici, avec un
  // message nommant la cible fautive.
  if (input.targets.some((t) => !targetInScope(t, ctx))) return KERNEL_VIDE

  const situations: Situation[] = []
  const recommendations: Recommendation[] = []

  for (const cible of [...input.targets].sort(ordreStable)) {
    const trouvees = evaluateSituations(
      input.evidence as EvidenceEvent[],
      {
        now: input.now,
        accountId: cible.accountId,
        personId: cible.personId,
        relevance: cible.relevance,
        lensId: lens.lensId,
        lensVersion: lens.lensVersion,
        ...(input.temporalAuthorityByEvidenceId
          ? { temporalAuthorityByEvidenceId: input.temporalAuthorityByEvidenceId }
          : {}),
      },
      lens.rulePacks,
    )

    for (const situation of trouvees) {
      situations.push(situation)

      const fourni = cible.eligibility ?? {}

      recommendations.push(
        recommendationDecision(situation, {
          // `now` reste sous notre contrôle : un appelant ne doit pas pouvoir
          // décaler l'horloge d'éligibilité en passant un contexte partiel.
          ...fourni,
          now: input.now,
          meetingScheduled: fourni.meetingScheduled ?? false,
          // Le contexte vient de l'entrée VALIDÉE, hors de portée d'un
          // résolveur d'éligibilité partiel.
          businessContext: {
            contextId: ctx.contextId,
            contextVersion: ctx.contextVersion,
            authorizedMotions: ctx.authorizedMotions,
          },
        }),
      )
    }
  }

  return { situations, recommendations }
}
