// SIGNAL_ACQUISITION_CONTRACT_002_E2E_BRIDGE_001 (+ R1, arbitrage A).
//
// ⚠️ CODE DE PRODUCTION EXERCÉ : registre des candidats, Bridge, registre des
// assertions VERSIONNÉ PAR CONTENU SÉMANTIQUE, ancres canoniques, magasin réel
// (repli mémoire, la même Map, jamais remplacée). Aucun réseau, aucune horloge
// système non injectée, AUCUN appel payant.
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  candidateId,
  hitFromCandidate,
  readCandidate,
  registerCandidates,
  SIGNAL_CANDIDATE_KIND,
} from '../lib/prospector/proactive/signalCandidates'
import {
  mapClaim,
  promoteToEvidence,
  sourceEvidenceFromHit,
  type Grounding,
  type HumanFactConfirmation,
  type SourceEvidence,
  type SourceLineage,
} from '../lib/prospector/proactive/signalBridge'
import {
  buildSourceAssertions,
  isSourceAssertion,
  recordSourceAssertions,
  sourceAssertionId,
  sourceAssertionIdV2,
  SOURCE_ASSERTION_KIND,
} from '../lib/prospector/proactive/sourceAssertion'
import {
  buildCanonicalAnchors,
  canonicalEventId,
  canonicalExecutiveEventId,
  recordCanonicalAnchors,
  CANONICAL_EVENT_KIND,
  CANONICAL_STATE_SNAPSHOT_KIND,
} from '../lib/prospector/proactive/canonicalFact'
import { assertedFactHash } from '../lib/prospector/proactive/acquisitionV2'
import { isEvidenceEvent } from '../lib/prospector/proactive/validators'
import { listItems, upsertItem } from '../lib/supabase/store'
import type { AcquisitionFactV2, SignalHit } from '../types/prospector'

const WS = 'ws_alpha'
const COMPTE = 'acc_siren_552100554'
const OBSERVED = '2026-08-20T09:00:00.000Z'
const RECUPERE = '2026-08-13T07:30:00.000Z'
const JOUR_FAIT = '2026-08-12'
const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: 'la cloture de sa Serie A de 12 millions' }

// ── FIXTURES V2 ─────────────────────────────────────────────────────────────

function v2Funding(p: Record<string, unknown> = {}, env: Record<string, unknown> = {}): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'FUNDING',
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: JOUR_FAIT, occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'Acme lève 12 M€ en série A', icebreaker: 'bravo' },
    extraction: { mode: 'claude-web', promptVersion: 'v2-e2e' },
    payload: {
      family: 'FUNDING',
      amount: { amountMinor: 1_200_000_000, currency: 'EUR', asPublished: '€12M' },
      roundStage: 'SERIES_A',
      investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }],
      ...p,
    },
    ...env,
  } as AcquisitionFactV2
}

function v2Exec(p: Record<string, unknown> = {}, env: Record<string, unknown> = {}): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'EXECUTIVE_CHANGE',
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    occurredAt: JOUR_FAIT, occurredAtPrecision: 'DAY', sourcePublishedAt: null,
    rawDetail: { detail: 'Marie Dupont nommée CRO', icebreaker: 'félicitations' },
    extraction: { mode: 'claude-web', promptVersion: 'v2-e2e' },
    payload: {
      family: 'EXECUTIVE_CHANGE', direction: 'APPOINTMENT',
      roleFunction: 'SALES', roleSeniority: 'C_LEVEL',
      person: { fullNameRaw: 'Marie Dupont', normalizedName: 'marie dupont', verification: 'NAME_ONLY' },
      roleTitleRaw: 'Chief Revenue Officer',
      ...p,
    },
    ...env,
  } as AcquisitionFactV2
}

function v2Hiring(valeur: number): AcquisitionFactV2 {
  return {
    contractVersion: 'v2', family: 'HIRING_SNAPSHOT',
    claimNature: 'STATE', eventStatus: 'UNKNOWN',
    occurredAt: null, occurredAtPrecision: 'UNKNOWN', sourcePublishedAt: null,
    rawDetail: { detail: `${valeur} postes Sales ouverts`, icebreaker: 'ça recrute' },
    extraction: { mode: 'claude-web', promptVersion: 'v2-e2e' },
    payload: {
      family: 'HIRING_SNAPSHOT', roleFunction: 'SALES', roleStatus: 'OPEN',
      openingsObserved: { value: valeur, method: 'ENUMERATED_POSTINGS' },
    },
  } as AcquisitionFactV2
}

