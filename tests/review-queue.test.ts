// DOMAIN_REVIEW_PROJECTION_V0_001 — la file de revue est une PROJECTION PURE.
//
// ⚠️ Les fixtures passent par les VRAIES primitives append-only du domaine
// (recordDomainProofObservation / recordDomainAdjudication) sur le repli
// mémoire — jamais des objets fabriqués à la main, sauf pour PROUVER le
// fail-closed sur histoire corrompue.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etatSession = vi.hoisted(() => ({ session: null as any }))
vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etatSession.session,
}))

import {
  DOMAIN_ADJUDICATION_KIND, DOMAIN_PROOF_OBSERVATION_KIND,
  recordDomainAdjudication, recordDomainProofObservation,
} from '../lib/prospector/proactive/domainBinding'
import { domainReviewItemId, projectDomainReviews } from '../lib/prospector/proactive/reviewQueue'
import listeHandler from '../pages/api/review/index'
import detailHandler from '../pages/api/review/[id]'

const g: any = globalThis as any
const WS = 'ws_review_a'
const AUTRE_WS = 'ws_review_b'
const SIREN = '989284955'
const HOTE = 'gradium.ai'
const URL_PREUVE = `https://${HOTE}/mentions-legales`

// Page LONGUE : ±160 caractères autour du SIREN restent dans le corps légal —
// une variation de QUEUE change le hash brut SANS toucher l'ancre, une
// variation du VOISINAGE change l'ancre.
const PREFIXE = 'Preambule editorial sans matiere legale. '.repeat(8)
const SUFFIXE = 'Clause annexe repetee pour eloigner la fin de page. '.repeat(8)
const corpsLegal = (rcs: string) => `Mentions légales — GRADIUM SAS, SIREN 989 284 955, ${rcs}, 10 rue de Paris.`
const page = (rcs = 'R.C.S. Paris', queue = '') => `${PREFIXE}${corpsLegal(rcs)} ${SUFFIXE}${queue}`
const PAGE_SANS_SIREN = `${PREFIXE}Mentions légales — GRADIUM SAS, sans immatriculation citée. ${SUFFIXE}`

const t = (n: number) => () => new Date(Date.UTC(2026, 8, 1, 10, n))
async function dpo(body: string, quand: () => Date, extra: Record<string, unknown> = {}) {
  const r = await recordDomainProofObservation(
    { siren: SIREN, domainHost: HOTE, proofUrl: URL_PREUVE, finalUrl: URL_PREUVE, body, ...extra },
    (extra.ws as string) ?? WS, quand,
  )
  if (r.ok === false) throw new Error(r.reason)
  return r.observation
}
async function dad(observationId: string, verdict: 'ACCEPTED_FIRST_PARTY' | 'REJECTED', quand: () => Date, ws = WS) {
  const r = await recordDomainAdjudication({ observationId, verdict }, 'alice', ws, quand)
  if (r.ok === false) throw new Error(r.reason)
  return r.adjudication
}
async function items(ws = WS) {
  const p = await projectDomainReviews(ws)
  if (p.ok === false) throw new Error(p.reason)
  return p.items
}

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etatSession.session = { tenant: { id: WS, kind: 'user' }, actorId: 'reviewer' }
})

describe('cas A — aucune adjudication applicable', () => {
  it('1 — preuve avec SIREN cible ⇒ NEEDS_REVIEW / PROOF_AWAITING_ADJUDICATION, deux gestes permis', async () => {
    const o = await dpo(page(), t(0))
    const [i] = await items()
    expect(i.state).toBe('NEEDS_REVIEW')
    expect(i.reasonCode).toBe('PROOF_AWAITING_ADJUDICATION')
    expect(i.lifecycle).toBe('OPEN')
    expect(i.sourceRefs.domainProofObservationId).toBe(o.id)
    expect(i.allowedActions).toEqual(['ACCEPT_FIRST_PARTY', 'REJECT'])
    expect(i.detectedAt).toBe(o.proofObservedAt)
    expect(i.subject).toEqual({ siren: SIREN, sourceHost: HOTE })
  })

  it('2 — preuve SANS SIREN cible ⇒ REJECT SEUL — exclusion à l’EXÉCUTION, pas en commentaire', async () => {
    await dpo(PAGE_SANS_SIREN, t(0))
    const [i] = await items()
    expect(i.reasonCode).toBe('TARGET_SIREN_ABSENT_AWAITING_DECISION')
    expect(i.allowedActions).toEqual(['REJECT'])
  })
})

