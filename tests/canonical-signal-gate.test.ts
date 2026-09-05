// SIGNAL_CANONICAL_GATE_V0_001 — la frontière fait canonique → Signal.
//
// ⚠️ TOUT EST DU CODE DE PRODUCTION : bridge, registre d'assertions, ancres
// canoniques, magasin (repli mémoire), gate. Aucun mock de sémantique.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bridgeSignals, sourceEvidenceFromHit, externalEvidenceId,
  type HumanFactConfirmation, type SourceEvidence,
} from '../lib/prospector/proactive/signalBridge'
import {
  buildSourceAssertions, recordSourceAssertions, SOURCE_ASSERTION_KIND, sourceAssertionIdV2,
  type AssertionBuildInput,
} from '../lib/prospector/proactive/sourceAssertion'
import {
  CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND,
  canonicalEventId, canonicalExecutiveEventId, canonicalSnapshotId, recordCanonicalAnchors,
} from '../lib/prospector/proactive/canonicalFact'
import { canonicalSignalGate, classifyExternalEvidence } from '../lib/prospector/proactive/canonicalSignalGate'
import { assembleLiveFactV2 } from '../lib/prospector/proactive/acquisitionV2'
import { canonicalClaimKey, EXTERNAL_SIGNAL_PROVIDER } from '../lib/prospector/proactive/types'
import type { KnownEvidenceEvent } from '../lib/prospector/proactive/catalog'
import type { SignalHit } from '../types/prospector'

const g: any = globalThis as any
const WS = 'ws_gate_a'
const AUTRE_WS = 'ws_gate_b'
const COMPTE = 'acc_siren_552100554'
const OBSERVED = '2026-08-20T09:00:00.000Z'
const RECUPERE = '2026-08-19T07:30:00.000Z'
const JOUR_EVT = '2026-08-12'

const V2_LEVEE = assembleLiveFactV2({
  factFamily: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
  eventDate: JOUR_EVT, eventDatePrecision: 'DAY', sourcePublishedAt: null,
  detail: 'annonce de cloture de la levee', icebreaker: '',
  extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
  roundStage: 'SEED', roleFunction: 'UNKNOWN', roleStatus: 'UNKNOWN',
})
if (!V2_LEVEE) throw new Error('fixture V2 invalide')

function hitLevee(url: string): SignalHit {
  return {
    company: 'Acme', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: JOUR_EVT, eventDatePrecision: 'DAY',
    sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
    v2: V2_LEVEE,
  } as SignalHit
}
function sourceA(chemin = '/presse/serie-a'): SourceEvidence {
  const s = sourceEvidenceFromHit(hitLevee(`https://acme.fr${chemin}`), 'https://acme.fr',
    { kind: 'ORIGINAL' }, { kind: 'UNVERIFIABLE' }, RECUPERE)
  if (!s) throw new Error('fixture source invalide')
  return s
}
function confirmation(cle: string, urls: string[]): HumanFactConfirmation {
  return { kind: 'HUMAN_CONFIRMED', canonicalKey: cle, confirmedBy: 'alice', confirmedAt: OBSERVED, sourceUrls: urls }
}

const CLE = canonicalClaimKey({ type: 'recent_funding', accountId: COMPTE, temporality: 'dated_event', occurredAt: JOUR_EVT })

/** Promotion RÉELLE via le bridge — rend evidence + lots d'assertions. */
function promotionLevee() {
  const sources = [sourceA()]
  const pont = bridgeSignals({
    accountId: COMPTE, observedAt: OBSERVED, sources,
    confirmations: [confirmation(CLE, sources.map((s) => s.url))],
  })
  if (pont.evidence.length !== 1) throw new Error(`bridge: ${JSON.stringify(pont.refusals)}`)
  const lots: AssertionBuildInput[] = pont.promotions.map((p) => ({
    workspaceId: WS, accountId: p.evidence.accountId, canonicalClaimKey: p.canonicalKey,
    evidence: p.evidence, qualifyingSources: p.qualifyingSources,
  }))
  return { evidence: pont.evidence[0] as KnownEvidenceEvent, lots }
}
async function historiqueComplet() {
  const { evidence, lots } = promotionLevee()
  const bilan = await recordSourceAssertions(lots, WS)
  if (bilan.failed > 0) throw new Error('assertions non ecrites')
  const ancres = await recordCanonicalAnchors(lots, WS, new Set(bilan.durableIds))
  if (ancres.failed > 0) throw new Error('ancres non ecrites')
  return { evidence, lots, bilan }
}

