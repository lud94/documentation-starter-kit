// JS-013 — PERSISTANCE DU MONITORING. Kinds SERVEUR-ONLY.
//
// ⚠️ AUCUN de ces kinds ne rejoint jamais WRITE_KINDS ni READ_KINDS du magasin
// générique (/api/store) : état de CONTRÔLE, exposé uniquement par les routes
// /api/monitoring sous verdict JS-020. Et AUCUN n'est de la vérité métier —
// le moteur de situations et le kernel ne lisent pas ces kinds.
//
// ── FAIL CLOSED (R1) ────────────────────────────────────────────────────────
// Chaque écriture est VÉRIFIÉE et chaque lecture d'autorité est STRICTE :
// « la base n'a pas répondu » n'est JAMAIS interprété comme « collection
// vide », « reçu absent » ou « écrit avec succès ». Un runtime gouverné ne
// fabrique pas de succès.
import { randomUUID } from 'node:crypto'

import {
  claimItemIfField,
  getItemStrict,
  insertItemIfAbsent,
  listItemsStrict,
  upsertItem,
} from '../../supabase/store'
import type {
  AccountMonitorV0,
  CadencePolicyV0,
  MonitoringRunResultV0,
  MonitorEvaluationReceiptV0,
} from './accountMonitor'
import {
  ACCOUNT_MONITOR_SCHEMA_VERSION,
  monitorIdFor,
} from './accountMonitor'
import type { LensId } from '../proactive/lens/registry'

export const ACCOUNT_MONITOR_KIND = 'account_monitor'
export const MONITORING_RUN_KIND = 'monitoring_run'
export const MONITOR_EVAL_RECEIPT_KIND = 'monitor_eval_receipt'
export const MONITORING_CLAIM_KIND = 'monitoring_claim'

/** Même TTL que les rappels : un bail orphelin expire, l'opération suivante reprend. */
export const MONITORING_CLAIM_TTL_MS = 10 * 60 * 1000

// ── CRÉATION — IDEMPOTENTE PAR IDENTITÉ LOGIQUE ─────────────────────────────

export type CreateMonitorResult =
  | { ok: true; monitor: AccountMonitorV0; created: true }
  | { ok: false; reason: 'monitor_already_exists'; existingId: string }
  | { ok: false; reason: 'store_write_failed' }

/**
 * Crée le moniteur ACTIVE — CREATE-ONLY. L'id est DÉRIVÉ de l'identité
 * logique (ws + accountRef + lens) : `insertItemIfAbsent` rend le doublon
 * ACTIVE structurellement impossible, sans migration. Un moniteur STOPPED du
 * même contexte occupe le même id : la recréation est un conflit EXPLICITE
 * (terminal V0, pas de résurrection silencieuse).
 */
export async function createAccountMonitor(input: {
  workspaceId: string
  accountRef: string
  lensId: LensId
  cadencePolicy: CadencePolicyV0
  createdByActorId: string
  nowMs: number
}): Promise<CreateMonitorResult> {
  const id = monitorIdFor(input.workspaceId, input.accountRef, input.lensId)
  const now = new Date(input.nowMs).toISOString()
  const monitor: AccountMonitorV0 = {
    schemaVersion: ACCOUNT_MONITOR_SCHEMA_VERSION,
    id,
    workspaceId: input.workspaceId,
    accountRef: input.accountRef,
    lensId: input.lensId,
    desiredOutcome: 'SURFACE_MATERIAL_CHANGE',
    cadencePolicy: input.cadencePolicy,
    status: 'ACTIVE',
    createdByActorId: input.createdByActorId,
    createdAt: now,
    updatedAt: now,
    revisionId: randomUUID(),
  }
  const inserted = await insertItemIfAbsent(ACCOUNT_MONITOR_KIND, id, monitor, input.workspaceId)
  if (inserted) return { ok: true, monitor, created: true }
  // Conflit OU indisponibilité : on relit pour trancher, fail closed sinon.
  const lu = await getItemStrict<AccountMonitorV0>(ACCOUNT_MONITOR_KIND, id, input.workspaceId)
  if (lu.ok && lu.value !== null) return { ok: false, reason: 'monitor_already_exists', existingId: id }
  return { ok: false, reason: 'store_write_failed' }
}

// ── LECTURES STRICTES ───────────────────────────────────────────────────────

export async function loadMonitor(
  workspaceId: string, monitorId: string,
): Promise<{ ok: true; monitor: AccountMonitorV0 | null } | { ok: false }> {
  const lu = await getItemStrict<AccountMonitorV0>(ACCOUNT_MONITOR_KIND, monitorId, workspaceId)
  if (lu.ok === false) return { ok: false }
  return { ok: true, monitor: lu.value }
}

