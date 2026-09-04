// ENTITY_RESOLUTION_OUTCOME_PERSISTENCE_002 — le registre append-only des
// issues de résolution d'entité, et son écriture BLOQUANTE dans la route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const etatSession = vi.hoisted(() => ({ session: null as any }))
const etatRegistre = vi.hoisted(() => ({ parNom: {} as Record<string, any>, muet: false }))
const etatErx = vi.hoisted(() => ({ echoue: false }))
const etatHorloge = vi.hoisted(() => ({ decalerAvantEro: false }))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etatSession.session,
}))
vi.mock('../lib/prospector/datagouv', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/datagouv')>()),
  lookupByName: async (name: string) => {
    if (etatRegistre.muet) throw new Error('registry unavailable')
    return etatRegistre.parNom[String(name).trim()] ?? { found: false, resolution: 'not_found' }
  },
  lookupBySiren: async () => ({ found: false, resolution: 'not_found' }),
}))
// L'ERO réel, avec une horloge DÉCALABLE avant l'écriture : prouve que l'ERX
// porte le retrievedAt DE L'ERO et jamais une horloge indépendante (M7).
vi.mock('../lib/prospector/proactive/entityResolution', async (orig) => {
  const reel = await orig<typeof import('../lib/prospector/proactive/entityResolution')>()
  return {
    ...reel,
    recordEntityResolutionObservation: async (...args: Parameters<typeof reel.recordEntityResolutionObservation>) => {
      if (etatHorloge.decalerAvantEro) vi.setSystemTime(Date.now() + 37)
      return reel.recordEntityResolutionObservation(...args)
    },
  }
})
// L'ERX réel, avec panne INJECTABLE : prouve que l'écriture est bloquante (M5).
vi.mock('../lib/prospector/proactive/entityResolutionOutcome', async (orig) => {
  const reel = await orig<typeof import('../lib/prospector/proactive/entityResolutionOutcome')>()
  return {
    ...reel,
    recordEntityResolutionOutcome: async (...args: Parameters<typeof reel.recordEntityResolutionOutcome>) => {
      if (etatErx.echoue) return { ok: false, reason: 'WRITE_FAILED' as const }
      return reel.recordEntityResolutionOutcome(...args)
    },
  }
})

import {
  ENTITY_RESOLUTION_ADJUDICATION_KIND, ENTITY_RESOLUTION_OBSERVATION_KIND,
  recordEntityResolutionObservation,
} from '../lib/prospector/proactive/entityResolution'
import {
  ENTITY_RESOLUTION_OUTCOME_KIND, entityOutcomeId, isEntityResolutionOutcome,
  listOutcomesForCandidateStrict, outcomeRecordHash, recordEntityResolutionOutcome,
} from '../lib/prospector/proactive/entityResolutionOutcome'
import { registerCandidates } from '../lib/prospector/proactive/signalCandidates'
import handler from '../pages/api/internal/entity-resolution-observation'
import type { SignalHit } from '../types/prospector'

const g: any = globalThis as any
const WS = 'ws_erx_a'
const AUTRE_WS = 'ws_erx_b'
const SIREN = '989284955'
const T0 = () => new Date('2026-09-05T10:00:00.000Z')
const INSTANT = '2026-09-05T10:00:00.000Z'
const FENETRE = [
  { siren: SIREN, name: 'GRADIUM', city: 'PARIS', naf: '62.01Z', active: true },
  { siren: '899270979', name: 'GRADIUM CONSEIL', city: 'LYON', naf: '70.22Z', active: true },
]

const hit = (company: string): SignalHit => ({
  company, signalType: 'levée', detail: '', icebreaker: '',
  sourceUrl: 'https://presse.exemple.fr/a', verified: false,
  claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-08',
  eventDatePrecision: 'DAY', sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
  extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
} as SignalHit)

async function candidat(company = 'Gradium', ws = WS) {
  const [cid] = await registerCandidates([hit(company)], ws, T0)
  return cid as string
}
async function eroPour(candidateId: string, ws = WS, quand = T0) {
  const r = await recordEntityResolutionObservation(
    { candidate: { id: candidateId, claim: { company: 'Gradium' } } as any,
      lookup: { candidates: FENETRE } as any },
    ws, quand,
  )
  if (r.ok === false) throw new Error(r.reason)
  return r.observation
}
function appeler(body: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req: any = { method: 'POST', body, cookies: {}, headers: {}, query: {} }
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this },
      json(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}