beforeEach(() => { if (g.__prospectorStore) g.__prospectorStore.clear() })

describe('classement — levée (FUNDING_ROUND)', () => {
  it('1/10/18 — histoire complète ⇒ CANONICALLY_GROUNDED ; rejeu compatible passe ; lecture déterministe', async () => {
    const { evidence } = await historiqueComplet()
    const a = await canonicalSignalGate([evidence], WS)
    if (a.ok === false) throw new Error(a.reason)
    expect(a.signals).toEqual([evidence])
    expect(a.excluded).toEqual([])
    // SIGNAL_TEMPORAL_WINDOW_V0_001 : le side-car temporel d'un ÉVÉNEMENT est
    // sa date métier prouvée — jamais recopié sur l'Evidence (toEqual ci-dessus
    // échouerait sur tout champ ajouté), jamais persisté (test 20).
    expect(a.temporalAuthorityByEvidenceId).toEqual({
      [evidence.id]: { basis: 'DATED_EVENT_DAY', referenceDay: JOUR_EVT },
    })
    const b = await canonicalSignalGate([evidence], WS) // rejeu strictement identique
    expect(b).toEqual(a) // 10 + 18 + side-car déterministe
  })

  it('2/15 — AUCUNE assertion (héritage non couvert) ⇒ MISSING/NO_SOURCE_ASSERTION, jamais « vieille evidence valide »', async () => {
    const { evidence } = promotionLevee() // rien d'écrit au registre
    const r = await canonicalSignalGate([evidence], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded).toEqual([{
      evidenceId: evidence.id, state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_SOURCE_ASSERTION',
    }])
  })

  it('3 — assertions durables mais AUCUNE ancre ⇒ MISSING/NO_CANONICAL_ANCHOR', async () => {
    const { evidence, lots } = promotionLevee()
    const bilan = await recordSourceAssertions(lots, WS)
    expect(bilan.failed).toBe(0) // ancres volontairement NON écrites
    const r = await canonicalSignalGate([evidence], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_CANONICAL_ANCHOR' })
  })

  it('4/5/7bis — ligne de registre malformée (assertion OU ancre) ⇒ CANONICAL_HISTORY_INVALID global, jamais filtrée', async () => {
    const { evidence } = await historiqueComplet()
    g.__prospectorStore.set(`${SOURCE_ASSERTION_KIND}|${WS}|sa_corrompue`, { id: 'sa_corrompue', workspaceId: WS })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'CANONICAL_HISTORY_INVALID' })
    g.__prospectorStore.delete(`${SOURCE_ASSERTION_KIND}|${WS}|sa_corrompue`)
    g.__prospectorStore.set(`${CANONICAL_EVENT_KIND}|${WS}|cev_corrompu`, { id: 'cev_corrompu', workspaceId: WS })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'CANONICAL_HISTORY_INVALID' })
  })

  it('6/17 — cloisonnement d’espace : l’histoire d’un espace ne fonde RIEN dans un autre', async () => {
    const { evidence } = await historiqueComplet() // tout écrit dans WS
    const r = await canonicalSignalGate([evidence], AUTRE_WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING' })
  })

  it('7/8 — assertion d’un AUTRE evidenceId ⇒ non-appui (MISSING) ; evidenceId identique mais AUTRE revendication ⇒ DIVERGENT', async () => {
    const { evidence, lots } = promotionLevee()
    // 7 — assertion réelle rattachée à un autre agrégat.
    const etranger = buildSourceAssertions({ ...lots[0], evidence: { ...lots[0].evidence, id: 'ev_ext_autreagregat00' } as any })
    for (const a of etranger) {
      g.__prospectorStore.set(`${SOURCE_ASSERTION_KIND}|${WS}|${a.id}`, a)
    }
    let r = await canonicalSignalGate([evidence], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_SOURCE_ASSERTION' })
    // 8 — même evidenceId, revendication étrangère : projection réécrite.
    g.__prospectorStore.clear()
    // Identité RECALCULÉE avec la revendication étrangère — la ligne reste de
    // forme valide, mais elle affirme une AUTRE revendication pour cet id.
    const distordu = buildSourceAssertions(lots[0]).map((a) => {
      const cleEtrangere = `recent_funding|${COMPTE}|2026-01-01`
      return {
        ...a,
        canonicalClaimKey: cleEtrangere,
        id: sourceAssertionIdV2(WS, cleEtrangere, a.sourceUrl, a.assertedFactHash as string, a.sourceObservedDay),
      }
    })
    for (const a of distordu) {
      g.__prospectorStore.set(`${SOURCE_ASSERTION_KIND}|${WS}|${a.id}`, a)
    }
    r = await canonicalSignalGate([evidence], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ASSERTION_CLAIM_MISMATCH' })
  })

  it('9 — RÉGRESSION CENTRALE : la projection réécrite (fait V2 différent) est BLOQUÉE, pas avalisée par son id', async () => {
    const { evidence } = await historiqueComplet()
    // T1 : upsert ultérieur — même id, version sémantique DIFFÉRENTE.
    const reecrite = {
      ...evidence,
      structuredFact: { ...(evidence as any).structuredFact, payload: { family: 'FUNDING', roundStage: 'SERIES_A' } },
    } as KnownEvidenceEvent
    const r = await canonicalSignalGate([reecrite], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'SEMANTIC_VERSION_UNSUPPORTED' })
  })

  it('identité incohérente — acceptance.canonicalKey ≠ clé recalculée ⇒ DIVERGENT/EVIDENCE_IDENTITY_INCOHERENT', async () => {
    const { evidence } = await historiqueComplet()
    const trafiquee = { ...evidence, acceptance: { ...(evidence as any).acceptance, canonicalKey: 'autre|cle|2026-01-01' } } as KnownEvidenceEvent
    const r = await canonicalSignalGate([trafiquee], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'EVIDENCE_IDENTITY_INCOHERENT' })
  })

  it('14 — magasin muet ⇒ STORE_UNAVAILABLE, jamais []', async () => {
    const { evidence } = await historiqueComplet()
    const espion = vi.spyOn(await import('../lib/supabase/store'), 'listItemsStrict' as never)
    ;(espion as any).mockResolvedValue({ ok: false })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'STORE_UNAVAILABLE' })
    espion.mockRestore()
  })

  it('16 — evidence INTERNE (CRM) : hors périmètre, passe inchangée, jamais classée', async () => {
    const interne = {
      id: 'ev_crm_1', type: 'hot_lead', accountId: COMPTE, scope: 'account',
      temporality: 'undated_state', assertionType: 'inference', confidence: 0.8,
      observedAt: OBSERVED, source: { provider: 'prospector_crm' },
    } as unknown as KnownEvidenceEvent
    const r = await canonicalSignalGate([interne], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([interne])
    expect(r.excluded).toEqual([])
  })
})

