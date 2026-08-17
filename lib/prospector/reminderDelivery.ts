// JARVIS-REMINDER-01C — livraison des rappels.
//
// Première destination : notification persistante Prospector.
// Telegram sera ajouté ensuite comme canal externe.
//
// La notification possède un identifiant déterministe basé sur la tâche :
// même si une exécution est rejouée, on écrase la même notification au lieu
// d'en créer plusieurs.

import { upsertItem } from '../supabase/store'
import type {
  ReminderDeliver,
  ReminderDeliveryContext,
  ReminderDeliveryResult,
} from './reminderRunner'

export interface StoredReminderNotification {
  id: string
  type: 'task'
  text: string
  when: string
  createdAt: number
  unread: boolean
  href: string
  taskId: string
  leadId?: string
}

export function reminderNotificationId(
  taskId: string,
): string {
  return `reminder_${taskId}`
}

export function buildReminderNotification(
  ctx: ReminderDeliveryContext,
  now: Date = new Date(),
): StoredReminderNotification {
  const id = reminderNotificationId(
    ctx.task.id,
  )

  return {
    id,
    type: 'task',
    text: ctx.message,

    // L'ISO reste la donnée d'autorité.
    // L'UI le transformera ensuite en
    // « à l'instant », « il y a 5 min », etc.
    when: now.toISOString(),

    createdAt: now.getTime(),
    unread: true,

    href: ctx.task.leadId
      ? `/leads/${ctx.task.leadId}`
      : '/planning',

    taskId: ctx.task.id,
    leadId: ctx.task.leadId,
  }
}

export async function deliverInAppReminder(
  ctx: ReminderDeliveryContext,
): Promise<ReminderDeliveryResult> {
  const notification =
    buildReminderNotification(ctx)

  const saved = await upsertItem(
    'notification',
    notification.id,
    notification,
    ctx.workspaceId,
  )

  if (!saved) {
    return {
      ok: false,
    }
  }

  return {
    ok: true,
    channel: 'in_app',
  }
}

// Signature directement injectable dans runReminderSweep().
export const reminderDeliver:
  ReminderDeliver = deliverInAppReminder