describe('cas C — dernière adjudication ACCEPTED : la matière décide, jamais le hash brut', () => {
  async function accepteeT0() {
    const o = await dpo(page(), t(0))
    await dad(o.id, 'ACCEPTED_FIRST_PARTY', t(1))
    return o
  }

  it('3/4 — revalidations fraîches sémantiquement IDENTIQUES (1 puis N) ⇒ AUCUN item', async () => {
    await accepteeT0()
    expect(await items()).toEqual([]) // latestDPO === adjugée
    await dpo(page(), t(2))
    expect(await items()).toEqual([])
    await dpo(page(), t(3))
    await dpo(page(), t(4))
    expect(await items()).toEqual([]) // N revalidations identiques
  })

  it('5/19 — dérive du HTML brut SEUL (hash ≠, ancre =) ⇒ AUCUN item', async () => {
    const adj = await accepteeT0()
    const fraiche = await dpo(page('R.C.S. Paris', '<div>footer dynamique</div>'), t(2))
    expect(fraiche.proofContentHash).not.toBe(adj.proofContentHash) // le mutant que la revue doit IGNORER
    expect(fraiche.proofAnchor).toBe(adj.proofAnchor)
    expect(await items()).toEqual([])
  })

  it('6 — ancre changée (SIREN pourtant présent) ⇒ PROOF_CHANGED / PROOF_ANCHOR_CHANGED avec les trois refs', async () => {
    const adjO = await accepteeT0()
    const fraiche = await dpo(page('R.C.S. Lyon'), t(2))
    const [i] = await items()
    expect(i.state).toBe('PROOF_CHANGED')
    expect(i.reasonCode).toBe('PROOF_ANCHOR_CHANGED')
    expect(i.sourceRefs.domainProofObservationId).toBe(fraiche.id)
    expect(i.sourceRefs.previousObservationId).toBe(adjO.id)
    expect(typeof i.sourceRefs.previousAdjudicationId).toBe('string')
    expect(i.allowedActions).toEqual(['ACCEPT_FIRST_PARTY', 'REJECT'])
  })

  it('7 — SIREN disparu ⇒ PROOF_CHANGED / TARGET_SIREN_ABSENT, ACCEPT exclu à l’exécution', async () => {
    await accepteeT0()
    await dpo(PAGE_SANS_SIREN, t(2))
    const [i] = await items()
    expect(i.state).toBe('PROOF_CHANGED')
    expect(i.reasonCode).toBe('TARGET_SIREN_ABSENT')
    expect(i.allowedActions).toEqual(['REJECT'])
  })

  it('8 — divergence PUIS restauration exacte ⇒ AUCUN item (seule la plus récente compte)', async () => {
    await accepteeT0()
    await dpo(page('R.C.S. Lyon'), t(2)) // divergente
    await dpo(page(), t(3))              // restauration octet pour octet de la matière
    expect(await items()).toEqual([])
  })
})

describe('cas B — dernière adjudication REJECTED', () => {
  it('9/10 — rejet autoritatif : rien par défaut, et rien sur preuve postérieure sémantiquement IDENTIQUE', async () => {
    const o = await dpo(page(), t(0))
    await dad(o.id, 'REJECTED', t(1))
    expect(await items()).toEqual([]) // 9
    await dpo(page(), t(2))           // même matière que la rejetée
    expect(await items()).toEqual([]) // 10
  })

  it('11 — matière NOUVELLE après rejet ⇒ NEEDS_REVIEW / NEW_PROOF_AFTER_REJECTION ciblant la récente', async () => {
    const o = await dpo(page(), t(0))
    const rejet = await dad(o.id, 'REJECTED', t(1))
    const nouvelle = await dpo(page('R.C.S. Lyon'), t(2))
    const [i] = await items()
    expect(i.reasonCode).toBe('NEW_PROOF_AFTER_REJECTION')
    expect(i.state).toBe('NEEDS_REVIEW')
    expect(i.sourceRefs.domainProofObservationId).toBe(nouvelle.id)
    expect(i.sourceRefs.previousObservationId).toBe(o.id)
    expect(i.sourceRefs.previousAdjudicationId).toBe(rejet.id)
  })
})

