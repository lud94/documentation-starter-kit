import { describe, expect, it } from 'vitest'

import { middleware } from '../middleware'

describe('reminder scheduler middleware boundary', () => {
  it('lets /api/reminders/run reach its own machine auth without browser session', async () => {
    const res = await middleware({
      nextUrl: { pathname: '/api/reminders/run' },
    } as any)

    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })
})
