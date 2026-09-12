// JS-020_PERMISSION_CONTROL_V0_001 — PERSISTANCE DES AFFECTATIONS DE RÔLE.
//
// ── kind SERVEUR UNIQUEMENT ─────────────────────────────────────────────────
// `workspace_role_assignment` est ABSENT des whitelists client de /api/store
// (lecture ET écriture), et ne doit JAMAIS les rejoindre : c'est un document
// d'AUTORITÉ. Il ne s'écrit que par l'API dédiée (session d'infrastructure
// admin), il ne se lit côté produit que par le résolveur ci-dessous.
//
// ── LECTURE PAR REQUÊTE, PAS DE CACHE ───────────────────────────────────────
// La session est un HMAC apatride de 12 h sans révocation : mettre le rôle en
// session (ou en cache) donnerait 12 h de fenêtre à un rôle retiré. Le
// document est relu STRICTEMENT à chaque évaluation d'autorité — la
// révocation prend effet à la requête suivante.
import { randomUUID } from 'node:crypto'

import { getItemStrict, upsertItem } from '../../supabase/store'
import {
  ROLE_ASSIGNMENT_SCHEMA_VERSION,
  ROLE_INVALID,
  ROLE_UNASSIGNED,
  ROLE_UNAVAILABLE,
  validateAssignmentsInput,
  validateRoleAssignmentDocument,
  type RoleAssignmentDocument,
  type RoleResolution,
} from './roleAssignment'

export const ROLE_ASSIGNMENT_KIND = 'workspace_role_assignment'
export const ACTIVE_ASSIGNMENT_ID = 'active'

/**
 * Résout le RoleKind canonique d'un acteur dans un espace.
 *
 * Règles, toutes FAIL CLOSED :
 *   document absent            → UNASSIGNED
 *   acteur absent (doc valide) → UNASSIGNED
 *   document malformé / rôle
 *   hors union fermée          → INVALID
 *   magasin muet               → UNAVAILABLE
 * Aucun défaut (ni SDR, ni sales_rep) ; l'admin d'infrastructure n'est JAMAIS
 * promu HEAD_OF_SALES — s'il n'est pas affecté, il est UNASSIGNED comme tout
 * acteur. L'actorId vient de la session ; jamais du corps ni de la query.
 */
export async function resolveSalesRole(ws: string, actorId: string): Promise<RoleResolution> {
  if (typeof ws !== 'string' || !ws.trim()) return ROLE_UNASSIGNED
  if (typeof actorId !== 'string' || !actorId.trim()) return ROLE_UNASSIGNED

  const lu = await getItemStrict<unknown>(ROLE_ASSIGNMENT_KIND, ACTIVE_ASSIGNMENT_ID, ws)
  if (lu.ok === false) return ROLE_UNAVAILABLE
  // ABSENT ≠ MALFORMÉ (doctrine JS-012 R1) : null = aucune ligne ; toute autre
  // valeur est une ligne existante qui doit passer la validation de contrat.
  if (lu.value === null) return ROLE_UNASSIGNED

  const v = validateRoleAssignmentDocument(lu.value)
  if (v.ok === false) return ROLE_INVALID

  const role = v.document.assignments[actorId]
  if (role === undefined) return ROLE_UNASSIGNED
  return { state: 'ASSIGNED', roleKind: role }
}

/**
 * Enregistre la map d'affectations d'un espace — métadonnées CONSTRUITES ICI
 * (version de schéma, revisionId UUID serveur, horodatage serveur). Le client
 * ne fournit que la map ; rien d'autre ne survit. Remplacement entier,
 * dernier-écrit-gagnant assumé (même doctrine que JS-012 : identifiant de
 * révision OPAQUE, aucune séquence prétendue).
 */
export async function saveRoleAssignments(
  input: unknown,
  ws: string,
): Promise<{ ok: true; revisionId: string } | { ok: false; reason: string }> {
  if (typeof ws !== 'string' || !ws.trim()) return { ok: false, reason: 'workspace_missing' }

  const v = validateAssignmentsInput(input)
  if (v.ok === false) return { ok: false, reason: v.reason }

  const document: RoleAssignmentDocument = {
    schemaVersion: ROLE_ASSIGNMENT_SCHEMA_VERSION,
    revisionId: randomUUID(),
    updatedAt: new Date().toISOString(),
    assignments: v.assignments,
  }
  const ecrit = await upsertItem(ROLE_ASSIGNMENT_KIND, ACTIVE_ASSIGNMENT_ID, document, ws)
  if (!ecrit) return { ok: false, reason: 'store_write_failed' }
  return { ok: true, revisionId: document.revisionId }
}
