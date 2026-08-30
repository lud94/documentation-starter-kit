// FACTUAL_MEMORY_TEST_HARNESS_001 — le harnais est lui-même testé (PART 12).
//
// ⚠️ CODE DE PRODUCTION EXERCÉ à travers le harnais : registre des candidats,
// Bridge, registre des assertions, ancres, magasin réel (repli mémoire — la
// même Map, jamais remplacée). Le mode mémoire est EXPLICITE (`allowMemory`),
// exactement comme le drapeau `-Memory` de l'enveloppe PowerShell.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  cleanupHarnessWorkspace,
  diagnoseCandidateReadBack,
  runFactualCase,
  sameSemanticFact,
  verifyHarnessEnvironment,
  HARNESS_WORKSPACE,
} from '../lib/prospector/proactive/harness/factualHarness'
import { SOURCE_ASSERTION_KIND } from '../lib/prospector/proactive/sourceAssertion'

const g: any = globalThis as any
const ENV_SAUVES = [
  'SIGNAL_ARCH_V1_SOURCE_ASSERTIONS', 'SIGNAL_ARCH_V1_CANONICAL_FACTS',
  'NODE_ENV', 'VERCEL', 'VERCEL_ENV',
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL',
] as const
let sauvegarde: Record<string, string | undefined> = {}

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  sauvegarde = {}
  for (const n of ENV_SAUVES) sauvegarde[n] = process.env[n]
  // Drapeaux ACTIVÉS pour ce processus de test — le mécanisme exact du lanceur.
  process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS = '1'
  process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS = '1'
})
afterEach(() => {
  for (const n of ENV_SAUVES) {
    if (sauvegarde[n] === undefined) delete (process.env as any)[n]
    else (process.env as any)[n] = sauvegarde[n]
  }
})

const run = (cas: string, opts: Parameters<typeof runFactualCase>[1] = {}) =>
  runFactualCase(cas, { allowMemory: true, ...opts })

describe('cas dorés (H1–H3)', () => {
  it('H1 — funding PASS : chaîne complète, relecture comprise', async () => {
    const r = await run('funding')
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 1, events: 1, snapshots: 0 })
    expect(r.environment!.workspace).toBe(HARNESS_WORKSPACE)
    expect(r.steps.every((s) => s.ok)).toBe(true)
  })

  it('H2 — executive PASS : EXECUTIVE_APPOINTMENT relu, clé de personne scopée au compte', async () => {
    const r = await run('executive')
    expect(r.verdict).toBe('PASS')
    const ancre = r.persisted.find((p) => p.summary.startsWith('EXECUTIVE_APPOINTMENT'))
    expect(ancre?.summary).toContain('name:marie dupont@acc_siren_999000001')
  })

  it('H3 — hiring 15→22→8 PASS : trois assertions, trois instantanés, tableau de constat', async () => {
    const r = await run('hiring')
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 3, events: 0, snapshots: 3 })
    expect(r.table!.map((l) => l.openings)).toEqual([15, 22, 8])
    expect(r.table!.map((l) => l.day)).toEqual(['2026-09-01', '2026-09-15', '2026-09-30'])
    // ⚠️ AUCUNE interprétation dans la sortie : constat, jamais de tendance.
    expect(JSON.stringify(r)).not.toMatch(/accel|decel|trend|tendance/i)
  })
})

describe('correction et désaccord (H4–H6)', () => {
  it('H4 — funding-correction : 2 assertions versionnées, 1 CanonicalEvent', async () => {
    const r = await run('funding-correction')
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 2, events: 1, snapshots: 0 })
  })

  it('H5 — funding-disagreement : 2 assertions (URL A/B), 1 CanonicalEvent', async () => {
    const r = await run('funding-disagreement')
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 2, events: 1, snapshots: 0 })
  })

  it('H6 — hiring-same-day-correction : 2 assertions, 1 instantané du jour', async () => {
    const r = await run('hiring-same-day-correction')
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 2, events: 0, snapshots: 1 })
  })
})

