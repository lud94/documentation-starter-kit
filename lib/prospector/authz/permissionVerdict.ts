// JS-020_PERMISSION_CONTROL_V0_001 — VERDICT DE PERMISSION V0.
//
// ── L'ÉQUATION D'AUTORITÉ EFFECTIVE ─────────────────────────────────────────
//   EffectivePermission =
//     identité d'acteur (session serveur)
//     ∩ RoleKind Sales canonique (document d'affectation)
//     ∩ politique de capacité rôle × action (table FERMÉE ci-dessous)
//     ∩ politique d'espace exigée par l'action (externalAI strict)
//     ∩ périmètre Mission / étape courante
//     ∩ exigence d'approbation canonique (SEC-004)
//
// Premier échec DUR gagne ; APPROVAL_REQUIRED n'est atteignable qu'après que
// TOUTES les portes d'autorité ont passé. La visibilité UI n'est JAMAIS une
// autorité : chaque route d'exécution ré-évalue ce verdict depuis l'état
// serveur COURANT.
//
// ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────
// Pas d'IAM générale, pas de graphe de permissions, pas de DSL. Aucune action
// d'ENVOI de message (messaging:send : contrat futur séparé) — le registre est
// FERMÉ et une action inconnue échoue CAPABILITY_FORBIDDEN. Le vocabulaire de
// contrôle du moteur proactif (motions.ts) reste un domaine SÉPARÉ : aucun
// mapping MissionTool → capacité proactive n'est déduit par convention ici ;
// un futur adaptateur (post-JS-015) devra être EXPLICITE, jamais deviné.
//
// MODULE PUR : aucune E/S — les lectures (rôle, politique d'espace) sont
// faites par l'appelant et passées en entrée.
import type { RoleKind } from '../proactive/roles/roleCard'
import type { WorkspacePermissions } from '../../../types/prospector'
import type { RoleResolution } from './roleAssignment'

// ── REGISTRE D'ACTIONS V0 — FERMÉ. ──────────────────────────────────────────
// B2B-1 (JS-015) : `messaging:prepare` = GÉNÉRATION DE BROUILLON uniquement —
// aucun effet d'envoi, aucune écriture CRM, aucun contact prospect. Toute
// action d'ENVOI (`messaging:send`) reste ABSENTE du registre : elle recevra
// son propre contrat d'autorité/approbation. Génération ≠ Envoi.
export const ACTION_REFS = Object.freeze([
  'mission:read',
  'mission:create',
  'mission:delete',
  'mission:approve',
  'mission:source_companies',
  'mission:import_companies',
  'mission:resolve_dirigeants',
  'mission:enrich_companies',
  'mission:create_list',
  'mission:create_sequence',
  'read:leads',
  'read:lists',
  'read:sequences',
  'monitoring:read',
  'monitoring:create',
  'monitoring:stop',
  'monitoring:run',
  'messaging:prepare',
  'read:accounts',
] as const)
export type ActionRef = typeof ACTION_REFS[number]

export function isActionRef(value: unknown): value is ActionRef {
  return typeof value === 'string' && (ACTION_REFS as readonly string[]).includes(value)
}

/** Périmètre de ressources V0 : EXACTEMENT l'espace entier, dit explicitement. */
export type ResourceScopeV0 = { readonly kind: 'ALL_WORKSPACE' }
export const RESOURCE_SCOPE_ALL_WORKSPACE: ResourceScopeV0 = Object.freeze({ kind: 'ALL_WORKSPACE' as const })

const MISSION_TOOL_ACTIONS = Object.freeze([
  'mission:source_companies', 'mission:import_companies', 'mission:resolve_dirigeants',
  'mission:enrich_companies', 'mission:create_list', 'mission:create_sequence',
] as const)
const MISSION_LIFECYCLE_ACTIONS = Object.freeze([
  'mission:read', 'mission:create', 'mission:delete', 'mission:approve',
] as const)
const READ_ACTIONS = Object.freeze(['read:leads', 'read:lists', 'read:sequences'] as const)
/**
 * JS-013 — Monitoring de COMPTE (motion ACCOUNT, JS-011) : AM/KAM = PRIMARY,
 * AE et Head of Sales = SECONDARY ⇒ les quatre actions. SDR_BDR = ACCOUNT
 * NOT_APPLICABLE ⇒ AUCUNE action AccountMonitor — ce qui ne signifie JAMAIS
 * « SDR ne monitorera rien » : le futur monitoring de PROSPECTS appartient à
 * la motion ACQUIRE, hors JS-013.
 */
