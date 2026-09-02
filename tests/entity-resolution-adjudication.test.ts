// ENTITY_RESOLUTION_ADJUDICATION_001 — adjudication d'entité CADRÉE CANDIDAT.
//
// ⚠️ HORS LIGNE : magasin réel (repli mémoire), registre INJECTÉ/mocké,
// horloges injectées. Aucun appel Data.gouv réel.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  session: null as any,
  parNom: {} as Record<string, any>,
  parSiren: {} as Record<string, any>,
  registreMuet: false,
}))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etat.session,
}))
vi.mock('../lib/prospector/datagouv', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/datagouv')>()),
  lookupByName: async (name: string) => {
    if (etat.registreMuet) throw new Error('registry unavailable')
    return etat.parNom[String(name).trim()] ?? { found: false, resolution: 'not_found' }
  },
  lookupBySiren: async (siren: string) => {
    if (etat.registreMuet) throw new Error('registry unavailable')
    return etat.parSiren[String(siren)] ?? { found: false, resolution: 'not_found' }
  },
}))

import {
  effectiveHumanDecision, entityAdjudicationId, entityCandidatesHash,
  ENTITY_RESOLUTION_ADJUDICATION_KIND, ENTITY_RESOLUTION_OBSERVATION_KIND,
  isEntityResolutionObservation, readEntityResolutionObservation,
  recordEntityResolutionAdjudication, recordEntityResolutionObservation,
  resolveEntityForCandidate,
} from '../lib/prospector/proactive/entityResolution'
import { registerCandidates, readCandidate } from '../lib/prospector/proactive/signalCandidates'
import { sourceEvidenceFromHit } from '../lib/prospector/proactive/signalBridge'
import obsHandler from '../pages/api/internal/entity-resolution-observation'
import adjHandler from '../pages/api/internal/entity-resolution-adjudication'
import type { SignalHit } from '../types/prospector'

const g: any = globalThis as any
const WS = 'ws_entity_a'
const AUTRE_WS = 'ws_entity_b'
const T0 = () => new Date('2026-09-02T10:00:00.000Z')
const t = (h: string) => () => new Date(`2026-09-02T${h}:00.000Z`)

const SIREN_A = '899270979'
const SIREN_B = '111222333'
const FENETRE = [
  { siren: SIREN_A, name: 'DEFACTO', city: 'PARIS', naf: '62.01Z', effectif: '20-49', dirigeant: 'Jane Dupont', active: true },
  { siren: SIREN_B, name: 'DEFACTO CONSEIL', city: 'LYON', naf: '70.22Z', active: true },
]

const hit = (company: string, sourceUrl: string, siren?: string): SignalHit => ({
  company, signalType: 'levée', detail: '', icebreaker: '', sourceUrl, verified: false,
  claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-08',
  eventDatePrecision: 'DAY', sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
  ...(siren ? { siren } : {}),
  extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
} as SignalHit)

async function candidat(company = 'Defacto', url = 'https://presse.exemple.fr/a', ws = WS) {
  const [cid] = await registerCandidates([hit(company, url)], ws, T0)
  const lu = await readCandidate(cid!, ws)
  if (lu.ok === false) throw new Error(lu.state)
  return lu.candidate
}

async function observationPour(c: any, candidats: any[] = FENETRE, now = T0) {
  const r = await recordEntityResolutionObservation(
    { candidate: c, lookup: { found: false, resolution: 'ambiguous', ambiguous: true, candidates: candidats } as any },
    WS, now,
  )
  if (r.ok === false) throw new Error(r.reason)
  return r.observation
}

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etat.session = { tenant: { id: WS, kind: 'user' }, actorId: 'user_adjudicateur' }
  etat.parNom = {}
  etat.parSiren = {}
  etat.registreMuet = false
})

async function appeler(handler: any, body: any) {
  const req: any = { method: 'POST', body, cookies: {} }
  let status = 0; let json: any = null
  const res: any = { status(c: number) { status = c; return res }, json(b: any) { json = b; return res } }
  await handler(req, res)
  return { status, body: json }
}

