import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const store = new Map<string, any>()

const key = (
  kind: string,
  ws: string,
  id: string,
) => `${kind}|${ws}|${id}`

let failTaskUpsert = false

const listItems = vi.fn(
  async <T = any>(
    kind: string,
    ws: string,
  ): Promise<T[]> => {
    const prefix = `${kind}|${ws}|`

    return Array.from(store.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, value]) => value as T)
  },
)

const getItemStrict = vi.fn(
  async <T = any>(
    kind: string,
    id: string,
    ws: string,
  ) => ({
    ok: true as const,
    value:
      (store.get(key(kind, ws, id)) as T) ??
      null,
  }),
)

const insertItemIfAbsent = vi.fn(
  async (
    kind: string,
    id: string,
    data: any,
    ws: string,
  ) => {
    const k = key(kind, ws, id)

    if (store.has(k)) {
      return false
    }

    store.set(k, data)
    return true
  },
)

const upsertItem = vi.fn(
  async (
    kind: string,
    id: string,
    data: any,
    ws: string,
  ) => {
    if (kind === 'task' && failTaskUpsert) {
      return false
    }

    store.set(
      key(kind, ws, id),
      data,
    )

    return true
  },
)

const deleteItem = vi.fn(
  async (
    kind: string,
    id: string,
    ws: string,
  ) => {
    store.delete(key(kind, ws, id))
    return true
  },
)

const deleteExpired = vi.fn(
  async (
    kind: string,
    ws: string,
    olderThanIso: string,
  ) => {
    const cutoff = Date.parse(olderThanIso)
    const prefix = `${kind}|${ws}|`

    for (const [k, value] of Array.from(
      store.entries(),
    )) {
      if (!k.startsWith(prefix)) continue

      if (
        typeof value?.at === 'number' &&
        value.at < cutoff
      ) {
        store.delete(k)
      }
    }

    return true
  },
)

vi.mock('../lib/supabase/store', () => ({
  listItems: (...args: any[]) =>
    (listItems as any)(...args),

  getItemStrict: (...args: any[]) =>
    (getItemStrict as any)(...args),

  insertItemIfAbsent: (...args: any[]) =>
    (insertItemIfAbsent as any)(...args),

  upsertItem: (...args: any[]) =>
    (upsertItem as any)(...args),

  deleteItem: (...args: any[]) =>
    (deleteItem as any)(...args),

  deleteExpired: (...args: any[]) =>
    (deleteExpired as any)(...args),
}))

const listWorkspaces = vi.fn(async () => [])

vi.mock(
  '../lib/supabase/workspaces',
  () => ({
    listWorkspaces: (...args: any[]) =>
      (listWorkspaces as any)(...args),
  }),
)

import {
  runReminderSweep,
  type ReminderDeliver,
  type StoredReminderTask,
} from '../lib/prospector/reminderRunner'

const NOW =
  new Date('2026-08-17T12:00:00.000Z')
// 14:00 à Paris.

function putTask(
  ws: string,
  task: Partial<StoredReminderTask> & {
    id: string
    title: string
  },
) {
  const value: StoredReminderTask = {
    done: false,
    dueDate: '2026-08-17',
    dueTime: '14:00',
    timeZone: 'Europe/Paris',
    ...task,
  }

  store.set(
    key('task', ws, value.id),
    value,
  )

  return value
}

beforeEach(() => {
  store.clear()
  failTaskUpsert = false
  vi.clearAllMocks()
  listWorkspaces.mockResolvedValue([])
})

