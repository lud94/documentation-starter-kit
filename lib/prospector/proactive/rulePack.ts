// ARCH-RULEPACK-001 — CONTRAT DES RULE PACKS.
//
// ── MODULE DE CONTRAT NEUTRE, ET C'EST STRUCTUREL ───────────────────────────
// `RecommendationRule` vit ICI et non dans `recommendationEngine`. Sans cela,
// un pack devrait importer le moteur de recommandation, lequel importe le
// registre des packs — cycle à l'exécution.
//
// Ce fichier n'importe donc RIEN d'autre que `./types` et `./motions`, tous
// deux eux-mêmes sans dépendance vers les packs ou les registres.
//
// ── « ENFICHABLE » NE VEUT PAS DIRE « DYNAMIQUE » ───────────────────────────
// Un pack est du code TypeScript, importé statiquement, versionné dans ce
// dépôt, revu et testé. Aucun `eval`, aucun chargement distant, aucun code
// utilisateur, aucun DSL. L'extensibilité est une propriété de compilation, pas
// d'exécution — c'est précisément ce qui la rend auditable.
import type { EvidenceEvent, PlayType, Situation } from './types'
import type { HumanControl } from './motions'

/**
 * Contexte d'évaluation d'une situation.
 *
 * ⚠️ `relevance` vient de la LENS, jamais du pack. Un pack interprète des
 * faits ; il ne décide pas de leur pertinence commerciale pour un métier
 * donné. Cette séparation est ce qui permet à deux lenses de lire les mêmes
 * evidences avec des priorités différentes.
 */
export interface SituationEvaluationContext {
  now: Date
  accountId: string
  personId?: string
  /** 0..1 — pertinence ICP / offre / objectif, calculée par la lens. */
  relevance: number
  /** Provenance, injectée par le moteur. Un pack ne les fabrique jamais. */
  lensId: string
  lensVersion: string
}

/** Ce qu'une situation recommande de faire, côté métier. */
export interface RecommendationRule {
  play: PlayType
  recommendedAction: string
  reason: string
}

/**
 * Une règle de détection.
 *
 * La signature est EXACTEMENT celle des trois détecteurs qui existaient déjà
 * dans `situationEngine` : `(evidence, context) => Situation | null`. Le
 * contrat n'a pas été inventé pour ce lot, il a été constaté puis nommé.
 */
export interface SituationRule<S extends string, E extends string> {
  ruleId: string
  situationType: S
  detect(
    evidence: readonly EvidenceEvent<E>[],
    context: SituationEvaluationContext,
  ): Situation | null
}

/**
 * Un pack de règles versionné.
 *
 * `S` et `E` sont INFÉRÉS depuis `declaredSituationTypes` et
 * `declaredEvidenceTypes` via `defineRulePack`. C'est ce qui fait qu'une faute
 * de frappe dans `rules[].situationType` ou dans une clé de `plays` échoue à
 * la compilation, sans qu'aucune liste ne soit maintenue à deux endroits.
 */
export interface RulePack<S extends string, E extends string> {
  packId: string
  packVersion: string

  /** Source de vérité de `S`. Le catalogue global en dérive. */
  declaredSituationTypes: readonly S[]
  /** Source de vérité de `E`. Déclaratif : sert au catalogue et au harness. */
  declaredEvidenceTypes: readonly E[]

  rules: readonly SituationRule<S, E>[]

  /**
   * Arbitration INTRA-PACK, et strictement intra-pack.
   *
   * ⚠️ Elle ne reçoit QUE les situations produites par CE pack. Un pack ne peut
   * donc jamais supprimer ni modifier la sortie d'un autre vertical — la
   * boucle du moteur le garantit par construction, pas par convention.
   *
   * Invariant vérifié en test : le résultat est un SOUS-ENSEMBLE de l'entrée.
   * Une arbitration filtre ; elle ne fabrique pas.
   */
  arbitrate?(produced: readonly Situation[]): Situation[]

  /** EXHAUSTIF sur `S` : une situation déclarée sans play ne compile pas. */
  plays: Readonly<Record<S, RecommendationRule>>

  /**
   * PLANCHER DE CONTRÔLE — POLICY, PAS INVARIANT MÉTIER UNIVERSEL.
   *
   * Un pack peut imposer un niveau minimal de contrôle humain sur certaines de
   * ses situations. Un contexte peut le DURCIR, jamais l'assouplir.
   *
   * ⚠️ Exemple à venir (hors de ce lot) : `space_contraction →
   * approval_required` pour le vertical immobilier. Ce sera un choix de
   * PRUDENCE pris en l'absence de données, pas une vérité du courtage : il
   * traiterait de la même façon une contraction annoncée par le client
   * lui-même (fait établi) et une contraction INFÉRÉE depuis des
   * licenciements (inférence, sensible).
   *
   * Le contrat permettra plus tard de les distinguer sans rupture :
   * `Situation.evidenceIds` porte déjà les evidences ayant matériellement
   * contribué, et chacune porte son `assertionType`. Élargir ce champ vers une
   * fonction sera un ÉLARGISSEMENT de type, donc rétrocompatible.
   * AUCUN moteur conditionnel n'est construit ici.
   */
  controlFloor?: Readonly<Partial<Record<S, HumanControl>>>
}

/**
 * Déclare un pack en INFÉRANT ses littéraux.
 *
 * Sans ce helper, `S` et `E` s'élargiraient à `string` et le catalogue perdrait
 * toute valeur : `space_expnsion` compilerait aussi bien que `space_expansion`.
 */
export function defineRulePack<S extends string, E extends string>(
  pack: RulePack<S, E>,
): RulePack<S, E> {
  return pack
}

/** Forme effacée, utilisable dans un registre hétérogène. */
export type AnyRulePack = RulePack<string, string>