const lignesErx = (ws = WS) =>
  [...g.__prospectorStore.entries()]
    .filter(([k]: any) => k.startsWith(`${ENTITY_RESOLUTION_OUTCOME_KIND}|${ws}|`)).map(([, v]: any) => v)

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etatSession.session = { tenant: { id: WS, kind: 'user' }, actorId: 'reviewer' }
  etatRegistre.parNom = {}
  etatRegistre.muet = false
  etatErx.echoue = false
  etatHorloge.decalerAvantEro = false
})
afterEach(() => { vi.useRealTimers() })

describe('route — chaque passage registre abouti persiste EXACTEMENT une issue', () => {
  it('1 — AUTO_RESOLVED ⇒ ERX AUTO_EXACT portant le SIREN exact, aucun ERO', async () => {
    const cid = await candidat()
    etatRegistre.parNom['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, candidates: FENETRE }
    const r = await appeler({ candidateId: cid })
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('AUTO_RESOLVED')
    const erx = lignesErx()
    expect(erx.length).toBe(1)
    expect(erx[0].outcome).toBe('AUTO_EXACT')
    expect(erx[0].siren).toBe(SIREN)
    expect(erx[0].observationId).toBeUndefined()
    expect(erx[0].subjectCandidateId).toBe(cid)
    expect(isEntityResolutionOutcome(erx[0], WS)).toBe(true)
  })

  it('2/21 — ambigu ⇒ ERO + ERX AMBIGUOUS, MÊME instant que l’ERO (jamais une horloge indépendante)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'))
    etatHorloge.decalerAvantEro = true // l'ERO est daté APRÈS l'instant du passage route
    const cid = await candidat()
    etatRegistre.parNom['Gradium'] = { found: false, resolution: 'ambiguous', candidates: FENETRE }
    const r = await appeler({ candidateId: cid })
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('OBSERVATION_RECORDED')
    const erx = lignesErx()
    expect(erx.length).toBe(1)
    expect(erx[0].outcome).toBe('AMBIGUOUS')
    expect(erx[0].siren).toBeUndefined()
    expect(erx[0].observationId).toBe(r.body.observation.id)
    expect(erx[0].observedAt).toBe(r.body.observation.retrievedAt) // un passage = une horloge
  })

  it('3 — remédiation de conflit ⇒ ERO + ERX CONFLICT_REMEDIATION portant le SIREN auto en conflit', async () => {
    const cid = await candidat()
    const ero = await eroPour(cid)
    const { recordEntityResolutionAdjudication } = await import('../lib/prospector/proactive/entityResolution')
    const adj = await recordEntityResolutionAdjudication(
      { observationId: ero.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: '899270979' }, 'alice', WS, T0)
    if (adj.ok === false) throw new Error(adj.reason)
    // Le registre résout desormais 989284955 ≠ décision humaine 899270979.
    etatRegistre.parNom['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, candidates: FENETRE }
    const r = await appeler({ candidateId: cid })
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('IDENTITY_CONFLICT_OBSERVATION_RECORDED')
    const erx = lignesErx()
    expect(erx.length).toBe(1)
    expect(erx[0].outcome).toBe('CONFLICT_REMEDIATION')
    expect(erx[0].siren).toBe(SIREN)
    expect(erx[0].observationId).toBe(r.body.observation.id)
    expect(erx[0].observedAt).toBe(r.body.observation.retrievedAt)
  })

  it('4 — introuvable ⇒ ERX NOT_FOUND sans siren ni fenêtre ; raison sociale VIDE ⇒ aucun passage, aucun ERX', async () => {
    const cid = await candidat()
    const r = await appeler({ candidateId: cid }) // registre: not_found par défaut
    expect(r.status).toBe(409)
    expect(r.body.state).toBe('ENTITY_NOT_FOUND')
    const erx = lignesErx()
    expect(erx.length).toBe(1)
    expect(erx[0].outcome).toBe('NOT_FOUND')
    expect(erx[0].siren).toBeUndefined()
    expect(erx[0].observationId).toBeUndefined()
  })

  it('5/6/7 — panne registre, requête invalide, historique corrompu : AUCUN ERX', async () => {
    const cid = await candidat()
    etatRegistre.muet = true
    expect((await appeler({ candidateId: cid })).status).toBe(503)
    expect(lignesErx().length).toBe(0) // 5
    etatRegistre.muet = false
    expect((await appeler({ candidateId: 42 })).status).toBe(400)
    expect(lignesErx().length).toBe(0) // 6
    // Historique humain corrompu ⇒ 409 TAMPERED, rien d'écrit.
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|era_corrompue`, {
      id: 'era_corrompue', workspaceId: WS, observationId: 42, corrompu: true,
    })
    etatRegistre.parNom['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, candidates: FENETRE }
    const r = await appeler({ candidateId: cid })
    expect(r.status).toBe(409)
    expect(r.body.state).toBe('ENTITY_RESOLUTION_HISTORY_TAMPERED')
    expect(lignesErx().length).toBe(0) // 7
  })

  it('22/23 — échec d’écriture ERX ⇒ 503 EXPLICITE, jamais le succès logique ; l’ERO déjà écrit RESTE (aucun rollback)', async () => {
    const cid = await candidat()
    etatRegistre.parNom['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, candidates: FENETRE }
    etatErx.echoue = true
    const auto = await appeler({ candidateId: cid })
    expect(auto.status).toBe(503)
    expect(auto.body.state).toBe('ENTITY_RESOLUTION_OUTCOME_WRITE_FAILED') // 22 (AUTO)
    // Branche ambiguë : l'ERO réussit PUIS l'ERX échoue — 503, ERO conservé.
    const cid2 = await candidat('Gradium 2')
    etatRegistre.parNom['Gradium 2'] = { found: false, resolution: 'ambiguous', candidates: FENETRE }
    const ambigu = await appeler({ candidateId: cid2 })
    expect(ambigu.status).toBe(503)
    expect(ambigu.body.state).toBe('ENTITY_RESOLUTION_OUTCOME_WRITE_FAILED')
    const eros = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|`))
    expect(eros.length).toBe(1) // 23 — append-only intact, pas de rollback
    expect(lignesErx().length).toBe(0)
  })
})

