import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { upsertLeadChecked, listLeads, deleteLead } from '../lib/supabase/leads'
import { resetConfigCache } from '../lib/env'
import type { Lead } from '../types/prospector'

// Défaut P0 corrigé : l'ancienne écriture (upsert onConflict:'id') déplaçait la
// ligne d'un espace de travail à un autre. Ces cas verrouillent le comportement.
//
// ⚠️ PORTÉE — ces tests s'exécutent sur le REPLI MÉMOIRE (aucune variable Supabase
// définie). Ils valident les règles d'isolation, mais NI la contrainte d'unicité
// PostgreSQL, NI le code 23505, NI la concurrence réelle. Cette validation-là est
// dans tests/integration/leads-pg.test.ts et elle est OBLIGATOIRE avant toute
// promotion en production.

const SUPA = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY',
  'SUPABASE_KEY', 'SERVICE_ROLE_KEY', 'SERVICE_ROLE', 'APP_ENV_STRICT']
let saved: Record<string, string | undefined> = {}

function lead(id: string, company: string): Lead {
  return {
    id, kind: 'account', firstName: '', lastName: '', title: '', company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
  } as Lead
}

beforeEach(() => {
  saved = {}
  for (const k of SUPA) { saved[k] = process.env[k]; delete process.env[k] }
  resetConfigCache()
  // Le repli mémoire vit sur globalThis, mais le module en capture la référence à
  // l'import : REMPLACER l'objet ne réinitialise rien, il faut vider CETTE instance.
  const g = globalThis as any
  if (!g.__prospectorLeads3) g.__prospectorLeads3 = new Map()
  g.__prospectorLeads3.clear()
})
afterEach(() => {
  for (const k of SUPA) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  resetConfigCache()
})

describe('isolation par espace de travail', () => {
  it('un lead écrit dans A n’est pas visible depuis B', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    expect(await listLeads('ws_a')).toHaveLength(1)
    expect(await listLeads('ws_b')).toHaveLength(0)
  })

  it('DÉFAUT P0 — écrire le même identifiant depuis B est REFUSÉ, et A est intact', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')

    const r = await upsertLeadChecked(lead('ld_1', 'Pirate'), 'ws_b')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('workspace_conflict')

    const a = await listLeads('ws_a')
    expect(a).toHaveLength(1)
    expect(a[0].company).toBe('Acme')      // aucune donnée écrasée
    expect(await listLeads('ws_b')).toHaveLength(0) // aucune ligne déplacée
  })

  it('mettre à jour depuis le MÊME espace fonctionne (non-régression)', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    const r = await upsertLeadChecked(lead('ld_1', 'Acme SAS'), 'ws_a')
    expect(r.ok).toBe(true)
    const a = await listLeads('ws_a')
    expect(a).toHaveLength(1)
    expect(a[0].company).toBe('Acme SAS')
  })

  it('supprimer depuis B ne supprime pas la ligne de A', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    await deleteLead('ld_1', 'ws_b')
    expect(await listLeads('ws_a')).toHaveLength(1)
  })

  it('un identifiant neuf dans B est accepté — aucun faux refus', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    const r = await upsertLeadChecked(lead('ld_2', 'Beta'), 'ws_b')
    expect(r.ok).toBe(true)
    expect(await listLeads('ws_b')).toHaveLength(1)
  })

  it('le motif de refus est exploitable par l’appelant', async () => {
    await upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    const r = await upsertLeadChecked(lead('ld_1', 'X'), 'ws_b')
    expect(r.reason).toBe('workspace_conflict')
    expect(['workspace_conflict', 'contention', 'db_error', 'env_blocked']).toContain(r.reason)
  })
})

describe('interaction avec le contrat d’environnement', () => {
  it('écritures suspendues → refus explicite, rien n’est écrit', async () => {
    process.env.APP_ENV_STRICT = '1' // APP_ENV absent + mode strict → blocage
    resetConfigCache()
    const r = await upsertLeadChecked(lead('ld_9', 'Bloquée'), 'ws_a')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('env_blocked')
    expect(await listLeads('ws_a')).toHaveLength(0)
  })
})