describe(
  'JARVIS-REMINDER-01B — reminder runner',
  () => {
    it(
      'livre une tâche échue et pose receipt + reminderSentAt',
      async () => {
        putTask('admin', {
          id: 'tk_due',
          title: 'Relancer Severine',
          leadName: 'Severine GABAY',
        })

        const deliver = vi.fn<ReminderDeliver>(
          async () => ({
            ok: true,
            channel: 'test',
          }),
        )

        const result =
          await runReminderSweep(
            deliver,
            {
              now: NOW,
              workspaceIds: ['admin'],
            },
          )

        expect(result).toEqual({
          workspaces: 1,
          scanned: 1,
          due: 1,
          delivered: 1,
          skipped: 0,
          failed: 0,
        })

        expect(deliver).toHaveBeenCalledTimes(1)

        const ctx =
         deliver.mock.calls[0]![0]

        expect(ctx.workspaceId).toBe('admin')
        expect(ctx.task.id).toBe('tk_due')
        expect(ctx.message).toContain(
          '⏰ Rappel : Relancer Severine',
        )
        expect(ctx.message).toContain(
          'Severine GABAY',
        )

        const receipt = store.get(
          key(
            'reminder_receipt',
            'admin',
            'tk_due',
          ),
        )

        expect(receipt).toBeTruthy()
        expect(receipt.channel).toBe('test')

        const savedTask = store.get(
          key('task', 'admin', 'tk_due'),
        )

        expect(savedTask.reminderSentAt).toBe(
          NOW.toISOString(),
        )
      },
    )

    it(
      'ne livre jamais deux fois un rappel déjà traité',
      async () => {
        putTask('admin', {
          id: 'tk_once',
          title: 'Appeler Severine',
        })

        const deliver = vi.fn(
          async () => ({
            ok: true,
            channel: 'test',
          }),
        )

        await runReminderSweep(deliver, {
          now: NOW,
          workspaceIds: ['admin'],
        })

        await runReminderSweep(deliver, {
          now: new Date(
            '2026-08-17T12:05:00.000Z',
          ),
          workspaceIds: ['admin'],
        })

        expect(deliver).toHaveBeenCalledTimes(1)
      },
    )

    it(
      'le receipt reste autoritaire si la mise à jour pratique de la tâche échoue',
      async () => {
        putTask('admin', {
          id: 'tk_receipt',
          title: 'Relancer',
        })

        failTaskUpsert = true

        const deliver = vi.fn(
          async () => ({
            ok: true,
            channel: 'test',
          }),
        )

        const first =
          await runReminderSweep(
            deliver,
            {
              now: NOW,
              workspaceIds: ['admin'],
            },
          )

        expect(first.delivered).toBe(1)

        // La tâche n'a pas reçu reminderSentAt,
        // mais le receipt existe.
        const task = store.get(
          key(
            'task',
            'admin',
            'tk_receipt',
          ),
        )

        expect(
          task.reminderSentAt,
        ).toBeUndefined()

        failTaskUpsert = false

        const second =
          await runReminderSweep(
            deliver,
            {
              now: new Date(
                '2026-08-17T12:05:00.000Z',
              ),
              workspaceIds: ['admin'],
            },
          )

        expect(second.skipped).toBe(1)
        expect(deliver).toHaveBeenCalledTimes(1)
      },
    )

    it(
      'réessaie au passage suivant après un échec de livraison',
      async () => {
        putTask('admin', {
          id: 'tk_retry',
          title: 'Relancer',
        })

        const deliver = vi
            .fn<ReminderDeliver>()
          .mockResolvedValueOnce({
            ok: false,
          })
          .mockResolvedValueOnce({
            ok: true,
            channel: 'test',
          })

        const first =
          await runReminderSweep(
            deliver,
            {
              now: NOW,
              workspaceIds: ['admin'],
            },
          )

        expect(first.failed).toBe(1)

        const second =
          await runReminderSweep(
            deliver,
            {
              now: new Date(
                '2026-08-17T12:01:00.000Z',
              ),
              workspaceIds: ['admin'],
            },
          )

        expect(second.delivered).toBe(1)
        expect(deliver).toHaveBeenCalledTimes(2)
      },
    )

    it(
      'deux sweeps concurrents ne livrent qu’une seule fois',
      async () => {
        putTask('admin', {
          id: 'tk_race',
          title: 'Relancer',
        })

        let release:
          (() => void) | undefined

        const gate = new Promise<void>(
          (resolve) => {
            release = resolve
          },
        )

        const deliver = vi.fn(
          async () => {
            await gate

            return {
              ok: true,
              channel: 'test',
            }
          },
        )

        const first =
          runReminderSweep(deliver, {
            now: NOW,
            workspaceIds: ['admin'],
          })

        // Laisse le premier sweep obtenir le claim.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        const second =
          runReminderSweep(deliver, {
            now: NOW,
            workspaceIds: ['admin'],
          })

        await Promise.resolve()

        release?.()

        const [a, b] =
          await Promise.all([
            first,
            second,
          ])

        expect(deliver).toHaveBeenCalledTimes(1)

        expect(
          a.delivered + b.delivered,
        ).toBe(1)

        expect(
          a.skipped + b.skipped,
        ).toBe(1)
      },
    )

    it(
      'isole strictement deux workspaces ayant le même taskId',
      async () => {
        putTask('ws_a', {
          id: 'tk_same',
          title: 'Rappel A',
        })

        putTask('ws_b', {
          id: 'tk_same',
          title: 'Rappel B',
        })

        const deliver = vi.fn(
          async () => ({
            ok: true,
            channel: 'test',
          }),
        )

        const result =
          await runReminderSweep(
            deliver,
            {
              now: NOW,
              workspaceIds: [
                'ws_a',
                'ws_b',
              ],
            },
          )

        expect(result.delivered).toBe(2)

        expect(
          (
  deliver.mock.calls as unknown as Array<
    [Parameters<ReminderDeliver>[0]]
  >
).map(([ctx]) => ctx.workspaceId),
        ).toEqual([
          'ws_a',
          'ws_b',
        ])

        expect(
          store.has(
            key(
              'reminder_receipt',
              'ws_a',
              'tk_same',
            ),
          ),
        ).toBe(true)

        expect(
          store.has(
            key(
              'reminder_receipt',
              'ws_b',
              'tk_same',
            ),
          ),
        ).toBe(true)
      },
    )

    it(
      'ignore naturellement les tâches futures et legacy',
      async () => {
        putTask('admin', {
          id: 'tk_future',
          title: 'Plus tard',
          dueTime: '16:00',
        })

        putTask('admin', {
          id: 'tk_legacy',
          title: 'Ancienne tâche',
          dueDate: undefined,
          dueTime: undefined,
        })

        const deliver = vi.fn(
          async () => ({
            ok: true,
          }),
        )

        const result =
          await runReminderSweep(
            deliver,
            {
              now: NOW,
              workspaceIds: ['admin'],
            },
          )

        expect(result.scanned).toBe(2)
        expect(result.due).toBe(0)
        expect(result.delivered).toBe(0)
        expect(deliver).not.toHaveBeenCalled()
      },
    )

    it(
      'sans liste explicite, traite admin + workspaces actifs mais pas les suspendus',
      async () => {
        listWorkspaces.mockResolvedValue([
          {
            id: 'ws_active',
            status: 'active',
          },
          {
            id: 'ws_suspended',
            status: 'suspended',
          },
        ])

        putTask('admin', {
          id: 'tk_admin',
          title: 'Admin',
        })

        putTask('ws_active', {
          id: 'tk_active',
          title: 'Actif',
        })

        putTask('ws_suspended', {
          id: 'tk_suspended',
          title: 'Suspendu',
        })

        const deliver = vi.fn(
          async () => ({
            ok: true,
            channel: 'test',
          }),
        )

        const result =
          await runReminderSweep(
            deliver,
            { now: NOW },
          )

        expect(result.workspaces).toBe(2)
        expect(result.delivered).toBe(2)

        expect(
          (deliver.mock.calls as any[][]).map(
            (call) => call[0].workspaceId,
            ),
        ).toEqual([
          'admin',
          'ws_active',
        ])
      },
    )
  },
)