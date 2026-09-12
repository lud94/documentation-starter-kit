// JS-015 B2A — SCÉNARIOS DE COPY CONTRÔLÉS (SURFACE TEST/EVAL SEULE).
//
// ── A ≠ B : DEUX STATUTS STRUCTURELLEMENT DISTINCTS ─────────────────────────
// A. COMPORTEMENT GOLDEN AUTORITATIF : vit dans goldenFixtures.ts — les
//    Goldens nommés y restent des PLACEHOLDERS (aucune décision inventée,
//    attentes = PENDING_AUTHORITATIVE_GOLDEN_SOURCE). RIEN ici ne les remplit.
// B. ENTRÉE DE SCÉNARIO CONTRÔLÉE (ce fichier) : pour exercer le RENDERER,
//    chaque scénario porte une action/objectif/canal CONTRÔLÉS — ce sont des
//    ENTRÉES DE TEST choisies par le harnais, JAMAIS une attente Golden ni une
//    vérité produit. Les faits d'entreprise ne sont PAS fabriqués : l'évidence
//    des scénarios est synthétique et préfixée ev_scenario_*.
//
// ── L'ORACLE COMPORTEMENTAL ─────────────────────────────────────────────────
// Il teste les PRINCIPES GELÉS, pas une prose exacte : chaque scénario nomme
// les IMPLICATIONS FACTUELLES INTERDITES (montées en fait non prouvées) que le
// pipeline doit rendre inexprimables — structurellement (refs inconnues/non
// montrables, rendu DIRECT sur incertain/contre-signal) ou par termes
// interdits BLOQUANTS. SQUAD n'a AUCUN scénario ici : la non-activation
// (STRATÉGIQUEMENT INTÉRESSANT ≠ COMMERCIALEMENT PRIORISÉ) signifie qu'aucun
// contexte message-ready n'existe — compose est INATTEIGNABLE depuis ce cas.
//
// ── HONNÊTETÉ DU HARNAIS ────────────────────────────────────────────────────
// Le validateur déterministe ne prouve PAS la fidélité sémantique d'une
// paraphrase arbitraire. Ce que les tests prouvent : les violations
// STRUCTURELLEMENT détectables sont rejetées. Le résiduel sémantique est
// documenté, pas maquillé.
import type {
  MessageChannelV0,
  OutreachObjectiveV0,
  SelectedActionV0,
} from '../../../lib/prospector/messaging/messageContext'

export interface ControlledCopyScenarioV0 {
  readonly scenarioKind: 'CONTROLLED_COPY_SCENARIO_INPUT'
  readonly scenarioId: 'REDSEN' | 'AEROW_KIMEIA' | 'WALLIX'
  /** ENTRÉES contrôlées du harnais — jamais une décision produit gelée. */
  readonly controlledAction: SelectedActionV0
  readonly controlledObjective: OutreachObjectiveV0
  readonly controlledChannel: MessageChannelV0
  /** Raisonnements contrôlés — formulés pour NE PAS porter de fait inventé. */
  readonly controlledWhyNow: string
  readonly controlledWhyTalk: string
  readonly controlledHighValueUnknown?: string
  /**
   * Montées en fait INTERDITES pour ce scénario — injectées comme termes
   * interdits BLOQUANTS du contexte de test. Contrainte de harnais, pas une
   * connaissance de compte.
   */
  readonly prohibitedFactualUpgrades: readonly string[]
  /** Le principe gelé que ce scénario exerce. */
  readonly frozenPrinciple: string
}

export const CONTROLLED_COPY_SCENARIOS_V0: readonly ControlledCopyScenarioV0[] = Object.freeze([
  Object.freeze({
    scenarioKind: 'CONTROLLED_COPY_SCENARIO_INPUT' as const,
    scenarioId: 'REDSEN' as const,
    controlledAction: 'START_OUTREACH' as const,
    controlledObjective: 'LEARN_HIGH_VALUE_UNKNOWN' as const,
    controlledChannel: 'email' as const,
    controlledWhyNow: 'signal daté de recrutement de consultants observé sur le compte (portée réelle inconnue)',
    controlledWhyTalk: 'responsable opérationnel du périmètre concerné par le sujet',
    controlledHighValueUnknown: 'comment l’organisation du travail sur site évolue avec la croissance des effectifs de conseil',
    prohibitedFactualUpgrades: Object.freeze([
      'croissance des effectifs au siège',
      'agrandissement de vos bureaux',
      'besoin immobilier',
    ]),
    frozenPrinciple:
      'recrutement de consultants ⇏ croissance du siège ⇏ expansion de bureaux ⇏ besoin immobilier ; '
      + 'le WHY TALK opérationnel ne fabrique jamais un WHY NOW ; la copy reste exploratoire/interrogative.',
  }),
  Object.freeze({
    scenarioKind: 'CONTROLLED_COPY_SCENARIO_INPUT' as const,
    scenarioId: 'AEROW_KIMEIA' as const,
    controlledAction: 'START_OUTREACH' as const,
    controlledObjective: 'OPEN_CONVERSATION' as const,
    controlledChannel: 'email' as const,
    controlledWhyNow: 'intégration de deux entités annoncée (modalités physiques non établies)',
    controlledWhyTalk: 'pilote l’intégration côté opérations',
    prohibitedFactualUpgrades: Object.freeze([
      'même adresse',
      'consolidation physique de vos équipes',
      'pression sur vos bureaux',
      'votre déménagement',
    ]),
    frozenPrinciple:
      'croissance/intégration peut être pertinente ; même adresse ⇏ consolidation physique, '
      + 'croissance du conseil ⇏ pression immobilière, intégration ⇏ déménagement — plausible ≠ prouvé.',
  }),
  Object.freeze({
    scenarioKind: 'CONTROLLED_COPY_SCENARIO_INPUT' as const,
    scenarioId: 'WALLIX' as const,
    controlledAction: 'START_OUTREACH' as const,
    controlledObjective: 'LEARN_HIGH_VALUE_UNKNOWN' as const,
    controlledChannel: 'linkedin' as const,
    controlledWhyNow: 'trace immobilière ANCIENNE dans le domaine public (état actuel inconnu)',
    controlledWhyTalk: 'décideur du périmètre environnement de travail',
    controlledHighValueUnknown: 'la position actuelle de l’implantation parisienne (l’empreinte réelle est une inconnue)',
    prohibitedFactualUpgrades: Object.freeze([
      'votre bail arrive à échéance',
      'votre déménagement en cours',
      'manque de place',
      'recherche immobilière active',
    ]),
    frozenPrinciple:
      'une évidence immobilière historique/périmée ne se promeut JAMAIS en fait actuel ; '
      + 'bail, déménagement, manque de place, recherche active ne sont pas affirmables ; '
      + 'objectif = gain d’information ⇒ copy exploratoire et interrogative.',
  }),
])
