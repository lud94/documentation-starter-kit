// JS-011_MOTION_MODEL_V0_002 — MOTION COMMERCIALE V0.
//
// ── CE QU'EST UNE MOTION COMMERCIALE, ET CE QU'ELLE N'EST PAS ───────────────
//
// Une Motion Commerciale nomme une FAÇON DE VENDRE — la nature du revenu
// poursuivi et les objets sur lesquels elle opère. C'est une taxonomie de
// PROJECTION : elle organise la lecture, jamais l'autorité.
//
//   Motion Commerciale  « comment on vend »            → taxonomie métier
//   Capacité d'action   « ce qu'on a le DROIT de faire » → autorité (motions.ts)
//
// Les deux vocabulaires partagent le mot « motion » dans la langue courante ;
// ils ne partagent RIEN d'autre. Ce module n'importe pas, ne réexporte pas et
// n'étend pas le vocabulaire de capacités de `motions.ts` : une Motion
// Commerciale n'accorde aucune permission, ne débloque aucune action, ne
// modifie aucun niveau de contrôle humain. Le préfixe `Commercial` est
// systématique précisément pour rendre la confusion impossible.
//
// ── POURQUOI EXACTEMENT DEUX MOTIONS ────────────────────────────────────────
//
//   ACQUIRE  → conquérir du revenu NOUVEAU (prospects, leads, comptes cibles)
//   ACCOUNT  → développer et conserver le revenu EXISTANT (comptes clients)
//
// Le « leadership commercial » n'est PAS une motion : c'est une projection
// AGRÉGÉE, scoped au rôle HEAD_OF_SALES, au-dessus des motions des autres.
// « Pipeline » et « forecast » ne sont pas des motions : ce sont des VUES.
// Les introduire ici ferait d'un angle de lecture une catégorie de vente.
//
// ── UNE SEULE RÉALITÉ MÉTIER ────────────────────────────────────────────────
// La motion change la PROJECTION, jamais la VÉRITÉ. Aucun champ d'ici ne
// touche la mémoire factuelle, les Situations, les Missions, les Playbooks,
// les permissions ou l'autonomie. Module PUR : constantes et lookup fermé —
// aucun réseau, aucun stockage, aucun LLM, aucune mutation, aucune exécution.
//
// Import de TYPE uniquement (effacé à l'émission) : le rôle vient du
// vocabulaire canonique de roleCard, jamais d'une chaîne libre.
import type { RoleKind } from './roles/roleCard'

/** Version du SCHÉMA de la définition (forme du contrat). */
export const COMMERCIAL_MOTION_SCHEMA_VERSION = 'commercial-motion-v0.1'

/** Version du CONTENU (valeurs des définitions et de la matrice). */
export const COMMERCIAL_MOTION_VERSION = 'v0.1'

/**
 * Les DEUX motions commerciales de V0 — union FERMÉE.
 *
 * ⚠️ NE JAMAIS ajouter SALES_LEADERSHIP, LEADERSHIP, PIPELINE ou FORECAST :
 * le premier est une projection de rôle, les autres sont des vues.
 */
export type CommercialMotionKind = 'ACQUIRE' | 'ACCOUNT'

/** Famille d'objectif de revenu que la motion poursuit. */
export type CommercialObjectiveFamily =
  | 'WIN_NEW_REVENUE' // revenu nouveau — conquête
  | 'GROW_AND_KEEP_CLIENTS' // revenu existant — développement et rétention

/**
 * Objets commerciaux sur lesquels une motion OPÈRE.
 *
 * ⚠️ STAKEHOLDER n'est PAS un objet commercial : un interlocuteur est une
 * personne dans un compte, pas une unité de revenu.
 */
export type CommercialObjectKind =
  | 'PROSPECT'
  | 'LEAD'
  | 'TARGET_ACCOUNT'
  | 'OPPORTUNITY'
  | 'CLIENT_ACCOUNT'

/**
 * Sous-intentions FERMÉES de la motion ACCOUNT — et d'elle SEULE.
 *
 * EXPAND/PROTECT/RENEW/REACTIVATE sont quatre lectures d'une même façon de
 * vendre (le compte existant), pas quatre motions. Les promouvoir au niveau
 * supérieur multiplierait les catégories sans multiplier les réalités.
 */
export type AccountCommercialIntent = 'EXPAND' | 'PROTECT' | 'RENEW' | 'REACTIVATE'

/**
 * Définition d'une motion commerciale — contrat V0, ENTIÈREMENT en lecture
 * seule.
 *
 * Volontairement ABSENTS de ce contrat (et ce n'est pas un oubli) :
 * rôles applicables (portés par la matrice d'adaptation SÉPARÉE, jamais par
 * la définition), intentions de Mission (propriété des RoleCards), familles
 * de Situations, références Playbook, poids d'attention, actions permises,
 * autorisation, autonomie, configuration tenant, étape CRM, champs modèle.
 */
export interface CommercialMotionDefinitionV0 {
  readonly schemaVersion: typeof COMMERCIAL_MOTION_SCHEMA_VERSION
  readonly motionVersion: typeof COMMERCIAL_MOTION_VERSION
  readonly motionKind: CommercialMotionKind
  readonly objectiveFamily: CommercialObjectiveFamily
  readonly applicableObjectKinds: readonly CommercialObjectKind[]
  readonly accountIntents?: readonly AccountCommercialIntent[]
}