// ── FIXTURES HIT / SOURCE ───────────────────────────────────────────────────
// Les champs V1 restent cohérents entre sources d'un même fait : la détection
// de contradiction matérielle lit encore le contrat V1, et un désaccord V1
// bloquerait la promotion avant même le contrat V2.

function hitV2(url: string, v2: AcquisitionFactV2, p: Partial<SignalHit> = {}): SignalHit {
  const etat = v2.family === 'HIRING_SNAPSHOT'
  return {
    company: 'Acme', signalType: etat ? 'recrutement' : 'levée', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: etat ? 'STATE' : 'EVENT',
    eventStatus: etat ? 'UNKNOWN' : 'COMPLETED',
    eventDate: etat ? null : JOUR_FAIT, eventDatePrecision: etat ? 'UNKNOWN' : 'DAY',
    sourcePublishedAt: null,
    roleStatus: etat ? 'OPEN' : 'UNKNOWN',
    roleFunction: etat ? 'SALES' : 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'v2-e2e' },
    v2,
    ...p,
  } as SignalHit
}

function sourceDe(hit: SignalHit, o: { site?: string | null; retrievedAt?: string } = {}): SourceEvidence {
  const s = sourceEvidenceFromHit(
    hit, o.site ?? null, { kind: 'ORIGINAL' } as SourceLineage, ANCRE,
    'retrievedAt' in o ? o.retrievedAt : RECUPERE,
  )
  if (!s) throw new Error('fixture invalide')
  return s
}

/** Grade A : document du site officiel. */
function sourceA(v2: AcquisitionFactV2, chemin = '/presse/fait'): SourceEvidence {
  return sourceDe(hitV2(`https://acme.fr${chemin}`, v2), { site: 'https://acme.fr' })
}

function confirme(sourceUrls: string[], cle: string): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED', canonicalKey: cle, confirmedBy: 'actor_7f2c',
    confirmedAt: '2026-08-20T10:00:00.000Z', sourceUrls,
  }
}