/**
 * Liste STRICTE (R1, Fix 3-A) : « la base n'a pas répondu » ≠ « aucun
 * moniteur ». `listItems` rendrait `[]` sur panne — une fausse absence que la
 * route transformerait en 200 mensonger. Ici les deux issues restent
 * distinctes ; la route rend 503 sur { ok:false }.
 */
export async function listMonitors(
  workspaceId: string,
): Promise<{ ok: true; monitors: AccountMonitorV0[] } | { ok: false }> {
  const lu = await listItemsStrict<AccountMonitorV0>(ACCOUNT_MONITOR_KIND, workspaceId)
  if (lu.ok === false) return { ok: false }
  return { ok: true, monitors: lu.values }
}

// ── BAIL D'OPÉRATION MONITEUR — PARTAGÉ PAR RUN **ET** STOP (R1, Fix 2) ─────
//
// UN SEUL mécanisme d'exclusion pour toute opération sur un moniteur : le run
// ET l'arrêt de cycle de vie. Deux verrous distincts laisseraient un STOP
// courir SOUS un run qui ré-upserterait ensuite son objet ACTIVE périmé —
// la résurrection exacte que ce bail interdit.
//
// ── REPRISE D'UN BAIL EXPIRÉ : ATOMIQUE (R1, Fix 2-bis) ─────────────────────
// L'ancien chemin lisait le bail expiré puis UPSERTAIT sans condition : deux
// travailleurs pouvaient tous deux se croire propriétaires. Désormais la
// reprise est liée à l'INSTANCE EXACTE observée (leaseToken unique) via
// `claimItemIfField` — suppression conditionnelle atomique — puis le
// remplaçant est posé par `insertItemIfAbsent`. La propriété N'EXISTE que si
// l'insertion du bail de remplacement réussit : gagner la suppression de
// l'ancien bail ne suffit JAMAIS.

interface MonitorOperationLease {
  monitorId: string
  leaseToken: string
  claimedAt: number
  expiresAt: number
}

export type LeaseAcquisition =
  | { ok: true; leaseToken: string }
  | { ok: false; reason: 'CLAIM_HELD' | 'STORE_FAILURE' }

const leaseId = (monitorId: string) => `mclaim_${monitorId}`

export async function acquireMonitorOperationLease(
  workspaceId: string, monitorId: string, nowMs: number,
): Promise<LeaseAcquisition> {
  const id = leaseId(monitorId)
  const fraiche = (): MonitorOperationLease => ({
    monitorId, leaseToken: randomUUID(), claimedAt: nowMs, expiresAt: nowMs + MONITORING_CLAIM_TTL_MS,
  })

  // 1 — voie nominale : insertion exclusive, un seul gagnant.
  const premiere = fraiche()
  if (await insertItemIfAbsent(MONITORING_CLAIM_KIND, id, premiere, workspaceId)) {
    return { ok: true, leaseToken: premiere.leaseToken }
  }

  // 2 — un bail existe (ou la base n'a pas répondu) : lecture STRICTE.
  const lu = await getItemStrict<MonitorOperationLease>(MONITORING_CLAIM_KIND, id, workspaceId)
  if (lu.ok === false) return { ok: false, reason: 'STORE_FAILURE' }
  if (lu.value === null) {
    // Le bail a disparu entre-temps : on retente UNE insertion exclusive.
    const seconde = fraiche()
    if (await insertItemIfAbsent(MONITORING_CLAIM_KIND, id, seconde, workspaceId)) {
      return { ok: true, leaseToken: seconde.leaseToken }
    }
    return { ok: false, reason: 'CLAIM_HELD' }
  }

  // 3 — bail non expiré : détenu.
  const jeton = typeof lu.value.leaseToken === 'string' ? lu.value.leaseToken : ''
  const expire = typeof lu.value.expiresAt === 'number' && lu.value.expiresAt <= nowMs
  if (!expire || !jeton) return { ok: false, reason: 'CLAIM_HELD' }

  // 4 — bail expiré : suppression conditionnelle de l'INSTANCE EXACTE
  //     observée. Un seul contendant gagne cette suppression ; un bail plus
  //     récent (autre jeton) ne peut pas être volé.
  const supprime = await claimItemIfField<MonitorOperationLease>(
    MONITORING_CLAIM_KIND, id, workspaceId, 'leaseToken', jeton,
  )
  if (supprime === null) return { ok: false, reason: 'CLAIM_HELD' }

  // 5 — remplacement par insertion exclusive. Si un autre appelant gagne la
  //     clé dans l'intervalle suppression→insertion, NOUS ne possédons RIEN.
  const remplacement = fraiche()
  if (await insertItemIfAbsent(MONITORING_CLAIM_KIND, id, remplacement, workspaceId)) {
    return { ok: true, leaseToken: remplacement.leaseToken }
  }
  return { ok: false, reason: 'CLAIM_HELD' }
}

