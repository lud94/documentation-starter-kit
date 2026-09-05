import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const {
  runReminderSweep,
  reminderDeliver,
} = vi.hoisted(() => ({
  runReminderSweep: vi.fn(),
  reminderDeliver: vi.fn(),
}))

vi.mock(
  '../lib/prospector/reminderRunner',
  () => ({
    runReminderSweep,
  }),
)

vi.mock(
  '../lib/prospector/reminderDelivery',
  () => ({
    reminderDeliver,
  }),
)

import handler from '../pages/api/reminders/run'

const ORIGINAL_CRON_SECRET =
  process.env.CRON_SECRET

function request(
  method: string,
  authorization?: string,
): any {
  return {
    method,
    headers: authorization
      ? {
          authorization,
        }
      : {},
  }
}

function response(): any {
  const res: any = {}

  res.status = vi.fn(() => res)
  res.json = vi.fn(() => res)

  return res
}

beforeEach(() => {
  vi.clearAllMocks()

  delete process.env.CRON_SECRET
})

afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET
  } else {
    process.env.CRON_SECRET =
      ORIGINAL_CRON_SECRET
  }
})

describe(
  'JARVIS-REMINDER-01D — scheduler route',
  () => {
    it(
      'refuse toute méthode autre que POST',
      async () => {
        process.env.CRON_SECRET =
          'scheduler-secret'

        const req = request(
          'GET',
          'Bearer scheduler-secret',
        )

        const res = response()

        await handler(req, res)

        expect(res.status).toHaveBeenCalledWith(
          405,
        )

        expect(res.json).toHaveBeenCalledWith({
          error: 'POST only',
        })

        expect(
          runReminderSweep,
        ).not.toHaveBeenCalled()
      },
    )

    it(
      'échoue fermé si CRON_SECRET est absent',
      async () => {
        const req = request('POST')

        const res = response()

        await handler(req, res)

        expect(res.status).toHaveBeenCalledWith(
          503,
        )

        expect(res.json).toHaveBeenCalledWith({
          error: 'scheduler_unavailable',
        })

        expect(
          runReminderSweep,
        ).not.toHaveBeenCalled()
      },
    )

    it(
      'refuse un appel sans Authorization',
      async () => {
        process.env.CRON_SECRET =
          'scheduler-secret'

        const req = request('POST')

        const res = response()

        await handler(req, res)

        expect(res.status).toHaveBeenCalledWith(
          401,
        )

        expect(res.json).toHaveBeenCalledWith({
          error: 'unauthorized',
        })

        expect(
          runReminderSweep,
        ).not.toHaveBeenCalled()
      },
    )

    it(
      'refuse un Bearer token incorrect',
      async () => {
        process.env.CRON_SECRET =
          'scheduler-secret'

        const req = request(
          'POST',
          'Bearer mauvais-secret',
        )

        const res = response()

        await handler(req, res)

        expect(res.status).toHaveBeenCalledWith(
          401,
        )

        expect(res.json).toHaveBeenCalledWith({
          error: 'unauthorized',
        })

        expect(
          runReminderSweep,
        ).not.toHaveBeenCalled()
      },
    )

    it(
      'exécute le sweep avec le bon secret',
      async () => {
        process.env.CRON_SECRET =
          'scheduler-secret'

        runReminderSweep.mockResolvedValue({
          workspaces: 2,
          scanned: 5,
          due: 2,
          delivered: 2,
          skipped: 0,
          failed: 0,
        })

        const req = request(
          'POST',
          'Bearer scheduler-secret',
        )

        const res = response()

        await handler(req, res)

        expect(
          runReminderSweep,
        ).toHaveBeenCalledTimes(1)

        expect(
          runReminderSweep,
        ).toHaveBeenCalledWith(
          reminderDeliver,
        )

        expect(res.status).toHaveBeenCalledWith(
          200,
        )

        expect(res.json).toHaveBeenCalledWith({
          ok: true,
          workspaces: 2,
          scanned: 5,
          due: 2,
          delivered: 2,
          skipped: 0,
          failed: 0,
        })
      },
    )

    it(
      'ne révèle pas le détail interne si le sweep plante',
      async () => {
        process.env.CRON_SECRET =
          'scheduler-secret'

        runReminderSweep.mockRejectedValue(
          new Error(
            'supabase table secret interne',
          ),
        )

        const req = request(
          'POST',
          'Bearer scheduler-secret',
        )

        const res = response()

        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {})

        try {
          await handler(req, res)

          expect(
            res.status,
          ).toHaveBeenCalledWith(500)

          expect(
            res.json,
          ).toHaveBeenCalledWith({
            error: 'reminder_sweep_failed',
          })

          expect(
            JSON.stringify(
              res.json.mock.calls,
            ),
          ).not.toContain(
            'supabase table secret interne',
          )
        } finally {
          consoleError.mockRestore()
        }
      },
    )
  },
)