describe('observation (append-only, cliché exact)', () => {
  it('fenêtre ambiguë : cliché EXACT persisté — ordre registre préservé, website EXCLU, compte exact, normalisation de production', async () => {
    const c = await candidat('  Defacto ')
    const o = await observationPour(c, [
      { ...FENETRE[1], website: 'https://ne-doit-pas-persister.fr' },
      FENETRE[0],
    ])
    expect(o.id).toMatch(/^ero_[0-9a-f]{32}$/)
    expect(o.subjectCandidateId).toBe(c.id)
    expect(o.candidates.map((x) => x.siren)).toEqual([SIREN_B, SIREN_A]) // ordre préservé, jamais trié
    expect((o.candidates[0] as any).website).toBeUndefined()
    expect(o.returnedCount).toBe(2)
    expect(o.resultWindow).toBe(10)
    expect(o.queryRaw).toBe('Defacto')
    expect(o.retrievedAt).toBe('2026-09-02T10:00:00.000Z')
  })

  it('retrievedAt différents ⇒ observations distinctes ; candidats différents ⇒ candidatesHash/id différents', async () => {
    const c = await candidat()
    const a = await observationPour(c, FENETRE, T0)
    const b = await observationPour(c, FENETRE, t('11:00'))
    const d = await observationPour(c, [FENETRE[0]], t('11:00'))
    expect(new Set([a.id, b.id, d.id]).size).toBe(3)
    expect(a.candidatesHash).toBe(b.candidatesHash)
    expect(d.candidatesHash).not.toBe(a.candidatesHash)
  })

  it('altérations — y compris cliché falsifié AVEC recordHash recalculé : TAMPERED ; inter-espaces : inconnu', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    const cle = `${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|${o.id}`
    const original = JSON.parse(JSON.stringify(g.__prospectorStore.get(cle)))
    expect((await readEntityResolutionObservation(o.id, AUTRE_WS)).ok).toBe(false)
    for (const mutation of [
      (r: any) => { r.candidates[0].siren = '999999999' },                 // cliché mué, hash pas refait
      (r: any) => { r.returnedCount = 1 },                                // compte incohérent
      (r: any) => { r.queryNormalized = 'autre' },                        // normalisation non reproduite
      (r: any) => { r.score = 1 },                                        // clé hors contrat
    ]) {
      const row = JSON.parse(JSON.stringify(original)); mutation(row)
      g.__prospectorStore.set(cle, row)
      expect(await readEntityResolutionObservation(o.id, WS)).toEqual({ ok: false, reason: 'OBSERVATION_TAMPERED' })
    }
    // ── FALSIFICATIONS SÉMANTIQUES AVEC recordHash CORRECTEMENT RECALCULÉ ──
    // (le vrai vecteur : seules les VÉRIFICATIONS SÉMANTIQUES trahissent, pas
    // le condensat d'intégrité). recordHash exact = sha256(canonicalJson(sans)).
    const { createHash } = await import('node:crypto')
    const { canonicalJson } = await import('../lib/prospector/proactive/acquisitionV2')
    const rehacher = (row: any) => {
      const { id: _i, recordHash: _r, ...sans } = row
      row.recordHash = createHash('sha256').update(canonicalJson(sans), 'utf8').digest('hex')
    }
    // a) candidat substitué, candidatesHash STOCKÉ conservé (l'id reste donc
    //    cohérent), recordHash recalculé ⇒ SEULE la revérification
    //    candidatesHash ↔ candidats le trahit.
    let row = JSON.parse(JSON.stringify(original))
    row.candidates[0] = { ...row.candidates[0], siren: '999999999' }
    rehacher(row)
    g.__prospectorStore.set(cle, row)
    expect(await readEntityResolutionObservation(o.id, WS)).toEqual({ ok: false, reason: 'OBSERVATION_TAMPERED' })
    // b) returnedCount menteur, recordHash recalculé ⇒ seule l'égalité
    //    compte ↔ longueur le trahit.
    row = JSON.parse(JSON.stringify(original))
    row.returnedCount = row.candidates.length + 1
    rehacher(row)
    g.__prospectorStore.set(cle, row)
    expect(await readEntityResolutionObservation(o.id, WS)).toEqual({ ok: false, reason: 'OBSERVATION_TAMPERED' })
    // c) queryNormalized menteur, recordHash ET identité refaits en cohérence
    //    (re-clé) ⇒ seule la recomputation via le normaliseur de PRODUCTION
    //    le trahit.
    row = JSON.parse(JSON.stringify(original))
    row.queryNormalized = 'mensonge normalise'
    const { entityObservationId } = await import('../lib/prospector/proactive/entityResolution')
    row.id = entityObservationId(WS, row.subjectCandidateId, row.queryNormalized, row.retrievedAt, row.candidatesHash)
    rehacher(row)
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|${row.id}`, row)
    expect(await readEntityResolutionObservation(row.id, WS)).toEqual({ ok: false, reason: 'OBSERVATION_TAMPERED' })
    g.__prospectorStore.set(cle, original)
    expect(isEntityResolutionObservation(g.__prospectorStore.get(cle), WS)).toBe(true)
  })

  it('route : auto exact ⇒ AUTO_RESOLVED sans observation ; introuvable ⇒ ENTITY_NOT_FOUND ; panne ⇒ 503 ; requête dérivée du CANDIDAT', async () => {
    const c = await candidat('Gradium', 'https://presse.exemple.fr/g')
    etat.parNom['Gradium'] = { found: true, resolution: 'resolved', siren: '989284955' }
    let r = await appeler(obsHandler, { candidateId: c.id, company: 'Injection Corp', siren: '000000000' })
    expect(r.body).toEqual({ state: 'AUTO_RESOLVED', siren: '989284955' })
    etat.parNom['Gradium'] = { found: false, resolution: 'not_found' }
    r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.body.state).toBe('ENTITY_NOT_FOUND')
    etat.registreMuet = true
    r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.status).toBe(503)
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|`))
    expect(lignes).toEqual([]) // aucun de ces trois cas ne fabrique une observation
    etat.registreMuet = false
    etat.parNom['Gradium'] = { found: false, resolution: 'ambiguous', ambiguous: true, candidates: FENETRE }
    r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.body.state).toBe('OBSERVATION_RECORDED')
    expect(r.body.observation.queryRaw).toBe('Gradium') // dérivée du candidat, jamais du corps
  })
})

