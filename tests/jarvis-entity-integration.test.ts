import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '../types/prospector'

// ── Données ──────────────────────────────────────────────────────────────────

function makeSeverine(): Lead {
  return {
    id: 'ld_g1z77zvy',
    kind: 'contact',
    firstName: 'Severine',
    lastName: 'GABAY',
    company: 'REDSEN FRANCE',
    title: 'À qualifier',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: null,
    phone: null,
  }
}

function makeHomonyme(): Lead {
  return {
    id: 'ld_other',
    kind: 'contact',
    firstName: 'Severine',
    lastName: 'GABAY',
    company: 'AUTRE SOCIETE',
    title: 'À qualifier',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: null,
    phone: null,
  }
}

let leads: Lead[] = []
let storageOk = true

// ── LLM ──────────────────────────────────────────────────────────────────────

const callClaude = vi.fn()

vi.mock('../lib/prospector/llm', () => ({
  callClaude: (...args: any[]) => callClaude(...args),
  parseJson: <T>(text: string): T | null => {
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  },
  cacheKey: (...parts: any[]) => JSON.stringify(parts),
}))

// ── Keystore ─────────────────────────────────────────────────────────────────

vi.mock('../lib/prospector/keystore', () => ({
  getKey: (name: string) =>
    name === 'ANTHROPIC_API_KEY' ? 'test-key' : '',
}))

// ── Leads ────────────────────────────────────────────────────────────────────

const upsertLeadChecked = vi.fn(
  async (_lead: Lead, _ws: string) => ({
    ok: true,
  }),
)

const listLeadsStrict = vi.fn(async () =>
  storageOk
    ? {
        ok: true as const,
        leads,
      }
    : {
        ok: false as const,
      },
)

vi.mock('../lib/supabase/leads', () => ({
  listLeads: async () => leads,
  listLeadsStrict: (...args: any[]) =>
    (listLeadsStrict as any)(...args),
  upsertLeadChecked: (...args: any[]) =>
    (upsertLeadChecked as any)(...args),
}))

// ── Store générique ──────────────────────────────────────────────────────────

const upsertItem = vi.fn(
  async (
    _kind: string,
    _id: string,
    _item: any,
    _ws: string,
  ) => true,
)
vi.mock('../lib/supabase/store', () => ({
  listItems: async () => [],
  upsertItem: (...args: any[]) =>
    (upsertItem as any)(...args),
}))

// ── Dépendances non utilisées dans ce lot ────────────────────────────────────

vi.mock('../lib/prospector/datagouv', () => ({
  lookupByName: vi.fn(),
  fetchCompanyDetail: vi.fn(),
  fetchCompanies: vi.fn(),
}))

vi.mock('../lib/prospector/identify', () => ({
  identifyLead: vi.fn(),
  enrichCompanyWeb: vi.fn(),
}))

import {
  executeJarvis,
  planJarvis,
} from '../lib/prospector/jarvisAgent'

const tenant = {
  id: 'admin',
  name: 'Admin',
  status: 'active',
} as any

function llmPlan(action: any, reply = 'Action préparée.') {
  callClaude.mockResolvedValueOnce({
    blocked: false,
    text: JSON.stringify({
      reply,
      action,
    }),
  })
}

beforeEach(() => {
  leads = [makeSeverine()]
  storageOk = true

  vi.clearAllMocks()

  upsertLeadChecked.mockResolvedValue({
    ok: true,
  })

  upsertItem.mockResolvedValue(true)
})