const MONITORING_ACTIONS = Object.freeze([
  'monitoring:read', 'monitoring:create', 'monitoring:stop', 'monitoring:run',
] as const)
/**
 * B2B-1 (JS-015) — `messaging:prepare` : la surface produit initiale est la
 * charge ACQUIRE / Lead / RedactionModal ⇒ SDR_BDR et ACCOUNT_EXECUTIVE
 * uniquement. AM/KAM et Head of Sales : CAPABILITY_FORBIDDEN — on ne
 * pré-autorise PAS de futures charges messaging compte/managériales avant que
 * leurs chemins gouvernés existent ; extension par décision de politique
 * EXPLICITE seulement.
 */
const MESSAGING_PREPARE_ACTIONS = Object.freeze(['messaging:prepare'] as const)

/**
 * PFV0-2A — `read:accounts` : L'UNIQUE autorité de lecture produit générique
 * (projection Today + Company Workspace). LECTURE SEULE — n'autorise AUCUNE
 * écriture, AUCUN run de monitoring, AUCUN message, AUCUN envoi, AUCUNE
 * exécution de mission, AUCUN appel IA externe, AUCUNE mutation CRM. La
 * nouvelle couche produit ne s'appuie NI sur `read:leads` (héritage) NI sur
 * `monitoring:read` pour ouvrir un Company Workspace. Ouverte aux quatre
 * rôles Sales canoniques : lire l'intelligence de compte de son espace est la
 * charge commune des quatre motions.
 */
const PRODUCT_READ_ACTIONS = Object.freeze(['read:accounts'] as const)

/**
 * POLITIQUE RÔLE × ACTION — AUTORITÉ, donc ICI et pas dans les RoleCards.
 *
 * Les six MissionTools actuels sont la charge ACQUIRE/Prospector d'aujourd'hui.
 * AM/KAM et Head of Sales n'ont PAS encore de Missions compte/pipeline dans le
 * registre fermé d'outils — on n'invente pas leurs futurs outils : leur
 * exécution ACQUIRE est interdite, leurs lectures restent ouvertes.
 * Toute paire rôle/action ABSENTE de cette table est CAPABILITY_FORBIDDEN.
 */
export const ROLE_ACTION_POLICY: Readonly<Record<RoleKind, readonly ActionRef[]>> = Object.freeze({
  SDR_BDR: Object.freeze([...MISSION_LIFECYCLE_ACTIONS, ...MISSION_TOOL_ACTIONS, ...READ_ACTIONS, ...PRODUCT_READ_ACTIONS, ...MESSAGING_PREPARE_ACTIONS]),
  ACCOUNT_EXECUTIVE: Object.freeze([...MISSION_LIFECYCLE_ACTIONS, ...MISSION_TOOL_ACTIONS, ...READ_ACTIONS, ...PRODUCT_READ_ACTIONS, ...MONITORING_ACTIONS, ...MESSAGING_PREPARE_ACTIONS]),
  ACCOUNT_MANAGER_KAM: Object.freeze<readonly ActionRef[]>(['mission:read', ...READ_ACTIONS, ...PRODUCT_READ_ACTIONS, ...MONITORING_ACTIONS]),
  HEAD_OF_SALES: Object.freeze<readonly ActionRef[]>(['mission:read', ...READ_ACTIONS, ...PRODUCT_READ_ACTIONS, ...MONITORING_ACTIONS]),
})

