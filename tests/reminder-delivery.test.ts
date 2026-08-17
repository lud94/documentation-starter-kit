import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const { upsertItem } = vi.hoisted(() => ({
  upsertItem: vi.fn(),
}))

vi.mock('../lib/supabase/store', () => ({
  upsertItem,
}))

import {
  buildReminderNotification,
  deliverInAppReminder,
  reminderNotificationId,
} from '../lib/prospector/reminderDelivery'

import type {
  ReminderDeliveryContext,
} from '../lib/prospector/reminderRunner'

const NOW =
  new Date('2026-08-17T12:00:00.000Z')

const context: ReminderDeliveryContext = {
  workspaceId: 'admin',
  task: {
    id: 'tk_123',
    title: 'Relancer Severine',
    leadId: 'ld_g1z77zvy',
    leadName: 'Severine GABAY',
    dueDate: '2026-08-17',
    dueTime: '14:00',
    timeZone: 'Europe/Paris',
  },
  message:
    '⏰ Rappel : Relancer Severine — Severine GABAY',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe(
  'JARVIS-REMINDER-01C — in-app delivery',
  () => {
    it(
      'génère un identifiant déterministe par tâche',
      () => {
        expect(
          reminderNotificationId('tk_123'),
        ).toBe('reminder_tk_123')

        expect(
          reminderNotificationId('tk_123'),
        ).toBe(
          reminderNotificationId('tk_123'),
        )
      },
    )

    it(
      'construit une notification persistante liée au lead',
      () => {
        const notification =
          buildReminderNotification(
            context,
            NOW,
          )

        expect(notification).toEqual({
          id: 'reminder_tk_123',
          type: 'task',
          text:
            '⏰ Rappel : Relancer Severine — Severine GABAY',
          when:
            '2026-08-17T12:00:00.000Z',
          createdAt: NOW.getTime(),
          unread: true,
          href: '/leads/ld_g1z77zvy',
          taskId: 'tk_123',
          leadId: 'ld_g1z77zvy',
        })
      },
    )

    it(
      'renvoie vers le planning si aucun lead n’est lié',
      () => {
        const notification =
          buildReminderNotification(
            {
              ...context,
              task: {
                ...context.task,
                leadId: undefined,
                leadName: undefined,
              },
            },
            NOW,
          )

        expect(notification.href).toBe(
          '/planning',
        )
      },
    )

    it(
      'persiste la notification dans le bon workspace',
      async () => {
        upsertItem.mockResolvedValue(true)

        const result =
          await deliverInAppReminder(
            context,
          )

        expect(result).toEqual({
          ok: true,
          channel: 'in_app',
        })

        expect(
          upsertItem,
        ).toHaveBeenCalledTimes(1)

        expect(
          upsertItem,
        ).toHaveBeenCalledWith(
          'notification',
          'reminder_tk_123',
          expect.objectContaining({
            id: 'reminder_tk_123',
            type: 'task',
            taskId: 'tk_123',
            leadId: 'ld_g1z77zvy',
            unread: true,
            href: '/leads/ld_g1z77zvy',
          }),
          'admin',
        )
      },
    )

    it(
      'échoue fermé si la notification ne peut pas être persistée',
      async () => {
        upsertItem.mockResolvedValue(false)

        const result =
          await deliverInAppReminder(
            context,
          )

        expect(result).toEqual({
          ok: false,
        })
      },
    )
  },
)