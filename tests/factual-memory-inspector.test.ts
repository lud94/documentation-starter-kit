// FACTUAL_MEMORY_INSPECTOR_V0_001 — l'inspecteur LECTURE SEULE est testé.
//
// Semis par le VRAI pipeline (harnais → registre → ancres), magasin réel
// (repli mémoire, la même Map). L'inspecteur relit avec les primitives
// strictes de production ; rien n'est simulé, rien n'est écrit par lui.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { inspectFactualMemory } from '../lib/prospector/proactive/inspector'
import { supportingAssertions } from '../lib/prospector/proactive/inspectorView'
import { runFactualCase, HARNESS_WORKSPACE } from '../lib/prospector/proactive/harness/factualHarness'
import { SOURCE_ASSERTION_KIND } from '../lib/prospector/proactive/sourceAssertion'

const g: any = globalThis as any
beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS = '1'
  process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS = '1'
})

const fait = (family: string, extra: Record<string, unknown> = {}): any => ({
  contractVersion: 'v2', family, claimNature: 'EVENT', eventStatus: 'COMPLETED',
  occurredAt: '2026-07-01', occurredAtPrecision: 'DAY', sourcePublishedAt: '2026-07-02',
  rawDetail: { detail: 'fait réel documenté', icebreaker: 'ok' },
  extraction: { mode: 'manual-curated', promptVersion: 'inspector-v0' },
  payload: { family, roundStage: 'SEED' },
  ...extra,
})

async function semer(company: string, siren: string, montant = '€10M', minor = 1_000_000_000) {
  const r = await runFactualCase('manual', {
    allowMemory: true,
    manualCase: {
      account: { company, siren, officialWebsite: 'https://presse.example.test' },
      sourceUrl: `https://presse.example.test/${siren}`,
      retrievedAt: '2026-07-03T07:30:00.000Z',
      fact: fait('FUNDING', {
        payload: {
          family: 'FUNDING', roundStage: 'SERIES_A',
          amount: { amountMinor: minor, currency: 'EUR', asPublished: montant },
        },
      }),
    },
  })
  expect(r.verdict).toBe('PASS')
}

describe('cloisonnement (R1/R2/R10)', () => {
  it('R1 — un compte ne voit JAMAIS les faits d’un autre compte du même espace', async () => {
    await semer('Lupin Dental', '850067877')
    await semer('OVHcloud', '537407926')
    const lupin = await inspectFactualMemory('acc_siren_850067877', HARNESS_WORKSPACE)
    if (lupin.ok === false) throw new Error(lupin.reason)
    expect(lupin.view.company).toBe('Lupin Dental')
    expect(JSON.stringify(lupin.view)).not.toContain('537407926')
    expect(JSON.stringify(lupin.view)).not.toContain('OVHcloud')
    expect(lupin.view.events.length).toBe(1)
    expect(lupin.view.claims.length).toBe(1)
  })

  it('R2 — un autre ESPACE est invisible, même pour le même compte', async () => {
    await semer('Lupin Dental', '850067877')
    // Une ligne parfaitement valide… dans un AUTRE espace.
    const [k, v] = [...g.__prospectorStore.entries()].find(([x]: any) => x.startsWith(`${SOURCE_ASSERTION_KIND}|`))!
    g.__prospectorStore.set(k.replace(`|${HARNESS_WORKSPACE}|`, '|ws_autre|'), { ...v, workspaceId: 'ws_autre' })
    const autre = await inspectFactualMemory('acc_siren_850067877', 'ws_autre')
    if (autre.ok === false) throw new Error(autre.reason)
    // L'identité de l'assertion enjambe l'espace ⇒ recalcul divergent ⇒ rejetée,
    // jamais présentée comme un fait de cet espace.
    expect(autre.view.claims).toEqual([])
    const harnais = await inspectFactualMemory('acc_siren_850067877', HARNESS_WORKSPACE)
    if (harnais.ok === false) throw new Error(harnais.reason)
    expect(harnais.view.claims.length).toBe(1) // R10 — l'espace du harnais s'inspecte en local
  })

  it('accountId non vérifié ⇒ INVALID_ACCOUNT, aucune lecture', async () => {
    const r = await inspectFactualMemory('acc_name_lupin', HARNESS_WORKSPACE)
    expect(r).toEqual({ ok: false, reason: 'INVALID_ACCOUNT' })
  })
})