// ═════════════════════════════════════════════════════════════════════════════
// 1 — Résolution AVANT confirmation
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01B — résolution avant confirmation', () => {
  it('accent ajouté par le LLM → même lead exact et leadId figé', async () => {
    llmPlan({
      type: 'set_status',
      name: 'Séverine GABAY',
      status: 'chaud',
    })

    const plan = await planJarvis(
      tenant,
      'Mets Severine GABAY en chaud',
      { channel: 'app' },
    )

    expect(plan.action).not.toBeNull()
    expect(plan.action.leadId).toBe('ld_g1z77zvy')
    expect(plan.action.name).toBe('Severine GABAY')

    expect(plan.reply).toContain('Je vais passer')
    expect(plan.reply).toContain('REDSEN FRANCE')

    // Le planner n'a plus le droit d'annoncer un succès déjà accompli.
    expect(plan.reply).not.toContain('passée en statut')
    expect(plan.reply).not.toContain('✓')
  })

  it('Severine Gabet → correspondance probable, jamais mutation silencieuse', async () => {
    llmPlan({
      type: 'set_status',
      name: 'Severine Gabet',
      status: 'chaud',
    })

    const plan = await planJarvis(
      tenant,
      'Mets Severine Gabet en chaud',
      { channel: 'app' },
    )

    expect(plan.action).not.toBeNull()
    expect(plan.action.leadId).toBe('ld_g1z77zvy')

    expect(plan.reply).toContain(
      'J’ai trouvé un lead proche',
    )

    expect(plan.reply).toContain(
      'Severine GABAY — REDSEN FRANCE',
    )

    expect(plan.reply).toContain('Confirme')
  })

  it('deux homonymes → aucune action n’est proposée', async () => {
    leads = [
      makeSeverine(),
      makeHomonyme(),
    ]

    llmPlan({
      type: 'set_status',
      name: 'Severine GABAY',
      status: 'chaud',
    })

    const plan = await planJarvis(
      tenant,
      'Mets Severine GABAY en chaud',
      { channel: 'app' },
    )

    expect(plan.action).toBeNull()

    expect(plan.reply).toContain(
      'plusieurs correspondances',
    )

    expect(plan.reply).toContain('REDSEN FRANCE')
    expect(plan.reply).toContain('AUTRE SOCIETE')
  })

  it('panne de stockage → jamais transformée en "Lead introuvable"', async () => {
    storageOk = false

    llmPlan({
      type: 'set_status',
      name: 'Severine GABAY',
      status: 'chaud',
    })

    const plan = await planJarvis(
      tenant,
      'Mets Severine GABAY en chaud',
      { channel: 'app' },
    )

    expect(plan.action).toBeNull()

    expect(plan.reply).toContain(
      'Je ne peux pas lire le pipeline',
    )

    expect(plan.reply).not.toContain('introuvable')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — Exécution par ID
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01B — l’ID serveur est l’autorité', () => {
  it('leadId correct + nom falsifié → le lead identifié par ID est modifié', async () => {
    const result = await executeJarvis(
      tenant,
      {
        type: 'set_status',
        leadId: 'ld_g1z77zvy',

        // Le nom n'est plus une autorité.
        name: 'UNE AUTRE PERSONNE',
        status: 'chaud',
      },
      'admin',
    )

    expect(result).toContain('statut « chaud »')

    expect(upsertLeadChecked).toHaveBeenCalledTimes(1)

    const savedLead =
      upsertLeadChecked.mock.calls[0][0] as Lead

    expect(savedLead.id).toBe('ld_g1z77zvy')
    expect(savedLead.firstName).toBe('Severine')
    expect(savedLead.lastName).toBe('GABAY')
    expect(savedLead.status).toBe('chaud')
  })

  it('lead supprimé entre planification et confirmation → aucune mutation', async () => {
    leads = []

    const result = await executeJarvis(
      tenant,
      {
        type: 'set_status',
        leadId: 'ld_g1z77zvy',
        name: 'Severine GABAY',
        status: 'chaud',
      },
      'admin',
    )

    expect(result).toContain('introuvable')

    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })

  it('action directe fuzzy sans leadId → aucune mutation', async () => {
    const result = await executeJarvis(
      tenant,
      {
        type: 'set_status',
        name: 'Severine Gabet',
        status: 'chaud',
      },
      'admin',
    )

    // targetForExecution n'autorise en compatibilité que l'exact.
    expect(result).toContain('introuvable')

    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — Notes / tâches
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01B — note/tâche liée au lead résolu', () => {
  it('une note résolue utilise le leadId réel', async () => {
    llmPlan({
      type: 'add_note',
      name: 'Séverine GABAY',
      text: 'Rappeler lundi',
    })

    const plan = await planJarvis(
      tenant,
      'Rappelle Séverine GABAY lundi',
      { channel: 'app' },
    )

    expect(plan.action.leadId).toBe('ld_g1z77zvy')

    const result = await executeJarvis(
      tenant,
      plan.action,
      'admin',
    )

    expect(result).toContain('Note/tâche créée')

    expect(upsertItem).toHaveBeenCalledTimes(1)

    const [
      kind,
      ,
      task,
      ws,
    ] = upsertItem.mock.calls[0]

    expect(kind).toBe('task')
    expect(ws).toBe('admin')
    expect(task.leadId).toBe('ld_g1z77zvy')
    expect(task.leadName).toBe('Severine GABAY')
  })

  it('lead disparu avant confirmation → aucune tâche orpheline', async () => {
    leads = []

    const result = await executeJarvis(
      tenant,
      {
        type: 'add_note',
        leadId: 'ld_g1z77zvy',
        name: 'Severine GABAY',
        text: 'Rappeler lundi',
      },
      'admin',
    )

    expect(result).toContain('Rien n’a été créé')

    expect(upsertItem).not.toHaveBeenCalled()
  })
})