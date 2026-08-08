import type { NextApiRequest, NextApiResponse } from 'next'
import { listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setClientPassword } from '../../../lib/supabase/workspaces'
import { isAdminRequest } from '../../../lib/auth/guard'
import { adminWorkspaceView } from '../../../lib/prospector/workspaceView'

// Route d'ADMINISTRATION des espaces clients. Toutes méthodes confondues.
//
// ⚠️ DÉFAUT CORRIGÉ (lot SEC-0). Le branchement `GET` précédait `isAdminRequest`,
// et le middleware n'exige qu'une session VALIDE — pas une session admin. Un
// client authentifié obtenait donc la liste de tous les espaces : identifiants,
// noms, plans, emails clients, statuts, permissions. L'EXISTENCE même d'un autre
// client est une information qu'un client ne doit pas pouvoir obtenir.
//
// Aucune vue client n'a été ajoutée en remplacement : le seul consommateur de
// cette route est `pages/admin.tsx`. Le client obtient son propre espace par
// `/api/auth/me` et son option de sélecteur par `/api/workspaces/active` —
// tous deux déjà bornés à son espace.
//
// GET → liste · POST création · PATCH maj · DELETE suppr — ADMIN pour tout.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Le garde vient AVANT tout branchement de méthode : c'est la forme qui ne
  // peut pas se retrouver contournée par l'ajout d'une méthode future.
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  if (req.method === 'GET') {
    // Projection EXPLICITE. Une ligne de base ne part jamais telle quelle vers
    // le navigateur : les colonnes que SEC-1 et MT-1 ajouteront (credential,
    // budget) ne peuvent pas se publier ici sans qu'on l'écrive.
    const list = await listWorkspaces()
    return res.status(200).json({ workspaces: list.map(adminWorkspaceView) })
  }
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const name = String(body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nom requis.' })
    const ws = await createWorkspace(name, String(body?.plan || 'Starter'))
    return res.status(200).json({ workspace: ws })
  }
  if (req.method === 'PATCH') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const id = String(body?.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    // Définition du mot de passe client (optionnel)
    if (typeof body?.clientPassword === 'string' && body.clientPassword.length >= 8) {
      await setClientPassword(id, body.clientPassword)
    }
    const ws = await updateWorkspace(id, body?.patch || {})
    return res.status(200).json({ workspace: ws })
  }
  if (req.method === 'DELETE') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
    const id = String(body?.id || req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id requis.' })
    const ok = await deleteWorkspace(id)
    return res.status(200).json({ ok })
  }
  res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