describe('adjudication (append-only, sélecteur pur)', () => {
  it('sélection ∈ cliché acceptée ; SIREN hors cliché refusé ; active:false refusé ; verdict/sélecteur cohérents', async () => {
    const c = await candidat()
    const o = await observationPour(c, [...FENETRE, { siren: '444555666', name: 'X', city: 'Y', naf: 'Z', active: false }])
    expect((await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)).ok).toBe(true)
    expect(await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: '777777777' }, 'alice', WS, T0))
      .toEqual({ ok: false, reason: 'SIREN_NOT_IN_OBSERVATION' })
    expect(await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: '444555666' }, 'alice', WS, T0))
      .toEqual({ ok: false, reason: 'CANDIDATE_NOT_ELIGIBLE' })
    expect((await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE' }, 'alice', WS, T0)).ok).toBe(false)
    expect((await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'NONE_OF_OBSERVED_CANDIDATES', selectedSiren: SIREN_A }, 'alice', WS, T0)).ok).toBe(false)
  })

  it('ACCEPT A → NONE (fenêtre couvrant A) → ACCEPT B : TROIS enregistrements, dernier déterministe', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    const a1 = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('12:00'))
    const a2 = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'NONE_OF_OBSERVED_CANDIDATES' }, 'alice', WS, t('12:05'))
    const a3 = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_B }, 'alice', WS, t('12:10'))
    if (a1.ok === false || a2.ok === false || a3.ok === false) throw new Error('adjudication échouée')
    expect(new Set([a1.adjudication.id, a2.adjudication.id, a3.adjudication.id]).size).toBe(3)
    const d = await effectiveHumanDecision(c.id, WS)
    expect(d.kind).toBe('ACCEPTED')
    expect((d as any).siren).toBe(SIREN_B)
    expect(entityAdjudicationId(WS, o.id, 'ACCEPTED_CANDIDATE', SIREN_A, 'alice', '2026-09-02T12:00:00.000Z'))
      .not.toBe(entityAdjudicationId(WS, o.id, 'ACCEPTED_CANDIDATE', SIREN_A, 'bob', '2026-09-02T12:00:00.000Z'))
  })

  it('RÈGLE NONE §8 : un NONE dont la fenêtre ne montre PAS la sélection courante A est REFUSÉ, non persisté', async () => {
    const c = await candidat()
    const o1 = await observationPour(c, FENETRE, T0)
    await recordEntityResolutionAdjudication({ observationId: o1.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('12:00'))
    // Nouvelle fenêtre SANS A :
    const o2 = await observationPour(c, [FENETRE[1]], t('13:00'))
    expect(await recordEntityResolutionAdjudication({ observationId: o2.id, verdict: 'NONE_OF_OBSERVED_CANDIDATES' }, 'alice', WS, t('13:05')))
      .toEqual({ ok: false, reason: 'OBSERVATION_DOES_NOT_COVER_CURRENT_SELECTION' })
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|`))
    expect(lignes.length).toBe(1) // rien persisté
    const d = await effectiveHumanDecision(c.id, WS)
    expect(d.kind).toBe('ACCEPTED') // A jamais révoquée par une fenêtre qui ne l'a pas montrée
  })

  it('route : acteur/instant navigateur IGNORÉS ; observation d’un autre espace refusée', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    const r = await appeler(adjHandler, {
      observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A,
      adjudicatedBy: 'attaquant', adjudicatedAt: '1999-01-01T00:00:00.000Z',
    })
    expect(r.status).toBe(200)
    expect(r.body.adjudication.adjudicatedBy).toBe('user_adjudicateur')
    expect(r.body.adjudication.adjudicatedAt).not.toBe('1999-01-01T00:00:00.000Z')
    etat.session = { tenant: { id: AUTRE_WS, kind: 'user' }, actorId: 'autre' }
    const r2 = await appeler(adjHandler, { observationId: o.id, verdict: 'NONE_OF_OBSERVED_CANDIDATES' })
    expect(r2.status).toBe(404)
  })
})

describe('VERROU STRUCTUREL V0 — portée CANDIDAT, jamais le nom', () => {
  it('C1 « Mio » adjugé SIREN X : C2 « Mio » du MÊME espace n’hérite RIEN', async () => {
    const c1 = await candidat('Mio', 'https://presse.exemple.fr/mio-1')
    const c2 = await candidat('Mio', 'https://presse.exemple.fr/mio-2')
    const o = await observationPour(c1)
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)
    etat.parSiren[SIREN_A] = { found: true, resolution: 'resolved', siren: SIREN_A, name: 'DEFACTO', active: true }
    // auto ambigu pour « Mio » :
    etat.parNom['Mio'] = { found: false, resolution: 'ambiguous', ambiguous: true, candidates: FENETRE }
    expect((await resolveEntityForCandidate(c1, WS)).state).toBe('RESOLVED')
    expect(await resolveEntityForCandidate(c2, WS)).toEqual({ state: 'NOT_RESOLVED' }) // AUCUN héritage
  })
})

describe('résolveur composite — matrice auto/humain (7 cas)', () => {
  const actifA = () => { etat.parSiren[SIREN_A] = { found: true, resolution: 'resolved', siren: SIREN_A, name: 'DEFACTO', active: true } }

  it('cas 1/2 — sans humain : auto exact résout (AUTO), auto ambigu/introuvable ⇒ NOT_RESOLVED ; panne ⇒ REGISTRY_UNAVAILABLE', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A, name: 'DEFACTO' }
    expect(await resolveEntityForCandidate(c, WS)).toMatchObject({ state: 'RESOLVED', siren: SIREN_A, entityAuthority: 'AUTO_EXACT_REGISTRY' })
    expect((await resolveEntityForCandidate(c, WS) as any).entityResolutionAdjudicationId).toBeUndefined()
    etat.parNom['Defacto'] = { found: false, resolution: 'ambiguous', ambiguous: true, candidates: FENETRE }
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'NOT_RESOLVED' })
    etat.registreMuet = true
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'REGISTRY_UNAVAILABLE' })
  })

  it('cas 3 — humain A + auto ambigu : revalidation lookupBySiren EXACTE et ACTIVE ⇒ HUMAN + era exact ; inactif/inconnu/disparu ⇒ fail closed', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    const adj = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)
    if (adj.ok === false) throw new Error(adj.reason)
    etat.parNom['Defacto'] = { found: false, resolution: 'ambiguous', ambiguous: true, candidates: FENETRE }
    actifA()
    expect(await resolveEntityForCandidate(c, WS)).toMatchObject({
      state: 'RESOLVED', siren: SIREN_A,
      entityAuthority: 'HUMAN_SELECTED_REGISTRY_CANDIDATE',
      entityResolutionAdjudicationId: adj.adjudication.id,
    })
    for (const cas of [
      { found: true, resolution: 'resolved', siren: SIREN_A, active: false },      // radiée
      { found: true, resolution: 'resolved', siren: SIREN_A },                     // active inconnu
      { found: true, resolution: 'resolved', siren: '999999999', active: true },   // siren discordant
      { found: false, resolution: 'not_found' },                                   // disparue
    ]) {
      etat.parSiren[SIREN_A] = cas
      expect(await resolveEntityForCandidate(c, WS), JSON.stringify(cas)).toEqual({ state: 'NOT_RESOLVED' })
    }
  })

  it('cas 4/5 — humain A + auto A : accord (autorité AUTO, sans era) ; humain A + auto B : IDENTITY_CONFLICT', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    const accord: any = await resolveEntityForCandidate(c, WS)
    expect(accord).toMatchObject({ state: 'RESOLVED', siren: SIREN_A, entityAuthority: 'AUTO_EXACT_REGISTRY' })
    expect(accord.entityResolutionAdjudicationId).toBeUndefined()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_B }
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'IDENTITY_CONFLICT' })
  })

  it('cas 6/7 — dernier NONE : auto B VU-ET-REJETÉ ⇒ conflit ; auto B JAMAIS VU ⇒ AUTO résout ; auto non résolu ⇒ NOT_RESOLVED', async () => {
    const c = await candidat()
    const o = await observationPour(c) // fenêtre contient A et B
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'NONE_OF_OBSERVED_CANDIDATES' }, 'alice', WS, T0)
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_B }
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'IDENTITY_CONFLICT' }) // B figurait dans la fenêtre rejetée
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: '555666777' } // jamais vu
    expect(await resolveEntityForCandidate(c, WS)).toMatchObject({ state: 'RESOLVED', siren: '555666777', entityAuthority: 'AUTO_EXACT_REGISTRY' })
    etat.parNom['Defacto'] = { found: false, resolution: 'not_found' }
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'NOT_RESOLVED' })
  })

  it('candidateSiren contradictoire avec la résolution (auto OU humaine) ⇒ IDENTITY_CONFLICT — jamais promu en autorité', async () => {
    const [cid] = await registerCandidates([hit('Defacto', 'https://presse.exemple.fr/x', SIREN_B)], WS, T0)
    const lu = await readCandidate(cid!, WS)
    if (lu.ok === false) throw new Error(lu.state)
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    expect(await resolveEntityForCandidate(lu.candidate, WS)).toEqual({ state: 'IDENTITY_CONFLICT' })
  })
})

describe('remédiation d’un conflit d’identité (durcissement §1)', () => {
  it('A–H : humain A + auto exact B jamais vu ⇒ conflit ; la route persiste une fenêtre FRAÎCHE contenant B ; ACCEPT B ⇒ résolution B', async () => {
    const c = await candidat()
    // A. l'humain a accepté A depuis une ancienne fenêtre SANS B.
    const o1 = await observationPour(c, [FENETRE[0]], T0)
    await recordEntityResolutionAdjudication({ observationId: o1.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('12:00'))
    // B. le registre auto-résout désormais B, avec SA fenêtre (même recherche).
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_B, name: 'DEFACTO CONSEIL', candidates: FENETRE }
    // D. la résolution normale ⇒ IDENTITY_CONFLICT.
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'IDENTITY_CONFLICT' })
    // E/F. la route d'observation PEUT persister la fenêtre fraîche — B y figure.
    const r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.body.state).toBe('IDENTITY_CONFLICT_OBSERVATION_RECORDED')
    expect(r.body.observation.candidates.map((x: any) => x.siren)).toContain(SIREN_B)
    // G. l'humain accepte B sur CETTE observation.
    const adj = await recordEntityResolutionAdjudication(
      { observationId: r.body.observation.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_B }, 'alice', WS, t('13:00'),
    )
    expect(adj.ok).toBe(true)
    // H. la résolution suit désormais la matrice : humain B + auto B ⇒ accord.
    expect(await resolveEntityForCandidate(c, WS)).toMatchObject({
      state: 'RESOLVED', siren: SIREN_B, entityAuthority: 'AUTO_EXACT_REGISTRY',
    })
  })

  it('auto exact SANS conflit humain : toujours AUTO_RESOLVED, AUCUNE observation superflue ; accord humain A + auto A idem', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A, candidates: FENETRE }
    let r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.body).toEqual({ state: 'AUTO_RESOLVED', siren: SIREN_A })
    const o = await observationPour(c, FENETRE, t('09:00'))
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('09:05'))
    r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.body.state).toBe('AUTO_RESOLVED') // accord ⇒ pas de fenêtre de remédiation
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${ENTITY_RESOLUTION_OBSERVATION_KIND}|`))
    expect(lignes.length).toBe(1) // seule l'observation créée manuellement ci-dessus
  })
})