/** Libération CONDITIONNELLE : on ne relâche que SON PROPRE bail (jeton exact). */
export async function releaseMonitorOperationLease(
  workspaceId: string, monitorId: string, leaseToken: string,
): Promise<void> {
  await claimItemIfField(MONITORING_CLAIM_KIND, leaseId(monitorId), workspaceId, 'leaseToken', leaseToken)
}

// ── ARRÊT — SEULE TRANSITION DE CYCLE DE VIE ────────────────────────────────

/**
 * ACTIVE → STOPPED, TERMINAL. Uniquement par l'action de cycle de vie
 * autorisée (monitoring:stop) — jamais automatiquement : échec de source,
 * politique retirée, rôle perdu, cible non résolue sont des états de RUN.
 * L'appelant DOIT détenir le bail d'opération du moniteur.
 */
export async function stopMonitor(
  monitor: AccountMonitorV0, stoppedByActorId: string, nowMs: number,
): Promise<{ ok: true; monitor: AccountMonitorV0 } | { ok: false }> {
  const now = new Date(nowMs).toISOString()
  const stopped: AccountMonitorV0 = {
    ...monitor,
    status: 'STOPPED',
    stoppedAt: now,
    stoppedByActorId,
    updatedAt: now,
    revisionId: randomUUID(),
  }
  const ok = await upsertItem(ACCOUNT_MONITOR_KIND, monitor.id, stopped, monitor.workspaceId)
  return ok ? { ok: true, monitor: stopped } : { ok: false }
}

/**
 * Avance les horodatages de run — appelé UNIQUEMENT par le runner sous bail.
 *
 * DÉFENSE EN PROFONDEUR (R1, Fix 2) : le patch est appliqué sur la ligne
 * COURANTE relue STRICTEMENT, jamais sur un objet mémoire potentiellement
 * périmé — et une ligne STOPPED n'est JAMAIS réécrite : aucune écriture
 * d'horodatage ne peut ressusciter un moniteur arrêté, même si un appelant
 * futur violait la discipline du bail. Écriture VÉRIFIÉE (R1, Fix 3-B) :
 * un échec du magasin ne rend jamais un objet « comme si » persisté.
 */
export async function persistMonitorTimestamps(
  workspaceId: string,
  monitorId: string,
  patch: { lastAttemptAt?: string; lastSuccessAt?: string; lastMaterialChangeAt?: string },
  nowMs: number,
): Promise<{ ok: true; monitor: AccountMonitorV0 } | { ok: false; reason: 'STORE_FAILURE' | 'MONITOR_STOPPED' | 'MONITOR_MISSING' }> {
  const lu = await getItemStrict<AccountMonitorV0>(ACCOUNT_MONITOR_KIND, monitorId, workspaceId)
  if (lu.ok === false) return { ok: false, reason: 'STORE_FAILURE' }
  if (lu.value === null) return { ok: false, reason: 'MONITOR_MISSING' }
  if (lu.value.status !== 'ACTIVE') return { ok: false, reason: 'MONITOR_STOPPED' }
  const suivant: AccountMonitorV0 = {
    ...lu.value,
    ...patch,
    updatedAt: new Date(nowMs).toISOString(),
    revisionId: randomUUID(),
  }
  const ecrit = await upsertItem(ACCOUNT_MONITOR_KIND, monitorId, suivant, workspaceId)
  if (!ecrit) return { ok: false, reason: 'STORE_FAILURE' }
  return { ok: true, monitor: suivant }
}

// ── RUNS ET REÇUS — ÉCRITURES VÉRIFIÉES ─────────────────────────────────────

export async function persistRunResult(run: MonitoringRunResultV0): Promise<boolean> {
  return upsertItem(MONITORING_RUN_KIND, run.runId, run, run.workspaceId)
}

export async function receiptExists(
  workspaceId: string, receiptId: string,
): Promise<{ ok: true; exists: boolean } | { ok: false }> {
  const lu = await getItemStrict<MonitorEvaluationReceiptV0>(MONITOR_EVAL_RECEIPT_KIND, receiptId, workspaceId)
  if (lu.ok === false) return { ok: false }
  return { ok: true, exists: lu.value !== null }
}

/** Write-once : l'id dérivé (moniteur+ref+empreinte) EST la dédup du skip. */
export async function persistReceipt(receipt: MonitorEvaluationReceiptV0): Promise<boolean> {
  return insertItemIfAbsent(MONITOR_EVAL_RECEIPT_KIND, receipt.id, receipt, receipt.workspaceId)
}