/**
 * La SEULE politique d'espace stricte consommée par JS-020 : externalAI, et
 * UNIQUEMENT pour les actions qui invoquent réellement une IA externe —
 * l'enrichissement web (Claude/web) et, depuis B2B-1, la génération de
 * brouillon `messaging:prepare` (rédacteur contraint B2A via la passerelle
 * gouvernée). Les autres drapeaux hérités (messaging, leads, sequences,
 * validate) restent des indices UI — JAMAIS de l'autorité d'exécution : le
 * drapeau hérité `messaging` n'autorise NI ne bloque `messaging:prepare`.
 */
export function actionRequiresExternalAI(action: ActionRef): boolean {
  return action === 'mission:enrich_companies' || action === 'messaging:prepare'
}

/**
 * Politique INTRINSÈQUE de l'espace PROPRE de l'administrateur (R1-1).
 *
 * ⚠️ Clé : l'IDENTIFIANT d'espace (`'admin'`, ADMIN_TENANT_ID), JAMAIS le
 * genre de tenant. L'espace propre de l'admin n'a pas de ligne
 * prospector_workspaces — doctrine existante : « il l'utilise sans
 * restriction » (route external-ai). Cette constante aligne le verdict JS-020
 * sur cette doctrine, à la FRONTIÈRE d'entrée d'autorité — jamais dans
 * l'accesseur strict, qui continue de dire ce qui est réellement persisté.
 * Un admin travaillant DANS un espace CLIENT sélectionné obéit à la politique
 * stricte de CET espace. Les quatre drapeaux hérités sont posés à FALSE :
 * JS-020 ne consomme qu'externalAI, et l'exception intrinsèque ne doit jamais
 * promouvoir les indices UI en autorité.
 */
export const INTRINSIC_ADMIN_WORKSPACE_POLICY: WorkspacePolicyRead = Object.freeze({
  ok: true as const,
  state: 'CONFIGURED' as const,
  permissions: Object.freeze({
    messaging: false, leads: false, sequences: false, validate: false, externalAI: true,
  }),
})

/** Lecture STRICTE de la politique d'espace — quatre issues, jamais confondues. */
export type WorkspacePolicyRead =
  | { ok: true; state: 'CONFIGURED'; permissions: WorkspacePermissions }
  | { ok: true; state: 'NOT_CONFIGURED' }
  | { ok: true; state: 'INVALID' }
  | { ok: false; state: 'UNAVAILABLE' }

export type BlockReason =
  | 'ROLE_ASSIGNMENT_INVALID'
  | 'ROLE_ASSIGNMENT_UNAVAILABLE'
  | 'CAPABILITY_FORBIDDEN'
  | 'WORKSPACE_POLICY_DENIED'
  | 'WORKSPACE_POLICY_UNAVAILABLE'
  | 'MISSION_SCOPE_DENIED'

export type PermissionVerdict =
  | { state: 'ALLOWED'; roleKind: RoleKind; action: ActionRef; resourceScope: ResourceScopeV0 }
  | { state: 'APPROVAL_REQUIRED'; reason: 'APPROVAL_REQUIRED'; roleKind: RoleKind; action: ActionRef; resourceScope: ResourceScopeV0 }
  | { state: 'BLOCKED'; reason: BlockReason; roleKind?: RoleKind; action: ActionRef; resourceScope: ResourceScopeV0 }
  | { state: 'SALES_ROLE_UNASSIGNED'; action: ActionRef; resourceScope: ResourceScopeV0 }

export interface PermissionEvaluationInput {
  role: RoleResolution
  /** Chaîne d'action — inconnue ⇒ CAPABILITY_FORBIDDEN (registre fermé). */
  action: string
  /**
   * Lecture stricte de la politique d'espace. OBLIGATOIRE quand l'action
   * l'exige ; absente dans ce cas ⇒ WORKSPACE_POLICY_UNAVAILABLE (fail closed).
   */
  workspacePolicy?: WorkspacePolicyRead
  /** Périmètre Mission courant — `{ ok:false }` ⇒ MISSION_SCOPE_DENIED. */
  missionScope?: { ok: boolean }
  /** Exigence d'approbation CANONIQUE (SEC-004) de l'action évaluée. */
  needsApproval?: boolean
}

