// Persistance des leads, cloisonnée par espace (workspace).
// Table `prospector_leads (id text pk, data jsonb, workspace_id text, created_at timestamptz)`.
// Règle : chacun opère dans UN espace. 'admin' = l'espace propre de l'admin.
// Le workspace est déterminé par le serveur (session + espace actif), jamais par le client.
import type { Lead } from '../../types/prospector'
import { supabase } from './client'
import { writeAllowed } from '../env'

const TABLE = 'prospector_leads'
const g = globalThis as any
const mem: Map<string, { lead: Lead; ws: string }> = g.__prospectorLeads3 || (g.__prospectorLeads3 = new Map())

export async function listLeads(ws: string): Promise<Lead[]> {
  const sb = supabase()
  if (!sb) return Array.from(mem.values()).filter((r) => r.ws === ws).map((r) => r.lead)
  try {
    const { data, error } = await sb.from(TABLE).select('data').eq('workspace_id', ws).order('created_at', { ascending: false })
    if (error || !data) return []
    return data.map((r: any) => r.data as Lead)
  } catch { return [] }
}
// Lecture STRICTE des leads.
//
// Contrairement à listLeads(), cette primitive distingue :
// - workspace réellement vide ;
// - erreur / indisponibilité de la base.
//
// Une résolution d'identité ne doit jamais transformer une panne de stockage
// en faux message "Lead introuvable".
export type StrictLeadsRead =
  | { ok: true; leads: Lead[] }
  | { ok: false }

export async function listLeadsStrict(
  ws: string,
): Promise<StrictLeadsRead> {
  const sb = supabase()

  if (!sb) {
    return {
      ok: true,
      leads: Array.from(mem.values())
        .filter((r) => r.ws === ws)
        .map((r) => r.lead),
    }
  }

  try {
    const { data, error } = await sb
      .from(TABLE)
      .select('data')
      .eq('workspace_id', ws)
      .order('created_at', { ascending: false })

    if (error || !data) {
      return { ok: false }
    }

    return {
      ok: true,
      leads: data.map((r: any) => r.data as Lead),
    }
  } catch {
    return { ok: false }
  }
}

// Motif d'échec d'écriture. Distingue le CONFLIT MÉTIER (l'identifiant appartient
// à un autre espace) de l'incident TECHNIQUE — les deux appellent des réponses
// HTTP et des messages utilisateur différents.
export type UpsertFailure = 'workspace_conflict' | 'contention' | 'db_error' | 'env_blocked'
export interface UpsertResult { ok: boolean; reason?: UpsertFailure }

// Écriture d'un lead, CLOISONNÉE PAR ESPACE.
//
// ⚠️ Défaut corrigé ici (P0). La clé primaire de prospector_leads est `id` SEUL,
// sans workspace_id — contrairement à prospector_store, partitionné par
// (kind, id, workspace_id). L'ancienne implémentation faisait un upsert avec
// onConflict:'id', si bien qu'écrire un identifiant existant écrasait la ligne ET
// déplaçait son workspace_id vers l'espace de l'appelant. La lecture et la
// suppression filtraient correctement ; l'écriture, non.
//
// La clé primaire n'est PAS modifiée dans ce lot (arbitrage produit). On obtient
// donc l'isolation par la séquence suivante, où c'est la BASE qui tranche :
//   1. update … where id = ? AND workspace_id = ?   → cas nominal, une requête
//   2. sinon insert → succès, ou violation d'unicité (23505)
//   3. sur 23505, on relit le propriétaire :
//        même espace  → course entre deux insertions concurrentes du même
//                       identifiant neuf : UNE seule reprise d'update, bornée
//        autre espace → REFUS, aucune modification
export async function upsertLeadChecked(lead: Lead, ws: string): Promise<UpsertResult> {
  if (!writeAllowed('prospector_leads')) return { ok: false, reason: 'env_blocked' }
  const sb = supabase()

  // Repli mémoire : mêmes règles d'isolation, sans concurrence réelle.
  if (!sb) {
    const existing = mem.get(lead.id)
    if (existing && existing.ws !== ws) return { ok: false, reason: 'workspace_conflict' }
    mem.set(lead.id, { lead, ws })
    return { ok: true }
  }

  const row = { id: lead.id, data: lead, workspace_id: ws, created_at: new Date().toISOString() }

  try {
    // 1. Mise à jour ciblée sur l'espace courant.
    const upd = await sb.from(TABLE).update({ data: lead, workspace_id: ws }).eq('id', lead.id).eq('workspace_id', ws).select('id')
    if (upd.error) return { ok: false, reason: 'db_error' }
    if ((upd.data?.length || 0) > 0) return { ok: true }

    // 2. Aucune ligne dans cet espace → insertion.
    const ins = await sb.from(TABLE).insert(row)
    if (!ins.error) return { ok: true }
    if ((ins.error as any).code !== '23505') return { ok: false, reason: 'db_error' }

    // 3. Violation d'unicité : l'identifiant existe. À qui appartient-il ?
    const owner = await sb.from(TABLE).select('workspace_id').eq('id', lead.id).maybeSingle()
    if (owner.error) return { ok: false, reason: 'db_error' }
    if (!owner.data) return { ok: false, reason: 'contention' } // supprimé entre-temps
    if (owner.data.workspace_id !== ws) return { ok: false, reason: 'workspace_conflict' }

    // Même espace : une insertion concurrente a gagné la course. UNE seule
    // reprise — au-delà, on remonte la contention plutôt que de masquer une
    // anomalie derrière des tentatives répétées.
    const retry = await sb.from(TABLE).update({ data: lead, workspace_id: ws }).eq('id', lead.id).eq('workspace_id', ws).select('id')
    if (retry.error) return { ok: false, reason: 'db_error' }
    return (retry.data?.length || 0) > 0 ? { ok: true } : { ok: false, reason: 'contention' }
  } catch {
    return { ok: false, reason: 'db_error' }
  }
}

// Suppression cloisonnée : on ne supprime que dans l'espace courant.
export async function deleteLead(id: string, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_leads')) return false
  const sb = supabase()
  if (!sb) { const r = mem.get(id); if (r && r.ws !== ws) return false; mem.delete(id); return true }
  try {
    const { error } = await sb.from(TABLE).delete().eq('id', id).eq('workspace_id', ws)
    return !error
  } catch { return false }
}
