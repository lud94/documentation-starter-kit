// SEC-004_MISSION_EXEC_AUTHORITY_V0_001 — APPROBATIONS DE MISSION.
//
// ── APPROBATION DEMANDÉE ≠ ACCORDÉE ≠ EXÉCUTION ≠ COMPLÉTION ────────────────
// Avant ce lot, « approuver » était un booléen du corps de requête : n'importe
// quelle session de l'espace pouvait exécuter l'étape courante en envoyant
// `approve: true`, sans trace de QUI a approuvé QUOI. L'approbation devient un
// OBJET SERVEUR distinct :
//
//   write-once   `insertItemIfAbsent` — une approbation ne s'écrase pas ;
//   exactement   liée à acteur + espace + mission + étape + outil + empreinte
//   liée         canonique des paramètres — si l'action exécutable change,
//                l'identifiant attendu change, et rien ne se consomme ;
//   consume-once `claimItemIfField(state='granted')` — suppression atomique
//                conditionnelle : deux consommations concurrentes ne peuvent
//                réussir qu'UNE fois.
//
// ⚠️ Le `kind` est SERVEUR UNIQUEMENT : absent de la whitelist client de
// `/api/store` (et cette liste ne doit jamais l'accueillir). Le magasin
// générique n'est PAS append-only ; c'est la discipline de CE module —
// insertion-seule puis claim atomique — qui donne à l'objet d'approbation ses
// garanties, pas la table.
import { createHash } from 'node:crypto'

import { claimItemIfField, getItemStrict, insertItemIfAbsent } from '../supabase/store'

export const MISSION_APPROVAL_KIND = 'mission_approval'
export const MISSION_APPROVAL_VERSION = 'mission-approval-v0.1'

export interface MissionApprovalRecord {
  readonly schemaVersion: typeof MISSION_APPROVAL_VERSION
  readonly state: 'granted'
  readonly actorId: string
  readonly workspaceId: string
  readonly missionId: string
  /** R2 — instance de CRÉATION serveur de la mission : delete + recréation du
   *  même missionId ⇒ instance différente ⇒ liaison différente. */
  readonly missionAuthorityInstance: string
  readonly stepId: string
  readonly tool: string
  readonly actionFingerprint: string
  readonly grantedAt: string
}

/**
 * Identifiant DÉTERMINISTE de l'approbation — dérivé de la liaison COMPLÈTE.
 *
 * C'est lui qui rend la liaison exacte : l'exécution recalcule l'identifiant
 * ATTENDU depuis l'état serveur COURANT (acteur de la requête, espace résolu,
 * mission relue, étape au curseur, empreinte recalculée). Un acteur différent,
 * une étape différente, des paramètres modifiés ⇒ identifiant différent ⇒
 * l'approbation accordée reste introuvable, et RIEN ne s'exécute. L'ordre des
 * champs est fixé ici — jamais dépendant d'un ordre d'insertion JSON.
 */
export function approvalId(binding: {
  actorId: string
  workspaceId: string
  missionId: string
  missionAuthorityInstance: string
  stepId: string
  actionFingerprint: string
}): string {
  const canonique = [
    MISSION_APPROVAL_VERSION,
    binding.actorId,
    binding.workspaceId,
    binding.missionId,
    binding.missionAuthorityInstance,
    binding.stepId,
    binding.actionFingerprint,
  ].join('\n')
  return `apr_${createHash('sha256').update(canonique, 'utf8').digest('hex').slice(0, 40)}`
}

/**
 * Le contenu d'un enregistrement persisté correspond-il EXACTEMENT à la
 * liaison attendue ? (R1-2)
 *
 * UNE seule règle, partagée par l'accord (classification d'un rejeu) et la
 * consommation (vérification post-claim) : deux règles divergeraient. L'égalité
 * d'identifiant ne suffit JAMAIS — l'identifiant n'est qu'une adresse ; c'est
 * le CONTENU persisté qui doit affirmer la même liaison, champ par champ.
 */
export function approvalRecordMatches(
  record: unknown,
  expected: {
    actorId: string
    workspaceId: string
    missionId: string
    missionAuthorityInstance: string
    stepId: string
    tool: string
    actionFingerprint: string
  },
): record is MissionApprovalRecord {
  if (!record || typeof record !== 'object') return false
  const r = record as Record<string, unknown>
  return (
    r.schemaVersion === MISSION_APPROVAL_VERSION &&
    r.state === 'granted' &&
    r.actorId === expected.actorId &&
    r.workspaceId === expected.workspaceId &&
    r.missionId === expected.missionId &&
    r.missionAuthorityInstance === expected.missionAuthorityInstance &&
    r.stepId === expected.stepId &&
    r.tool === expected.tool &&
    r.actionFingerprint === expected.actionFingerprint
  )
}