// ── REGISTRE — DEUX DÉFINITIONS, GELÉES À CHAQUE NIVEAU ─────────────────────
// Gel EXPLICITE de chaque objet et de chaque tableau imbriqué. Pas de
// framework générique de deep-freeze : la structure est petite, connue et
// fermée ; l'expliciter rend chaque gel VÉRIFIABLE à la lecture.

const MOTION_ACQUIRE: CommercialMotionDefinitionV0 = Object.freeze({
  schemaVersion: COMMERCIAL_MOTION_SCHEMA_VERSION,
  motionVersion: COMMERCIAL_MOTION_VERSION,
  motionKind: 'ACQUIRE' as const,
  objectiveFamily: 'WIN_NEW_REVENUE' as const,
  applicableObjectKinds: Object.freeze([
    'PROSPECT',
    'LEAD',
    'TARGET_ACCOUNT',
    'OPPORTUNITY',
  ] as const),
  // Pas d'accountIntents : la conquête n'a pas de sous-intentions de compte.
})

const MOTION_ACCOUNT: CommercialMotionDefinitionV0 = Object.freeze({
  schemaVersion: COMMERCIAL_MOTION_SCHEMA_VERSION,
  motionVersion: COMMERCIAL_MOTION_VERSION,
  motionKind: 'ACCOUNT' as const,
  objectiveFamily: 'GROW_AND_KEEP_CLIENTS' as const,
  applicableObjectKinds: Object.freeze(['CLIENT_ACCOUNT', 'OPPORTUNITY'] as const),
  accountIntents: Object.freeze(['EXPAND', 'PROTECT', 'RENEW', 'REACTIVATE'] as const),
})

/** Registre fermé des motions commerciales. Gelé, valeurs gelées. */
export const COMMERCIAL_MOTIONS: Readonly<
  Record<CommercialMotionKind, CommercialMotionDefinitionV0>
> = Object.freeze({
  ACQUIRE: MOTION_ACQUIRE,
  ACCOUNT: MOTION_ACCOUNT,
})

// ── ADAPTATION RÔLE × MOTION — SÉPARÉE DE LA DÉFINITION ─────────────────────
// L'applicabilité par rôle est une propriété de la RELATION rôle↔motion,
// jamais de la motion elle-même. La loger dans la définition inviterait
// chaque nouveau rôle à réécrire le cœur ; la matrice s'étend, le cœur non.

/**
 * Pertinence d'une motion pour un rôle — PROJECTION, jamais permission.
 * `NOT_APPLICABLE` masque une lecture ; il n'interdit aucune action.
 */
export type RoleCommercialMotionApplicability = 'PRIMARY' | 'SECONDARY' | 'NOT_APPLICABLE'

/** Matrice fermée Rôle × Motion. Gelée à chaque niveau. */
export const ROLE_COMMERCIAL_MOTION_MATRIX: Readonly<
  Record<RoleKind, Readonly<Record<CommercialMotionKind, RoleCommercialMotionApplicability>>>
> = Object.freeze({
  SDR_BDR: Object.freeze({
    ACQUIRE: 'PRIMARY' as const,
    ACCOUNT: 'NOT_APPLICABLE' as const,
  }),
  ACCOUNT_EXECUTIVE: Object.freeze({
    ACQUIRE: 'PRIMARY' as const,
    ACCOUNT: 'SECONDARY' as const,
  }),
  ACCOUNT_MANAGER_KAM: Object.freeze({
    ACQUIRE: 'NOT_APPLICABLE' as const,
    ACCOUNT: 'PRIMARY' as const,
  }),
  HEAD_OF_SALES: Object.freeze({
    ACQUIRE: 'SECONDARY' as const,
    ACCOUNT: 'SECONDARY' as const,
  }),
})

// ── RÉSOLUTION FERMÉE, FAIL CLOSED ──────────────────────────────────────────

/**
 * Résultat de résolution — union discriminée, objets TOUJOURS gelés.
 * Inconnu n'est jamais défaut : aucune motion n'est « supposée ».
 */
export type CommercialMotionResolution =
  | { readonly ok: true; readonly motion: CommercialMotionDefinitionV0 }
  | { readonly ok: false; readonly state: 'UNKNOWN_COMMERCIAL_MOTION' }

const RESOLUTION_ACQUIRE: CommercialMotionResolution = Object.freeze({
  ok: true as const,
  motion: MOTION_ACQUIRE,
})

const RESOLUTION_ACCOUNT: CommercialMotionResolution = Object.freeze({
  ok: true as const,
  motion: MOTION_ACCOUNT,
})

const RESOLUTION_UNKNOWN: CommercialMotionResolution = Object.freeze({
  ok: false as const,
  state: 'UNKNOWN_COMMERCIAL_MOTION' as const,
})

/**
 * Résout un hint de motion commerciale — correspondance EXACTE uniquement.
 *
 * ⚠️ AUCUNE normalisation : pas de trim, pas de casse, pas de fuzzy, pas de
 * défaut. `'acquire'`, `'SALES_LEADERSHIP'`, `'PIPELINE'`, `''`, `null`,
 * `undefined`, un objet — tout ce qui n'est pas EXACTEMENT `'ACQUIRE'` ou
 * `'ACCOUNT'` rend `UNKNOWN_COMMERCIAL_MOTION`. Deviner une taxonomie de
 * lecture fabriquerait une projection que personne n'a choisie.
 */
export function resolveCommercialMotion(hint: unknown): CommercialMotionResolution {
  if (hint === 'ACQUIRE') return RESOLUTION_ACQUIRE
  if (hint === 'ACCOUNT') return RESOLUTION_ACCOUNT
  return RESOLUTION_UNKNOWN
}