/** Promotion RÉELLE puis chaîne registre → ancres, comme `promote.ts`. */
async function chaine(sources: SourceEvidence[], cle: string) {
  const r = promoteToEvidence({
    accountId: COMPTE, observedAt: OBSERVED, sources,
    confirmations: [confirme(sources.map((s) => s.url), cle)],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  const lot = {
    workspaceId: WS, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
    evidence: r.evidence, qualifyingSources: r.qualifyingSources,
  }
  const bilan = await recordSourceAssertions([lot], WS)
  const ancres = await recordCanonicalAnchors([lot], WS, new Set(bilan.durableIds))
  return { evidence: r.evidence, lot, bilan, ancres }
}

const g: any = globalThis as any
beforeEach(() => { if (g.__prospectorStore) g.__prospectorStore.clear() })

async function lignes(kind: string) { return listItems<any>(kind, WS) }

// ═══ PART 1/2 — TRANSPORT CANDIDAT & SOURCEEVIDENCE ═════════════════════════

describe('transport candidat', () => {
  const hit = () => hitV2('https://acme.fr/presse/fait', v2Funding(), { siren: '552100554' })

  it('le bloc V2 validé est porté VERBATIM : registre → relecture → hit reconstruit', async () => {
    const [id] = await registerCandidates([hit()], WS)
    expect(id).toBeTruthy()
    const lu = await readCandidate(id, WS)
    if (lu.ok === false) throw new Error('candidat illisible')
    expect(lu.candidate.claim.v2).toEqual(v2Funding())
    expect(hitFromCandidate(lu.candidate).v2).toEqual(v2Funding())
  })

  it('V2 malformé ⇒ AUCUN candidat émis — jamais dépouillé pour continuer en V1', async () => {
    const abime = hit()
    ;(abime.v2 as any).payload = { family: 'FUNDING' } // roundStage manquant
    const [id] = await registerCandidates([abime], WS)
    expect(id).toBeNull()
  })

  it('identité héritée V1 inchangée octet pour octet — verrou littéral', () => {
    const claim = {
      company: 'Acme', signalType: 'levée' as const, sourceUrl: 'https://acme.fr/presse/serie-a',
      claimNature: 'EVENT' as const, eventStatus: 'COMPLETED' as const,
      eventDate: JOUR_FAIT, eventDatePrecision: 'DAY' as const, sourcePublishedAt: null,
      roleStatus: 'UNKNOWN' as const, roleFunction: 'UNKNOWN' as const,
      candidateSiren: '552100554', v2: null,
    }
    expect(candidateId(claim, WS)).toBe('cand_10ce702f3c0b7ce8f0a8fbb00eebb2bd')
  })

  it('une ligne HÉRITÉE sans champ v2 reste lisible, relue avec v2 = null', async () => {
    const claim: any = {
      company: 'Acme', signalType: 'levée', sourceUrl: 'https://acme.fr/presse/serie-a',
      claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: JOUR_FAIT,
      eventDatePrecision: 'DAY', sourcePublishedAt: null,
      roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN', candidateSiren: '552100554',
    }
    const id = 'cand_10ce702f3c0b7ce8f0a8fbb00eebb2bd'
    await upsertItem(SIGNAL_CANDIDATE_KIND, id, { id, claim, issuedAt: OBSERVED }, WS)
    const lu = await readCandidate(id, WS)
    if (lu.ok === false) throw new Error('ligne héritée illisible')
    expect(lu.candidate.claim.v2).toBeNull()
  })

  it('le bloc V2 est SIGNÉ : un fait différent rend un identifiant différent', async () => {
    const a = hit()
    const b = hitV2('https://acme.fr/presse/fait', v2Funding({
      amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' },
    }), { siren: '552100554' })
    const [ia] = await registerCandidates([a], WS)
    const [ib] = await registerCandidates([b], WS)
    expect(ia).not.toBe(ib)
  })

  it('SourceEvidence porte le V2 du hit, sans reconstruction', () => {
    const s = sourceA(v2Funding())
    expect(s.hit.v2).toEqual(v2Funding())
  })
})

// ═══ PART 4/6 — MAPPING V2 & PROJECTION EVIDENCE ════════════════════════════

describe('mapClaim V2 — fermé, sans prose, sans repli', () => {
  it('FUNDING → recent_funding ; EXECUTIVE → executive_appointment/departure ; HIRING → sales_hiring', () => {
    expect(mapClaim(hitV2('https://x.fr/a', v2Funding()))).toEqual({
      type: 'recent_funding', temporality: 'dated_event', occurredAt: JOUR_FAIT,
    })
    expect(mapClaim(hitV2('https://x.fr/a', v2Exec()))).toEqual({
      type: 'executive_appointment', temporality: 'dated_event', occurredAt: JOUR_FAIT,
    })
    expect(mapClaim(hitV2('https://x.fr/a', v2Exec({ direction: 'DEPARTURE' })))).toEqual({
      type: 'executive_departure', temporality: 'dated_event', occurredAt: JOUR_FAIT,
    })
    expect(mapClaim(hitV2('https://x.fr/a', v2Hiring(15)))).toEqual({
      type: 'sales_hiring', temporality: 'undated_state',
    })
  })

  it('direction UNKNOWN ⇒ refus AVANT toute evidence — fail closed', () => {
    expect(mapClaim(hitV2('https://x.fr/a', v2Exec({ direction: 'UNKNOWN' })))).toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('V2 présent mais malformé ⇒ refus, JAMAIS un repli sur le chemin V1', () => {
    const h = hitV2('https://x.fr/a', v2Funding()) // champs V1 parfaitement mappables
    ;(h.v2 as any).family = 'EXECUTIVE_CHANGE' // discriminants incohérents
    expect(mapClaim(h)).toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('ANNOUNCED_FUTURE V2 ⇒ INTENT_NOT_REALIZED ; recrutement non-Sales ⇒ refus', () => {
    expect(mapClaim(hitV2('https://x.fr/a', v2Funding({}, { eventStatus: 'ANNOUNCED_FUTURE' }))))
      .toBe('INTENT_NOT_REALIZED')
    const tech = v2Hiring(3)
    ;(tech.payload as any).roleFunction = 'TECH'
    expect(mapClaim(hitV2('https://x.fr/a', tech))).toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('l’evidence porte le fait structuré de la source PRINCIPALE, validé à la relecture', async () => {
    const { evidence } = await chaine([sourceA(v2Funding())], `recent_funding|${COMPTE}|${JOUR_FAIT}`)
    expect((evidence as any).structuredFact).toEqual(v2Funding())
    expect(isEvidenceEvent(evidence)).toBe(true)
    const abime = { ...evidence, structuredFact: { contractVersion: 'v2' } }
    expect(isEvidenceEvent(abime)).toBe(false)
    const herite = { ...evidence } as any
    delete herite.structuredFact
    expect(isEvidenceEvent(herite)).toBe(true)
  })
})

// ═══ R1–R9 — VERSIONNEMENT PAR CONTENU SÉMANTIQUE ══════════════════════════

describe('assertions versionnées par contenu (arbitrage A)', () => {
  const CLE = `recent_funding|${COMPTE}|${JOUR_FAIT}`

  function assertionsDe(sources: SourceEvidence[]) {
    const r = promoteToEvidence({
      accountId: COMPTE, observedAt: OBSERVED, sources,
      confirmations: [confirme(sources.map((s) => s.url), CLE)],
    })
    if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
    return buildSourceAssertions({
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
      evidence: r.evidence, qualifyingSources: r.qualifyingSources,
    })
  }

  it('R1 — rejeu inchangé (autre instant de récupération) : UNE assertion', async () => {
    const [a] = assertionsDe([sourceA(v2Funding())])
    const [b] = assertionsDe([sourceDe(hitV2('https://acme.fr/presse/fait', v2Funding()),
      { site: 'https://acme.fr', retrievedAt: '2026-08-19T22:00:00.000Z' })])
    expect(a.id).toBe(b.id) // ⚠️ retrievedAt n'entre PAS dans l'identité d'un événement
    const r1 = await recordSourceAssertions([{ workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE, evidence: { id: 'x', type: 'recent_funding', temporality: 'dated_event', observedAt: OBSERVED } as any, qualifyingSources: [sourceA(v2Funding())] }], WS)
    expect(r1.created).toBe(1)
  })

  it('R2 — CORRECTION ÉDITORIALE 10M€ → 12M€, même URL : DEUX assertions, les deux instantanés durables', async () => {
    const dixM = v2Funding({ amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' } })
    const [a10] = assertionsDe([sourceA(dixM)])
    const [a12] = assertionsDe([sourceA(v2Funding())])
    expect(a10.sourceUrl).toBe(a12.sourceUrl)
    expect(a10.id).not.toBe(a12.id)

    const r = await chaine([sourceA(dixM)], CLE)
    expect(r.bilan.created).toBe(1)
    const r2 = await chaine([sourceA(v2Funding())], CLE)
    expect(r2.bilan.created).toBe(1) // pas « existing » : c'est une NOUVELLE assertion
    const rows = await lignes(SOURCE_ASSERTION_KIND)
    const montants = rows.map((x) => x.structuredFact.payload.amount.amountMinor).sort()
    expect(montants).toEqual([1_000_000_000, 1_200_000_000]) // le registre retient LES DEUX
  })

  it('R3 — même fait sémantique, prose d’audit différente : UNE assertion', () => {
    const autreProse = v2Funding({}, { rawDetail: { detail: 'communiqué réécrit', icebreaker: 'autre' } })
    const [a] = assertionsDe([sourceA(v2Funding())])
    const [b] = assertionsDe([sourceA(autreProse)])
    expect(a.id).toBe(b.id)
  })

  it('R4 — tableau d’investisseurs réordonné : même version sémantique', () => {
    const deux = [
      { nameRaw: 'Index Ventures', role: 'LEAD' },
      { nameRaw: 'Accel', role: 'PARTICIPANT' },
    ]
    const h1 = assertedFactHash(v2Funding({ investors: deux }), COMPTE)
    const h2 = assertedFactHash(v2Funding({ investors: [...deux].reverse() }), COMPTE)
    expect(h1).toBe(h2)
  })

  it('R5 — Index LEAD → PARTICIPANT : DEUX assertions (le rôle est sémantique)', () => {
    const [a] = assertionsDe([sourceA(v2Funding())])
    const [b] = assertionsDe([sourceA(v2Funding({ investors: [{ nameRaw: 'Index Ventures', role: 'PARTICIPANT' }] }))])
    expect(a.id).not.toBe(b.id)
  })

  it('R6/R7/R8 — états : même jour + décompte changé ⇒ DEUX ; rejeu même jour ⇒ UNE ; autre jour ⇒ DEUX', () => {
    const etat = (v: number, retrievedAt = RECUPERE) => {
      const r = promoteToEvidence({
        accountId: COMPTE, observedAt: OBSERVED,
        sources: [sourceDe(hitV2('https://acme.fr/carrieres', v2Hiring(v)), { site: 'https://acme.fr', retrievedAt })],
        confirmations: [confirme(['https://acme.fr/carrieres'], `sales_hiring|${COMPTE}|STATE`)],
      })
      if (r.ok === false) throw new Error(r.reason)
      return buildSourceAssertions({
        workspaceId: WS, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
        evidence: r.evidence, qualifyingSources: r.qualifyingSources,
      })[0]
    }
    expect(etat(15).id).not.toBe(etat(16).id) // R6 — le décompte est dans la version
    expect(etat(15).id).toBe(etat(15, '2026-08-13T21:00:00.000Z').id) // R7 — même jour, même fait
    expect(etat(15).id).not.toBe(etat(15, '2026-08-27T07:30:00.000Z').id) // R8 — l'historique d'observation
    expect(etat(15).structuredFact!.payload).toMatchObject({ openingsObserved: { value: 15 } })
  })

  it('R9 — chemin V1 (sans v2) : algorithme et champs STRICTEMENT inchangés', () => {
    const sansV2 = hitV2('https://acme.fr/presse/fait', v2Funding())
    delete (sansV2 as any).v2
    const r = promoteToEvidence({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [sourceDe(sansV2, { site: 'https://acme.fr' })],
      confirmations: [confirme(['https://acme.fr/presse/fait'], CLE)],
    })
    if (r.ok === false) throw new Error(r.reason)
    const [a] = buildSourceAssertions({
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE,
      evidence: r.evidence, qualifyingSources: r.qualifyingSources,
    })
    expect(a.id).toBe(sourceAssertionId(WS, CLE, 'https://acme.fr/presse/fait'))
    expect(a.structuredFact).toBeUndefined()
    expect(a.assertedFactHash).toBeUndefined()
    expect((r.evidence as any).structuredFact).toBeUndefined()
  })

  it('garde de forme : instantané et condensat vont ENSEMBLE, et le condensat est recalculé', () => {
    const [a] = assertionsDe([sourceA(v2Funding())])
    expect(isSourceAssertion(a)).toBe(true)
    expect(isSourceAssertion({ ...a, structuredFact: undefined })).toBe(false) // condensat orphelin
    expect(isSourceAssertion({ ...a, assertedFactHash: undefined })).toBe(false) // instantané non vérifiable
    const substitue = JSON.parse(JSON.stringify(a))
    substitue.structuredFact.payload.amount.amountMinor = 999
    expect(isSourceAssertion(substitue)).toBe(false) // fait substitué sous une identité existante
  })

  it('§9 durabilité — une version ANTÉRIEURE à la même URL ne rend jamais durable une version CHANGÉE', async () => {
    const dixM = v2Funding({ amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' } })
    const r10 = await chaine([sourceA(dixM)], CLE)
    const [a12] = assertionsDe([sourceA(v2Funding())])
    expect(r10.bilan.durableIds).not.toContain(a12.id)
    const r12 = await chaine([sourceA(v2Funding())], CLE)
    expect(r12.bilan.durableIds).toEqual([a12.id]) // exactement LA version écrite, pas l'URL
  })

  it('§10 doctrine — le nombre d’assertions N’EST PAS le nombre de sources indépendantes', async () => {
    const dixM = v2Funding({ amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' } })
    await chaine([sourceA(dixM)], CLE)                       // URL A, version 10M
    await chaine([sourceA(v2Funding())], CLE)                // URL A, version 12M
    await chaine([sourceA(v2Funding(), '/presse/b')], CLE)   // URL B, version 12M
    const rows = await lignes(SOURCE_ASSERTION_KIND)
    expect(rows.length).toBe(3)
    expect(new Set(rows.map((r) => r.sourceUrl)).size).toBe(2)
    // ⚠️ Toute future confiance de fait doit compter des URL (ou éditeurs)
    // distinctes, jamais des lignes. Et rien en production ne compte les lignes
    // du registre comme des éditeurs : le Bridge n'importe pas le registre.
    const bridge = readFileSync(join(process.cwd(), 'lib/prospector/proactive/signalBridge.ts'), 'utf8')
    expect(bridge).not.toMatch(/from '\.\/sourceAssertion'/)
  })
})

// ═══ PART 8/9 — LES TROIS E2E + DÉSACCORD MULTI-SOURCES ═════════════════════

describe('E2E factual memory', () => {
  it('E2E-1 FUNDING — candidat → evidence → assertion durable → CanonicalEvent, identité insensible au montant', async () => {
    const [cid] = await registerCandidates(
      [hitV2('https://acme.fr/presse/fait', v2Funding(), { siren: '552100554' })], WS,
    )
    const lu = await readCandidate(cid, WS)
    if (lu.ok === false) throw new Error('candidat illisible')
    const hit = { ...hitFromCandidate(lu.candidate), sourceUrl: 'https://acme.fr/presse/fait' }
    const { bilan, ancres } = await chaine(
      [sourceDe(hit as SignalHit, { site: 'https://acme.fr', retrievedAt: lu.candidate.issuedAt })],
      `recent_funding|${COMPTE}|${JOUR_FAIT}`,
    )
    expect(bilan.created).toBe(1)
    expect(ancres.created).toBe(1)
    const [ev] = await lignes(CANONICAL_EVENT_KIND)
    expect(ev.type).toBe('FUNDING_ROUND')
    expect(ev.id).toBe(canonicalEventId(WS, COMPTE, JOUR_FAIT))
    // ⚠️ NI montant NI investisseur dans l'identité : la version 10M€ ancre le MÊME fait.
    const dixM = v2Funding({ amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' }, investors: [] })
    const r2 = await chaine([sourceA(dixM)], `recent_funding|${COMPTE}|${JOUR_FAIT}`)
    expect(r2.ancres.existing).toBe(1)
    expect((await lignes(CANONICAL_EVENT_KIND)).length).toBe(1)
  })

  it('E2E-2 EXECUTIVE — Marie Dupont CRO : assertion durable, evidence, CanonicalEvent EXECUTIVE_APPOINTMENT scopé au compte', async () => {
    const { evidence, bilan, ancres } = await chaine(
      [sourceA(v2Exec())], `executive_appointment|${COMPTE}|${JOUR_FAIT}`,
    )
    expect(evidence.type).toBe('executive_appointment')
    expect(bilan.created).toBe(1)
    expect(ancres.created).toBe(1)
    const [ev] = await lignes(CANONICAL_EVENT_KIND)
    expect(ev.type).toBe('EXECUTIVE_APPOINTMENT')
    expect(ev.personKey).toBe(`name:marie dupont@${COMPTE}`) // NAME_ONLY, scopé au compte
    expect(ev.id).toBe(canonicalExecutiveEventId(WS, 'EXECUTIVE_APPOINTMENT', COMPTE, 'SALES', `name:marie dupont@${COMPTE}`, JOUR_FAIT))
    // ⚠️ NI intitulé NI séniorité dans l'identité : un autre titre/une autre
    // séniorité versionne l'ASSERTION, jamais l'ancre.
    const autre = v2Exec({ roleSeniority: 'VP_DIRECTOR', roleTitleRaw: 'CRO' })
    const r2 = await chaine([sourceA(autre)], `executive_appointment|${COMPTE}|${JOUR_FAIT}`)
    expect(r2.bilan.created).toBe(1) // séniorité = version sémantique nouvelle
    expect(r2.ancres.existing).toBe(1) // …mais LA MÊME ancre
    expect((await lignes(CANONICAL_EVENT_KIND)).length).toBe(1)
  })

  it('E2E-2b — direction UNKNOWN n’ancre JAMAIS, même si un type exécutif est forgé en aval', () => {
    const fait = v2Exec({ direction: 'UNKNOWN' })
    const anchors = buildCanonicalAnchors({
      workspaceId: WS, accountId: COMPTE,
      canonicalClaimKey: `executive_appointment|${COMPTE}|${JOUR_FAIT}`,
      evidence: { id: 'ev_forge', type: 'executive_appointment', temporality: 'dated_event', occurredAt: JOUR_FAIT, observedAt: OBSERVED } as any,
      qualifyingSources: [sourceA(fait)],
      durableAssertionIds: new Set(
        buildSourceAssertions({
          workspaceId: WS, accountId: COMPTE,
          canonicalClaimKey: `executive_appointment|${COMPTE}|${JOUR_FAIT}`,
          evidence: { id: 'ev_forge', type: 'executive_appointment', temporality: 'dated_event', occurredAt: JOUR_FAIT, observedAt: OBSERVED } as any,
          qualifyingSources: [sourceA(fait)],
        }).map((a) => a.id),
      ),
    })
    expect(anchors.execEvents).toEqual([])
  })

  it('E2E-3 HIRING — 15 → 22 → 8 : trois assertions durables gardant CHACUNE son décompte, trois instantanés canoniques', async () => {
    const CLE = `sales_hiring|${COMPTE}|STATE`
    const jours: Array<[number, string]> = [
      [15, '2026-08-13T07:30:00.000Z'], [22, '2026-08-27T07:30:00.000Z'], [8, '2026-09-11T07:30:00.000Z'],
    ]
    for (const [v, ra] of jours) {
      const r = await chaine(
        [sourceDe(hitV2('https://acme.fr/carrieres', v2Hiring(v)), { site: 'https://acme.fr', retrievedAt: ra })], CLE,
      )
      expect(r.bilan.created).toBe(1)
      expect(r.ancres.created).toBe(1)
    }
    const rows = await lignes(SOURCE_ASSERTION_KIND)
    expect(rows.map((r) => r.structuredFact.payload.openingsObserved.value).sort((a, b) => a - b)).toEqual([8, 15, 22])
    expect((await lignes(CANONICAL_STATE_SNAPSHOT_KIND)).length).toBe(3)
    // ⚠️ AUCUNE interprétation : pas d'accélération, pas de Situation — le
    // registre CONSTATE, il ne conclut pas. Et le décompte n'entre pas dans
    // l'identité de l'instantané : 15 et 16 le même jour = MÊME instantané.
    const memesJours = await chaine(
      [sourceDe(hitV2('https://acme.fr/carrieres', v2Hiring(16)), { site: 'https://acme.fr', retrievedAt: '2026-08-13T20:00:00.000Z' })], CLE,
    )
    expect(memesJours.bilan.created).toBe(1) // nouvelle VERSION d'assertion
    expect(memesJours.ancres.existing).toBe(1) // même ancre d'état
  })

  it('PART 9 — désaccord 10M€ / 12M€ entre DEUX URL : deux assertions, UNE ancre FUNDING_ROUND', async () => {
    const CLE = `recent_funding|${COMPTE}|${JOUR_FAIT}`
    const dixM = v2Funding({ amount: { amountMinor: 1_000_000_000, currency: 'EUR', asPublished: '€10M' } })
    const { bilan, ancres } = await chaine(
      [sourceA(dixM, '/presse/a'), sourceA(v2Funding(), '/presse/b')], CLE,
    )
    expect(bilan.created).toBe(2)
    const rows = await lignes(SOURCE_ASSERTION_KIND)
    expect(rows.map((r) => r.structuredFact.payload.amount.amountMinor).sort()).toEqual([1_000_000_000, 1_200_000_000])
    expect(ancres.created).toBe(1)
    expect((await lignes(CANONICAL_EVENT_KIND)).length).toBe(1) // JAMAIS un second événement par montant
  })

  it('isolation : une entrée d’ancrage inexploitable ne jette jamais', async () => {
    const r = await recordCanonicalAnchors([{ workspaceId: WS } as any], WS, new Set())
    expect(r).toEqual({ created: 0, existing: 0, failed: 0 })
  })
})
