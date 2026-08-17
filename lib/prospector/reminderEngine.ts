// JARVIS-REMINDER-01 — moteur de décision des rappels.
//
// Ce module NE FAIT AUCUN ENVOI.
// Il décide uniquement si une tâche structurée est arrivée à échéance.
//
// Principes :
// - déterministe ;
// - fuseau IANA explicite ;
// - tâches legacy sans dueDate => jamais déclenchées automatiquement ;
// - tâche terminée => jamais déclenchée ;
// - reminderSentAt présent => jamais redéclenchée ;
// - sans heure explicite => rappel à 09:00 locale par défaut ;
// - un cron en retard peut rattraper une tâche déjà échue.

export const DEFAULT_REMINDER_TIME_ZONE = 'Europe/Paris'
export const DEFAULT_DATE_ONLY_REMINDER_TIME = '09:00'

export interface ReminderTask {
  id: string
  title: string
  dueDate?: string
  dueTime?: string | null
  timeZone?: string
  done?: boolean
  reminderSentAt?: string | null
  leadId?: string
  leadName?: string
}

export type ReminderReason =
  | 'due'
  | 'future'
  | 'done'
  | 'already_sent'
  | 'no_schedule'
  | 'invalid_schedule'

export interface ReminderDecision {
  due: boolean
  reason: ReminderReason

  /** Exemple : 2026-08-18T14:00 */
  scheduledLocal?: string

  timeZone?: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function validIsoDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false
  }

  const [year, month, day] =
    value.split('-').map(Number)

  const d = new Date(
    Date.UTC(year, month - 1, day),
  )

  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  )
}

function validLocalTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  )
}

function validTimeZone(
  timeZone: string,
  now: Date,
): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
    }).format(now)

    return true
  } catch {
    return false
  }
}

function localDateTimeKey(
  now: Date,
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const value = (
    type: Intl.DateTimeFormatPartTypes,
  ) =>
    parts.find(
      (part) => part.type === type,
    )?.value || ''

  return (
    `${value('year')}-` +
    `${value('month')}-` +
    `${value('day')}T` +
    `${pad2(Number(value('hour')))}:` +
    `${pad2(Number(value('minute')))}`
  )
}

export function reminderDecision(
  task: ReminderTask,
  options: {
    now?: Date
    defaultTimeZone?: string
    dateOnlyTime?: string
  } = {},
): ReminderDecision {
  const now = options.now ?? new Date()

  if (task.done) {
    return {
      due: false,
      reason: 'done',
    }
  }

  if (
    typeof task.reminderSentAt === 'string' &&
    task.reminderSentAt.trim()
  ) {
    return {
      due: false,
      reason: 'already_sent',
    }
  }

  // Les anciennes tâches ne portant qu'un libellé "due"
  // ne sont jamais interprétées automatiquement.
  if (!validIsoDate(task.dueDate)) {
    return {
      due: false,
      reason: task.dueDate
        ? 'invalid_schedule'
        : 'no_schedule',
    }
  }

  const dueTime =
    task.dueTime === null ||
    task.dueTime === undefined ||
    task.dueTime === ''
      ? (
          options.dateOnlyTime ??
          DEFAULT_DATE_ONLY_REMINDER_TIME
        )
      : task.dueTime

  if (!validLocalTime(dueTime)) {
    return {
      due: false,
      reason: 'invalid_schedule',
    }
  }

  const timeZone =
    task.timeZone ||
    options.defaultTimeZone ||
    DEFAULT_REMINDER_TIME_ZONE

  if (!validTimeZone(timeZone, now)) {
    return {
      due: false,
      reason: 'invalid_schedule',
    }
  }

  const scheduledLocal =
    `${task.dueDate}T${dueTime}`

  const nowLocal =
    localDateTimeKey(now, timeZone)

  if (nowLocal < scheduledLocal) {
    return {
      due: false,
      reason: 'future',
      scheduledLocal,
      timeZone,
    }
  }

  return {
    due: true,
    reason: 'due',
    scheduledLocal,
    timeZone,
  }
}

export function selectDueReminders(
  tasks: ReminderTask[],
  options: {
    now?: Date
    defaultTimeZone?: string
    dateOnlyTime?: string
  } = {},
): ReminderTask[] {
  return tasks.filter(
    (task) =>
      reminderDecision(task, options).due,
  )
}