describe('déterminisme, tri, identités', () => {
  it('12 — ACCEPTED puis REJECTED plus tard : le TRI (adjudicatedAt desc) fait gagner le rejet', async () => {
    const o = await dpo(page(), t(0))
    await dad(o.id, 'ACCEPTED_FIRST_PARTY', t(1))
    await dad(o.id, 'REJECTED', t(2))
    expect(await items()).toEqual([]) // cas B, pas cas C
    // Et l'ordre des DPO (proofObservedAt desc) désigne bien la plus récente :
    await dpo(page('R.C.S. Lyon'), t(3))
    await dpo(page(), t(4)) // restauration — si le tri était inversé, l'item s'ouvrirait
    expect(await items()).toEqual([])
  })

  it('12-bis — REJECTED puis ACCEPTED plus tard : le tri fait gagner l’acceptation, une divergence est un PROOF_CHANGED (jamais NEW_PROOF_AFTER_REJECTION)', async () => {
    const o = await dpo(page(), t(0))
    await dad(o.id, 'REJECTED', t(1))
    await dad(o.id, 'ACCEPTED_FIRST_PARTY', t(2)) // plus récente — l'autorité en vigueur
    await dpo(page('R.C.S. Lyon'), t(3))
    const [i] = await items()
    expect(i.state).toBe('PROOF_CHANGED')
    expect(i.reasonCode).toBe('PROOF_ANCHOR_CHANGED') // un tri inversé rendrait NEW_PROOF_AFTER_REJECTION
  })

  it('13 — deux lectures ⇒ items identiques octet pour octet, id déterministe recalculable', async () => {
    const o = await dpo(page(), t(0))
    const [a] = await items()
    const [b] = await items()
    expect(a).toEqual(b)
    expect(a.id).toBe(domainReviewItemId(WS, o.id))
    expect(a.id).toMatch(/^rvw_[0-9a-f]{32}$/)
  })

  it('14/15 — isolation d’espace : les revues d’un espace n’apparaissent pas dans un autre', async () => {
    await dpo(page(), t(0))
    expect((await items(WS)).length).toBe(1)
    expect(await items(AUTRE_WS)).toEqual([])
    // Et l'identifiant d'item inclut l'espace : un id volé ne coïncide jamais.
    const [i] = await items(WS)
    expect(i.id).not.toBe(domainReviewItemId(AUTRE_WS, i.sourceRefs.domainProofObservationId))
  })

  it('16 — histoire corrompue ⇒ HISTORY_INVALID, JAMAIS un filtrage silencieux', async () => {
    await dpo(page(), t(0))
    g.__prospectorStore.set(`${DOMAIN_PROOF_OBSERVATION_KIND}|${WS}|dpo_corrompue`, {
      id: 'dpo_corrompue', workspaceId: WS, siren: SIREN, corrompue: true,
    })
    expect(await projectDomainReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' })
    // Adjudication orpheline (aucune observation) : incohérent ⇒ fermé aussi.
    g.__prospectorStore.clear()
    const o = await dpo(page(), t(0))
    const a = await dad(o.id, 'ACCEPTED_FIRST_PARTY', t(1))
    g.__prospectorStore.delete(`${DOMAIN_PROOF_OBSERVATION_KIND}|${WS}|${o.id}`)
    void a
    expect(await projectDomainReviews(WS)).toEqual({ ok: false, reason: 'HISTORY_INVALID' })
  })
})

describe('routes — lecture seule, session, 503 explicites', () => {
  function appeler(handler: any, query: Record<string, unknown> = {}, method = 'GET') {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req: any = { method, query, cookies: {}, headers: {} }
      const res: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this },
        json(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this },
      }
      Promise.resolve(handler(req, res)).catch(reject)
    })
  }

  it('GET /api/review : items OPEN, contrat versionné ; filtres clos ; POST refusé ; non authentifié ⇒ 403', async () => {
    await dpo(page(), t(0))
    const r = await appeler(listeHandler)
    expect(r.status).toBe(200)
    expect(r.body.contractVersion).toBe('review-read-v0')
    expect(r.body.items.length).toBe(1)
    expect(r.body.items[0].kind).toBe('DOMAIN_AUTHORITY_REVIEW')
    // Le modèle de lecture n'expose NI hash NI corps.
    expect(JSON.stringify(r.body)).not.toMatch(/recordHash|proofContentHash/)
    expect((await appeler(listeHandler, { kind: 'AUTRE' })).status).toBe(400)
    // ⚠️ NON SUPPORTÉ ≠ VIDE : la V0 ne projette pas l'historique résolu —
    // RESOLVED/SUPERSEDED sont REFUSÉS (400), jamais servis `{ items: [] }`.
    expect((await appeler(listeHandler, { lifecycle: 'OPEN' })).status).toBe(200)
    expect((await appeler(listeHandler, { lifecycle: 'RESOLVED' })).status).toBe(400)
    expect((await appeler(listeHandler, { lifecycle: 'SUPERSEDED' })).status).toBe(400)
    expect((await appeler(listeHandler, { lifecycle: 'FERME' })).status).toBe(400)
    expect((await appeler(listeHandler, {}, 'POST')).status).toBe(405)
    etatSession.session = null
    expect((await appeler(listeHandler)).status).toBe(403)
  })

  it('17 — magasin muet ⇒ 503 explicite, JAMAIS 200 { items: [] }', async () => {
    const { listItemsStrict } = await import('../lib/supabase/store')
    void listItemsStrict
    const espion = vi.spyOn(await import('../lib/supabase/store'), 'listItemsStrict' as never)
    ;(espion as any).mockResolvedValue({ ok: false })
    const r = await appeler(listeHandler)
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('STORE_UNAVAILABLE')
    espion.mockRestore()
  })

  it('GET /api/review/[id] : matière de décision sûre, id inconnu/malformé ⇒ 404, espace étranger ⇒ 404', async () => {
    const o = await dpo(page(), t(0))
    const id = domainReviewItemId(WS, o.id)
    const r = await appeler(detailHandler, { id })
    expect(r.status).toBe(200)
    expect(r.body.item.id).toBe(id)
    expect(r.body.decisionMaterial).toEqual({
      proofUrl: o.proofUrl, finalUrl: o.finalUrl, proofObservedAt: o.proofObservedAt,
      targetSirenFound: true, proofAnchor: o.proofAnchor,
    })
    expect(JSON.stringify(r.body)).not.toMatch(/recordHash|proofContentHash/)
    expect((await appeler(detailHandler, { id: 'rvw_' + '0'.repeat(32) })).status).toBe(404)
    expect((await appeler(detailHandler, { id: 'nimporte' })).status).toBe(404)
    // Un id calculé pour un AUTRE espace ne désigne rien dans cette session.
    expect((await appeler(detailHandler, { id: domainReviewItemId(AUTRE_WS, o.id) })).status).toBe(404)
  })
})

describe('18 — verrou structurel LECTURE ≠ REVALIDATION', () => {
  it('la projection et les routes de revue n’importent AUCUNE primitive de réseau/capture/résolution', () => {
    const { readFileSync } = require('node:fs')
    const fichiers = [
      'lib/prospector/proactive/reviewQueue.ts',
      'pages/api/review/index.ts',
      'pages/api/review/[id].ts',
    ]
    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8')
      for (const interdit of [
        'eligibleAdjudicatedDomain', 'captureLegalProof', 'legalProofFetch',
        'lookupByName', 'lookupBySiren', 'resolveEntityForCandidate', 'datagouv',
        'node:https', 'node:http', 'fetch(', 'anthropic',
        'insertItemIfAbsent', 'upsertItem', 'saveEvidence',
      ]) {
        expect(src.includes(interdit), `${f} contient « ${interdit} »`).toBe(false)
      }
    }
    // Et la condition sémantique du cas C est bien (SIREN ∧ ancre), sans hash brut.
    const projection = readFileSync('lib/prospector/proactive/reviewQueue.ts', 'utf8')
    expect(projection).toMatch(/targetSirenFound === true && derniereDpo\.proofAnchor === obsAdjugee\.proofAnchor/)
  })
})
