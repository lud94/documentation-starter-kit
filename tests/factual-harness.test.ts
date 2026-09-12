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
    const r = await run('manual', { manualCase: { account: { company: 'X', siren: '999000001', officialWebsite: 'https://example.test' }, sourceUrl: 'https://example.test/manuel', retrievedAt: '2026-07-02T07:30:00.000Z', observedAt: '2026-07-02T09:00:00.000Z', confirmedAt: '2026-07-02T09:05:00.000Z', fact } })
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

describe('mode manuel — identité de compte RÉELLE (FACTUAL_REAL_WORLD_MANUAL_001)', () => {
  const faitManuel = (extra: Record<string, unknown> = {}): any => ({
    contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: '2026-07-01', occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'levée réelle documentée', icebreaker: 'ok' },
    extraction: { mode: 'manual-curated', promptVersion: 'real-world-manual-v1', model: 'GPT-5.6 Sol' },
    payload: { family: 'FUNDING', roundStage: 'SEED' },
    ...extra,
  })
  const enveloppeManuelle = (company: string, siren: string) => ({
    // `officialWebsite` : seul chemin vers le grade A pour une source unique —
    // la politique de source de production n'est PAS contournée.
    account: { company, siren, officialWebsite: 'https://presse.example.test' },
    sourceUrl: 'https://presse.example.test/annonce',
    retrievedAt: '2026-07-02T07:30:00.000Z',
    observedAt: '2026-07-02T09:00:00.000Z',
    confirmedAt: '2026-07-02T09:05:00.000Z',
    fact: faitManuel(),
  })

  it('R1/R3/R4/R5 — Lupin Dental 850067877 : le compte FOURNI traverse tout le pipeline', async () => {
    const r = await run('manual', { manualCase: enveloppeManuelle('Lupin Dental', '850067877') })
    expect(r.verdict).toBe('PASS')
    expect(r.input.company).toBe('Lupin Dental')
    expect(r.input.account).toBe('acc_siren_850067877')

    // Rien ne reste sous l'identité synthétique, et TOUT porte le compte réel.
    const tout = [...g.__prospectorStore.entries()]
    expect(JSON.stringify(tout)).not.toContain('999000001')
    const candidat = tout.find(([k]: any) => k.startsWith('proactive_signal_candidate|'))![1]
    expect(candidat.claim.company).toBe('Lupin Dental') // R3
    const assertion = tout.find(([k]: any) => k.startsWith('proactive_source_assertion|'))![1]
    expect(assertion.accountId).toBe('acc_siren_850067877') // R4
    expect(assertion.canonicalClaimKey).toBe('recent_funding|acc_siren_850067877|2026-07-01')
    const ancre = tout.find(([k]: any) => k.startsWith('proactive_canonical_event|'))![1]
    expect(ancre.accountId).toBe('acc_siren_850067877') // R5
    // Et toujours dans le SEUL espace du harnais.
    for (const [k] of tout) expect(k).toContain(`|${HARNESS_WORKSPACE}|`)
  })

  it('R2 — OVHcloud 537407926 → acc_siren_537407926 exactement', async () => {
    const r = await run('manual', { manualCase: enveloppeManuelle('OVHcloud', '537407926') })
    expect(r.verdict).toBe('PASS')
    expect(r.input.account).toBe('acc_siren_537407926')
  })

  it('R6/R7 — les cas dorés restent OCTET POUR OCTET sous ACME TEST / acc_siren_999000001', async () => {
    for (const cas of ['funding', 'executive', 'hiring']) {
      const r = await run(cas)
      expect(r.input.company, cas).toBe('ACME TEST')
      expect(r.input.account, cas).toBe('acc_siren_999000001')
      expect(r.verdict, cas).toBe('PASS')
    }
  })

  it('R8 — SIREN invalide ou company absente : INVALID_INPUT, rien n’est persisté', async () => {
    const mauvais = enveloppeManuelle('Lupin Dental', '85006787') // 8 chiffres
    expect((await run('manual', { manualCase: mauvais })).verdict).toBe('INVALID_INPUT')
    const sansNom = enveloppeManuelle('  ', '850067877')
    expect((await run('manual', { manualCase: sansNom })).verdict).toBe('INVALID_INPUT')
    expect(g.__prospectorStore.size).toBe(0)
  })

  it('R9/R10/R11 — vocabulaire d’extraction clos : manual-curated accepté, hérités inchangés, inconnu rejeté', async () => {
    const { isAcquisitionFactV2 } = await import('../lib/prospector/proactive/acquisitionV2')
    expect(isAcquisitionFactV2(faitManuel())).toBe(true) // R9
    for (const mode of ['exa+claude', 'claude-web']) { // R10
      expect(isAcquisitionFactV2(faitManuel({ extraction: { mode, promptVersion: 'p' } })), mode).toBe(true)
    }
    for (const mode of ['scraped', 'manual', 'MANUAL-CURATED', '']) { // R11
      expect(isAcquisitionFactV2(faitManuel({ extraction: { mode, promptVersion: 'p' } })), mode).toBe(false)
    }
  })

  it('R12 — la provenance d’extraction ne participe à AUCUNE identité factuelle', async () => {
    const { assertedFactHash, semanticFactProjection } = await import('../lib/prospector/proactive/acquisitionV2')
    const manuel = faitManuel()
    const web = faitManuel({ extraction: { mode: 'claude-web', promptVersion: 'autre', model: 'x' } })
    // Même projection sémantique, même condensat de version — l'extraction est
    // une métadonnée d'assemblage, délibérément EXCLUE du fait affirmé.
    expect(semanticFactProjection(manuel, 'acc_siren_850067877'))
      .toEqual(semanticFactProjection(web, 'acc_siren_850067877'))
    expect(assertedFactHash(manuel, 'acc_siren_850067877'))
      .toBe(assertedFactHash(web, 'acc_siren_850067877'))
    // Et l'ancre canonique est identique : mêmes ws/compte/jour ⇒ même id,
    // quel que soit le mode d'extraction des assertions qui la soutiennent.
    const { canonicalEventId } = await import('../lib/prospector/proactive/canonicalFact')
    expect(canonicalEventId('ws_factual_harness', 'acc_siren_850067877', '2026-07-01'))
      .toBe(canonicalEventId('ws_factual_harness', 'acc_siren_850067877', '2026-07-01'))
  })
})

