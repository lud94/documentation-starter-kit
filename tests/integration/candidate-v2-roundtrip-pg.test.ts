import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// Tests d'INTÉGRATION — FACTUAL_MEMORY_TEST_HARNESS_RUNTIME_FIX_001.
//
// ── LE DÉFAUT QUE CE FICHIER REPRODUIT ET VERROUILLE ────────────────────────
// Le premier run Windows réel du harnais a échoué à la relecture du candidat :
// PostgreSQL `jsonb` NE PRÉSERVE PAS l'ordre des clés, et le bloc V2 relu
// revient réordonné. Le validateur (`isAcquisitionFactV2`, structurel) et
// l'identité (`candidateId`, bâtie sur la sérialisation canonique triée) y
// sont insensibles — c'est ce que ces cas PROUVENT contre la vraie base —
// mais toute comparaison `JSON.stringify` ne l'est pas : le harnais comparait
// ainsi, et concluait à tort que le fait avait changé.
//
// Rien n'est simulé : TypeScript → supabase-js → PostgREST → PostgreSQL.
// Prérequis : `npx supabase start` puis `npx supabase db reset --local`.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:55321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const WS = '_rtfix_ws_harness'
const KIND = 'proactive_signal_candidate'

let candidats: typeof import('../../lib/prospector/proactive/signalCandidates')
let harnais: typeof import('../../lib/prospector/proactive/harness/factualHarness')
let acquisition: typeof import('../../lib/prospector/proactive/acquisitionV2')
let raw: any

const FACT = {
  contractVersion: 'v2', family: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
  occurredAt: '2026-08-12', occurredAtPrecision: 'DAY', sourcePublishedAt: null,
  rawDetail: { detail: 'ACME TEST lève 12 M€ en série A', icebreaker: 'bravo' },
  extraction: { mode: 'claude-web', promptVersion: 'rtfix-integration' },
  payload: {
    family: 'FUNDING',
    amount: { amountMinor: 1_200_000_000, currency: 'EUR', asPublished: '€12M' },
    roundStage: 'SERIES_A',
    investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }],
  },
} as any

function hit(): any {
  return {
    company: 'ACME TEST', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: 'https://example.test/acme-series-a', verified: false, siren: '999000001',
    claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-08-12',
    eventDatePrecision: 'DAY', sourcePublishedAt: null,
    roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'rtfix-integration' },
    v2: FACT,
  }
}

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale (`npx supabase start`), '
      + 'appliquer les migrations (`npx supabase db reset --local`), puis exporter la clé de service.',
    )
  }
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
  process.env.APP_ENV = 'development'
  delete process.env.APP_ENV_STRICT

  raw = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  candidats = await import('../../lib/prospector/proactive/signalCandidates')
  harnais = await import('../../lib/prospector/proactive/harness/factualHarness')
  acquisition = await import('../../lib/prospector/proactive/acquisitionV2')
})

async function purge() {
  await raw.from('prospector_store').delete().eq('kind', KIND).eq('workspace_id', WS)
}
beforeEach(purge)
afterAll(purge)

describe('aller-retour jsonb du candidat V2 (R2)', () => {
  it('inscrit, relit et revalide un candidat V2 contre la VRAIE base', async () => {
    const [cid] = await candidats.registerCandidates([hit()], WS)
    expect(cid).toBeTruthy()

    // La ligne existe, DANS LE BON ESPACE, avec le bon identifiant.
    const { data, error } = await raw.from('prospector_store')
      .select('data, workspace_id').eq('kind', KIND).eq('id', cid).eq('workspace_id', WS).single()
    expect(error).toBeNull()
    expect(data.workspace_id).toBe(WS)

    // ⚠️ LA PREUVE DU DÉFAUT D'ORIGINE : jsonb a le DROIT de réordonner les
    // clés — l'égalité SÉMANTIQUE (canonique) doit tenir même quand
    // `JSON.stringify` diverge. On n'exige PAS que stringify diffère (c'est un
    // détail de stockage), on exige que la sémantique survive dans tous les cas.
    expect(harnais.sameSemanticFact(data.data.claim.v2, FACT)).toBe(true)

    // Relecture PRODUCTION : trois états, revalidation V2, identité recalculée.
    const lu = await candidats.readCandidate(cid, WS)
    if (lu.ok === false) throw new Error(`readCandidate: ${lu.state}`)
    expect(acquisition.isAcquisitionFactV2(lu.candidate.claim.v2)).toBe(true)
    expect(harnais.sameSemanticFact(lu.candidate.claim.v2, FACT)).toBe(true)
    expect(candidats.candidateId(lu.candidate.claim, WS)).toBe(cid)
  })

  it('R4 — une identité substituée sous l’identifiant est toujours rejetée (jsonb réel)', async () => {
    const [cid] = await candidats.registerCandidates([hit()], WS)
    const { data } = await raw.from('prospector_store')
      .select('data').eq('kind', KIND).eq('id', cid).eq('workspace_id', WS).single()
    const falsifie = JSON.parse(JSON.stringify(data.data))
    falsifie.claim.v2.payload.amount.amountMinor = 999
    await raw.from('prospector_store').update({ data: falsifie })
      .eq('kind', KIND).eq('id', cid).eq('workspace_id', WS)

    const lu = await candidats.readCandidate(cid, WS)
    expect(lu).toEqual({ ok: false, state: 'CANDIDATE_UNKNOWN' })
  })

  it('R3 — un bloc V2 persisté malformé est rejeté à la relecture (jsonb réel)', async () => {
    const [cid] = await candidats.registerCandidates([hit()], WS)
    const { data } = await raw.from('prospector_store')
      .select('data').eq('kind', KIND).eq('id', cid).eq('workspace_id', WS).single()
    const ampute = JSON.parse(JSON.stringify(data.data))
    delete ampute.claim.v2.payload.roundStage
    await raw.from('prospector_store').update({ data: ampute })
      .eq('kind', KIND).eq('id', cid).eq('workspace_id', WS)

    const lu = await candidats.readCandidate(cid, WS)
    expect(lu).toEqual({ ok: false, state: 'CANDIDATE_UNKNOWN' })
  })

  it('R11 — un candidat V1 (sans v2) fait le même aller-retour, inchangé', async () => {
    const v1 = hit()
    delete v1.v2
    const [cid] = await candidats.registerCandidates([v1], WS)
    expect(cid).toBeTruthy()
    const lu = await candidats.readCandidate(cid, WS)
    if (lu.ok === false) throw new Error(`readCandidate: ${lu.state}`)
    expect(lu.candidate.claim.v2).toBeNull()
    expect(candidats.candidateId(lu.candidate.claim, WS)).toBe(cid)
  })
})
