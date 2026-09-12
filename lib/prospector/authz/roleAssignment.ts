// JS-020_PERMISSION_CONTROL_V0_001 — AFFECTATION CANONIQUE DE RÔLE SALES.
//
// ── LA SOURCE D'AUTORITÉ DU RÔLE, ET ELLE SEULE ─────────────────────────────
// Le RoleKind canonique d'un acteur vient EXCLUSIVEMENT du document
// d'affectation par espace (kind serveur `workspace_role_assignment`).
// Ne sont JAMAIS consultés comme autorité de rôle :
//   - la SessionRole d'infrastructure (admin/client) ;
//   - l'indice hérité du contexte runtime proactif ;
//   - les RoleCards (projection descriptive, JS-006) ;
//   - la Motion Commerciale (taxonomie, JS-011) ;
//   - le vocabulaire de capacités du moteur proactif.
//
// INCONNU ÉCHOUE FERMÉ : aucun rôle par défaut, jamais. Un acteur absent du
// document est UNASSIGNED ; une valeur hors de l'union fermée est INVALID ;
// un magasin muet est UNAVAILABLE — trois états DISTINCTS, chacun refusant.
//
// MODULE PUR : types, constantes gelées, validation locale déterministe.
// Import de TYPE uniquement depuis roleCard (effacé à l'émission) — le
// vocabulaire RoleKind n'est pas dupliqué, il est RÉUTILISÉ.
import type { RoleKind } from '../proactive/roles/roleCard'

export const ROLE_ASSIGNMENT_SCHEMA_VERSION = 'role-assignment-v0.1'

/**
 * Valeurs runtime de l'union fermée RoleKind.
 *
 * ⚠️ Le TYPE vient de roleCard ; cette liste est TYPÉE contre lui — ajouter
 * ou retirer une valeur casse la compilation, et un test de parité verrouille
 * l'égalité avec le registre JS-006. Aucune redéfinition de l'union.
 */
export const ROLE_KINDS: readonly RoleKind[] = Object.freeze([
  'SDR_BDR',
  'ACCOUNT_EXECUTIVE',
  'ACCOUNT_MANAGER_KAM',
  'HEAD_OF_SALES',
] as const)

export function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === 'string' && (ROLE_KINDS as readonly string[]).includes(value)
}

/** Document d'affectation persisté — métadonnées SERVEUR, jamais client. */
export interface RoleAssignmentDocument {
  readonly schemaVersion: typeof ROLE_ASSIGNMENT_SCHEMA_VERSION
  readonly revisionId: string
  readonly updatedAt: string
  readonly assignments: Readonly<Record<string, RoleKind>>
}

function texteNonBlanc(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Valide la MAP d'affectations fournie par un administrateur (entrée PUT).
 * Clés = actorId non blancs ; valeurs = RoleKind de l'union fermée.
 * Toute anomalie refuse l'ensemble — pas de réparation partielle.
 */
export function validateAssignmentsInput(
  input: unknown,
): { ok: true; assignments: Record<string, RoleKind> } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'assignments_invalid' }
  }
  const sortie: Record<string, RoleKind> = {}
  for (const [actorId, role] of Object.entries(input as Record<string, unknown>)) {
    if (!texteNonBlanc(actorId)) return { ok: false, reason: 'actor_id_invalid' }
    if (!isRoleKind(role)) return { ok: false, reason: `role_invalid:${String(role).slice(0, 40)}` }
    sortie[actorId] = role
  }
  return { ok: true, assignments: sortie }
}

/**
 * Valide un document PERSISTÉ relu du magasin — validation de contrat à la
 * lecture (structurelle, locale, déterministe). Jamais une revalidation métier.
 */
export function validateRoleAssignmentDocument(
  input: unknown,
): { ok: true; document: RoleAssignmentDocument } | { ok: false } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  const d = input as Record<string, unknown>
  if (d.schemaVersion !== ROLE_ASSIGNMENT_SCHEMA_VERSION) return { ok: false }
  if (!texteNonBlanc(d.revisionId)) return { ok: false }
  if (!texteNonBlanc(d.updatedAt) || !Number.isFinite(Date.parse(d.updatedAt as string))) return { ok: false }
  const v = validateAssignmentsInput(d.assignments)
  if (v.ok === false) return { ok: false }
  return { ok: true, document: d as unknown as RoleAssignmentDocument }
}

/**
 * Résolution du rôle d'UN acteur — quatre issues DISTINCTES, jamais confondues.
 * `UNASSIGNED` (pas de document, ou acteur absent d'un document valide) appelle
 * une affectation ; `INVALID` appelle une réparation ; `UNAVAILABLE` appelle un
 * réessai. Aucune ne donne un rôle.
 */
export type RoleResolution =
  | { readonly state: 'ASSIGNED'; readonly roleKind: RoleKind }
  | { readonly state: 'UNASSIGNED' }
  | { readonly state: 'INVALID' }
  | { readonly state: 'UNAVAILABLE' }

export const ROLE_UNASSIGNED: RoleResolution = Object.freeze({ state: 'UNASSIGNED' as const })
export const ROLE_INVALID: RoleResolution = Object.freeze({ state: 'INVALID' as const })
export const ROLE_UNAVAILABLE: RoleResolution = Object.freeze({ state: 'UNAVAILABLE' as const })