describe('fail closed (H7–H10)', () => {
  it('H7 — cas manuel malformé : INVALID_INPUT, AUCUNE persistance', async () => {
    const r = await run('manual', { manualCase: { account: { siren: '999000002' }, sourceUrl: 'https://x.test/a', retrievedAt: '2026-09-01T07:30:00.000Z', fact: { contractVersion: 'v2' } } })
    expect(r.verdict).toBe('INVALID_INPUT')
    expect(r.persisted).toEqual([])
    expect(g.__prospectorStore.size).toBe(0)
  })

  it('H7b — cas manuel VALIDE : même validateur, même pipeline, PASS', async () => {
    const fact = {
      contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
      occurredAt: '2026-07-01', occurredAtPrecision: 'DAY', sourcePublishedAt: null,
      rawDetail: { detail: 'cas manuel', icebreaker: 'ok' },
      extraction: { mode: 'claude-web', promptVersion: 'manual' },
      payload: { family: 'FUNDING', roundStage: 'SEED' },
    }
    const r = await run('manual', { manualCase: { account: { company: 'X', siren: '999000001' }, sourceUrl: 'https://example.test/manuel', retrievedAt: '2026-07-02T07:30:00.000Z', fact } })
    expect(r.verdict).toBe('PASS')
    expect(r.actual).toEqual({ assertions: 1, events: 1, snapshots: 0 })
  })

  it('H8 — environnement de production REFUSÉ (NODE_ENV et Vercel)', async () => {
    ;(process.env as any).NODE_ENV = 'production'
    expect((await run('funding')).verdict).toBe('BLOCKED')
    ;(process.env as any).NODE_ENV = 'test'
    process.env.VERCEL_ENV = 'production'
    const r = await run('funding')
    expect(r.verdict).toBe('BLOCKED')
    expect(r.reason).toContain('PRODUCTION_REFUSED')
    expect(g.__prospectorStore.size).toBe(0) // refusé AVANT toute écriture
  })

  it('H8b — Supabase NON LOCAL refusé, sans jamais recopier la valeur', () => {
    process.env.SUPABASE_URL = 'https://prod-project.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x'
    const r = verifyHarnessEnvironment(true)
    if (r.ok === true) throw new Error('aurait dû refuser')
    expect(r.reason).toBe('NON_LOCAL_DATABASE_REFUSED: SUPABASE_URL ne désigne pas localhost')
    expect(r.reason).not.toContain('prod-project') // aucune valeur divulguée
    delete process.env.SUPABASE_URL
  })

  it('H9 — une relecture qui ne correspond pas fait ÉCHOUER le verdict', async () => {
    const r = await run('funding', {
      betweenWriteAndVerify: () => {
        // Sabotage : on altère le fait structuré persisté SOUS le même id.
        for (const [k, v] of g.__prospectorStore.entries()) {
          if (k.startsWith(`${SOURCE_ASSERTION_KIND}|`)) {
            v.structuredFact.payload.amount.amountMinor = 999
          }
        }
      },
    })
    expect(r.verdict).toBe('FAIL')
    expect(r.steps.find((s) => s.name.startsWith('SourceAssertion'))!.ok).toBe(false)
  })

  it('H10 — persistance locale absente ⇒ BLOCKED, jamais un faux PASS mémoire', async () => {
    for (const n of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL']) delete process.env[n]
    const r = await runFactualCase('funding', {}) // mode par défaut : PAS de repli
    expect(r.verdict).toBe('BLOCKED')
    expect(r.reason).toContain('LOCAL_SUPABASE_REQUIRED')
    // Le mode mémoire, lui, est EXPLICITE et s'ANNONCE comme non persistant.
    const m = await run('funding')
    expect(m.environment!.mode).toBe('IN_MEMORY')
    expect(m.environment!.database).toContain('RIEN n\'est persisté')
  })
})

describe('sortie machine et hygiène (H11)', () => {
  it('H11 — le résultat est un JSON valide et complet (cas, environnement, étapes, ids, verdict)', async () => {
    const r = await run('funding')
    const j = JSON.parse(JSON.stringify(r))
    for (const cle of ['caseName', 'verdict', 'environment', 'input', 'steps', 'persisted', 'expected', 'actual']) {
      expect(j, cle).toHaveProperty(cle)
    }
    expect(j.persisted.every((p: any) => typeof p.id === 'string' && p.id.length > 0)).toBe(true)
  })

  it('nettoyage : purge UNIQUEMENT l’espace du harnais, via les primitives serveur', async () => {
    await run('hiring')
    const avant = g.__prospectorStore.size
    expect(avant).toBeGreaterThan(0)
    // Une ligne d'un AUTRE espace ne doit jamais être touchée.
    g.__prospectorStore.set('proactive_source_assertion|ws_autre|sa_x', { id: 'sa_x' })
    const r = await cleanupHarnessWorkspace()
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe(avant)
    expect(g.__prospectorStore.size).toBe(1)
    expect(g.__prospectorStore.has('proactive_source_assertion|ws_autre|sa_x')).toBe(true)
  })

  it('aucun secret dans la sortie : pas de clé de service ni de valeur d’environnement', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'secret_ne_doit_jamais_sortir'
    const r = await run('funding')
    expect(JSON.stringify(r)).not.toContain('secret_ne_doit_jamais_sortir')
  })
})

