// JS-020_PERMISSION_CONTROL_V0_001 — PROJECTION ET ADMINISTRATION DES PERMISSIONS.
//
// ── GET : PROJECTION DE LECTURE, JAMAIS UNE AUTORITÉ ────────────────────────
// Rend le rôle Sales canonique de l'ACTEUR COURANT et la projection
// AllowedAction du registre d'actions fermé. Aucun jeton, aucune preuve :
// aucune route d'exécution n'accepte cette projection en entrée — chaque
// exécution ré-évalue le verdict depuis l'état serveur courant (TOCTOU).
//
// LECTURE ≠ REVALIDATION : résolution de session, lecture stricte du document
// d'affectation, lecture stricte de la politique d'espace, évaluation locale
// pure. Aucun LLM, aucun web, aucune recapture, aucune mutation.
//
// ── PUT : SESSION D'INFRASTRUCTURE ADMIN UNIQUEMENT ─────────────────────────
// Maintient le document d'affectation de l'espace ACTIF (résolution serveur —
// jamais un espace du corps). Le client ne fournit que la map
// {actorId → RoleKind} ; schéma, revisionId et horodatage sont serveur. Une
// session client ne peut PAS écrire. Le kind reste ABSENT des whitelists du
// magasin générique.
import type { NextApiRequest, NextApiResponse } from 'next'

import { ADMIN_TENANT_ID, resolveActorFromRequest } from '../../lib/prospector/tenant'
import { getWorkspacePermissionsStrict } from '../../lib/supabase/workspaces'
import { resolveSalesRole, saveRoleAssignments } from '../../lib/prospector/authz/roleAssignmentStore'
import {
  buildAllowedActions,
  INTRINSIC_ADMIN_WORKSPACE_POLICY,
  RESOURCE_SCOPE_ALL_WORKSPACE,
} from '../../lib/prospector/authz/permissionVerdict'
import { logSafeError, PUBLIC_ERROR } from '../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'GET/PUT only' })
  }

  // Acteur ET espace viennent de la session — jamais du corps ni de la query.
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ error: 'forbidden' })
  const ws = acteur.tenant.id

  try {
    if (req.method === 'PUT') {
      // Autorité d'ÉCRITURE : session d'infrastructure admin uniquement. Le
      // rôle Sales ne donne PAS ce droit — administrer la plateforme et
      // opérer un rôle métier restent deux taxonomies séparées.
      if (acteur.tenant.kind !== 'admin') {
        return res.status(403).json({ error: 'admin_session_required' })
      }
      const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
      const ecrit = await saveRoleAssignments(body?.assignments, ws)
      if (ecrit.ok === false) {
        const code = ecrit.reason === 'store_write_failed' ? 503 : 422
        return res.status(code).json({ error: ecrit.reason })
      }
      // État RELU, jamais déduit de l'écriture.
    }

    const role = await resolveSalesRole(ws, acteur.actorId)
    // R1-1 — l'espace PROPRE de l'admin (IDENTIFIANT, jamais le genre de
    // tenant) porte l'autorisation externalAI intrinsèque, alignée sur la
    // route external-ai ; tout autre espace projette sa politique STRICTE.
    const politique = ws === ADMIN_TENANT_ID
      ? INTRINSIC_ADMIN_WORKSPACE_POLICY
      : await getWorkspacePermissionsStrict(ws)
    return res.status(200).json({
      actorRole: role.state === 'ASSIGNED'
        ? { state: 'ASSIGNED', roleKind: role.roleKind }
        : { state: role.state },
      resourceScope: RESOURCE_SCOPE_ALL_WORKSPACE,
      allowedActions: buildAllowedActions(role, politique),
    })
  } catch (e) {
    logSafeError('permissions.failed', e, { operation: 'permissions' })
    return res.status(502).json({ error: PUBLIC_ERROR })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
