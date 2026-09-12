// JARVIS-REMINDER-01B — exécution sûre des rappels.
//
// Le Reminder Engine décide QUAND.
// Ce module garantit QUI peut traiter une tâche et évite les doubles envois
// lorsque plusieurs workers / cron se chevauchent.
//
// Important : un envoi vers un système externe ne peut pas être
// transactionnel avec PostgreSQL. Le contrat réaliste est donc :
// - claim exclusif avant envoi ;
// - receipt persistant après succès ;
// - retry possible après échec ;
// - un crash exactement entre l'envoi et l'écriture du receipt reste
//   une fenêtre résiduelle d'at-least-once, documentée et bornée.

import {
  deleteExpired,
  deleteItem,
  getItemStrict,
  insertItemIfAbsent,
  listItems,
  upsertItem,
} from '../supabase/store'
import { listWorkspaces } from '../supabase/workspaces'
import {
  reminderDecision,
  type ReminderTask,
} from './reminderEngine'

const CLAIM_KIND = 'reminder_claim'
const RECEIPT_KIND = 'reminder_receipt'

export const REMINDER_CLAIM_TTL_MS =
  10 * 60 * 1000

export interface StoredReminderTask
  extends ReminderTask {
  due?: string
}

export interface ReminderDeliveryContext {
  workspaceId: string
  task: StoredReminderTask
  message: string
}

export interface ReminderDeliveryResult {
  ok: boolean
  channel?: string
}

export type ReminderDeliver = (
  ctx: ReminderDeliveryContext,
) => Promise<ReminderDeliveryResult>

export interface ReminderRunResult {
  workspaces: number
  scanned: number
  due: number
  delivered: number
  skipped: number
  failed: number
}

interface ReminderReceipt {
  id: string
  taskId: string
  sentAt: string
  channel?: string
}

function reminderMessage(
  task: StoredReminderTask,
): string {
  const lead =
    task.leadName?.trim()
      ? ` — ${task.leadName.trim()}`
      : ''

  return `⏰ Rappel : ${task.title}${lead}`
}

async function activeWorkspaceIds(): Promise<
  string[]
> {
  const workspaces = await listWorkspaces()

  // L'espace "admin" est un véritable espace métier,
  // mais il n'a pas de ligne dédiée dans prospector_workspaces.
  const ids = [
    'admin',
    ...workspaces
      .filter(
        (workspace) =>
          workspace.status !== 'suspended',
      )
      .map((workspace) => workspace.id),
  ]

  return Array.from(new Set(ids))
}

async function releaseClaim(
  taskId: string,
  workspaceId: string,
): Promise<void> {
  await deleteItem(
    CLAIM_KIND,
    taskId,
    workspaceId,
  )
}

async function processTask(
  workspaceId: string,
  candidate: StoredReminderTask,
  deliver: ReminderDeliver,
  now: Date,
): Promise<
  'delivered' | 'skipped' | 'failed'
> {
  // Réservation atomique : un seul worker peut traiter
  // ce taskId dans ce workspace à un instant donné.
  const claimed = await insertItemIfAbsent(
    CLAIM_KIND,
    candidate.id,
    {
      id: candidate.id,
      taskId: candidate.id,
      at: now.getTime(),
    },
    workspaceId,
  )

  if (!claimed) {
    return 'skipped'
  }

  try {
    // Si un receipt existe déjà, le rappel a déjà été livré.
    // Lecture STRICTE : panne de stockage => on n'envoie rien.
    const receiptRead =
      await getItemStrict<ReminderReceipt>(
        RECEIPT_KIND,
        candidate.id,
        workspaceId,
      )

    if (!receiptRead.ok) {
      return 'failed'
    }

    if (receiptRead.value) {
      return 'skipped'
    }

    // Relecture de la tâche APRÈS le claim :
    // elle peut avoir été terminée ou modifiée depuis le scan.
    const taskRead =
      await getItemStrict<StoredReminderTask>(
        'task',
        candidate.id,
        workspaceId,
      )

    if (!taskRead.ok) {
      return 'failed'
    }

    if (!taskRead.value) {
      return 'skipped'
    }

    const task = taskRead.value

    const decision = reminderDecision(
      task,
      { now },
    )

    if (!decision.due) {
      return 'skipped'
    }

    const result = await deliver({
      workspaceId,
      task,
      message: reminderMessage(task),
    })

    if (!result.ok) {
      return 'failed'
    }

    const sentAt = now.toISOString()

    // Le receipt est l'autorité anti-double envoi.
    const receiptCreated =
      await insertItemIfAbsent(
        RECEIPT_KIND,
        task.id,
        {
          id: task.id,
          taskId: task.id,
          sentAt,
          channel: result.channel,
        } satisfies ReminderReceipt,
        workspaceId,
      )

    if (!receiptCreated) {
      // Ambigu : conflit ou panne.
      // On ne prétend pas avoir sécurisé la livraison.
      return 'failed'
    }

    // Champ pratique pour l'UI et le diagnostic.
    // Même si cette écriture échoue, le receipt empêche
    // le rappel de repartir.
    await upsertItem(
      'task',
      task.id,
      {
        ...task,
        reminderSentAt: sentAt,
      },
      workspaceId,
    )

    return 'delivered'
  } catch {
    return 'failed'
  } finally {
    // Un échec redevient éligible au prochain passage.
    // Un succès reste protégé par son receipt.
    await releaseClaim(
      candidate.id,
      workspaceId,
    )
  }
}

export async function runReminderSweep(
  deliver: ReminderDeliver,
  options: {
    now?: Date
    workspaceIds?: string[]
  } = {},
): Promise<ReminderRunResult> {
  const now = options.now ?? new Date()

  const workspaceIds =
    options.workspaceIds ??
    (await activeWorkspaceIds())

  const result: ReminderRunResult = {
    workspaces: workspaceIds.length,
    scanned: 0,
    due: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  }

  for (const workspaceId of workspaceIds) {
    // Nettoyage des claims abandonnés par un worker mort.
    await deleteExpired(
      CLAIM_KIND,
      workspaceId,
      new Date(
        now.getTime() -
          REMINDER_CLAIM_TTL_MS,
      ).toISOString(),
    )

    const tasks =
      await listItems<StoredReminderTask>(
        'task',
        workspaceId,
      )

    result.scanned += tasks.length

    for (const task of tasks) {
      if (
        !reminderDecision(task, { now }).due
      ) {
        continue
      }

      result.due++

      const outcome = await processTask(
        workspaceId,
        task,
        deliver,
        now,
      )

      if (outcome === 'delivered') {
        result.delivered++
      } else if (outcome === 'failed') {
        result.failed++
      } else {
        result.skipped++
      }
    }
  }

  return result
}