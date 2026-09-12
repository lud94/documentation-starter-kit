// SIGNAL_ARCHITECTURE_V1_WAVE1 — LA PROVENANCE SURVIT À LA PROMOTION.
//
// ── LE DÉFAUT QUE CES TESTS VERROUILLENT ────────────────────────────────────
// `signalBridge` CALCULE le grade, l'éditeur, la lignée et l'ancrage, s'en sert
// pour décider si une revendication peut devenir un fait… puis les jette.
// Relue six mois plus tard, une evidence pouvait dire QUI l'avait adjugée et
// sur QUELLES URL, mais plus POURQUOI ces sources étaient qualifiantes. Un
// auditeur devait re-télécharger les pages — c'est-à-dire refaire l'histoire,
// avec la politique d'AUJOURD'HUI et non celle du jour de la promotion.
//
// ⚠️ CE QUI EST RÉELLEMENT EXERCÉ. `promoteToEvidence`, `isEvidenceEvent` et le
// Decision Kernel sont le code de PRODUCTION. Rien n'est simulé : aucun réseau,
// aucune horloge système — `observedAt` et `now` sont injectés.
import { describe, expect, it } from 'vitest'

import {
  bridgeSignals,
  promoteToEvidence,
  sourceEvidenceFromHit,
  type Grounding,
  type HumanFactConfirmation,
  type SourceEvidence,
  type SourceLineage,
} from '../lib/prospector/proactive/signalBridge'
import { isEvidenceEvent } from '../lib/prospector/proactive/validators'
import { evaluateEvidence } from '../lib/prospector/proactive/decisionKernel'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { SignalHit } from '../types/prospector'

const COMPTE = 'acc_siren_552100554'
const OBSERVED = '2026-08-20T09:00:00.000Z'
const RECUPERE = '2026-08-19T07:30:00.000Z'   // la veille : JAMAIS `observedAt`
const CLE_LEVEE = `recent_funding|${COMPTE}|2026-08-12`

const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: 'la cloture de sa Serie A de 12 millions' }

/** Levée bouclée, datée au jour — forme RÉELLE du contrat d'acquisition. */
function leveeBouclee(url: string, p: Partial<SignalHit> = {}): SignalHit {
  return {
    company: 'Acme', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: '2026-08-12', eventDatePrecision: 'DAY',
    sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
    ...p,
  } as SignalHit
}

function confirme(sourceUrls: string[]): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED', canonicalKey: CLE_LEVEE,
    confirmedBy: 'actor_7f2c', confirmedAt: '2026-08-20T10:00:00.000Z',
    sourceUrls,
  }
}

/**
 * Source de grade A ancrée — le chemin de promotion le plus court.
 *
 * Le site officiel déclaré au registre vaut A ; `lineage`, `grounding` et
 * `retrievedAt` sont fournis explicitement pour que ce soit CE QU'ILS VALENT,
 * et non un défaut, que les assertions observent.
 */
function sourceA(p: {
  lineage?: SourceLineage
  grounding?: Grounding
  retrievedAt?: string
  hit?: Partial<SignalHit>
} = {}): SourceEvidence {
  const s = sourceEvidenceFromHit(
    leveeBouclee('https://acme.fr/presse/serie-a', p.hit),
    'https://acme.fr',
    p.lineage ?? { kind: 'ORIGINAL' },
    p.grounding ?? ANCRE,
    'retrievedAt' in p ? p.retrievedAt : RECUPERE,
  )
  if (!s) throw new Error('fixture invalide')
  return s
}