describe('registre ERX — validation sémantique stricte, identité, idempotence', () => {
  it('9/12/13 — clés closes et cohérence outcome↔champs (AUTO exige siren ; NOT_FOUND refuse tout)', async () => {
    const cid = await candidat()
    expect((await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', observedAt: INSTANT }, WS)).ok).toBe(false) // 12
    expect((await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'NOT_FOUND', siren: SIREN, observedAt: INSTANT }, WS)).ok).toBe(false) // 13
    expect((await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'NOT_FOUND', observationId: 'ero_' + 'a'.repeat(32), observedAt: INSTANT }, WS)).ok).toBe(false) // 13
    expect((await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AMBIGUOUS', siren: SIREN, observationId: 'ero_' + 'a'.repeat(32), observedAt: INSTANT }, WS)).ok).toBe(false) // AMBIGUOUS refuse siren
    const ok = await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: SIREN, observedAt: INSTANT }, WS)
    expect(ok.ok).toBe(true)
    if (ok.ok === false) throw new Error('impossible')
    // Clé inconnue injectée ⇒ validateur ferme (clés closes).
    expect(isEntityResolutionOutcome({ ...ok.outcome, intrus: 1 }, WS)).toBe(false) // 9
  })

  it('10/11 — recordHash ou id substitués ⇒ rejet (identité et intégrité RECALCULÉES)', async () => {
    const cid = await candidat()
    const r = await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: SIREN, observedAt: INSTANT }, WS)
    if (r.ok === false) throw new Error(r.reason)
    const falsifie = { ...r.outcome, siren: '899270979' }
    falsifie.recordHash = outcomeRecordHash((({ id: _i, recordHash: _r, ...rest }) => rest)(falsifie) as any)
    expect(isEntityResolutionOutcome(falsifie, WS)).toBe(false) // 11 — l'id ne recolle plus
    expect(isEntityResolutionOutcome({ ...r.outcome, recordHash: '0'.repeat(64) }, WS)).toBe(false) // 10
  })

  it('14/15/16/17/18 — l’ERO lié doit exister, être VALIDE, du MÊME espace, du MÊME sujet, au MÊME instant', async () => {
    const cid = await candidat()
    const ero = await eroPour(cid)
    // 17 — orphelin.
    expect(await recordEntityResolutionOutcome(
      { subjectCandidateId: cid, outcome: 'AMBIGUOUS', observationId: 'ero_' + 'b'.repeat(32), observedAt: ero.retrievedAt }, WS))
      .toEqual({ ok: false, reason: 'OBSERVATION_INVALID' })
    // 16 — ERO d'un AUTRE espace : invisible depuis WS ⇒ refus.
    const cidB = await candidat('Gradium', AUTRE_WS)
    const eroB = await eroPour(cidB, AUTRE_WS)
    expect((await recordEntityResolutionOutcome(
      { subjectCandidateId: cid, outcome: 'AMBIGUOUS', observationId: eroB.id, observedAt: eroB.retrievedAt }, WS)).ok).toBe(false)
    // 18 — sujet différent.
    const cid2 = await candidat('Gradium 2')
    expect((await recordEntityResolutionOutcome(
      { subjectCandidateId: cid2, outcome: 'AMBIGUOUS', observationId: ero.id, observedAt: ero.retrievedAt }, WS)).ok).toBe(false)
    // Instant divergent ⇒ refus (un passage = une horloge).
    expect((await recordEntityResolutionOutcome(
      { subjectCandidateId: cid, outcome: 'AMBIGUOUS', observationId: ero.id, observedAt: '2026-09-05T10:00:00.001Z' }, WS)).ok).toBe(false)
    // 15 — remédiation : le SIREN en conflit DOIT figurer dans la fenêtre.
    expect((await recordEntityResolutionOutcome(
      { subjectCandidateId: cid, outcome: 'CONFLICT_REMEDIATION', siren: '111222333', observationId: ero.id, observedAt: ero.retrievedAt }, WS)).ok).toBe(false)
    expect((await recordEntityResolutionOutcome(
      { subjectCandidateId: cid, outcome: 'CONFLICT_REMEDIATION', siren: SIREN, observationId: ero.id, observedAt: ero.retrievedAt }, WS)).ok).toBe(true) // 14/15 nominal
  })

  it('19/20 — rejeu identique ⇒ created:false ; même instant mais SIREN différent ⇒ identités DIFFÉRENTES', async () => {
    const cid = await candidat()
    const a = await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: SIREN, observedAt: INSTANT }, WS)
    const rejeu = await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: SIREN, observedAt: INSTANT }, WS)
    if (a.ok === false || rejeu.ok === false) throw new Error('écriture échouée')
    expect(a.created).toBe(true)
    expect(rejeu.created).toBe(false) // 19
    const b = await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: '899270979', observedAt: INSTANT }, WS)
    if (b.ok === false) throw new Error(b.reason)
    expect(b.outcome.id).not.toBe(a.outcome.id) // 20 — le SIREN est dans l'identité
    expect(entityOutcomeId(WS, cid, 'AUTO_EXACT', SIREN, undefined, INSTANT))
      .not.toBe(entityOutcomeId(WS, cid, 'AUTO_EXACT', '899270979', undefined, INSTANT))
  })

  it('8/25/26 — isolation d’espace ; un ERO hérité SANS ERX n’est JAMAIS interprété ; magasin muet ⇒ échec explicite', async () => {
    const cid = await candidat()
    await recordEntityResolutionOutcome({ subjectCandidateId: cid, outcome: 'AUTO_EXACT', siren: SIREN, observedAt: INSTANT }, WS)
    const chezA = await listOutcomesForCandidateStrict(cid, WS)
    const chezB = await listOutcomesForCandidateStrict(cid, AUTRE_WS)
    if (chezA.ok === false || chezB.ok === false) throw new Error('lecture échouée')
    expect(chezA.values.length).toBe(1)
    expect(chezB.values.length).toBe(0) // 8
    // 25 — candidat hérité : ERO présent, aucun ERX ⇒ liste VIDE, aucune
    // classification dérivée. « Hors couverture » n'est PAS un état d'entité.
    const legacy = await candidat('Societe Heritee')
    await eroPour(legacy)
    const lu = await listOutcomesForCandidateStrict(legacy, WS)
    if (lu.ok === false) throw new Error(lu.reason)
    expect(lu.values).toEqual([])
    // 26 — magasin muet ⇒ STORE_UNAVAILABLE, jamais une liste vide crue.
    const espion = vi.spyOn(await import('../lib/supabase/store'), 'listItemsStrict' as never)
    ;(espion as any).mockResolvedValue({ ok: false })
    expect(await listOutcomesForCandidateStrict(cid, WS)).toEqual({ ok: false, reason: 'STORE_UNAVAILABLE' })
    espion.mockRestore()
    // Ligne ERX corrompue ⇒ HISTORY_INVALID fermé, jamais filtrée.
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_OUTCOME_KIND}|${WS}|erx_corrompu`, { id: 'erx_corrompu', workspaceId: WS })
    expect(await listOutcomesForCandidateStrict(cid, WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' })
  })
})

describe('24 — pare-feu structurel du résolveur', () => {
  it('resolveEntityForCandidate n’importe, ne lit et n’écrit JAMAIS le registre des issues', () => {
    const { readFileSync } = require('node:fs')
    const resolveur = readFileSync('lib/prospector/proactive/entityResolution.ts', 'utf8')
    for (const interdit of ['entityResolutionOutcome', 'ENTITY_RESOLUTION_OUTCOME', 'erx_', 'recordEntityResolutionOutcome']) {
      expect(resolveur.includes(interdit), `entityResolution.ts contient « ${interdit} »`).toBe(false)
    }
    // Et l'ERX ne remonte jamais vers le résolveur : dépendance à sens unique.
    const registre = readFileSync('lib/prospector/proactive/entityResolutionOutcome.ts', 'utf8')
    expect(registre.includes('resolveEntityForCandidate')).toBe(false)
    expect(registre.includes('lookupByName')).toBe(false)
    expect(registre.includes('lookupBySiren')).toBe(false)
  })
})