/**
 * Évalue le verdict — PUR, déterministe, ordre d'évaluation FIGÉ.
 *
 * ⚠️ L'ORDRE EST LA SÉCURITÉ (§11 du ticket) : sur /run, ce verdict est rendu
 * AVANT toute consommation d'approbation SEC-004 — un rôle révoqué ou une
 * politique retirée APRÈS l'accord refuse l'exécution SANS brûler l'accord.
 */
export function evaluatePermission(input: PermissionEvaluationInput): PermissionVerdict {
  const scope = RESOURCE_SCOPE_ALL_WORKSPACE
  const actionConnue = isActionRef(input.action)
  const action: ActionRef = actionConnue ? (input.action as ActionRef) : 'mission:read'

  // 1 — rôle canonique. Inconnu ≠ invalide ≠ indisponible : trois refus typés.
  if (input.role.state === 'UNASSIGNED') {
    return { state: 'SALES_ROLE_UNASSIGNED', action: actionConnue ? action : ('mission:read' as ActionRef), resourceScope: scope }
  }
  if (input.role.state === 'INVALID') {
    return { state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_INVALID', action, resourceScope: scope }
  }
  if (input.role.state === 'UNAVAILABLE') {
    return { state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_UNAVAILABLE', action, resourceScope: scope }
  }
  const roleKind = input.role.roleKind

  // 2 — capacité rôle × action. Action inconnue OU paire absente ⇒ interdit.
  if (!actionConnue || !ROLE_ACTION_POLICY[roleKind].includes(action)) {
    return { state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN', roleKind, action, resourceScope: scope }
  }

  // 3 — politique d'espace exigée par L'ACTION (externalAI, strictement).
  //     Seul `externalAI === true` EXPLICITE permet ; false, absent, invalide,
  //     non fourni ⇒ refus. Jamais le repli tout-vrai hérité ici.
  if (actionRequiresExternalAI(action)) {
    const p = input.workspacePolicy
    if (!p) {
      return { state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE', roleKind, action, resourceScope: scope }
    }
    if (p.ok === false) {
      return { state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE', roleKind, action, resourceScope: scope }
    }
    if (p.state !== 'CONFIGURED' || p.permissions.externalAI !== true) {
      return { state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED', roleKind, action, resourceScope: scope }
    }
  }

  // 4 — périmètre Mission / étape courante.
  if (input.missionScope && input.missionScope.ok === false) {
    return { state: 'BLOCKED', reason: 'MISSION_SCOPE_DENIED', roleKind, action, resourceScope: scope }
  }

  // 5 — exigence d'approbation canonique : atteinte SEULEMENT ici.
  if (input.needsApproval === true) {
    return { state: 'APPROVAL_REQUIRED', reason: 'APPROVAL_REQUIRED', roleKind, action, resourceScope: scope }
  }
  return { state: 'ALLOWED', roleKind, action, resourceScope: scope }
}

/**
 * AllowedAction — PROJECTION DE LECTURE, jamais une autorité.
 * Aucun jeton, aucune preuve, aucun approvalId, aucun nonce : aucune route
 * d'exécution n'accepte cet objet du client — l'exécution ré-évalue toujours.
 */
export interface AllowedAction {
  readonly action: ActionRef
  readonly state: PermissionVerdict['state']
  readonly reason?: string
  readonly resourceScope: ResourceScopeV0
}

export function buildAllowedActions(
  role: RoleResolution,
  workspacePolicy: WorkspacePolicyRead,
): AllowedAction[] {
  return ACTION_REFS.map((action) => {
    const v = evaluatePermission({ role, action, workspacePolicy })
    return {
      action,
      state: v.state,
      ...(v.state === 'BLOCKED' || v.state === 'APPROVAL_REQUIRED' ? { reason: v.reason } : {}),
      resourceScope: RESOURCE_SCOPE_ALL_WORKSPACE,
    }
  })
}
