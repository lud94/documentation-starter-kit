// ENTITY_REVIEW_PROJECTION_V0_001 — la revue d'identité d'entité est une
// PROJECTION PURE sur ERX + ERO + ERA. Jamais de réseau, jamais d'écriture.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etatSession = vi.hoisted(() => ({ session: null as any }))
vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etatSession.session,
}))

import { createHash } from 'node:crypto'

import {
  ENTITY_RESOLUTION_ADJUDICATION_KIND, ENTITY_RESOLUTION_OBSERVATION_KIND,
  entityAdjudicationId, recordEntityResolutionAdjudication, recordEntityResolutionObservation,
} from '../lib/prospector/proactive/entityResolution'
import {
  ENTITY_RESOLUTION_OUTCOME_KIND, entityOutcomeId, outcomeRecordHash, recordEntityResolutionOutcome,
} from '../lib/prospector/proactive/entityResolutionOutcome'
import {
  entityBlockedItemId, entityReviewItemId, projectEntityReviews,
} from '../lib/prospector/proactive/reviewQueue'
import { canonicalJson } from '../lib/prospector/proactive/acquisitionV2'
import listeHandler from '../pages/api/review/index'
import detailHandler from '../pages/api/review/[id]'

const g: any = globalThis as any
const WS = 'ws_erev_a'
const AUTRE_WS = 'ws_erev_b'
const S = '989284955' // Gradium — souvent la cible
const B = '899270979' // l'« autre » entité de la fenêtre
const FENETRE = [
  { siren: S, name: 'GRADIUM', city: 'PARIS', naf: '62.01Z', active: true },
  { siren: B, name: 'GRADIUM CONSEIL', city: 'LYON', naf: '70.22Z', active: true },
]
const FENETRE_SANS_S = [
  { siren: B, name: 'GRADIUM CONSEIL', city: 'LYON', naf: '70.22Z', active: true },
]
const C1 = 'cand_' + '1'.repeat(32)
const C2 = 'cand_' + '2'.repeat(32)
const CX = 'cand_' + 'e'.repeat(32)
const CL = 'cand_' + 'd'.repeat(32)
const t = (n: number) => () => new Date(Date.UTC(2026, 8, 5, 12, n))
const instant = (n: number) => new Date(Date.UTC(2026, 8, 5, 12, n)).toISOString()
const sha = (x: string) => createHash('sha256').update(x, 'utf8').digest('hex')

async function ero(candidateId: string, quand = t(0), fenetre = FENETRE, ws = WS) {
  const r = await recordEntityResolutionObservation(
    { candidate: { id: candidateId, claim: { company: 'Gradium' } } as any, lookup: { candidates: fenetre } as any },
    ws, quand,
  )
  if (r.ok === false) throw new Error(r.reason)
  return r.observation
}
async function era(observationId: string, verdict: 'ACCEPTED_CANDIDATE' | 'NONE_OF_OBSERVED_CANDIDATES', selectedSiren: string | undefined, quand = t(1), ws = WS) {
  const r = await recordEntityResolutionAdjudication({ observationId, verdict, ...(selectedSiren ? { selectedSiren } : {}) }, 'alice', ws, quand)
  if (r.ok === false) throw new Error(r.reason)
  return r.adjudication
}
async function erx(input: any, ws = WS) {
  const r = await recordEntityResolutionOutcome(input, ws)
  if (r.ok === false) throw new Error(r.reason)
  return r.outcome
}
async function items(ws = WS) {
  const p = await projectEntityReviews(ws)
  if (p.ok === false) throw new Error(p.reason)
  return p.items
}

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etatSession.session = { tenant: { id: WS, kind: 'user' }, actorId: 'reviewer' }
})