describe('parité de rejeu du candidat (FACTUAL_MANUAL_REPLAY_PARITY_001)', () => {
  const faitExec = (): any => ({
    contractVersion: 'v2', family: 'EXECUTIVE_CHANGE', claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: '2026-08-26', occurredAtPrecision: 'DAY', sourcePublishedAt: '2026-08-27',
    rawDetail: { detail: 'nomination réelle', icebreaker: 'félicitations' },
    extraction: { mode: 'manual-curated', promptVersion: 'real-world-manual-v1' },
    payload: {
      family: 'EXECUTIVE_CHANGE', direction: 'APPOINTMENT', roleFunction: 'SALES',
      roleSeniority: 'C_LEVEL',
      person: { fullNameRaw: 'Marie Dupont', normalizedName: 'marie dupont', verification: 'NAME_ONLY' },
    },
  })
  const faitFunding = (): any => ({
    contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: '2026-08-26', occurredAtPrecision: 'DAY', sourcePublishedAt: '2026-08-27',
    rawDetail: { detail: 'levée réelle', icebreaker: 'bravo' },
    extraction: { mode: 'manual-curated', promptVersion: 'real-world-manual-v1' },
    payload: { family: 'FUNDING', roundStage: 'SEED' },
  })
  const faitHiring = (): any => ({
    contractVersion: 'v2', family: 'HIRING_SNAPSHOT', claimNature: 'STATE', eventStatus: 'UNKNOWN',
    occurredAt: null, occurredAtPrecision: 'UNKNOWN', sourcePublishedAt: '2026-08-27',
    rawDetail: { detail: '3 postes ouverts', icebreaker: 'ça recrute' },
    extraction: { mode: 'manual-curated', promptVersion: 'real-world-manual-v1' },
    payload: { family: 'HIRING_SNAPSHOT', roleFunction: 'SALES', roleStatus: 'OPEN',
      openingsObserved: { value: 3, method: 'ENUMERATED_POSTINGS' } },
  })
  const enveloppe = (fact: any) => ({
    account: { company: 'Lupin Dental', siren: '850067877', officialWebsite: 'https://presse.example.test' },
    sourceUrl: 'https://presse.example.test/annonce',
    retrievedAt: '2026-08-28T07:30:00.000Z',
    observedAt: '2026-08-28T09:00:00.000Z',
    confirmedAt: '2026-08-28T09:05:00.000Z',
    fact,
  })
  const candidatEnBase = () => {
    const [, v] = [...g.__prospectorStore.entries()]
      .find(([k]: any) => k.startsWith('proactive_signal_candidate|'))!
    return v.claim
  }

  it('R1/R6/R10 — FUNDING manuel : la coquille héritée MIROIRE le fait V2, sourcePublishedAt survit', async () => {
    const r = await run('manual', { manualCase: enveloppe(faitFunding()) })
    expect(r.verdict).toBe('PASS')
    const claim = candidatEnBase()
    expect(claim.signalType).toBe('levée')
    expect(claim.eventDate).toBe('2026-08-26')       // R1 — jamais le jour synthétique
    expect(claim.eventDatePrecision).toBe('DAY')
    expect(claim.sourcePublishedAt).toBe('2026-08-27') // R6
    expect(claim.v2.sourcePublishedAt).toBe('2026-08-27') // R10 — le fait V2 inchangé
  })

  it('R2/R3/R4 — EXECUTIVE manuel : actu, jour du fait, fonction du fait — jamais « levée » datée d’ailleurs', async () => {
    const r = await run('manual', { manualCase: enveloppe(faitExec()) })
    expect(r.verdict).toBe('PASS')
    const claim = candidatEnBase()
    expect(claim.signalType).toBe('actu')            // R2
    expect(claim.signalType).not.toBe('levée')
    expect(claim.eventDate).toBe('2026-08-26')       // R3
    expect(claim.eventDate).not.toBe('2026-08-12')
    expect(claim.roleFunction).toBe('SALES')         // R4
  })

  it('R5 — HIRING manuel : champs d’ÉTAT reflétés (OPEN/SALES, pas de date inventée)', async () => {
    const r = await run('manual', { manualCase: enveloppe(faitHiring()) })
    expect(r.verdict).toBe('PASS')
    const claim = candidatEnBase()
    expect(claim.signalType).toBe('recrutement')
    expect(claim.claimNature).toBe('STATE')
    expect(claim.eventDate).toBeNull()
    expect(claim.eventDatePrecision).toBe('UNKNOWN')
    expect(claim.roleStatus).toBe('OPEN')
    expect(claim.roleFunction).toBe('SALES')
  })

  it('R7/R8/R9 — sourcePublishedAt traverse rejeu → SourceEvidence → provenance PERSISTÉE de l’assertion', async () => {
    const r = await run('manual', { manualCase: enveloppe(faitFunding()) })
    expect(r.verdict).toBe('PASS')
    // R7 — le hit REJOUÉ (reconstruit du registre, comme en production).
    const { readCandidate, hitFromCandidate, candidateId } = await import('../lib/prospector/proactive/signalCandidates')
    const claim = candidatEnBase()
    const lu = await readCandidate(candidateId(claim, HARNESS_WORKSPACE), HARNESS_WORKSPACE)
    if (lu.ok === false) throw new Error(lu.state)
    const rejoue = hitFromCandidate(lu.candidate)
    expect(rejoue.sourcePublishedAt).toBe('2026-08-27')
    // R9 — la provenance PERSISTÉE de l'assertion porte la date de publication.
    const assertion = [...g.__prospectorStore.entries()]
      .find(([k]: any) => k.startsWith('proactive_source_assertion|'))![1]
    expect(assertion.provenance.sourcePublishedAt).toBe('2026-08-27')
    expect(assertion.structuredFact.sourcePublishedAt).toBe('2026-08-27') // R10 encore
  })

  it('R11 — verrou structurel : l’aval consomme le hit REJOUÉ du registre, jamais l’objet original', () => {
    const src = readFileSync(join(process.cwd(), 'lib/prospector/proactive/harness/factualHarness.ts'), 'utf8')
    expect(src).toMatch(/const hitRejoue = hitFromCandidate\(/)
    expect(src).toMatch(/sourceEvidenceFromHit\(hitRejoue,/)
    expect(src).toMatch(/mapClaim\(hitRejoue\)/)
    // L'original ne nourrit RIEN en aval : ni preuve, ni mapping.
    expect(src).not.toMatch(/sourceEvidenceFromHit\(hit,/)
    expect(src).not.toMatch(/mapClaim\(hit\)/)
  })

  it('R12 — les six identifiants de candidats synthétiques sont inchangés (verrous littéraux)', async () => {
    const attendus: Record<string, string[]> = {
      funding: ['cand_b181e56e7d776f039d1828ec6052ea1e'],
      executive: ['cand_78f5f76180a88a9b01e65810a33704bc'],
      hiring: ['cand_38e6efde9ec01752724e0b7cff19ba8d', 'cand_b05da52ca68751b488546e8406695de8', 'cand_e81ecc7532a812f1e6f7b259a7dbcc59'],
      'funding-correction': ['cand_ddcb0b5d78245f3276089f6a80f4ef3d', 'cand_b181e56e7d776f039d1828ec6052ea1e'],
      'funding-disagreement': ['cand_54452b3f40df9c32a0686ecb5c68ca03', 'cand_a6f06c2575dca236c9fda4221e20dae7'],
      'hiring-same-day-correction': ['cand_38e6efde9ec01752724e0b7cff19ba8d', 'cand_cd7dd9e313cacf6250e11dda0b850996'],
    }
    for (const [cas, ids] of Object.entries(attendus)) {
      if (g.__prospectorStore) g.__prospectorStore.clear()
      const r = await run(cas)
      expect(r.verdict, cas).toBe('PASS')
      expect(r.persisted.filter((p) => p.kind === 'proactive_signal_candidate').map((p) => p.id), cas).toEqual(ids)
    }
  })
})

describe('parité des horloges manuelles (FACTUAL_MANUAL_CLOCK_PARITY_001)', () => {
  const RETR = '2026-08-20T07:30:00.000Z'
  const OBS = '2026-08-21T10:00:00.000Z'
  const CONF = '2026-08-22T11:15:00.000Z'
  const enveloppe = (fact: any, extra: Record<string, unknown> = {}): any => ({
    account: { company: 'Lupin Dental', siren: '850067877', officialWebsite: 'https://presse.example.test' },
    sourceUrl: 'https://presse.example.test/horloges',
    retrievedAt: RETR, observedAt: OBS, confirmedAt: CONF,
    fact, ...extra,
  })
  const evenement = (): any => ({
    contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: '2026-08-19', occurredAtPrecision: 'DAY', sourcePublishedAt: '2026-08-19',
    rawDetail: { detail: 'levée réelle', icebreaker: 'ok' },
    extraction: { mode: 'manual-curated', promptVersion: 'clock-parity' },
    payload: { family: 'FUNDING', roundStage: 'SEED' },
  })
  const etat = (): any => ({
    contractVersion: 'v2', family: 'HIRING_SNAPSHOT', claimNature: 'STATE', eventStatus: 'UNKNOWN',
    occurredAt: null, occurredAtPrecision: 'UNKNOWN', sourcePublishedAt: '2026-08-19',
    rawDetail: { detail: '3 postes', icebreaker: 'ok' },
    extraction: { mode: 'manual-curated', promptVersion: 'clock-parity' },
    payload: { family: 'HIRING_SNAPSHOT', roleFunction: 'SALES', roleStatus: 'OPEN',
      openingsObserved: { value: 3, method: 'ENUMERATED_POSTINGS' } },
  })
  const assertionPersistee = () => [...g.__prospectorStore.entries()]
    .find(([k]: any) => k.startsWith(`${SOURCE_ASSERTION_KIND}|`))![1]

  it('A — ÉVÉNEMENT manuel : trois instants distincts, chacun relu à SA place, aucun jour d’état', async () => {
    const r = await run('manual', { manualCase: enveloppe(evenement()) })
    expect(r.verdict).toBe('PASS')
    const a = assertionPersistee()
    expect(a.provenance.retrievedAt).toBe(RETR)
    expect(a.observedAt).toBe(OBS)
    expect(a.acceptance.confirmedAt).toBe(CONF)
    expect(new Set([RETR, OBS, CONF]).size).toBe(3) // trois horloges, trois valeurs
    expect(a.sourceObservedDay).toBeUndefined()
  })

  it('B — ÉTAT manuel : sourceObservedDay dérive de retrievedAt SEUL, jamais des horloges d’adjudication', async () => {
    const r = await run('manual', { manualCase: enveloppe(etat()) })
    expect(r.verdict).toBe('PASS')
    const a = assertionPersistee()
    expect(a.sourceObservedDay).toBe('2026-08-20') // le jour de RÉCUPÉRATION…
    expect(a.sourceObservedDay).not.toBe(OBS.slice(0, 10)) // …jamais celui de l'adjudication
    expect(a.sourceObservedDay).not.toBe(CONF.slice(0, 10)) // …ni celui de la confirmation
    expect(a.observedAt).toBe(OBS)
    expect(a.acceptance.confirmedAt).toBe(CONF)
  })

  it('C/D/E — horloge manquante ou invalide ⇒ INVALID_INPUT, RIEN n’est persisté', async () => {
    for (const casse of [
      { observedAt: undefined },                       // C — observedAt absent
      { confirmedAt: undefined },                      // D — confirmedAt absent
      { retrievedAt: undefined },                      //     retrievedAt absent
      { observedAt: '2026-08-21' },                    // E — jour sans heure : pas un instant strict
      { confirmedAt: '2026-08-21T24:00:00Z' },         // E — instant normalisable, refusé strictement
      { retrievedAt: 'hier' },                         // E — prose
    ]) {
      if (g.__prospectorStore) g.__prospectorStore.clear()
      const env = enveloppe(evenement(), casse)
      for (const [k, v] of Object.entries(casse)) if (v === undefined) delete env[k]
      const r = await run('manual', { manualCase: env })
      expect(r.verdict, JSON.stringify(casse)).toBe('INVALID_INPUT')
      expect(g.__prospectorStore.size, JSON.stringify(casse)).toBe(0)
    }
  })

  it('F — les cas dorés gardent la constante synthétique, inchangée', async () => {
    const r = await run('funding')
    expect(r.verdict).toBe('PASS')
    const a = assertionPersistee()
    expect(a.observedAt).toBe('2026-09-30T12:00:00.000Z')
    expect(a.acceptance.confirmedAt).toBe('2026-09-30T12:00:00.000Z')
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