/**
 * ACCORDE une approbation — write-once, jamais un upsert.
 *
 * Rejouer le même geste (même liaison) rend `alreadyGranted` : l'approbation
 * existante n'est ni réécrite ni ré-horodatée. Aucune exécution ici.
 */
export async function grantApproval(
  binding: {
    actorId: string
    workspaceId: string
    missionId: string
    missionAuthorityInstance: string
    stepId: string
    tool: string
    actionFingerprint: string
  },
  nowMs: number,
): Promise<{ ok: true; approvalId: string; alreadyGranted: boolean } | { ok: false; reason: 'store_write_failed' }> {
  const id = approvalId(binding)
  const record: MissionApprovalRecord = {
    schemaVersion: MISSION_APPROVAL_VERSION,
    state: 'granted',
    actorId: binding.actorId,
    workspaceId: binding.workspaceId,
    missionId: binding.missionId,
    missionAuthorityInstance: binding.missionAuthorityInstance,
    stepId: binding.stepId,
    tool: binding.tool,
    actionFingerprint: binding.actionFingerprint,
    grantedAt: new Date(nowMs).toISOString(),
  }
  const inserted = await insertItemIfAbsent(MISSION_APPROVAL_KIND, id, record, binding.workspaceId)
  if (inserted) return { ok: true, approvalId: id, alreadyGranted: false }
  // Insertion refusée : soit la liaison est DÉJÀ approuvée (rejeu du geste),
  // soit la base est muette. On distingue par une LECTURE STRICTE — jamais un
  // claim, qui consommerait. `alreadyGranted` n'est prononcé que si la ligne
  // relue est INTÉGRALEMENT valide et porte EXACTEMENT la liaison attendue
  // (R1-2) : `state === 'granted'` seul ne prouve rien — une ligne malformée
  // ou à la mauvaise liaison sous le bon identifiant est un échec explicite,
  // jamais une approbation. Base muette ou ligne absente ⇒ échec : on
  // n'annonce jamais une approbation que rien ne stocke.
  const relu = await getItemStrict<MissionApprovalRecord>(MISSION_APPROVAL_KIND, id, binding.workspaceId)
  if (relu.ok === true && approvalRecordMatches(relu.value, binding)) {
    return { ok: true, approvalId: id, alreadyGranted: true }
  }
  return { ok: false, reason: 'store_write_failed' }
}

/**
 * CONSOMME l'approbation exacte — atomique, une seule fois.
 *
 * `claimItemIfField(…, 'state', 'granted')` supprime la ligne SEULEMENT si son
 * état est encore `granted`, et rend son contenu. Deux exécutions concurrentes
 * ne peuvent en obtenir qu'une. La liaison est ensuite RE-vérifiée champ par
 * champ contre l'attendu recalculé : une ligne forgée sous le bon identifiant
 * mais au mauvais contenu ne s'exécute pas. Toute incertitude ⇒ refus.
 */
export async function consumeApproval(
  expected: {
    actorId: string
    workspaceId: string
    missionId: string
    missionAuthorityInstance: string
    stepId: string
    tool: string
    actionFingerprint: string
  },
  presentedApprovalId: string,
): Promise<{ ok: true } | {
  ok: false
  reason: 'approval_id_mismatch' | 'approval_missing_or_consumed' | 'approval_binding_mismatch'
}> {
  const id = approvalId(expected)
  // ── R1-1 : L'IDENTIFIANT PRÉSENTÉ DOIT ÊTRE LE BON, AVANT TOUT CLAIM. ────
  // L'identifiant n'est pas un drapeau d'opt-in : présenter `apr_wrong` ne
  // doit ni exécuter, ni CONSOMMER l'accord légitime. La comparaison précède
  // la moindre lecture du magasin — un identifiant faux ne touche à rien.
  if (presentedApprovalId !== id) return { ok: false, reason: 'approval_id_mismatch' }

  const claimed = await claimItemIfField<MissionApprovalRecord>(
    MISSION_APPROVAL_KIND, id, expected.workspaceId, 'state', 'granted',
  )
  if (!claimed) return { ok: false, reason: 'approval_missing_or_consumed' }

  // R1-2 : MÊME règle de correspondance que l'accord — jamais deux variantes.
  if (!approvalRecordMatches(claimed, expected)) {
    return { ok: false, reason: 'approval_binding_mismatch' }
  }
  return { ok: true }
}