describe('dernière issue = AMBIGUOUS', () => {
  it('1 — fenêtre sans adjudication ⇒ OPEN NEEDS_REVIEW / AMBIGUOUS_REGISTRY_MATCH, gestes ACCEPT+REJECT_ALL', async () => {
    const o = await ero(C1)
    const x = await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    const [i] = await items()
    expect(i.kind).toBe('ENTITY_IDENTITY_REVIEW')
    expect(i.state).toBe('NEEDS_REVIEW')
    expect(i.reasonCode).toBe('AMBIGUOUS_REGISTRY_MATCH')
    expect(i.lifecycle).toBe('OPEN')
    expect(i.subject).toEqual({ candidateId: C1 })
    expect((i as any).sourceRefs).toEqual({ entityResolutionOutcomeId: x.id, entityResolutionObservationId: o.id })
    expect((i as any).requiredDecision).toBe('ADJUDICATE_ENTITY')
    expect((i as any).allowedActions).toEqual(['ACCEPT_CANDIDATE', 'REJECT_ALL'])
    expect(i.detectedAt).toBe(x.observedAt)
  })

  it('2/3 — fenêtre adjugée (ACCEPTED ou NONE) ⇒ aucun item : l’humain a couvert CETTE fenêtre', async () => {
    const o = await ero(C1)
    await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    await era(o.id, 'ACCEPTED_CANDIDATE', S, t(1))
    expect(await items()).toEqual([]) // 2
    const o2 = await ero(C2, t(2))
    await erx({ subjectCandidateId: C2, outcome: 'AMBIGUOUS', observationId: o2.id, observedAt: o2.retrievedAt })
    await era(o2.id, 'NONE_OF_OBSERVED_CANDIDATES', undefined, t(3))
    expect(await items()).toEqual([]) // 3
  })
})

describe('dernière issue = CONFLICT_REMEDIATION(B sur fenêtre O)', () => {
  async function remediation(cand = C1) {
    const o = await ero(cand, t(0))
    const x = await erx({ subjectCandidateId: cand, outcome: 'CONFLICT_REMEDIATION', siren: S, observationId: o.id, observedAt: o.retrievedAt })
    return { o, x }
  }

  it('4 — sans adjudication sur O ⇒ OPEN CONFLICT / IDENTITY_CONFLICT_REMEDIATION', async () => {
    const { o, x } = await remediation()
    const [i] = await items()
    expect(i.state).toBe('CONFLICT')
    expect(i.reasonCode).toBe('IDENTITY_CONFLICT_REMEDIATION')
    expect((i as any).sourceRefs.entityResolutionOutcomeId).toBe(x.id)
    expect((i as any).sourceRefs.entityResolutionObservationId).toBe(o.id)
    expect((i as any).allowedActions).toEqual(['ACCEPT_CANDIDATE', 'REJECT_ALL'])
  })

  it('5 — ACCEPTED du SIREN en conflit sur O ⇒ conflit fermé, aucun item', async () => {
    const { o } = await remediation()
    await era(o.id, 'ACCEPTED_CANDIDATE', S, t(1))
    expect(await items()).toEqual([])
  })

  it('6 — ACCEPTED d’un AUTRE SIREN sur O ⇒ le conflit RESTE ouvert', async () => {
    const { o } = await remediation()
    await era(o.id, 'ACCEPTED_CANDIDATE', B, t(1))
    const [i] = await items()
    expect(i.state).toBe('CONFLICT')
    expect(i.reasonCode).toBe('IDENTITY_CONFLICT_REMEDIATION')
  })

  it('7 — NONE sur O ⇒ le conflit RESTE ouvert (l’entité a été vue et rejetée, rien n’est tranché)', async () => {
    const { o } = await remediation()
    await era(o.id, 'NONE_OF_OBSERVED_CANDIDATES', undefined, t(1))
    const [i] = await items()
    expect(i.state).toBe('CONFLICT')
    expect(i.reasonCode).toBe('IDENTITY_CONFLICT_REMEDIATION')
  })
})