describe('historique humain corrompu ⇒ FAIL CLOSED (durcissement §3)', () => {
  it('la ligne ACCEPT B la plus récente falsifiée : la décision NE retombe PAS sur A, la résolution auto est BLOQUÉE', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('12:00'))
    const b = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_B }, 'alice', WS, t('12:10'))
    if (b.ok === false) throw new Error(b.reason)
    // Falsification de la ligne la plus récente (recordHash cassé).
    const cle = `${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${b.adjudication.id}`
    g.__prospectorStore.get(cle).recordHash = 'e'.repeat(64)
    expect(await effectiveHumanDecision(c.id, WS)).toEqual({ kind: 'HISTORY_TAMPERED' })
    // Même un auto EXACT ne passe pas : corrompre l'histoire n'efface pas un conflit.
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    expect(await resolveEntityForCandidate(c, WS)).toEqual({ state: 'HISTORY_TAMPERED' })
  })

  it('observation référencée falsifiée ⇒ TAMPERED ; ligne corrompue d’un AUTRE candidat ⇒ n’empoisonne pas ; sujet illisible ⇒ TAMPERED', async () => {
    const c1 = await candidat('Defacto', 'https://presse.exemple.fr/d1')
    const c2 = await candidat('Autre', 'https://presse.exemple.fr/d2')
    const o1 = await observationPour(c1)
    await recordEntityResolutionAdjudication({ observationId: o1.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)
    // Observation de c1 falsifiée ⇒ l'historique de c1 est TAMPERED.
    const cle1 = `${ENTITY_RESOLUTION_OBSERVATION_KIND}|${WS}|${o1.id}`
    const orig1 = JSON.parse(JSON.stringify(g.__prospectorStore.get(cle1)))
    g.__prospectorStore.get(cle1).candidates = []
    expect(await effectiveHumanDecision(c1.id, WS)).toEqual({ kind: 'HISTORY_TAMPERED' })
    // Elle n'empoisonne PAS c2 (sujet brut lisible et étranger).
    expect(await effectiveHumanDecision(c2.id, WS)).toEqual({ kind: 'ABSENT' })
    // Sujet ILLISIBLE ⇒ falsifié-pour-tous (impossible de prouver « étranger »).
    g.__prospectorStore.get(cle1).subjectCandidateId = 42
    expect(await effectiveHumanDecision(c2.id, WS)).toEqual({ kind: 'HISTORY_TAMPERED' })
    g.__prospectorStore.set(cle1, orig1)
    expect((await effectiveHumanDecision(c1.id, WS)).kind).toBe('ACCEPTED')
  })

  it('sélection FORGÉE hors cliché avec recordHash ET identité refaits/re-clés : HISTORY_TAMPERED — jamais filtrée, jamais de retombée', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, t('12:00'))
    const b = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_B }, 'alice', WS, t('12:10'))
    if (b.ok === false) throw new Error(b.reason)
    const cle = `${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${b.adjudication.id}`
    const row = JSON.parse(JSON.stringify(g.__prospectorStore.get(cle)))
    // L'attaquant substitue un SIREN hors cliché et refait identité + intégrité
    // — la ligne est FORMELLEMENT valide : seule la cohérence sémantique
    // sélection ∈ cliché la trahit, et elle doit être TAMPERED, pas « filtrée ».
    row.selectedSiren = '999888777'
    row.id = entityAdjudicationId(WS, row.observationId, row.verdict, row.selectedSiren, row.adjudicatedBy, row.adjudicatedAt)
    const { createHash } = await import('node:crypto')
    const { canonicalJson } = await import('../lib/prospector/proactive/acquisitionV2')
    const { id: _i, recordHash: _r, ...sans } = row
    row.recordHash = createHash('sha256').update(canonicalJson(sans), 'utf8').digest('hex')
    g.__prospectorStore.delete(cle)
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${row.id}`, row)
    expect(await effectiveHumanDecision(c.id, WS)).toEqual({ kind: 'HISTORY_TAMPERED' })
  })

  it('promotion/observation bloquées explicitement : ENTITY_RESOLUTION_HISTORY_TAMPERED via la route d’observation', async () => {
    const c = await candidat()
    const o = await observationPour(c)
    const a = await recordEntityResolutionAdjudication({ observationId: o.id, verdict: 'ACCEPTED_CANDIDATE', selectedSiren: SIREN_A }, 'alice', WS, T0)
    if (a.ok === false) throw new Error(a.reason)
    g.__prospectorStore.get(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|${a.adjudication.id}`).recordHash = 'e'.repeat(64)
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A, candidates: FENETRE }
    const r = await appeler(obsHandler, { candidateId: c.id })
    expect(r.status).toBe(409)
    expect(r.body.state).toBe('ENTITY_RESOLUTION_HISTORY_TAMPERED')
  })
})

