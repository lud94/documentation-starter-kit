import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEC-JARVIS-APP-01
//
// Le navigateur ne doit jamais être l'autorité de l'action exécutée.
// Une écriture Jarvis reste côté serveur et le client ne reçoit qu'un nonce.

// ── Faux magasin reproduisant les garanties utiles de prospector_store ──────

type Row = {
  kind: string
  id: string
  ws: string
  data: any
}

let rows: Row[] = []

const insertItemIfAbsent = vi.fn(
  async (kind: string, id: string, data: any, ws: string) => {
    if (rows.some((r) => r.kind === kind && r.id === id && r.ws === ws)) {
      return false
    }

    rows.push({ kind, id, ws, data })
    return true
  },
)

const claimItemIfField = vi.fn(
  async (
    kind: string,
    id: string,
    ws: string,
    field: string,
    expected: string,
  ) => {
    const i = rows.findIndex(
      (r) =>
        r.kind === kind &&
        r.id === id &&
        r.ws === ws &&
        String(r.data?.[field]) === expected,
    )

    if (i < 0) return null

    return rows.splice(i, 1)[0].data
  },
)

const deleteExpired = vi.fn(async () => true)

vi.mock('../lib/supabase/store', () => ({
  insertItemIfAbsent: (...a: any[]) => (insertItemIfAbsent as any)(...a),
  claimItemIfField: (...a: any[]) => (claimItemIfField as any)(...a),
  deleteExpired: (...a: any[]) => (deleteExpired as any)(...a),
}))

// ── Faux tenant ──────────────────────────────────────────────────────────────

let currentWs = 'ws_a'

const resolveTenantFromRequest = vi.fn(async () => ({
  id: currentWs,
  name: currentWs,
  status: 'active',
}))

vi.mock('../lib/prospector/tenant', () => ({
  resolveTenantFromRequest: (...a: any[]) =>
    (resolveTenantFromRequest as any)(...a),
}))

// ── Keystore ─────────────────────────────────────────────────────────────────

vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (name: string) =>
    name === 'ANTHROPIC_API_KEY' ? 'anthropic-test-key' : '',
}))

// ── Cerveau Jarvis ───────────────────────────────────────────────────────────

const planJarvis = vi.fn()
const executeJarvis = vi.fn()

vi.mock('../lib/prospector/jarvisAgent', () => ({
  planJarvis: (...a: any[]) => (planJarvis as any)(...a),
  executeJarvis: (...a: any[]) => (executeJarvis as any)(...a),
  isWrite: (a: any) => !!a && a.type === 'write',
}))

import {
  createAppPending,
  consumeAppPending,
  dropAppPending,
} from '../lib/prospector/appPending'

import chatHandler from '../pages/api/jarvis/chat'

// ── Helpers route ─────────────────────────────────────────────────────────────

function mockRes() {
  const r: any = {
    statusCode: 0,
    body: undefined,
  }

  r.status = (code: number) => {
    r.statusCode = code
    return r
  }

  r.json = (body: any) => {
    r.body = body
    return r
  }

  return r
}

function req(body: any) {
  return {
    method: 'POST',
    body,
    headers: {},
    cookies: {},
    query: {},
  } as any
}

beforeEach(() => {
  rows = []
  currentWs = 'ws_a'

  vi.clearAllMocks()

  planJarvis.mockResolvedValue({
    reply: 'Je vais effectuer cette modification.',
    action: {
      type: 'write',
      target: 'lead_original',
      value: 'chaud',
    },
  })

  executeJarvis.mockResolvedValue('✅ Action exécutée.')
})

// ═════════════════════════════════════════════════════════════════════════════
// 1 — Primitive serveur
// ═════════════════════════════════════════════════════════════════════════════

