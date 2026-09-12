import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATE_ONLY_REMINDER_TIME,
  DEFAULT_REMINDER_TIME_ZONE,
  reminderDecision,
  selectDueReminders,
} from '../lib/prospector/reminderEngine'

describe('JARVIS-REMINDER-01A — reminder engine', () => {
  it('ne déclenche pas avant l’échéance', () => {
    const decision = reminderDecision(
      {
        id: 'tk_1',
        title: 'Relancer Severine',
        dueDate: '2026-08-17',
        dueTime: '14:00',
        timeZone: 'Europe/Paris',
      },
      {
        // 13:59 à Paris
        now: new Date('2026-08-17T11:59:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'future',
      scheduledLocal: '2026-08-17T14:00',
      timeZone: 'Europe/Paris',
    })
  })

  it('déclenche exactement à l’échéance', () => {
    const decision = reminderDecision(
      {
        id: 'tk_2',
        title: 'Relancer Severine',
        dueDate: '2026-08-17',
        dueTime: '14:00',
        timeZone: 'Europe/Paris',
      },
      {
        // 14:00 à Paris
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision.due).toBe(true)
    expect(decision.reason).toBe('due')
  })

  it('rattrape une tâche après son échéance', () => {
    const decision = reminderDecision(
      {
        id: 'tk_3',
        title: 'Relancer Severine',
        dueDate: '2026-08-17',
        dueTime: '14:00',
        timeZone: 'Europe/Paris',
      },
      {
        now: new Date('2026-08-17T12:12:00.000Z'),
      },
    )

    expect(decision.due).toBe(true)
  })

  it('utilise 09:00 pour une tâche sans heure', () => {
    const before = reminderDecision(
      {
        id: 'tk_4',
        title: 'Relancer Severine',
        dueDate: '2026-08-18',
        dueTime: null,
        timeZone: 'Europe/Paris',
      },
      {
        // 08:59 à Paris
        now: new Date('2026-08-18T06:59:00.000Z'),
      },
    )

    expect(before.due).toBe(false)
    expect(before.scheduledLocal).toBe(
      `2026-08-18T${DEFAULT_DATE_ONLY_REMINDER_TIME}`,
    )

    const atNine = reminderDecision(
      {
        id: 'tk_4',
        title: 'Relancer Severine',
        dueDate: '2026-08-18',
        dueTime: null,
        timeZone: 'Europe/Paris',
      },
      {
        // 09:00 à Paris
        now: new Date('2026-08-18T07:00:00.000Z'),
      },
    )

    expect(atNine.due).toBe(true)
  })

  it('ne redéclenche pas une tâche déjà envoyée', () => {
    const decision = reminderDecision(
      {
        id: 'tk_5',
        title: 'Relancer Severine',
        dueDate: '2026-08-17',
        dueTime: '10:00',
        timeZone: 'Europe/Paris',
        reminderSentAt: '2026-08-17T08:00:05.000Z',
      },
      {
        now: new Date('2026-08-17T10:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'already_sent',
    })
  })

  it('ne déclenche pas une tâche terminée', () => {
    const decision = reminderDecision(
      {
        id: 'tk_6',
        title: 'Relancer Severine',
        dueDate: '2026-08-17',
        dueTime: '09:00',
        done: true,
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'done',
    })
  })

  it('refuse les tâches legacy sans dueDate structurée', () => {
    const decision = reminderDecision(
      {
        id: 'tk_7',
        title: 'Ancienne tâche',
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'no_schedule',
    })
  })

  it('refuse une date invalide', () => {
    const decision = reminderDecision(
      {
        id: 'tk_8',
        title: 'Date invalide',
        dueDate: '2026-02-31',
        dueTime: '14:00',
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'invalid_schedule',
    })
  })

  it('refuse une heure invalide', () => {
    const decision = reminderDecision(
      {
        id: 'tk_9',
        title: 'Heure invalide',
        dueDate: '2026-08-17',
        dueTime: '25:00',
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'invalid_schedule',
    })
  })

  it('refuse un fuseau invalide', () => {
    const decision = reminderDecision(
      {
        id: 'tk_10',
        title: 'Fuseau invalide',
        dueDate: '2026-08-17',
        dueTime: '14:00',
        timeZone: 'Mars/Olympus',
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision).toEqual({
      due: false,
      reason: 'invalid_schedule',
    })
  })

  it('utilise Europe/Paris par défaut', () => {
    const decision = reminderDecision(
      {
        id: 'tk_11',
        title: 'Fuseau par défaut',
        dueDate: '2026-08-17',
        dueTime: '14:00',
      },
      {
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(decision.timeZone).toBe(
      DEFAULT_REMINDER_TIME_ZONE,
    )

    expect(decision.due).toBe(true)
  })

  it('respecte un autre fuseau IANA', () => {
    const decision = reminderDecision(
      {
        id: 'tk_12',
        title: 'New York',
        dueDate: '2026-08-17',
        dueTime: '09:00',
        timeZone: 'America/New_York',
      },
      {
        // 09:00 à New York en août = 13:00 UTC
        now: new Date('2026-08-17T13:00:00.000Z'),
      },
    )

    expect(decision.due).toBe(true)
    expect(decision.timeZone).toBe(
      'America/New_York',
    )
  })

  it('sélectionne uniquement les rappels réellement dus', () => {
    const tasks = [
      {
        id: 'due',
        title: 'Due',
        dueDate: '2026-08-17',
        dueTime: '10:00',
      },
      {
        id: 'future',
        title: 'Future',
        dueDate: '2026-08-17',
        dueTime: '15:00',
      },
      {
        id: 'done',
        title: 'Done',
        dueDate: '2026-08-17',
        dueTime: '09:00',
        done: true,
      },
      {
        id: 'sent',
        title: 'Sent',
        dueDate: '2026-08-17',
        dueTime: '09:00',
        reminderSentAt: '2026-08-17T07:00:00.000Z',
      },
      {
        id: 'legacy',
        title: 'Legacy',
      },
    ]

    const selected = selectDueReminders(
      tasks,
      {
        // 14:00 à Paris
        now: new Date('2026-08-17T12:00:00.000Z'),
      },
    )

    expect(selected.map((task) => task.id)).toEqual([
      'due',
    ])
  })
})