describe('lecture seule et traçabilité (R3/R4/R8/R9)', () => {
  it('R3/R4 — le module d’inspection n’importe AUCUNE primitive de mutation', () => {
    for (const f of [
      'lib/prospector/proactive/inspector.ts',
      'lib/prospector/proactive/inspectorView.ts',
      'pages/api/internal/factual-memory.ts',
      'pages/internal/factual-memory.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/upsertItem|insertItemIfAbsent|deleteItem|claimItem|deleteExpired/)
    }
  })

  it('R8 — deux versions sémantiques d’une même URL : 2 assertions, 1 URL unique — jamais « 2 sources »', async () => {
    await semer('Lupin Dental', '850067877', '€10M', 1_000_000_000)
    await semer('Lupin Dental', '850067877', '€12M', 1_200_000_000)
    const r = await inspectFactualMemory('acc_siren_850067877', HARNESS_WORKSPACE)
    if (r.ok === false) throw new Error(r.reason)
    const [groupe] = r.view.claims
    expect(groupe.assertions.length).toBe(2)
    expect(groupe.uniqueSourceUrls).toBe(1)
    // Traçabilité : l'ancre unique est soutenue par les DEUX versions.
    expect(r.view.events.length).toBe(1)
    expect(supportingAssertions(r.view.events[0], r.view.claims).length).toBe(2)
  })

  it('R9 — une ligne persistée malformée est REJETÉE (kind+id), jamais présentée comme un fait', async () => {
    await semer('Lupin Dental', '850067877')
    // Corruption sous identifiant existant : montant substitué dans l'instantané.
    const [, v] = [...g.__prospectorStore.entries()].find(([x]: any) => x.startsWith(`${SOURCE_ASSERTION_KIND}|`))!
    v.structuredFact.payload.amount.amountMinor = 42
    const r = await inspectFactualMemory('acc_siren_850067877', HARNESS_WORKSPACE)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.view.claims).toEqual([])
    expect(r.view.rejected.length).toBe(1)
    expect(r.view.rejected[0].kind).toBe(SOURCE_ASSERTION_KIND)
    expect(r.view.rejected[0].reason).toBe('MALFORMED_ROW')
    // Le contenu non validé n'est pas recopié dans la vue.
    expect(JSON.stringify(r.view.rejected)).not.toContain('42')
  })

  it('les instantanés d’état ne sont soutenus QUE par les assertions de LEUR jour', async () => {
    const jour = (ra: string) => runFactualCase('manual', {
      allowMemory: true,
      manualCase: {
        account: { company: 'Scaleway', siren: '433115904', officialWebsite: 'https://presse.example.test' },
        sourceUrl: 'https://presse.example.test/careers',
        retrievedAt: ra,
        fact: fait('HIRING_SNAPSHOT', {
          claimNature: 'STATE', eventStatus: 'UNKNOWN', occurredAt: null, occurredAtPrecision: 'UNKNOWN',
          payload: { family: 'HIRING_SNAPSHOT', roleFunction: 'SALES', roleStatus: 'OPEN',
            openingsObserved: { value: 4, method: 'ENUMERATED_POSTINGS' } },
        }),
      },
    })
    await jour('2026-08-30T07:00:00.000Z')
    await jour('2026-09-02T07:00:00.000Z')
    const r = await inspectFactualMemory('acc_siren_433115904', HARNESS_WORKSPACE)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.view.snapshots.length).toBe(2)
    for (const s of r.view.snapshots) {
      const soutien = supportingAssertions(s, r.view.claims)
      expect(soutien.length).toBe(1)
      expect(soutien[0].sourceObservedDay).toBe(s.stateObservedDay)
    }
  })
})