// H12 — le comportement de production hérité est inchangé : c'est l'ensemble
// de la suite (2293 tests précédents) qui le prouve ; ce fichier n'ajoute que
// des lectures/écritures dans l'espace réservé du harnais.

// ── RUNTIME_FIX_001 — la leçon du premier run Windows réel ──────────────────

describe('égalité sémantique — insensible au réordonnancement jsonb', () => {
  const fact: any = {
    contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: '2026-08-12', occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'd', icebreaker: 'i' },
    extraction: { mode: 'claude-web', promptVersion: 'p' },
    payload: {
      family: 'FUNDING', roundStage: 'SERIES_A',
      amount: { amountMinor: 1_200_000_000, currency: 'EUR', asPublished: '€12M' },
      investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }],
    },
  }
  const reordonne = (v: any): any => Array.isArray(v)
    ? v.map(reordonne)
    : (v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reordonne(v[k])]))
        : v)

  it('un bloc V2 aux clés réordonnées (comme le rend jsonb) reste LE MÊME fait', () => {
    const autre = reordonne(fact)
    expect(JSON.stringify(autre)).not.toBe(JSON.stringify(fact)) // le piège d'origine
    expect(sameSemanticFact(autre, fact)).toBe(true)             // la comparaison correcte
    expect(diagnoseCandidateReadBack(
      { ok: true, candidate: { id: 'cand_x', issuedAt: '', claim: { v2: autre } as any } },
      fact,
    )).toEqual({ ok: true, reason: 'OK' })
  })

  it('mais un fait RÉELLEMENT différent reste différent', () => {
    const change = JSON.parse(JSON.stringify(fact))
    change.payload.amount.amountMinor = 999
    expect(sameSemanticFact(change, fact)).toBe(false)
  })

  it('R5 — diagnostic fermé : indisponible ≠ absent ≠ V2 manquant ≠ fait divergent', () => {
    expect(diagnoseCandidateReadBack(null, fact).reason).toBe('CANDIDATE_NOT_ISSUED')
    expect(diagnoseCandidateReadBack({ ok: false, state: 'CANDIDATE_STORE_UNAVAILABLE' }, fact).reason)
      .toBe('CANDIDATE_STORE_UNAVAILABLE')
    expect(diagnoseCandidateReadBack({ ok: false, state: 'CANDIDATE_UNKNOWN' }, fact).reason)
      .toBe('CANDIDATE_UNKNOWN')
    expect(diagnoseCandidateReadBack(
      { ok: true, candidate: { id: 'cand_x', issuedAt: '', claim: { v2: null } as any } }, fact,
    ).reason).toBe('CANDIDATE_V2_ABSENT_AFTER_READ')
    const change = JSON.parse(JSON.stringify(fact))
    change.payload.roundStage = 'SEED'
    expect(diagnoseCandidateReadBack(
      { ok: true, candidate: { id: 'cand_x', issuedAt: '', claim: { v2: change } as any } }, fact,
    ).reason).toBe('CANDIDATE_V2_MISMATCH_AFTER_READ')
  })
})