describe('dernière issue = AUTO_EXACT(S)', () => {
  it('8/9 — humain ABSENT, ou ACCEPTED(S) ⇒ courant, aucun item', async () => {
    await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    expect(await items()).toEqual([]) // 8
    const o = await ero(C2, t(0))
    await era(o.id, 'ACCEPTED_CANDIDATE', S, t(1))
    await erx({ subjectCandidateId: C2, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    expect(await items()).toEqual([]) // 9
  })

  it('10 — ACCEPTED(A≠S) ⇒ OPEN CONFLICT / RÉ-OBSERVATION seule (aucune fenêtre fraîche inventée)', async () => {
    const o = await ero(C1, t(0))
    const a = await era(o.id, 'ACCEPTED_CANDIDATE', B, t(1))
    const x = await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    const [i] = await items()
    expect(i.state).toBe('CONFLICT')
    expect(i.reasonCode).toBe('AUTO_EXACT_CONFLICTS_WITH_HUMAN_DECISION')
    expect((i as any).requiredDecision).toBe('REOBSERVE_ENTITY')
    expect((i as any).allowedActions).toEqual(['REOBSERVE_ENTITY'])
    expect((i as any).sourceRefs).toEqual({ entityResolutionOutcomeId: x.id, previousEntityResolutionAdjudicationId: a.id })
  })

  it('11/12 — NONE : fenêtre contenant S ⇒ CONFLIT ; fenêtre SANS S ⇒ courant (bornage à la fenêtre vue)', async () => {
    const o = await ero(C1, t(0)) // fenêtre AVEC S
    await era(o.id, 'NONE_OF_OBSERVED_CANDIDATES', undefined, t(1))
    await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    const [i] = await items()
    expect(i.state).toBe('CONFLICT')
    expect((i as any).requiredDecision).toBe('REOBSERVE_ENTITY') // 11
    g.__prospectorStore.clear()
    const o2 = await ero(C2, t(0), FENETRE_SANS_S)
    await era(o2.id, 'NONE_OF_OBSERVED_CANDIDATES', undefined, t(1))
    await erx({ subjectCandidateId: C2, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    expect(await items()).toEqual([]) // 12
  })
})

describe('NOT_FOUND, dernier-gagne, héritage', () => {
  it('13 — NOT_FOUND ⇒ aucun item (issue datée, pas de décision bornée à demander)', async () => {
    await erx({ subjectCandidateId: C1, outcome: 'NOT_FOUND', observedAt: instant(5) })
    expect(await items()).toEqual([])
  })

  it('14 — SEULE la dernière issue compte : un vieux conflit suivi d’un AUTO_EXACT courant ⇒ aucun item', async () => {
    const o = await ero(C1, t(0))
    await erx({ subjectCandidateId: C1, outcome: 'CONFLICT_REMEDIATION', siren: S, observationId: o.id, observedAt: o.retrievedAt })
    await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(9) })
    expect(await items()).toEqual([]) // humain ABSENT + auto S courant ; l'ancien conflit n'émet RIEN
  })

  it('15/25-héritage — ERO/ERA SANS ERX ⇒ hors couverture, AUCUN item, AUCUNE inférence', async () => {
    const o = await ero(CL, t(0))
    await era(o.id, 'NONE_OF_OBSERVED_CANDIDATES', undefined, t(1))
    expect(await items()).toEqual([])
    // Et un ERO hérité SANS AUCUNE adjudication non plus : hors couverture ≠
    // ambigu — le reclasser fabriquerait une revue sur une histoire muette.
    await ero(CX, t(2))
    expect(await items()).toEqual([])
  })
})

describe('HISTORY_INVALID — histoire illisible ⇒ TOUTE la projection échoue fermée', () => {
  // Forge un ERX de FORME valide (id + recordHash recalculés) violant un
  // invariant croisé — seule la projection peut le voir.
  function forgerErx(champs: { subjectCandidateId: string; outcome: string; siren?: string; observationId?: string; observedAt: string }, ws = WS) {
    const sans = {
      workspaceId: ws, contractVersion: 'entity-resolution-outcome-v0',
      subjectCandidateId: champs.subjectCandidateId, outcome: champs.outcome,
      ...(champs.siren !== undefined ? { siren: champs.siren } : {}),
      ...(champs.observationId !== undefined ? { observationId: champs.observationId } : {}),
      observedAt: champs.observedAt, source: 'entity-resolution-observation-route',
    }
    const id = entityOutcomeId(ws, champs.subjectCandidateId, champs.outcome, champs.siren, champs.observationId, champs.observedAt)
    const rec = { id, ...sans, recordHash: outcomeRecordHash(sans as any) }
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_OUTCOME_KIND}|${ws}|${id}`, rec)
    return rec
  }

  it('16/17/18/19 — ERX orphelin, sujet divergent, instant divergent, remédiation hors fenêtre', async () => {
    const o = await ero(C1, t(0))
    forgerErx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: 'ero_' + 'f'.repeat(32), observedAt: o.retrievedAt })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 16
    g.__prospectorStore.clear()
    const o2 = await ero(C1, t(0))
    forgerErx({ subjectCandidateId: CX, outcome: 'AMBIGUOUS', observationId: o2.id, observedAt: o2.retrievedAt })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 17
    g.__prospectorStore.clear()
    const o3 = await ero(C1, t(0))
    forgerErx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o3.id, observedAt: instant(9) })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 18
    g.__prospectorStore.clear()
    const o4 = await ero(C1, t(0), FENETRE_SANS_S)
    forgerErx({ subjectCandidateId: C1, outcome: 'CONFLICT_REMEDIATION', siren: S, observationId: o4.id, observedAt: o4.retrievedAt })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 19
  })

  it('20/21/22/23 — ligne malformée (ERX, ERO, ERA) ou ERA orpheline ⇒ HISTORY_INVALID, jamais filtrée', async () => {
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_OUTCOME_KIND}|${WS}|erx_malforme`, { id: 'erx_malforme', workspaceId: WS })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 20
    g.__prospectorStore.clear()
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|ero_malforme`, { id: 'ero_malforme', workspaceId: WS })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 21
    g.__prospectorStore.clear()
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|era_malforme`, { id: 'era_malforme', workspaceId: WS })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 22
    g.__prospectorStore.clear()
    const o = await ero(C1, t(0))
    const a = await era(o.id, 'ACCEPTED_CANDIDATE', S, t(1))
    g.__prospectorStore.delete(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|${o.id}`)
    void a
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' }) // 23
  })
})

describe('ENTITY_HISTORY_BLOCKED — corruption sémantique visible, jamais un repli', () => {
  it('24 — ERA de FORME valide dont selectedSiren est HORS de sa fenêtre ⇒ item BLOQUÉ, aucune autre dérivation', async () => {
    const o = await ero(C1, t(0), FENETRE_SANS_S)
    await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    // Forge : structurellement valide (id + recordHash recalculés), mais la
    // sélection désigne S — absent de la fenêtre référencée.
    const sans = {
      workspaceId: WS, contractVersion: 'entity-resolution-adjudication-v0',
      observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: S,
      adjudicatedBy: 'alice', adjudicatedAt: instant(1),
    }
    const idForge = entityAdjudicationId(WS, o.id, 'ACCEPTED_CANDIDATE', S, 'alice', instant(1))
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${idForge}`, {
      id: idForge, ...sans, recordHash: sha(canonicalJson({ ...sans })),
    })
    const [i] = await items()
    expect(i.kind).toBe('ENTITY_HISTORY_BLOCKED')
    expect(i.state).toBe('BLOCKED')
    expect(i.reasonCode).toBe('HISTORY_TAMPERED')
    expect((i as any).allowedActions).toEqual([])
    expect((i as any).decisionAuthority).toBe('MACHINE_BLOCKED')
    expect(i.id).toBe(entityBlockedItemId(WS, idForge))
    expect((await items()).length).toBe(1) // pas d'item AMBIGUOUS en plus
  })

  it('24-bis — une ERA invalide ANCIENNE n’est JAMAIS effacée par une décision valide plus récente (parité avec effectiveHumanDecision)', async () => {
    // T0 : fenêtre SANS S ; T1 : ERA forgée ACCEPTED(S) — S hors fenêtre.
    const eroBad = await ero(C1, t(0), FENETRE_SANS_S)
    const sans = {
      workspaceId: WS, contractVersion: 'entity-resolution-adjudication-v0',
      observationId: eroBad.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: S,
      adjudicatedBy: 'alice', adjudicatedAt: instant(1),
    }
    const idBad = entityAdjudicationId(WS, eroBad.id, 'ACCEPTED_CANDIDATE', S, 'alice', instant(1))
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${idBad}`, {
      id: idBad, ...sans, recordHash: sha(canonicalJson({ ...sans })),
    })
    // T2/T3 : fenêtre POSTÉRIEURE contenant S + ERA VALIDE ACCEPTED(S).
    const eroGood = await ero(C1, t(2), FENETRE)
    await era(eroGood.id, 'ACCEPTED_CANDIDATE', S, t(3))
    // T4 : issue AUTO_EXACT(S) — en accord avec la décision valide récente.
    await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })

    // La production échoue fermée sur cette histoire — la revue DOIT l'exposer.
    const { effectiveHumanDecision } = await import('../lib/prospector/proactive/entityResolution')
    expect((await effectiveHumanDecision(C1, WS)).kind).toBe('HISTORY_TAMPERED')
    const liste = await items()
    expect(liste.length).toBe(1)
    expect(liste[0].kind).toBe('ENTITY_HISTORY_BLOCKED')
    expect(liste[0].id).toBe(entityBlockedItemId(WS, idBad)) // discriminant = l'ERA INVALIDE
  })
})

describe('déterminisme, isolation, magasin', () => {
  it('26/27 — isolation d’espace + id déterministe recalculable', async () => {
    const o = await ero(C1, t(0))
    const x = await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    const [a] = await items(WS)
    const [b] = await items(WS)
    expect(a).toEqual(b)
    expect(a.id).toBe(entityReviewItemId(WS, x.id))
    expect(await items(AUTRE_WS)).toEqual([])
    expect(a.id).not.toBe(entityReviewItemId(AUTRE_WS, x.id))
  })

  it('25 — magasin muet ⇒ STORE_UNAVAILABLE (l’API rendra 503), jamais []', async () => {
    const espion = vi.spyOn(await import('../lib/supabase/store'), 'listItemsStrict' as never)
    ;(espion as any).mockResolvedValue({ ok: false })
    expect(await projectEntityReviews(WS)).toEqual({ ok: false, reason: 'STORE_UNAVAILABLE' })
    espion.mockRestore()
  })
})

describe('routes — union des familles, filtres clos, matière de décision sûre', () => {
  function appeler(handler: any, query: Record<string, unknown> = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req: any = { method: 'GET', query, cookies: {}, headers: {} }
      const res: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this },
        json(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this },
      }
      Promise.resolve(handler(req, res)).catch(reject)
    })
  }
  async function fixtureMixte() {
    // Un item entité...
    const o = await ero(C1, t(0))
    const x = await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    // ...et un item domaine (preuve sans adjudication).
    const { recordDomainProofObservation } = await import('../lib/prospector/proactive/domainBinding')
    const dpo = await recordDomainProofObservation({
      siren: S, domainHost: 'gradium.ai',
      proofUrl: 'https://gradium.ai/mentions-legales', finalUrl: 'https://gradium.ai/mentions-legales',
      body: 'Mentions légales — GRADIUM SAS, SIREN 989 284 955.',
    }, WS, t(0))
    if (dpo.ok === false) throw new Error(dpo.reason)
    return { o, x }
  }

  it('28/29/30 — la liste fusionne Domaine + Entité sans casser le Domaine ; filtres kind clos ; lifecycle ≠ OPEN ⇒ 400', async () => {
    await fixtureMixte()
    const tout = await appeler(listeHandler)
    expect(tout.status).toBe(200)
    expect(tout.body.items.map((i: any) => i.kind).sort()).toEqual(['DOMAIN_AUTHORITY_REVIEW', 'ENTITY_IDENTITY_REVIEW'])
    const dom = await appeler(listeHandler, { kind: 'DOMAIN_AUTHORITY_REVIEW' })
    expect(dom.body.items.length).toBe(1)
    expect(dom.body.items[0].reasonCode).toBe('PROOF_AWAITING_ADJUDICATION') // sémantique Domain intacte
    const ent = await appeler(listeHandler, { kind: 'ENTITY_IDENTITY_REVIEW' })
    expect(ent.body.items.length).toBe(1)
    const bloques = await appeler(listeHandler, { kind: 'ENTITY_HISTORY_BLOCKED' })
    expect(bloques.status).toBe(200)
    expect(bloques.body.items).toEqual([])
    expect((await appeler(listeHandler, { kind: 'AUTRE' })).status).toBe(400) // 29
    expect((await appeler(listeHandler, { lifecycle: 'RESOLVED' })).status).toBe(400) // 30
    expect((await appeler(listeHandler, { lifecycle: 'OPEN' })).status).toBe(200)
  })

  it('31/32 — détail Domaine inchangé ; détail Entité avec fenêtre : champs SÛRS uniquement', async () => {
    const { o, x } = await fixtureMixte()
    const { domainReviewItemId, projectDomainReviews } = await import('../lib/prospector/proactive/reviewQueue')
    const dom = await projectDomainReviews(WS)
    if (dom.ok === false) throw new Error(dom.reason)
    const detDom = await appeler(detailHandler, { id: dom.items[0].id })
    expect(detDom.status).toBe(200)
    expect(Object.keys(detDom.body.decisionMaterial).sort())
      .toEqual(['finalUrl', 'proofAnchor', 'proofObservedAt', 'proofUrl', 'targetSirenFound']) // 31
    void domainReviewItemId
    const detEnt = await appeler(detailHandler, { id: entityReviewItemId(WS, x.id) })
    expect(detEnt.status).toBe(200)
    expect(detEnt.body.decisionMaterial.outcome).toBe('AMBIGUOUS')
    expect(detEnt.body.decisionMaterial.observationId).toBe(o.id)
    expect(detEnt.body.decisionMaterial.candidates).toEqual(FENETRE)
    expect(JSON.stringify(detEnt.body)).not.toMatch(/recordHash|candidatesHash|proofContentHash/) // 32
  })

  it('33 — détail d’un conflit AUTO_EXACT : issue + SIREN + instant, AUCUNE fenêtre fabriquée', async () => {
    const o = await ero(C1, t(0))
    await era(o.id, 'ACCEPTED_CANDIDATE', B, t(1))
    const x = await erx({ subjectCandidateId: C1, outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5) })
    const det = await appeler(detailHandler, { id: entityReviewItemId(WS, x.id) })
    expect(det.status).toBe(200)
    expect(det.body.decisionMaterial).toEqual({
      outcome: 'AUTO_EXACT', siren: S, observedAt: instant(5), requiredDecision: 'REOBSERVE_ENTITY',
    })
    expect('candidates' in det.body.decisionMaterial).toBe(false)
  })

  it('34 — détail d’un historique bloqué : { reason: HISTORY_TAMPERED }, rien de brut', async () => {
    const o = await ero(C1, t(0), FENETRE_SANS_S)
    await erx({ subjectCandidateId: C1, outcome: 'AMBIGUOUS', observationId: o.id, observedAt: o.retrievedAt })
    const sans = {
      workspaceId: WS, contractVersion: 'entity-resolution-adjudication-v0',
      observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: S,
      adjudicatedBy: 'alice', adjudicatedAt: instant(1),
    }
    const idForge = entityAdjudicationId(WS, o.id, 'ACCEPTED_CANDIDATE', S, 'alice', instant(1))
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${idForge}`, {
      id: idForge, ...sans, recordHash: sha(canonicalJson({ ...sans })),
    })
    const det = await appeler(detailHandler, { id: entityBlockedItemId(WS, idForge) })
    expect(det.status).toBe(200)
    expect(det.body.decisionMaterial).toEqual({ reason: 'HISTORY_TAMPERED' })
    expect(JSON.stringify(det.body)).not.toMatch(/selectedSiren|adjudicatedBy|recordHash/)
  })
})

describe('35/36 — pare-feu LECTURE ≠ REVALIDATION + zéro écriture', () => {
  it('les fichiers de revue n’importent AUCUN réseau/résolveur/écriture', () => {
    const { readFileSync } = require('node:fs')
    const fichiers = [
      'lib/prospector/proactive/reviewQueue.ts',
      'pages/api/review/index.ts',
      'pages/api/review/[id].ts',
    ]
    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8')
      for (const interdit of [
        'datagouv', 'lookupByName', 'lookupBySiren', 'resolveEntityForCandidate',
        'entity-resolution-observation\'', 'recordEntityResolutionOutcome',
        'recordEntityResolutionObservation', 'recordEntityResolutionAdjudication',
        'captureLegalProof', 'eligibleAdjudicatedDomain', 'legalProofFetch',
        'node:https', 'node:http', 'fetch(', 'anthropic',
        'insertItemIfAbsent', 'upsertItem', 'saveEvidence',
      ]) {
        expect(src.includes(interdit), `${f} contient « ${interdit} »`).toBe(false)
      }
    }
  })
})