describe('SEC-JARVIS-APP-01 — stockage serveur des confirmations', () => {
  it('génère un nonce opaque et rend l’action une seule fois', async () => {
    const action = {
      type: 'write',
      target: 'lead_1',
    }

    const cid = await createAppPending('ws_a', action)

    expect(cid).toMatch(/^[0-9a-f]{32}$/)

    const first = await consumeAppPending(cid!, 'ws_a')

    expect(first?.action).toEqual(action)

    const replay = await consumeAppPending(cid!, 'ws_a')

    expect(replay).toBeNull()
  })

  it('un autre workspace ne peut pas consommer la confirmation', async () => {
    const action = {
      type: 'write',
      target: 'lead_1',
    }

    const cid = await createAppPending('ws_a', action)

    expect(
      await consumeAppPending(cid!, 'ws_b'),
    ).toBeNull()

    // Le refus inter-tenant ne détruit pas la confirmation légitime.
    const legitimate = await consumeAppPending(cid!, 'ws_a')

    expect(legitimate?.action).toEqual(action)
  })

  it('une annulation est elle aussi liée au workspace', async () => {
    const cid = await createAppPending('ws_a', {
      type: 'write',
      target: 'lead_1',
    })

    expect(
      await dropAppPending(cid!, 'ws_b'),
    ).toBe(false)

    expect(
      await dropAppPending(cid!, 'ws_a'),
    ).toBe(true)

    expect(
      await consumeAppPending(cid!, 'ws_a'),
    ).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — Route Jarvis in-app
// ═════════════════════════════════════════════════════════════════════════════

describe('SEC-JARVIS-APP-01 — la route ne fait jamais confiance au navigateur', () => {
  it('une écriture renvoie uniquement un confirmationId, jamais l’action', async () => {
    const res = mockRes()

    await chatHandler(
      req({
        message: 'mets Paul en chaud',
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.needsConfirm).toBe(true)
    expect(res.body.confirmationId).toMatch(/^[0-9a-f]{32}$/)

    // L'action reste exclusivement côté serveur.
    expect(res.body.action).toBeUndefined()

    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('l’ancien payload confirm + action fourni par le navigateur n’est jamais exécuté', async () => {
    planJarvis.mockResolvedValue({
      reply: 'Aucune action.',
      action: null,
    })

    const forged = {
      type: 'write',
      target: 'lead_victime',
      value: 'perdu',
    }

    const res = mockRes()

    await chatHandler(
      req({
        message: '',
        confirm: true,
        action: forged,
      }),
      res,
    )

    expect(res.statusCode).toBe(200)

    // Le champ action envoyé par le navigateur est ignoré.
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('la confirmation exécute l’action conservée côté serveur, pas une action forgée', async () => {
    const original = {
      type: 'write',
      target: 'lead_original',
      value: 'chaud',
    }

    planJarvis.mockResolvedValue({
      reply: 'Je vais le mettre en chaud.',
      action: original,
    })

    const planned = mockRes()

    await chatHandler(
      req({
        message: 'mets Paul en chaud',
      }),
      planned,
    )

    const cid = planned.body.confirmationId

    const forged = {
      type: 'write',
      target: 'lead_victime',
      value: 'perdu',
    }

    const confirmed = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,

        // Même si un navigateur hostile tente encore de joindre une action,
        // la route ne la lit jamais.
        action: forged,
      }),
      confirmed,
    )

    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.body.done).toBe(true)

    expect(executeJarvis).toHaveBeenCalledTimes(1)

    expect(executeJarvis).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ws_a',
      }),
      original,
      'ws_a',
    )
  })

  it('une confirmation ne peut pas être rejouée', async () => {
    const first = mockRes()

    await chatHandler(
      req({
        message: 'modifie ce lead',
      }),
      first,
    )

    const cid = first.body.confirmationId

    const confirmed = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,
      }),
      confirmed,
    )

    expect(executeJarvis).toHaveBeenCalledTimes(1)

    const replay = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,
      }),
      replay,
    )

    expect(replay.body.done).toBe(false)
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('une confirmation créée dans A ne peut pas être exécutée dans B', async () => {
    currentWs = 'ws_a'

    const planned = mockRes()

    await chatHandler(
      req({
        message: 'modifie le lead',
      }),
      planned,
    )

    const cid = planned.body.confirmationId

    // Même nonce présenté depuis un autre tenant.
    currentWs = 'ws_b'

    const foreign = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,
      }),
      foreign,
    )

    expect(foreign.body.done).toBe(false)
    expect(executeJarvis).not.toHaveBeenCalled()

    // Le refus de B n'a pas détruit le droit légitime de A.
    currentWs = 'ws_a'

    const legitimate = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,
      }),
      legitimate,
    )

    expect(legitimate.body.done).toBe(true)
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('annuler consomme la confirmation et empêche toute exécution ultérieure', async () => {
    const planned = mockRes()

    await chatHandler(
      req({
        message: 'modifie le lead',
      }),
      planned,
    )

    const cid = planned.body.confirmationId

    const cancelled = mockRes()

    await chatHandler(
      req({
        cancel: cid,
      }),
      cancelled,
    )

    expect(cancelled.body.done).toBe(true)
    expect(executeJarvis).not.toHaveBeenCalled()

    const afterCancel = mockRes()

    await chatHandler(
      req({
        confirmationId: cid,
      }),
      afterCancel,
    )

    expect(afterCancel.body.done).toBe(false)
    expect(executeJarvis).not.toHaveBeenCalled()
  })
})