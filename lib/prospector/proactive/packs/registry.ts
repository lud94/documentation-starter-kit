// ARCH-RULEPACK-001 — REGISTRE DES RULE PACKS.
//
// ⚠️ TABLE STATIQUE, CONTRÔLÉE PAR SMART.AI. Aucun `eval`, aucun chargement
// distant, aucun code utilisateur, aucune résolution à l'exécution. Ajouter un
// pack, c'est ajouter une ligne ici et la faire relire — c'est exactement ce
// qui rend l'extensibilité auditable.
//
// Ce module n'importe QUE des packs. Il n'importe ni le catalogue, ni le
// moteur, ni les lenses : c'est ce qui le maintient en amont du graphe.
import { SALES_CORE } from './sales-core'
import { REAL_ESTATE_FABEL } from './real-estate-fabel'
import type { AnyRulePack } from '../rulePack'

export const PACK_REGISTRY = {
  'sales-core': SALES_CORE,
  'real-estate-fabel': REAL_ESTATE_FABEL,
} as const

/**
 * Identifiants de pack RÉELLEMENT enregistrés.
 *
 * C'est ce type qui rend mécaniquement vraie l'affirmation « un pack inconnu
 * échoue à la compilation » : `rulePacks: readonly RulePackId[]` n'accepte
 * aucune chaîne libre.
 */
export type RulePackId = keyof typeof PACK_REGISTRY

export const RULE_PACK_IDS = Object.keys(PACK_REGISTRY) as RulePackId[]

export function isRulePackId(value: string): value is RulePackId {
  return Object.prototype.hasOwnProperty.call(PACK_REGISTRY, value)
}

/** Accès effacé, pour les chemins qui manipulent des packs hétérogènes. */
export function rulePackById(id: string): AnyRulePack | null {
  return isRulePackId(id) ? (PACK_REGISTRY[id] as AnyRulePack) : null
}