describe('route interne (R5/R6/R11)', () => {
  async function appeler(method: string, query: Record<string, string>, env: Record<string, string | undefined> = {}) {
    const sauvegarde: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(env)) {
      sauvegarde[k] = process.env[k]
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    vi.resetModules()
    vi.doMock('../lib/prospector/tenant', () => ({
      resolveTenantFromRequest: async () => ({ id: 'ws_locataire', kind: 'client' }),
    }))
    const { default: handler } = await import('../pages/api/internal/factual-memory')
    let statut = 0; let corps: any = null
    const res: any = { status: (s: number) => { statut = s; return res }, json: (b: any) => { corps = b; return res } }
    await handler({ method, query, cookies: {} } as any, res)
    vi.doUnmock('../lib/prospector/tenant')
    for (const [k, v] of Object.entries(sauvegarde)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v }
    return { statut, corps }
  }

  it('R5 — aucune mutation : POST/PUT/DELETE ⇒ 405', async () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await appeler(m, {})).statut, m).toBe(405)
    }
  })

  it('R6 — pas d’accès générique au magasin : la route ignore tout `kind` et exige un compte vérifié', async () => {
    const src = readFileSync(join(process.cwd(), 'pages/api/internal/factual-memory.ts'), 'utf8')
    expect(src).not.toMatch(/query\.kind|listItems\(/)
    const r = await appeler('GET', { accountId: 'nimporte', kind: 'proactive_source_assertion' })
    expect(r.statut).toBe(400)
  })

  it('R11 — l’espace du harnais est INADRESSABLE en production (404, fail closed)', async () => {
    const prod = await appeler('GET', { accountId: 'acc_siren_850067877', scope: 'harness' }, { VERCEL_ENV: 'production' })
    expect(prod.statut).toBe(404)
    // En local, la même requête est servie (espace du harnais, lecture seule).
    await semer('Lupin Dental', '850067877')
    const local = await appeler('GET', { accountId: 'acc_siren_850067877', scope: 'harness' }, { VERCEL_ENV: undefined, VERCEL: undefined })
    expect(local.statut).toBe(200)
    expect(local.corps.view.company).toBe('Lupin Dental')
  })
})

describe('présentation et périmètre (R7/R12/R13)', () => {
  const page = readFileSync(join(process.cwd(), 'pages/internal/factual-memory.tsx'), 'utf8')

  it('R7 — les quatre horloges restent NOMMÉES et distinctes, jamais une « date » générique', () => {
    for (const label of ['SOURCE PUBLISHED', 'SOURCE RETRIEVED', 'ADJUDICATED', 'STATE OBSERVED DAY']) {
      expect(page).toContain(label)
    }
  })

  it('R8bis — la page distingue « assertions » et « URLs uniques », et marque INTERNAL / READ ONLY', () => {
    expect(page).toContain('URLs de source normalisées uniques')
    expect(page).toContain('INTERNAL / READ ONLY')
    expect(page).toContain('rel="noopener noreferrer"')
  })

  it('R12/R13 — aucun moteur de Situation/recommandation/score, aucun module Jarvis importé', () => {
    for (const f of [
      'lib/prospector/proactive/inspector.ts',
      'lib/prospector/proactive/inspectorView.ts',
      'pages/api/internal/factual-memory.ts',
      'pages/internal/factual-memory.tsx',
    ]) {
      // Sur les IMPORTS uniquement : la doc a le droit de NOMMER ce qui est
      // interdit ; les imports n'ont pas le droit de l'APPORTER.
      const imports = readFileSync(join(process.cwd(), f), 'utf8')
        .split('\n').filter((l) => /^\s*(import|export .* from)/.test(l)).join('\n')
      expect(imports, f).not.toMatch(/situationEngine|recommendationEngine|decisionKernel|eligibility|jarvis|orchestrator|motions/i)
    }
  })
})