describe('provenance d’entité (appariement strict)', () => {
  const hitSur = (url: string) => hit('Defacto', url)
  const ERA = `era_${'a'.repeat(32)}`

  it('HUMAN exige un era_ valide ; AUTO interdit tout id ; appariement incohérent ⇒ ÉCHEC FERMÉ (null) ; anciens appels inchangés', () => {
    const humain = sourceEvidenceFromHit(hitSur('https://x.fr/a'), undefined, undefined, undefined, undefined, undefined,
      { authority: 'HUMAN_SELECTED_REGISTRY_CANDIDATE', adjudicationId: ERA })!
    expect(humain.entityAuthority).toBe('HUMAN_SELECTED_REGISTRY_CANDIDATE')
    expect(humain.entityResolutionAdjudicationId).toBe(ERA)
    const auto = sourceEvidenceFromHit(hitSur('https://x.fr/a'), undefined, undefined, undefined, undefined, undefined,
      { authority: 'AUTO_EXACT_REGISTRY' })!
    expect(auto.entityAuthority).toBe('AUTO_EXACT_REGISTRY')
    expect(auto.entityResolutionAdjudicationId).toBeUndefined()
    // Incohérents ⇒ ÉCHEC FERMÉ : `null`, JAMAIS une rétrogradation muette
    // « autorité humaine revendiquée → aucune provenance ». Rien n'atteint
    // le Bridge, donc aucune evidence/assertion/ancre n'est écrite en aval.
    expect(sourceEvidenceFromHit(hitSur('https://x.fr/a'), undefined, undefined, undefined, undefined, undefined,
      { authority: 'HUMAN_SELECTED_REGISTRY_CANDIDATE' })).toBeNull() // era manquant
    expect(sourceEvidenceFromHit(hitSur('https://x.fr/a'), undefined, undefined, undefined, undefined, undefined,
      { authority: 'HUMAN_SELECTED_REGISTRY_CANDIDATE', adjudicationId: 'era_pas-hexadecimal' })).toBeNull() // era malformé
    expect(sourceEvidenceFromHit(hitSur('https://x.fr/a'), undefined, undefined, undefined, undefined, undefined,
      { authority: 'AUTO_EXACT_REGISTRY', adjudicationId: ERA })).toBeNull() // id factice sur AUTO
    const ancien = sourceEvidenceFromHit(hitSur('https://x.fr/a'))!
    expect(ancien.entityAuthority).toBeUndefined() // ancien contrat (sans entité) intact
  })
})