describe('cardinalités — instantanés d’état et événements de direction', () => {
  const CLE_ETAT = canonicalClaimKey({ type: 'sales_hiring', accountId: COMPTE, temporality: 'undated_state' })
  function evidenceEtat(): KnownEvidenceEvent {
    return {
      id: externalEvidenceId(CLE_ETAT), type: 'sales_hiring', accountId: COMPTE, scope: 'account',
      temporality: 'undated_state', assertionType: 'fact', confidence: 0.75,
      observedAt: OBSERVED,
      // ⚠️ R1-5 : l'URL PRINCIPALE de la projection doit être celle d'une
      // source réellement inscrite au registre — la première source d'état.
      source: { provider: EXTERNAL_SIGNAL_PROVIDER, url: 'https://acme.fr/jobs/0' },
      acceptance: { kind: 'human_confirmed', actorId: 'alice', confirmedAt: OBSERVED, canonicalKey: CLE_ETAT, sourceUrls: [] },
    } as unknown as KnownEvidenceEvent
  }
  function sourceEtat(url: string, retrievedAt: string): SourceEvidence {
    const s = sourceEvidenceFromHit(
      { ...hitLevee(url), v2: undefined, signalType: 'recrutement', claimNature: 'STATE', eventStatus: 'NOT_STATED', eventDate: null, eventDatePrecision: 'UNKNOWN' } as any,
      'https://acme.fr', { kind: 'ORIGINAL' }, { kind: 'UNVERIFIABLE' }, retrievedAt)
    if (!s) throw new Error('fixture etat invalide')
    return s
  }
  async function historiqueEtat(jours: string[]) {
    const e = evidenceEtat()
    const lots: AssertionBuildInput[] = [{
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_ETAT, evidence: e,
      qualifyingSources: jours.map((j, i) => sourceEtat(`https://acme.fr/jobs/${i}`, `${j}T08:00:00.000Z`)),
    }]
    const bilan = await recordSourceAssertions(lots, WS)
    if (bilan.failed > 0) throw new Error('assertions etat non ecrites')
    const ancres = await recordCanonicalAnchors(lots, WS, new Set(bilan.durableIds))
    if (ancres.failed > 0) throw new Error('ancres etat non ecrites')
    return e
  }

  it('11 — PLUSIEURS jours d’observation ⇒ PLUSIEURS instantanés exigés et trouvés — aucun effondrement', async () => {
    const e = await historiqueEtat(['2026-08-18', '2026-08-19'])
    const r = await canonicalSignalGate([e], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([e])
    const snapshots = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${CANONICAL_STATE_SNAPSHOT_KIND}|${WS}|`))
    expect(snapshots.length).toBe(2)
    // SIGNAL_TEMPORAL_WINDOW_V0_001 : l'autorité d'un ÉTAT est le jour
    // d'observation MAXIMAL des assertions durables — jamais le minimum,
    // jamais `observedAt`.
    expect(r.temporalAuthorityByEvidenceId[e.id]).toEqual({
      basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-08-19',
    })
  })

  it('12 — UN jour affirmé sans son instantané ⇒ MISSING/SNAPSHOT_DAY_UNANCHORED (échec fermé)', async () => {
    const e = await historiqueEtat(['2026-08-18', '2026-08-19'])
    const manquant = canonicalSnapshotId(WS, CLE_ETAT, '2026-08-19')
    g.__prospectorStore.delete(`${CANONICAL_STATE_SNAPSHOT_KIND}|${WS}|${manquant}`)
    const r = await canonicalSignalGate([e], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING', reason: 'SNAPSHOT_DAY_UNANCHORED' })
  })

  // ── R1-4 : la voie exécutive est DÉRIVÉE du fait sémantique V2, jamais
  // cueillie « par revendication ». Fixtures 100 % production : fait assemblé
  // par `assembleLiveFactV2`, assertions et ancres écrites par les
  // enregistreurs réels — AUCUNE ancre injectée à la main.
  const CLE_EXEC = canonicalClaimKey({ type: 'executive_appointment', accountId: COMPTE, temporality: 'dated_event', occurredAt: JOUR_EVT })
  function faitExec(nom: string) {
    const f = assembleLiveFactV2({
      factFamily: 'EXECUTIVE_CHANGE', claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: JOUR_EVT, eventDatePrecision: 'DAY', sourcePublishedAt: null,
      detail: `${nom} rejoint la direction`, icebreaker: '',
      extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
      direction: 'APPOINTMENT', personFullName: nom, roleSeniority: 'C_LEVEL',
      roleFunction: 'SALES', roleStatus: 'UNKNOWN',
    })
    if (!f) throw new Error('fixture exec invalide')
    return f
  }
  function sourceExec(chemin: string, fait: ReturnType<typeof faitExec> | undefined): SourceEvidence {
    const s = sourceEvidenceFromHit({ ...hitLevee(`https://acme.fr${chemin}`), v2: fait } as any,
      'https://acme.fr', { kind: 'ORIGINAL' }, { kind: 'UNVERIFIABLE' }, RECUPERE)
    if (!s) throw new Error('fixture source exec invalide')
    return s
  }
  function evidenceExec(fait?: ReturnType<typeof faitExec>): KnownEvidenceEvent {
    return {
      id: externalEvidenceId(CLE_EXEC), type: 'executive_appointment', accountId: COMPTE, scope: 'account',
      temporality: 'dated_event', occurredAt: JOUR_EVT, assertionType: 'fact', confidence: 0.75,
      observedAt: OBSERVED, source: { provider: EXTERNAL_SIGNAL_PROVIDER, url: 'https://acme.fr/exec/a' },
      acceptance: { kind: 'human_confirmed', actorId: 'alice', confirmedAt: OBSERVED, canonicalKey: CLE_EXEC, sourceUrls: [] },
      ...(fait ? { structuredFact: fait } : {}),
    } as unknown as KnownEvidenceEvent
  }
  async function historiqueExec(sources: SourceEvidence[], fait?: ReturnType<typeof faitExec>) {
    const e = evidenceExec(fait)
    const lots: AssertionBuildInput[] = [{
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_EXEC, evidence: e,
      qualifyingSources: sources,
    }]
    const bilan = await recordSourceAssertions(lots, WS)
    if (bilan.failed > 0) throw new Error('assertions exec non ecrites')
    const ancres = await recordCanonicalAnchors(lots, WS, new Set(bilan.durableIds))
    if (ancres.failed > 0) throw new Error('ancres exec non ecrites')
    return e
  }
  const registresLus = () => ({
    assertions: [...g.__prospectorStore.entries()]
      .filter(([k]: any) => k.startsWith(`${SOURCE_ASSERTION_KIND}|${WS}|`)).map(([, v]: any) => v),
    events: [...g.__prospectorStore.entries()]
      .filter(([k]: any) => k.startsWith(`${CANONICAL_EVENT_KIND}|${WS}|`)).map(([, v]: any) => v),
    snapshots: [] as any[],
  })

  it('13 — DEUX personnes affirmées par des sources durables ⇒ les DEUX ancres DÉRIVÉES, jamais un singleton', async () => {
    const jane = faitExec('Jane Doe')
    const john = faitExec('John Roe')
    // L'evidence cite Jane (source principale) ; John est affirmé par la
    // seconde source durable. Les deux ancres sont dérivées PAR PRODUCTION.
    const e = await historiqueExec([sourceExec('/exec/a', jane), sourceExec('/exec/b', john)], jane)
    const r = await canonicalSignalGate([e], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([e])
    const verdict = classifyExternalEvidence(e, WS, registresLus())
    if (verdict.state !== 'CANONICALLY_GROUNDED') throw new Error(verdict.state)
    expect(verdict.anchorIds.length).toBe(2)
  })

  it('R1-4 — l’ancre de John ne fonde JAMAIS l’évidence de Jane (même revendication, autre personne)', async () => {
    const jane = faitExec('Jane Doe')
    const john = faitExec('John Roe')
    const e = await historiqueExec([sourceExec('/exec/a', jane), sourceExec('/exec/b', john)], jane)
    // On retire l'ancre de JANE — celle de John (même claim/compte/jour) reste.
    const idJane = canonicalExecutiveEventId(WS, 'EXECUTIVE_APPOINTMENT', COMPTE, 'SALES', `name:jane doe@${COMPTE}`, JOUR_EVT)
    g.__prospectorStore.delete(`${CANONICAL_EVENT_KIND}|${WS}|${idJane}`)
    const r = await canonicalSignalGate([e], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING', reason: 'NO_CANONICAL_ANCHOR' })
  })

  it('R1-4 — héritage exec V1 SANS matière sémantique ⇒ jamais SignalV0, même si une ancre de même revendication existe', async () => {
    // Assertions V1 réelles (aucun fait structuré) : aucune ancre exécutive
    // n'est dérivable — et on n'en fabrique pas.
    const e = await historiqueExec([sourceExec('/exec/a', undefined)], undefined)
    // Même une ancre de même revendication posée par un AUTRE chemin ne doit
    // rien fonder : la personne de CETTE évidence n'est dérivable de rien.
    const idAutre = canonicalExecutiveEventId(WS, 'EXECUTIVE_APPOINTMENT', COMPTE, 'SALES', `name:john roe@${COMPTE}`, JOUR_EVT)
    g.__prospectorStore.set(`${CANONICAL_EVENT_KIND}|${WS}|${idAutre}`, {
      id: idAutre, workspaceId: WS, type: 'EXECUTIVE_APPOINTMENT', accountId: COMPTE,
      roleFunction: 'SALES', personKey: `name:john roe@${COMPTE}`, occurredAt: JOUR_EVT,
      occurredAtPrecision: 'DAY', canonicalClaimKey: CLE_EXEC,
    })
    const r = await canonicalSignalGate([e], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_MISSING', reason: 'SEMANTIC_VERSION_UNSUPPORTED' })
  })
})

describe('R1-2/R1-3/R1-5 — pas de repli mixte, cloisonnement de charge, appui de la source principale', () => {
  it('R1-2 — UNE assertion liée incompatible suffit : aucun repli sur le sous-ensemble valide', async () => {
    const { evidence, lots } = promotionLevee()
    const bilan = await recordSourceAssertions(lots, WS)
    expect(bilan.failed).toBe(0)
    await recordCanonicalAnchors(lots, WS, new Set(bilan.durableIds))
    // Une SECONDE assertion, structurellement valide, MÊME evidenceId, mais
    // revendication étrangère — à côté du soutien parfaitement valide.
    const forgees = buildSourceAssertions(lots[0]).map((a) => {
      const cleEtrangere = `recent_funding|${COMPTE}|2026-01-01`
      const urlAutre = 'https://acme.fr/autre-reprise'
      return {
        ...a,
        sourceUrl: urlAutre,
        canonicalClaimKey: cleEtrangere,
        id: sourceAssertionIdV2(WS, cleEtrangere, urlAutre, a.assertedFactHash as string, a.sourceObservedDay),
      }
    })
    for (const a of forgees) g.__prospectorStore.set(`${SOURCE_ASSERTION_KIND}|${WS}|${a.id}`, a)
    const r = await canonicalSignalGate([evidence], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'ASSERTION_CLAIM_MISMATCH' })
  })

  it('R1-3 — une ancre PHYSIQUEMENT sous WS mais dont la charge se déclare d’un autre espace ⇒ INVALID global', async () => {
    const { evidence } = await historiqueComplet()
    // Événement dérivé pour AUTRE_WS (identité interne valide), rangé sous WS.
    const idB = canonicalEventId(AUTRE_WS, COMPTE, JOUR_EVT)
    g.__prospectorStore.set(`${CANONICAL_EVENT_KIND}|${WS}|${idB}`, {
      id: idB, workspaceId: AUTRE_WS, type: 'FUNDING_ROUND', accountId: COMPTE,
      occurredAt: JOUR_EVT, occurredAtPrecision: 'DAY', canonicalClaimKey: CLE,
    })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'CANONICAL_HISTORY_INVALID' })
    g.__prospectorStore.delete(`${CANONICAL_EVENT_KIND}|${WS}|${idB}`)
    // Même règle pour un ÉVÉNEMENT EXÉCUTIF inter-espaces : mêmes
    // type/compte/claim/jour, charge d'un autre espace ⇒ ne soutient JAMAIS.
    const idExecB = canonicalExecutiveEventId(AUTRE_WS, 'EXECUTIVE_APPOINTMENT', COMPTE, 'SALES', `name:jane doe@${COMPTE}`, JOUR_EVT)
    g.__prospectorStore.set(`${CANONICAL_EVENT_KIND}|${WS}|${idExecB}`, {
      id: idExecB, workspaceId: AUTRE_WS, type: 'EXECUTIVE_APPOINTMENT', accountId: COMPTE,
      roleFunction: 'SALES', personKey: `name:jane doe@${COMPTE}`, occurredAt: JOUR_EVT,
      occurredAtPrecision: 'DAY', canonicalClaimKey: `executive_appointment|${COMPTE}|${JOUR_EVT}`,
    })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'CANONICAL_HISTORY_INVALID' })
    g.__prospectorStore.delete(`${CANONICAL_EVENT_KIND}|${WS}|${idExecB}`)
    // Et pour un INSTANTANÉ d'état.
    const cleEtat = canonicalClaimKey({ type: 'sales_hiring', accountId: COMPTE, temporality: 'undated_state' })
    const idSnapB = canonicalSnapshotId(AUTRE_WS, cleEtat, '2026-08-18')
    g.__prospectorStore.set(`${CANONICAL_STATE_SNAPSHOT_KIND}|${WS}|${idSnapB}`, {
      id: idSnapB, workspaceId: AUTRE_WS, type: 'HIRING_SNAPSHOT', accountId: COMPTE,
      canonicalClaimKey: cleEtat, stateObservedDay: '2026-08-18',
    })
    expect(await canonicalSignalGate([evidence], WS)).toEqual({ ok: false, reason: 'CANONICAL_HISTORY_INVALID' })
  })

  it('R1-5 — la source principale réécrite SANS assertion ⇒ DIVERGENT ; l’assertion de la nouvelle source la réhabilite', async () => {
    // T0 : histoire complète, source A.
    const { evidence, lots } = promotionLevee()
    const bilan = await recordSourceAssertions(lots, WS)
    expect(bilan.failed).toBe(0)
    await recordCanonicalAnchors(lots, WS, new Set(bilan.durableIds))
    // T1 : projection courante — même id, même fait sémantique, source B.
    const urlB = 'https://acme.fr/reprise/serie-a'
    const reecrite = { ...evidence, source: { ...(evidence as any).source, url: urlB } } as KnownEvidenceEvent
    let r = await canonicalSignalGate([reecrite], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([])
    expect(r.excluded[0]).toMatchObject({ state: 'CANONICAL_HISTORY_DIVERGENT', reason: 'PRIMARY_SOURCE_UNSUPPORTED' })
    // T2 : la source B est réellement inscrite au registre ⇒ la projection
    // courante redevient compatible. Une recapture légitime reste possible.
    const bilanB = await recordSourceAssertions([{ ...lots[0], qualifyingSources: [sourceA('/reprise/serie-a')] }], WS)
    expect(bilanB.failed).toBe(0)
    r = await canonicalSignalGate([reecrite], WS)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.signals).toEqual([reecrite])
  })
})