describe('cycle de vie du CLI (R9/R10)', () => {
  const cli = readFileSync(join(process.cwd(), 'scripts/factual-harness.mjs'), 'utf8')
  const directives = cli.split('\n').filter((l) => !l.trim().startsWith('//'))

  it('R10 — aucun `process.exit(` après le travail asynchrone : exitCode seulement', () => {
    for (const l of directives) expect(l, l).not.toMatch(/process\.exit\(/)
    expect(cli).toMatch(/process\.exitCode = await main\(\)/)
  })

  it('R9 — la table des codes de sortie est inchangée', () => {
    expect(cli).toMatch(/const EXIT = \{ PASS: 0, FAIL: 1, BLOCKED: 2, INVALID_INPUT: 3 \}/)
  })
})

describe('rapport PERSISTED — objets durables UNIQUES (POLISH_001)', () => {
  const parKind = (r: Awaited<ReturnType<typeof runFactualCase>>) => {
    const m: Record<string, number> = {}
    for (const p of r.persisted) m[p.kind] = (m[p.kind] ?? 0) + 1
    return m
  }

  it('funding-disagreement : 2 candidats, 2 assertions, 1 SEUL événement canonique rapporté', async () => {
    const r = await run('funding-disagreement')
    expect(r.verdict).toBe('PASS')
    expect(parKind(r)).toEqual({
      proactive_signal_candidate: 2,
      proactive_source_assertion: 2,
      proactive_canonical_event: 1,
    })
  })

  it('hiring-same-day-correction : 2 assertions distinctes restent 2, l’instantané répété devient 1', async () => {
    const r = await run('hiring-same-day-correction')
    expect(r.verdict).toBe('PASS')
    expect(parKind(r)).toEqual({
      proactive_signal_candidate: 2,
      proactive_source_assertion: 2,
      proactive_canonical_state_snapshot: 1,
    })
  })

  it('la déduplication porte sur kind+id — aucune ligne rapportée en double', async () => {
    for (const cas of ['funding', 'executive', 'hiring', 'funding-correction']) {
      const r = await run(cas)
      const cles = r.persisted.map((p) => `${p.kind}|${p.id}`)
      expect(new Set(cles).size, cas).toBe(cles.length)
    }
  })
})

describe('amorçage PowerShell (R6/R7 — verrous structurels)', () => {
  const ps1 = readFileSync(join(process.cwd(), 'scripts/factual-test.ps1'), 'utf8')

  it('R7 — l’hôte de l’API est vérifié local AVANT usage, et le refus n’imprime aucune valeur', () => {
    expect(ps1).toMatch(/\[uri\]\$apiUrl\)\.Host/)
    expect(ps1).toMatch(/'localhost', '127\.0\.0\.1', '::1'/)
    expect(ps1).toMatch(/REFUSED/)
    expect(ps1).not.toMatch(/Write-\w+[^\n]*\$serviceKey/)
    expect(ps1).not.toMatch(/Write-\w+[^\n]*\$apiUrl/)
  })

  it('POLISH_001 — amorçage sûr en PowerShell 5.1 : capture native, code de sortie souverain, stdout seul lu', () => {
    // Capture séparée stdout/stderr par System.Diagnostics.Process — jamais un
    // appel natif direct dont le stderr informationnel deviendrait terminant.
    expect(ps1).toMatch(/System\.Diagnostics\.ProcessStartInfo/)
    expect(ps1).toMatch(/RedirectStandardOutput = \$true/)
    expect(ps1).toMatch(/RedirectStandardError = \$true/)
    // Le CODE DE SORTIE fait foi ; stderr n'entre pas dans la décision.
    expect(ps1).toMatch(/\$statut\.ExitCode -ne 0/)
    // Les valeurs viennent de STDOUT uniquement.
    expect(ps1).toMatch(/\$statut\.StdOut -split/)
    const directives = ps1.split('\n').filter((l) => !l.trim().startsWith('#'))
    for (const l of directives) {
      // Plus aucune invocation native directe du CLI (la source du NativeCommandError 5.1).
      expect(l, l).not.toMatch(/& npx supabase/)
      // stderr n'est jamais affiché ni interpolé.
      expect(l, l).not.toMatch(/Write-\w+[^\n]*StdErr|\$err\b/)
    }
  })

  it('R6/R8 — portée processus : restauration en finally, et un env déjà fourni court-circuite l’amorçage', () => {
    expect(ps1).toMatch(/envDejaFourni/)
    expect(ps1).toMatch(/-not \$Memory -and -not \$envDejaFourni/)
    expect(ps1).toMatch(/finally/)
    expect(ps1).toMatch(/Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY/)
    // Sur les LIGNES DIRECTIVES uniquement — les commentaires documentent
    // précisément ce qui est interdit, ils ont le droit de le nommer.
    const directives = ps1.split('\n').filter((l) => !l.trim().startsWith('#'))
    for (const l of directives) {
      expect(l, l).not.toMatch(/supabase link/)
      expect(l, l).not.toMatch(/\.env\b/)
    }
  })
})