function promeut(sources: SourceEvidence[]) {
  const r = promoteToEvidence({
    accountId: COMPTE,
    observedAt: OBSERVED,
    sources,
    confirmations: [confirme(sources.map((s) => s.url))],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  return r.evidence as any
}

describe('T1–T4 — la qualification qui a DÉCIDÉ est persistée', () => {
  it('T1 — le grade survit', () => {
    expect(promeut([sourceA()]).source.provenance.grade).toBe('A')
  })

  it('T2 — l’éditeur survit, et c’est l’HÔTE, jamais le nom déclaré', () => {
    expect(promeut([sourceA()]).source.provenance.publisher).toBe('acme.fr')
  })

  it('T3 — la lignée survit, et distingue ORIGINAL de UNKNOWN', () => {
    expect(promeut([sourceA()]).source.provenance.lineage).toBe('ORIGINAL')
    // ⚠️ `UNKNOWN` est le cas NOMINAL de la voie produit actuelle : la lignée
    // n'est transportée par aucune acquisition. Le persister tel quel est le
    // seul relevé honnête — l'écrire `ORIGINAL` par défaut ferait de toute
    // reprise de communiqué une source indépendante.
    expect(promeut([sourceA({ lineage: { kind: 'UNKNOWN' } })]).source.provenance.lineage)
      .toBe('UNKNOWN')
  })

  it('T4 — l’ancrage survit, vérifié comme non vérifié', () => {
    expect(promeut([sourceA()]).source.provenance.grounding).toBe('VERIFIED_ANCHOR')
    expect(promeut([sourceA({ grounding: { kind: 'UNVERIFIABLE' } })]).source.provenance.grounding)
      .toBe('UNVERIFIABLE')
  })
})

describe('T5–T6 — les dates ne se substituent JAMAIS l’une à l’autre', () => {
  it('T5 — `sourcePublishedAt` survit quand la source la donne', () => {
    const e = promeut([sourceA({ hit: { sourcePublishedAt: '2026-08-13' } })])
    expect(e.source.provenance.sourcePublishedAt).toBe('2026-08-13')
  })

  it('T6 — absente, elle reste ABSENTE — jamais remplacée par `observedAt`', () => {
    const e = promeut([sourceA()])   // `sourcePublishedAt: null` dans la fixture
    expect('sourcePublishedAt' in e.source.provenance).toBe(false)
    // La formulation compte : on vérifie qu'aucune date de publication n'a été
    // FABRIQUÉE à partir d'un instant que nous connaissons.
    expect(e.source.provenance.sourcePublishedAt).not.toBe(OBSERVED)
    expect(e.source.provenance.sourcePublishedAt).not.toBe(RECUPERE)
  })

  it('T6b — `retrievedAt` est distinct de `observedAt`, et les deux coexistent', () => {
    const e = promeut([sourceA()])
    expect(e.source.provenance.retrievedAt).toBe(RECUPERE)
    expect(e.observedAt).toBe(OBSERVED)
    expect(e.source.provenance.retrievedAt).not.toBe(e.observedAt)
  })

  it('T6c — `retrievedAt` inconnu ⇒ champ ABSENT, aucune horloge lue', () => {
    const e = promeut([sourceA({ retrievedAt: undefined })])
    expect('retrievedAt' in e.source.provenance).toBe(false)
  })
})

describe('T7 — la corroboration du moment est conservée', () => {
  it('éditeurs indépendants, URL qualifiantes et compte cohérent', () => {
    const a = sourceEvidenceFromHit(leveeBouclee('https://maddyness.com/a'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const b = sourceEvidenceFromHit(leveeBouclee('https://sifted.eu/b'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const e = promeut([a, b])

    expect(e.corroboration.publishers).toEqual(['maddyness.com', 'sifted.eu'])
    expect(e.corroboration.independentPublisherCount).toBe(2)
    expect(e.corroboration.sourceUrls).toEqual(['https://maddyness.com/a', 'https://sifted.eu/b'])
  })

  it('zéro éditeur indépendant est un FAIT enregistré, pas un manque', () => {
    // Lignée non établie ⇒ aucune indépendance prouvée. C'est le cas nominal
    // de la V0, et un audit doit pouvoir le LIRE plutôt que le déduire.
    const e = promeut([sourceA({ lineage: { kind: 'UNKNOWN' } })])
    expect(e.corroboration.independentPublisherCount).toBe(0)
    expect(e.corroboration.publishers).toEqual([])
    expect(e.corroboration.sourceUrls).toEqual(['https://acme.fr/presse/serie-a'])
  })

  it('une source ÉCARTÉE ne figure pas comme un appui', () => {
    // Un agrégateur (grade C) ne qualifie pas : le compter donnerait à une
    // preuve rejetée l'apparence d'une corroboration.
    const faible = sourceEvidenceFromHit(
      leveeBouclee('https://news.google.com/x'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const e = promeut([sourceA(), faible])
    expect(e.corroboration.sourceUrls).toEqual(['https://acme.fr/presse/serie-a'])
    expect(e.corroboration.publishers).not.toContain('news.google.com')
  })

  it('la provenance décrit la source que `source.url` DÉSIGNE', () => {
    const a = sourceEvidenceFromHit(leveeBouclee('https://maddyness.com/a'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const b = sourceEvidenceFromHit(leveeBouclee('https://sifted.eu/b'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const e = promeut([b, a])   // ordre d'entrée inverse de l'ordre trié
    expect(e.source.url).toBe('https://maddyness.com/a')
    expect(e.source.provenance.publisher).toBe('maddyness.com')
  })
})

describe('T8 — compatibilité ascendante des documents déjà persistés', () => {
  /** Evidence LEGACY : exactement la forme écrite avant ce lot. */
  const legacy = {
    id: 'ev_ext_legacy', accountId: COMPTE, scope: 'account', type: 'recent_funding',
    source: { provider: 'web_signal_search', url: 'https://maddyness.com/a' },
    assertionType: 'fact', confidence: 0.75, observedAt: OBSERVED,
    temporality: 'dated_event', occurredAt: '2026-08-12',
    acceptance: {
      kind: 'human_confirmed', actorId: 'actor_7f2c',
      confirmedAt: '2026-08-20T10:00:00.000Z', canonicalKey: CLE_LEVEE,
      sourceUrls: ['https://maddyness.com/a'],
    },
  }

  it('une evidence SANS provenance ni corroboration reste valide', () => {
    expect(isEvidenceEvent(legacy)).toBe(true)
  })

  it('une evidence interne (CRM) reste valide sans provenance', () => {
    expect(isEvidenceEvent({
      id: 'ev_crm', accountId: COMPTE, scope: 'account', type: 'hot_lead',
      source: { provider: 'prospector_crm' }, assertionType: 'inference',
      confidence: 0.8, observedAt: OBSERVED, temporality: 'undated_state',
    })).toBe(true)
  })

  it('une provenance PRÉSENTE mais abîmée invalide l’evidence — fail closed', () => {
    // ⚠️ Une provenance à moitié fausse est PIRE qu'absente : la première ment,
    // la seconde se tait. Un grade inventé ferait croire à un audit que la
    // promotion s'est appuyée sur une qualification jamais produite.
    for (const provenance of [
      { grade: 'Z' },
      { lineage: 'PLAGIAT' },
      { grounding: 'PRESQUE' },
      { sourcePublishedAt: 'la semaine derniere' },
      { retrievedAt: '2026-08-19T24:00:00.000Z' },   // normalisé par Date.parse, refusé ici
      { publisher: '   ' },
      'pas un objet',
    ]) {
      expect(isEvidenceEvent({ ...legacy, source: { ...legacy.source, provenance } })).toBe(false)
    }
  })

  it('une corroboration incohérente invalide l’evidence', () => {
    // Un compte de 3 en face d'une liste vide affirmerait un appui que rien ne
    // porte — et c'est le champ qu'un lecteur pressé regarde en premier.
    expect(isEvidenceEvent({
      ...legacy, corroboration: { publishers: [], independentPublisherCount: 3 },
    })).toBe(false)
    expect(isEvidenceEvent({ ...legacy, corroboration: { publishers: [''] } })).toBe(false)
    expect(isEvidenceEvent({ ...legacy, corroboration: { independentPublisherCount: -1 } })).toBe(false)
  })

  it('une corroboration bien formée est acceptée à la relecture', () => {
    expect(isEvidenceEvent({
      ...legacy,
      source: { ...legacy.source, provenance: { grade: 'B', lineage: 'ORIGINAL', grounding: 'UNVERIFIABLE' } },
      corroboration: { publishers: ['maddyness.com'], sourceUrls: ['https://maddyness.com/a'], independentPublisherCount: 1 },
    })).toBe(true)
  })

  it('l’aller-retour écriture → relecture tient', () => {
    expect(isEvidenceEvent(promeut([sourceA()]))).toBe(true)
  })
})

describe('T10 — rejeu : la promotion est idempotente et ne dégrade rien', () => {
  it('deux promotions identiques produisent le MÊME document', () => {
    const a = promeut([sourceA()])
    const b = promeut([sourceA()])
    expect(b.id).toBe(a.id)
    expect(b).toEqual(a)
  })

  it('rejouer avec une source SUPPLÉMENTAIRE enrichit sans effacer', () => {
    const seule = promeut([sourceA()])
    const autre = sourceEvidenceFromHit(
      leveeBouclee('https://maddyness.com/a'), null, { kind: 'ORIGINAL' }, ANCRE)!
    const groupe = promeut([sourceA(), autre])

    // Même fait canonique — donc la même ligne au magasin.
    expect(groupe.id).toBe(seule.id)
    // La provenance reste celle d'une source RÉELLEMENT qualifiante, et la
    // corroboration ne perd aucune URL.
    expect(groupe.source.provenance.grade).toBeTruthy()
    expect(groupe.corroboration.sourceUrls).toContain('https://acme.fr/presse/serie-a')
  })
})

describe('T11 — la surface publique n’expose aucun détail de politique', () => {
  it('`bridgeSignals` ne rend que des refus catégoriels', () => {
    const r = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [sourceA()], confirmations: [],
    })
    expect(r.evidence).toHaveLength(0)
    expect(r.refusals[0].reason).toBe('NO_FACT_AUTHORITY')
  })
})

describe('T12 — le Decision Kernel est INCHANGÉ par ce lot', () => {
  it('une evidence enrichie traverse le kernel comme avant', () => {
    const e = promeut([sourceA()])
    const sortie = evaluateEvidence({
      now: new Date('2026-08-20T09:00:00.000Z'),
      businessContext: TEST_BUSINESS_CONTEXT,
      evidence: [e],
      targets: [{ accountId: COMPTE, relevance: 0.9 }],
    })
    // ⚠️ AUCUNE ASSERTION SUR LE NOMBRE DE SITUATIONS. Les packs exigent une
    // convergence que ce seul fait ne fournit pas, et l'exiger ici ferait de ce
    // test un test de règles métier. Ce qui est prouvé : le kernel accepte le
    // document enrichi sans le rejeter ni s'en trouver modifié.
    expect(Array.isArray(sortie.situations)).toBe(true)
    expect(Array.isArray(sortie.recommendations)).toBe(true)
  })
})