describe('19/20 — pare-feu LECTURE ≠ REVALIDATION, zéro écriture, moteur de Situations intact', () => {
  it('le gate n’importe AUCUN réseau/résolveur/écriture, et n’importe pas le moteur de Situations', () => {
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/canonicalSignalGate.ts', 'utf8')
    for (const interdit of [
      'resolveEntityForCandidate', 'datagouv', 'lookupByName', 'lookupBySiren',
      'eligibleAdjudicatedDomain', 'captureLegalProof', 'legalProofFetch',
      'recordSourceAssertions', 'recordCanonicalAnchors', 'saveCanonicalEvent',
      'saveSourceAssertion', 'insertItemIfAbsent', 'upsertItem', 'saveEvidence',
      'node:https', 'node:http', 'fetch(', 'anthropic',
      'situationEngine', 'evaluateSituations',
    ]) {
      expect(src.includes(interdit), `canonicalSignalGate.ts contient « ${interdit} »`).toBe(false)
    }
  })

  it('le gate n’a RIEN écrit pendant tous ses classements (magasin inchangé)', async () => {
    const { evidence } = await historiqueComplet()
    const avant = new Map(g.__prospectorStore)
    const r = await canonicalSignalGate([evidence], WS)
    expect(r.ok).toBe(true)
    expect([...g.__prospectorStore.entries()]).toEqual([...avant.entries()])
  })
})
