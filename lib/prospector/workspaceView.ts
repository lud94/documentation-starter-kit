// Projections d'espace client — lot SEC-0.
//
// ── LE DÉFAUT CORRIGÉ ────────────────────────────────────────────────────────
// `GET /api/workspaces` branchait sur la méthode AVANT d'appeler
// `isAdminRequest`. Le middleware n'exige qu'une session VALIDE, pas une session
// admin : un client authentifié obtenait donc la liste de tous les espaces —
// identifiants, noms, plans, emails clients, statuts et permissions. L'existence
// même de Client B est une information que Fabel ne doit pas obtenir.
//
// ── POURQUOI UN MODULE DE VUES, ET PAS SEULEMENT UN GARDE ────────────────────
// Le garde referme la porte d'aujourd'hui. Il ne dit rien de ce qui sortira
// demain par cette route. `rowToWs()` (lib/supabase/workspaces.ts) est déjà une
// projection explicite — mais c'est le MAPPEUR DE STOCKAGE : sa vocation est de
// rendre la ligne utilisable côté serveur, et il grandira naturellement avec le
// schéma. Le jour où SEC-1 ajoutera `credential_ref` et MT-1 `budget_micros`, un
// champ ajouté là pour un besoin serveur légitime traverserait la route
// jusqu'au navigateur, sans que personne n'ait décidé de le publier.
//
// D'où deux couches distinctes, et c'est la seule raison d'être de ce fichier :
//
//   rowToWs()            ligne DB → objet SERVEUR      (peut tout porter)
//   adminWorkspaceView() objet serveur → JSON ADMIN    (liste blanche)
//   workspaceOption()    objet serveur → SÉLECTEUR     (liste blanche)
//
// Une vue ne construit JAMAIS son résultat par copie (`{...ws}`, `delete`,
// `omit`) : elle nomme un par un les champs qu'elle publie. Une liste noire
// oublie ce qu'elle ne connaît pas encore ; une liste blanche ne peut pas.
//
// ⚠️ AUCUNE VUE CLIENT DE LA LISTE N'EXISTE, ET C'EST DÉLIBÉRÉ. Un client n'a
// aucun besoin de la route de liste : `/api/auth/me` lui rend déjà son propre
// espace et ses permissions, et `/api/workspaces/active` lui rend son unique
// option. Ajouter ici une `clientWorkspaceView()` créerait une surface que rien
// ne consomme — donc une surface que personne ne surveillerait.
import type { Workspace, WorkspacePermissions } from '../../types/prospector'

/** Ce qu'un ADMIN reçoit pour un espace. Rien de plus n'est publié. */
export interface AdminWorkspaceView {
  id: string
  name: string
  leads: number
  users: number
  plan: string
  clientEmail?: string
  status: 'active' | 'suspended'
  permissions?: WorkspacePermissions
  hasClientAccess: boolean
}

/** Entrée du sélecteur d'espace. Deux champs, parce que deux suffisent. */
export interface WorkspaceOption {
  id: string
  name: string
}

/**
 * Vue Admin d'un espace.
 *
 * Champs énumérés un par un. `client_password_hash` n'y figure pas — et ne peut
 * pas y arriver par accident, puisque rien n'est copié en bloc.
 */
export function adminWorkspaceView(ws: Workspace): AdminWorkspaceView {
  return {
    id: ws.id,
    name: ws.name,
    leads: ws.leads ?? 0,
    users: ws.users ?? 1,
    plan: ws.plan,
    clientEmail: ws.clientEmail,
    status: ws.status === 'suspended' ? 'suspended' : 'active',
    permissions: ws.permissions,
    hasClientAccess: !!ws.hasClientAccess,
  }
}

/**
 * Entrée de sélecteur. Sert les DEUX branches d'`/api/workspaces/active` :
 * la liste complète de l'admin et l'option unique du client. Une seule fonction
 * pour les deux, afin qu'un champ ajouté un jour n'apparaisse pas dans l'une
 * sans que l'autre soit relue.
 */
export function workspaceOption(ws: Pick<Workspace, 'id' | 'name'>): WorkspaceOption {
  return { id: ws.id, name: ws.name }
}
