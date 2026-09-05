// SIGNAL-EVIDENCE-BRIDGE-001 — DU SIGNAL EXTERNE AU KERNEL.
//
// ⚠️ CE QUI EST RÉELLEMENT PROUVÉ ICI. Le test décisif n'est pas qu'un
// `SignalHit` devienne un `EvidenceEvent` : c'est qu'il ATTEIGNE le moteur de
// décision de production et en ressorte une Situation réelle. Un Bridge qui
// s'arrête à l'objet intermédiaire produit du code sans appelant — le défaut
// exact que cet audit avait relevé sur le Kernel lui-même.
//
// Aucun réseau. Aucune horloge système : `now` et `observedAt` sont injectés.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0,
  bridgeSignals,
  canonicalKey,
  externalEvidenceId,
  gradeForSource,
  groupSourcesByClaim,
  independentPublishers,
  mapClaim,
  claimSubject,
  groundingFor,
  isHumanFactConfirmation,
  qualifyingSources,
  materialContradiction,
  promoteToEvidence,
  sourceEvidenceFromHit,
  sourcePolicyPasses,
  verifyAnchor,
  type Grounding,
  type HumanFactConfirmation,
  type SourceEvidence,
  type SourceLineage,
} from '../lib/prospector/proactive/signalBridge'
import { evaluate, persistEvaluation } from '../lib/prospector/proactive/orchestrator'
import { isResolvedSignalImportResult } from '../lib/prospector/capabilities'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { Lead, SignalHit } from '../types/prospector'

const NOW = new Date('2026-08-20T09:00:00.000Z')
const OBSERVED = '2026-08-20T09:00:00.000Z'
const COMPTE = 'acc_siren_552100554'

/** `SignalHit` de forme RÉELLE : tous les champs du contrat d'acquisition. */
function hit(p: Partial<SignalHit> = {}): SignalHit {
  return {
    company: 'Acme',
    signalType: 'autre',
    detail: '',
    icebreaker: '',
    sourceUrl: 'https://maddyness.com/a',
    verified: false,
    claimNature: 'UNKNOWN',
    eventStatus: 'UNKNOWN',
    eventDate: null,
    eventDatePrecision: 'UNKNOWN',
    sourcePublishedAt: null,
    roleStatus: 'UNKNOWN',
    roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
    ...p,
  } as SignalHit
}

/** Levée bouclée, datée au jour. */
function leveeBouclee(url: string, p: Partial<SignalHit> = {}): SignalHit {
  return hit({
    signalType: 'levée',
    sourceUrl: url,
    claimNature: 'EVENT',
    eventStatus: 'COMPLETED',
    eventDate: '2026-08-12',
    eventDatePrecision: 'DAY',
    ...p,
  })
}

/** Poste Sales actuellement ouvert. */
function posteSalesOuvert(url: string, p: Partial<SignalHit> = {}): SignalHit {
  return hit({
    signalType: 'recrutement',
    sourceUrl: url,
    claimNature: 'STATE',
    roleStatus: 'OPEN',
    roleFunction: 'SALES',
    ...p,
  })
}

/**
 * Matière source réellement capturée par l'application (voie `exa+claude`).
 * L'ancrage ci-dessous en est un extrait VERBATIM.
 */
const TEXTE_CAPTURE =
  "Acme annonce ce jour la cloture de sa Serie A de 12 millions d'euros, " +
  "menee par un fonds europeen. L'entreprise recrute par ailleurs un Account Executive."
const ANCRAGE = "la cloture de sa Serie A de 12 millions d'euros"

/** Ancrage VÉRIFIÉ par défaut : les tests de promotion portent sur autre chose. */
const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: ANCRAGE }

/** Clés canoniques des deux revendications employées par les tests. */
const CLE_LEVEE = `recent_funding|${COMPTE}|2026-08-12`
const CLE_POSTE = `sales_hiring|${COMPTE}|STATE`

/**
 * Adjudication humaine LIÉE à une revendication et aux sources examinées.
 * Seule autorité disponible en V0.
 */
function confirme(canonicalKey: string, sourceUrls: string[]): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED',
    canonicalKey,
    confirmedBy: 'actor_7f2c',
    confirmedAt: '2026-08-20T10:00:00.000Z',
    sourceUrls,
  }
}

/**
 * Confirmations couvrant CHAQUE revendication du lot, avec ses propres URL.
 *
 * ⚠️ Dérivées des sources réelles, jamais posées à la main : une confirmation
 * doit désigner la revendication qu'elle adjuge ET les sources examinées. Un
 * jeu de confirmations global figé masquerait précisément le défaut que R1c
 * corrige.
 */
function confirmationsPour(accountId: string, sources: readonly SourceEvidence[]) {
  const { groups } = groupSourcesByClaim(accountId, sources)
  return [...groups.entries()].map(([cle, groupe]) =>
    confirme(cle, groupe.map((s) => s.url)))
}

/** Passage complet, avec adjudication humaine de TOUTES les revendications. */
function pont(sources: readonly SourceEvidence[], accountId = COMPTE) {
  return bridgeSignals({
    accountId, observedAt: OBSERVED, sources,
    confirmations: confirmationsPour(accountId, sources),
  })
}

function src(
  h: SignalHit,
  lineage: SourceLineage = { kind: 'ORIGINAL' },
  website?: string,
  grounding: Grounding = ANCRE,
): SourceEvidence {
  const s = sourceEvidenceFromHit(h, website, lineage, grounding)
  if (!s) throw new Error('source inexploitable')
  return s
}

// ── GARDE D'ENTITÉ ──────────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — garde d’entité', () => {
  const bon = { added: 1, id: 'ld_1', siren: '552100554', resolution: 'resolved' as const }

  it('résolution autoritaire complète → acceptée', () => {
    expect(isResolvedSignalImportResult(bon)).toBe(true)
  })

  it('échoue fermé sur chaque état non résolu', () => {
    for (const resolution of ['ambiguous', 'not_found', 'provider_error'] as const) {
      expect(isResolvedSignalImportResult({ ...bon, resolution }), resolution).toBe(false)
    }
    expect(isResolvedSignalImportResult({ ...bon, resolution: undefined } as any)).toBe(false)
    expect(isResolvedSignalImportResult(null)).toBe(false)
    expect(isResolvedSignalImportResult(undefined)).toBe(false)
  })

  it('SIREN absent ou malformé → refus', () => {
    for (const siren of [undefined, '', '5521005', '5521005544', '55210055a', ' 552100554']) {
      expect(isResolvedSignalImportResult({ ...bon, siren } as any), String(siren)).toBe(false)
    }
  })

  it('résultat de doublon « id seul » → refus', () => {
    // `{added: 0, id}` est le retour d'un import DÉJÀ vu : il prouve qu'une
    // fiche existe, pas qu'une entité a été identifiée.
    expect(isResolvedSignalImportResult({ added: 0, id: 'ld_1' })).toBe(false)
  })

  it('`verified` seul ne vaut pas résolution', () => {
    expect(isResolvedSignalImportResult({ added: 1, id: 'ld_1', verified: true })).toBe(false)
  })

  it('`verified: true` ne rachète PAS une résolution non aboutie', () => {
    // ⚠️ Le cas dangereux : tout est présent, SIREN valide compris, et seule la
    // `resolution` dit la vérité. `verified` est un booléen qui écrase quatre
    // états ; s'en contenter ferait passer une ambiguïté ou une panne pour une
    // identification.
    for (const resolution of ['ambiguous', 'not_found', 'provider_error'] as const) {
      expect(
        isResolvedSignalImportResult({ ...bon, verified: true, resolution }),
        resolution,
      ).toBe(false)
    }
    expect(isResolvedSignalImportResult({ ...bon, verified: true, resolution: undefined } as any))
      .toBe(false)
  })

  it('un compte non vérifié (repli par nom) ne franchit pas la frontière', () => {
    const r = promoteToEvidence({
      accountId: 'acc_name_acme',
      sources: [src(leveeBouclee('https://maddyness.com/a'))],
      observedAt: OBSERVED, confirmations: [],
    })
    expect(r).toEqual({ ok: false, reason: 'NO_VERIFIED_ACCOUNT' })
  })
})

// ── QUALITÉ DE SOURCE ───────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — grade de source', () => {
  it('registre officiel → A', () => {
    expect(gradeForSource('https://annuaire-entreprises.data.gouv.fr/x')).toBe('A')
  })

  it('site déclaré de l’entreprise → A', () => {
    expect(gradeForSource('https://acme.fr/presse/levee', 'https://acme.fr')).toBe('A')
  })

  it('presse identifiée → B', () => {
    expect(gradeForSource('https://maddyness.com/a')).toBe('B')
    expect(gradeForSource('https://www.sifted.eu/b')).toBe('B')
  })

  it('agrégateur → C', () => {
    expect(gradeForSource('https://welcometothejungle.com/jobs/1')).toBe('C')
  })

  it('non classable → UNKNOWN, jamais un grade optimiste', () => {
    expect(gradeForSource('https://blog-inconnu.xyz/a')).toBe('UNKNOWN')
    expect(gradeForSource('pas une url')).toBe('UNKNOWN')
    expect(gradeForSource(null)).toBe('UNKNOWN')
  })

  it('un article citant un communiqué ne devient PAS une source A', () => {
    // Seule la CAPTURE de la source primaire la crée.
    const s = src(leveeBouclee('https://maddyness.com/a'), {
      kind: 'CITES', sourceUrl: 'https://acme.fr/presse',
    })
    expect(s.grade).toBe('B')
  })
})

// ── POLITIQUE DE SOURCE ─────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — politique de source', () => {
  it('A + une seule source → éligible', () => {
    expect(sourcePolicyPasses([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])).toBe(true)
  })

  it('B seul → NON éligible', () => {
    expect(sourcePolicyPasses([src(leveeBouclee('https://maddyness.com/a'))])).toBe(false)
  })

  it('B + 2 éditeurs indépendants prouvés → éligible', () => {
    expect(sourcePolicyPasses([
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b')),
    ])).toBe(true)
  })

  it('deux URL du MÊME éditeur ne font pas deux indépendances', () => {
    expect(sourcePolicyPasses([
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://maddyness.com/b')),
    ])).toBe(false)
  })

  it('lignée UNKNOWN ne compte JAMAIS comme indépendance', () => {
    const sources = [
      src(leveeBouclee('https://maddyness.com/a'), { kind: 'UNKNOWN' }),
      src(leveeBouclee('https://sifted.eu/b'), { kind: 'UNKNOWN' }),
    ]
    expect(independentPublishers(sources)).toEqual([])
    expect(sourcePolicyPasses(sources)).toBe(false)
  })

  it('C ou UNKNOWN → jamais éligibles, même nombreuses', () => {
    expect(sourcePolicyPasses([
      src(posteSalesOuvert('https://welcometothejungle.com/1')),
      src(posteSalesOuvert('https://hellowork.com/2')),
      src(posteSalesOuvert('https://apec.fr/3')),
    ])).toBe(false)
    expect(sourcePolicyPasses([src(leveeBouclee('https://inconnu.xyz/a'))])).toBe(false)
  })
})

// ── CANONICALISATION ────────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — identité canonique', () => {
  it('deux levées de DATES différentes ne s’écrasent pas', () => {
    const a = canonicalKey(COMPTE, { type: 'recent_funding' as any, temporality: 'dated_event', occurredAt: '2026-08-12' })
    const b = canonicalKey(COMPTE, { type: 'recent_funding' as any, temporality: 'dated_event', occurredAt: '2027-03-04' })
    expect(a).not.toBe(b)
    expect(externalEvidenceId(a)).not.toBe(externalEvidenceId(b))
  })

  it('l’identité est déterministe, sans horloge ni aléa', () => {
    const cle = canonicalKey(COMPTE, { type: 'sales_hiring' as any, temporality: 'undated_state' })
    expect(externalEvidenceId(cle)).toBe(externalEvidenceId(cle))
    expect(externalEvidenceId(cle)).toMatch(/^ev_ext_[0-9a-f]{16}$/)
  })

  it('cinq URL du même événement → UN seul groupe', () => {
    const sources = [
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b')),
      src(leveeBouclee('https://tech.eu/c')),
      src(leveeBouclee('https://frenchweb.fr/d')),
      src(leveeBouclee('https://eu-startups.com/e')),
    ]
    const { groups } = groupSourcesByClaim(COMPTE, sources)
    expect(groups.size).toBe(1)
  })
})

// ── CONTRADICTION ───────────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — contradiction', () => {
  it('COMPLETED vs ANNOUNCED_FUTURE → contradiction', () => {
    expect(materialContradiction([
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b', { eventStatus: 'ANNOUNCED_FUTURE' })),
    ])).toBe(true)
  })

  it('OPEN vs FILLED → contradiction', () => {
    expect(materialContradiction([
      src(posteSalesOuvert('https://maddyness.com/a')),
      src(posteSalesOuvert('https://sifted.eu/b', { roleStatus: 'FILLED' })),
    ])).toBe(true)
  })

  it('UNKNOWN n’est pas une contradiction — c’est une abstention', () => {
    expect(materialContradiction([
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b', { roleStatus: 'UNKNOWN' })),
    ])).toBe(false)
  })

  it('une contradiction BLOQUE la promotion, sans moyenne ni arbitrage', () => {
    const r = promoteToEvidence({
      accountId: COMPTE,
      observedAt: OBSERVED,
      sources: [
        src(leveeBouclee('https://maddyness.com/a')),
        src(leveeBouclee('https://sifted.eu/b', { eventStatus: 'ANNOUNCED_FUTURE' })),
      ],
    })
    expect(r).toEqual({ ok: false, reason: 'MATERIAL_CONTRADICTION' })
  })
})

// ── R1a — CONTRADICTION MESURÉE DE BOUT EN BOUT ────────────────────────────
//
// ⚠️ APPELER `materialContradiction()` DIRECTEMENT NE PROUVE RIEN. Le défaut
// corrigé ici était un problème d'ORDRE : la détection avait lieu APRÈS le
// mapping et le regroupement, donc une source contredisante pouvait être
// écartée avant d'être vue, et la survivante promue seule. Seul un passage
// complet par `bridgeSignals` le démontre.

describe('SIGNAL-EVIDENCE-BRIDGE-001a — contradiction, via bridgeSignals', () => {
  it('COMPLETED vs ANNOUNCED_FUTURE → ZÉRO evidence promue', () => {
    // La source ANNOUNCED_FUTURE était rejetée par `mapClaim` avant d'entrer
    // dans le groupe ; la COMPLETED était alors promue sans contradicteur.
    const out = pont([
        src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        src(leveeBouclee('https://sifted.eu/b', { eventStatus: 'ANNOUNCED_FUTURE' })),
      ])
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('MATERIAL_CONTRADICTION')
  })

  it('OPEN vs FILLED sur le même état de recrutement → ZÉRO evidence', () => {
    const out = pont([
        src(posteSalesOuvert('https://acme.fr/jobs/ae'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        src(posteSalesOuvert('https://sifted.eu/b', {
          claimNature: 'EVENT', roleStatus: 'FILLED',
          eventStatus: 'COMPLETED', eventDate: '2026-08-01', eventDatePrecision: 'DAY',
        })),
      ])
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('MATERIAL_CONTRADICTION')
  })

  it('dates métier exactes en conflit sur le même sujet → ZÉRO evidence', () => {
    // ⚠️ La date entrait dans l'identité canonique : deux jours différents
    // formaient DEUX groupes, donc deux faits, au lieu d'un désaccord.
    const out = pont([
        src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        src(leveeBouclee('https://sifted.eu/b', { eventDate: '2026-08-13' })),
      ])
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('MATERIAL_CONTRADICTION')
  })

  it('une contradiction n’en contamine pas un sujet SANS RAPPORT', () => {
    // Le poste ouvert reste promu alors que la levée est en litige : on écarte
    // un cluster, jamais l'ensemble des faits du compte.
    const out = pont([
        src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        src(leveeBouclee('https://sifted.eu/b', { eventStatus: 'ANNOUNCED_FUTURE' })),
        src(posteSalesOuvert('https://acme.fr/jobs/ae'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
      ])
    expect(out.evidence.map((e) => e.type)).toEqual(['sales_hiring'])
  })

  it('le sujet candidat ignore les dimensions CONTESTABLES', () => {
    // Statut, date et statut de poste n'y entrent pas : ce sont précisément les
    // dimensions sur lesquelles deux sources s'opposent.
    expect(claimSubject(leveeBouclee('https://x.fr/a')))
      .toBe(claimSubject(leveeBouclee('https://y.fr/b', {
        eventStatus: 'ANNOUNCED_FUTURE', eventDate: '2027-01-01',
      })))
  })
})

// ── R1a — ANCRAGE : UNE SORTIE DE LLM N'EST PAS UN FAIT ────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001a — ancrage matériel', () => {
  it('un extrait réellement présent dans la matière capturée est vérifié', () => {
    expect(verifyAnchor(ANCRAGE, TEXTE_CAPTURE)).toBe(true)
    expect(groundingFor(ANCRAGE, TEXTE_CAPTURE)).toEqual({
      kind: 'VERIFIED_ANCHOR', anchor: ANCRAGE,
    })
  })

  it('un extrait plausible mais ABSENT n’est pas vérifié', () => {
    // Mode de défaillance le plus courant d'un modèle : une citation crédible
    // qui n'apparaît nulle part.
    expect(verifyAnchor("la cloture de sa Serie B de 30 millions d'euros", TEXTE_CAPTURE)).toBe(false)
    expect(groundingFor("une citation inventee mais parfaitement credible", TEXTE_CAPTURE))
      .toEqual({ kind: 'UNVERIFIABLE' })
  })

  it('un ancrage trop court ne prouve rien', () => {
    expect(verifyAnchor('Acme', TEXTE_CAPTURE)).toBe(false)
  })

  it('sans matière capturée, aucun ancrage n’est possible', () => {
    // C'est le cas de la voie `claude-web` : `CallResult` n'expose que le JSON
    // final, sans trace d'outil ni contenu de page.
    expect(groundingFor(ANCRAGE, null)).toEqual({ kind: 'UNVERIFIABLE' })
    expect(groundingFor(ANCRAGE, '')).toEqual({ kind: 'UNVERIFIABLE' })
  })

  it('HÔTE DE CONFIANCE + AUCUNE adjudication → aucun fait automatique', () => {
    // ⚠️ LA GARDE LA PLUS IMPORTANTE, REFORMULÉE PAR L'ARBITRAGE R1c. L'ancrage
    // machine n'est plus une condition de promotion — aucune voie d'acquisition
    // ne le transporte jusqu'ici. Ce qui reste absolu : sans adjudication
    // humaine, aucun fait. Grade A, hôte de confiance et date exacte n'y
    // changent rien.
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED, confirmations: [],
      sources: [src(
        leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr',
        { kind: 'UNVERIFIABLE' },
      )],
    })
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('NO_FACT_AUTHORITY')
  })

  it('revendication NON ancrée mais ADJUGÉE → promouvable en V0', () => {
    const out = pont([src(
      leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr',
      { kind: 'UNVERIFIABLE' },
    )])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0].assertionType).toBe('fact')
  })

  it('matière capturée + revendication exacte → éligible selon la politique', () => {
    const ancre = groundingFor(ANCRAGE, TEXTE_CAPTURE)
    const out = pont([src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr', ancre)])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0].assertionType).toBe('fact')
  })
})

// ── R1b — ANCRAGE EMPRUNTÉ ─────────────────────────────────────────────────
//
// ⚠️ LE DÉFAUT : autorité et vérification pouvaient venir de SOURCES
// DIFFÉRENTES. Une source A autoritaire mais non ancrée ouvrait la porte, une
// source C ancrée fournissait l'ancrage, et la revendication passait sans
// qu'aucune source ne satisfasse les deux conditions.

describe('SIGNAL-EVIDENCE-BRIDGE-001b — l’ancrage ne s’emprunte pas', () => {
  const NON_ANCRE: Grounding = { kind: 'UNVERIFIABLE' }

  // ⚠️ CE COUPLAGE N'EST PLUS UNE GARDE DE PROMOTION (arbitrage R1c), mais la
  // FONCTION reste exacte et testée : le jour où l'ancrage machine sera
  // transporté de bout en bout (MACHINE-GROUNDING-001), autorité et
  // vérification devront tenir dans les MÊMES sources, jamais empruntées l'une
  // à l'autre.

  it('A NON ancrée + C ancrée → aucune source qualifiante ancrée', () => {
    expect(qualifyingSources([
      src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr', NON_ANCRE),
      src(leveeBouclee('https://welcometothejungle.com/x'), { kind: 'ORIGINAL' }, undefined, ANCRE),
    ])).toEqual([])
  })

  it('A NON ancrée + une seule B ancrée → la règle A ne s’applique pas', () => {
    expect(qualifyingSources([
      src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr', NON_ANCRE),
      src(leveeBouclee('https://maddyness.com/a'), { kind: 'ORIGINAL' }, undefined, ANCRE),
    ])).toEqual([])
  })

  it('B1 ancrée + B2 NON ancrée → insuffisant', () => {
    expect(qualifyingSources([
      src(leveeBouclee('https://maddyness.com/a'), { kind: 'ORIGINAL' }, undefined, ANCRE),
      src(leveeBouclee('https://sifted.eu/b'), { kind: 'ORIGINAL' }, undefined, NON_ANCRE),
    ])).toEqual([])
  })

  it('B1 + B2 ancrées ET indépendantes → deux sources qualifiantes', () => {
    expect(qualifyingSources([
      src(leveeBouclee('https://maddyness.com/a'), { kind: 'ORIGINAL' }, undefined, ANCRE),
      src(leveeBouclee('https://sifted.eu/b'), { kind: 'ORIGINAL' }, undefined, ANCRE),
    ])).toHaveLength(2)
  })

  it('les sources qualifiantes sont TOUTES ancrées quand l’ancrage est exigé', () => {
    const q = qualifyingSources([
      src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr', NON_ANCRE),
      src(leveeBouclee('https://maddyness.com/a'), { kind: 'ORIGINAL' }, undefined, ANCRE),
      src(leveeBouclee('https://sifted.eu/b'), { kind: 'ORIGINAL' }, undefined, ANCRE),
    ])
    expect(q.length).toBeGreaterThan(0)
    for (const s of q) expect(s.grounding.kind).toBe('VERIFIED_ANCHOR')
  })
})

// ── R1b — UN ANCRAGE VÉRIFIÉ N'EST PAS UNE AUTORITÉ ────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001b — autorité d’affirmation', () => {
  it('candidate ANCRÉE sans autorité → ZÉRO evidence', () => {
    // ⚠️ LA PREUVE ARCHITECTURALE DE « LLM OUTPUT != ACCEPTED TRUTH ». Tout est
    // réuni — source A, ancrage vérifié, date exacte, entité résolue — et rien
    // n'entre dans le Kernel : personne n'a adjugé l'interprétation.
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr')],
    })
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('NO_FACT_AUTHORITY')
  })

  it('candidate ancrée + confirmation humaine → promue', () => {
    const out = pont([src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0].assertionType).toBe('fact')
  })

  it('l’existence d’un ancrage ne produit JAMAIS un fait à elle seule', () => {
    expect(verifyAnchor(ANCRAGE, TEXTE_CAPTURE)).toBe(true)
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')],
    })
    expect(out.evidence).toEqual([])
  })

  it('une confirmation incomplète ne vaut pas adjudication', () => {
    const base = confirme(CLE_LEVEE, ['https://acme.fr/p'])
    for (const c of [
      undefined, null, {}, true, 'HUMAN_CONFIRMED',
      { ...base, kind: 'AUTRE' },
      { ...base, canonicalKey: '' },
      { ...base, confirmedBy: '   ' },
      { ...base, sourceUrls: [] },
      { ...base, sourceUrls: ['  '] },
      { ...base, sourceUrls: 'https://acme.fr/p' },
      // ⚠️ `STRUCTURED_AUTHORITY` A ÉTÉ RETIRÉE : sa forme ne prouve plus rien.
      { kind: 'STRUCTURED_AUTHORITY', provider: 'registre-officiel' },
    ]) {
      expect(isHumanFactConfirmation(c), JSON.stringify(c)).toBe(false)
    }
    expect(isHumanFactConfirmation(base)).toBe(true)
  })

  it('un horodatage non conforme fait échouer l’adjudication', () => {
    // ⚠️ `Date.parse` est permissif : `2026-08-20T24:00:00Z` y devient le 21.
    for (const t of [
      'y', 'tomorrow', '2026-99-99', '2026-08-20', '2026-02-30T10:00:00Z',
      '2026-08-20T24:00:00Z', '2026-08-20T10:60:00Z', '2026-08-20T10:00:00',
      '', null, 42,
    ]) {
      expect(
        isHumanFactConfirmation({ ...confirme(CLE_LEVEE, ['https://a.fr']), confirmedAt: t }),
        String(t),
      ).toBe(false)
    }
    for (const t of ['2026-08-20T10:00:00Z', '2026-08-20T10:00:00.123+02:00']) {
      expect(
        isHumanFactConfirmation({ ...confirme(CLE_LEVEE, ['https://a.fr']), confirmedAt: t }),
        t,
      ).toBe(true)
    }
  })

  it('un objet de forme STRUCTURED_AUTHORITY n’autorise AUCUN fait', () => {
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')],
      confirmations: [{ kind: 'STRUCTURED_AUTHORITY', provider: 'registre' } as any],
    })
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('NO_FACT_AUTHORITY')
  })

  it('l’autorité ne s’infère d’AUCUN indice indirect', () => {
    // Grade A, hôte de confiance, ancrage présent, 5 sources, `verified: true` :
    // aucun de ces indices ne remplace une adjudication.
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: ['acme.fr', 'maddyness.com', 'sifted.eu', 'tech.eu', 'frenchweb.fr'].map((d) =>
        src(leveeBouclee(`https://${d}/a`, { verified: true } as any), { kind: 'ORIGINAL' }, 'https://acme.fr')),
    })
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('NO_FACT_AUTHORITY')
  })
})

// ── R1c — UNE CONFIRMATION N'AUTORISE QU'UNE REVENDICATION ─────────────────
//
// ⚠️ LE DÉFAUT CORRIGÉ. L'autorité portait sur l'INVOCATION entière et se
// propageait à chaque groupe canonique : un opérateur validant une levée
// signait sans le savoir tous les autres faits du même lot.

describe('SIGNAL-EVIDENCE-BRIDGE-001c — adjudication liée à la revendication', () => {
  const LEVEE = 'https://acme.fr/presse/serie-a'
  const POSTE = 'https://acme.fr/jobs/ae'

  function deuxFaits() {
    return [
      src(leveeBouclee(LEVEE), { kind: 'ORIGINAL' }, 'https://acme.fr'),
      src(posteSalesOuvert(POSTE), { kind: 'ORIGINAL' }, 'https://acme.fr'),
    ]
  }

  function avec(confirmations: HumanFactConfirmation[]) {
    return bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED, sources: deuxFaits(), confirmations,
    })
  }

  it('seule la levée confirmée → SEULE la levée est promue', () => {
    const out = avec([confirme(CLE_LEVEE, [LEVEE])])
    expect(out.evidence.map((e) => e.type)).toEqual(['recent_funding'])
    expect(out.refusals.map((r) => r.reason)).toContain('NO_FACT_AUTHORITY')
  })

  it('seul le poste confirmé → SEUL le poste est promu', () => {
    const out = avec([confirme(CLE_POSTE, [POSTE])])
    expect(out.evidence.map((e) => e.type)).toEqual(['sales_hiring'])
  })

  it('les deux confirmés → les deux promus', () => {
    const out = avec([confirme(CLE_LEVEE, [LEVEE]), confirme(CLE_POSTE, [POSTE])])
    expect(out.evidence.map((e) => e.type).sort()).toEqual(['recent_funding', 'sales_hiring'])
  })

  it('aucune confirmation → aucun fait', () => {
    expect(avec([]).evidence).toEqual([])
  })

  it('une confirmation ne désignant PAS la revendication n’autorise rien', () => {
    const out = avec([confirme(`recent_funding|${COMPTE}|2027-01-01`, [LEVEE])])
    expect(out.evidence).toEqual([])
  })

  it('une confirmation portant sur d’AUTRES sources est refusée', () => {
    const out = avec([confirme(CLE_LEVEE, ['https://sifted.eu/autre-chose'])])
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('CONFIRMATION_SOURCE_MISMATCH')
  })

  it('une confirmation omettant une source qualifiante est refusée', () => {
    // Deux B indépendantes qualifient ; n'en confirmer qu'une revient à adjuger
    // une corroboration que la personne n'a pas examinée.
    const sources = [
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b')),
    ]
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED, sources,
      confirmations: [confirme(CLE_LEVEE, ['https://maddyness.com/a'])],
    })
    expect(out.evidence).toEqual([])
    expect(out.refusals.map((r) => r.reason)).toContain('CONFIRMATION_SOURCE_MISMATCH')
  })

  it('une confirmation couvrant les sources MAIS y ajoutant une URL étrangère est refusée', () => {
    // ⚠️ Le cas que la seule règle de couverture ne voit pas : toutes les
    // sources qualifiantes sont bien confirmées, et une URL du groupe voisin
    // s'y est glissée. Le signe d'une adjudication rattachée au mauvais objet.
    const out = avec([confirme(CLE_LEVEE, [LEVEE, POSTE])])
    expect(out.evidence.some((e) => e.type === 'recent_funding')).toBe(false)
    expect(out.refusals.map((r) => r.reason)).toContain('CONFIRMATION_SOURCE_MISMATCH')
  })

  it('l’ordre des URL confirmées est indifférent', () => {
    const sources = [
      src(leveeBouclee('https://maddyness.com/a')),
      src(leveeBouclee('https://sifted.eu/b')),
    ]
    const out = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED, sources,
      confirmations: [confirme(CLE_LEVEE, ['https://sifted.eu/b', ' https://maddyness.com/a '])],
    })
    expect(out.evidence).toHaveLength(1)
  })
})

// ── R1c — LA PROVENANCE D'ACCEPTATION SURVIT ───────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001c — provenance d’acceptation', () => {
  it('l’evidence promue porte QUI a adjugé, QUAND, sur QUOI et au vu de QUELLES sources', () => {
    const url = 'https://acme.fr/presse'
    const out = pont([src(leveeBouclee(url), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence[0].acceptance).toEqual({
      kind: 'human_confirmed',
      actorId: 'actor_7f2c',
      confirmedAt: '2026-08-20T10:00:00.000Z',
      canonicalKey: CLE_LEVEE,
      sourceUrls: [url],
    })
  })

  it('la provenance n’est PAS cachée dans source.reference', () => {
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence[0].source.reference ?? '').not.toContain('actor_7f2c')
  })

  it('une acceptation tronquée invalide l’evidence à la relecture', async () => {
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const bonne = out.evidence[0]
    expect(isEvidenceEvent(bonne)).toBe(true)

    for (const mauvaise of [
      { ...bonne, acceptance: { ...bonne.acceptance, actorId: '' } },
      { ...bonne, acceptance: { ...bonne.acceptance, confirmedAt: 'demain' } },
      { ...bonne, acceptance: { ...bonne.acceptance, canonicalKey: '' } },
      { ...bonne, acceptance: { ...bonne.acceptance, sourceUrls: [] } },
      { ...bonne, acceptance: { ...bonne.acceptance, kind: 'autre' } },
      { ...bonne, acceptance: 'human_confirmed' },
    ]) {
      expect(isEvidenceEvent(mauvaise), JSON.stringify((mauvaise as any).acceptance)).toBe(false)
    }
  })

  it('une evidence INTERNE sans acceptation reste valide — le CRM n’adjuge personne', async () => {
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const { acceptance, ...sans } = out.evidence[0] as any
    // Même objet, mais provenance INTERNE : il constate l'état de notre base et
    // n'a personne à citer.
    expect(isEvidenceEvent({ ...sans, source: { provider: 'prospector_crm', reference: 'ld_1' } }))
      .toBe(true)
  })

  it('un FAIT EXTERNE sans acceptation est INVALIDE — la garde ne se contourne pas', async () => {
    // ⚠️ Le vecteur réel : écrire directement dans le magasin, ou passer un objet
    // forgé à `externalEvidence`, en sautant tout le Bridge.
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const { acceptance, ...sans } = out.evidence[0] as any
    expect(isEvidenceEvent(sans)).toBe(false)
  })

  it('la source citée doit figurer parmi les preuves examinées', async () => {
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const e = out.evidence[0] as any
    expect(isEvidenceEvent({
      ...e, source: { ...e.source, url: 'https://une-source-jamais-revue.fr/x' },
    })).toBe(false)
  })

  it('la source persistée est la preuve QUALIFIANTE, pas une source faible du groupe', () => {
    // ⚠️ L'AGRÉGATEUR TRIE AVANT LA SOURCE OFFICIELLE (`apec.fr` < `zeta.fr`).
    // C'est indispensable : prendre la première URL du groupe une fois triée
    // choisirait donc la source FAIBLE — celle qui n'a fondé aucune décision et
    // que personne n'a retenue pour promouvoir.
    const out = pont([
      src(leveeBouclee('https://apec.fr/annonce'), { kind: 'ORIGINAL' }, 'https://zeta.fr'),
      src(leveeBouclee('https://zeta.fr/presse'), { kind: 'ORIGINAL' }, 'https://zeta.fr'),
    ])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0].source.url).toBe('https://zeta.fr/presse')
    expect(out.evidence[0].source.url).not.toContain('apec.fr')
  })

  it('les deux frontières partagent LA MÊME règle d’horodatage strict', async () => {
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const e = out.evidence[0] as any

    for (const t of ['2026-08-20T24:00:00Z', '2026-02-30T10:00:00Z', '2026-08-20', 'tomorrow']) {
      // refusé à l'ÉCRITURE…
      expect(isHumanFactConfirmation({ ...confirme(CLE_LEVEE, ['https://a.fr']), confirmedAt: t }), t)
        .toBe(false)
      // …et refusé à la RELECTURE.
      expect(isEvidenceEvent({ ...e, acceptance: { ...e.acceptance, confirmedAt: t } }), t)
        .toBe(false)
    }

    const bon = '2026-08-20T10:00:00.123+02:00'
    expect(isHumanFactConfirmation({ ...confirme(CLE_LEVEE, ['https://a.fr']), confirmedAt: bon })).toBe(true)
    expect(isEvidenceEvent({ ...e, acceptance: { ...e.acceptance, confirmedAt: bon } })).toBe(true)
  })

  it('provenance WEB + assertionType NON factuel → invalide, même sans acceptation', async () => {
    // ⚠️ LA PORTE QUE R1e FERME. Exiger l'adjudication seulement sur `fact`
    // laissait passer la même provenance en `inference` ou `assumption` : des
    // formes qu'AUCUN chemin légitime ne produit.
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const e = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
      .evidence[0] as any
    const { acceptance, ...sans } = e

    for (const assertionType of ['inference', 'assumption']) {
      expect(isEvidenceEvent({ ...sans, assertionType }), assertionType).toBe(false)
      // Même avec une adjudication valide : la provenance web n'admet que `fact`.
      expect(isEvidenceEvent({ ...e, assertionType }), `${assertionType} + acceptance`).toBe(false)
    }
    expect(isEvidenceEvent(e)).toBe(true)
  })

  it('l’adjudication doit désigner CETTE evidence — toute mutation la rompt', async () => {
    const { isEvidenceEvent } = await import('../lib/prospector/proactive/validators')
    const e = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
      .evidence[0] as any
    expect(isEvidenceEvent(e)).toBe(true)

    // ⚠️ Une evidence adjugée mutée d'une revendication vers une autre garderait
    // la signature humaine de la première.
    expect(isEvidenceEvent({ ...e, type: 'sales_hiring' })).toBe(false)
    expect(isEvidenceEvent({ ...e, occurredAt: '2026-08-13' })).toBe(false)
    expect(isEvidenceEvent({ ...e, accountId: 'acc_siren_999999999' })).toBe(false)
    expect(isEvidenceEvent({ ...e, temporality: 'undated_state', occurredAt: undefined })).toBe(false)
    expect(isEvidenceEvent({
      ...e, acceptance: { ...e.acceptance, canonicalKey: `recent_funding|${COMPTE}|2027-01-01` },
    })).toBe(false)
  })

  it('la corroboration ne compte QUE les preuves qualifiantes', () => {
    // Source A officielle + agrégateur faible dans le même groupe : le second
    // n'a fondé aucune décision et ne doit pas apparaître comme un appui.
    const r = promoteToEvidence({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [
        src(leveeBouclee('https://zeta.fr/presse'), { kind: 'ORIGINAL' }, 'https://zeta.fr'),
        src(leveeBouclee('https://apec.fr/annonce'), { kind: 'ORIGINAL' }, 'https://zeta.fr'),
      ],
      confirmations: [confirme(CLE_LEVEE, ['https://zeta.fr/presse'])],
    })
    expect(r.ok).toBe(true)
    if (r.ok === true) {
      expect(r.corroboration).toEqual(['zeta.fr'])
      expect(r.corroboration).not.toContain('apec.fr')
    }
  })

  it('la clé canonique a UNE seule définition, partagée', async () => {
    const { canonicalClaimKey } = await import('../lib/prospector/proactive/types')
    const e = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
      .evidence[0] as any
    expect(e.acceptance.canonicalKey).toBe(canonicalClaimKey({
      type: e.type, accountId: e.accountId,
      temporality: e.temporality, occurredAt: e.occurredAt,
    }))
    expect(canonicalKey(COMPTE, { type: 'recent_funding' as any, temporality: 'dated_event', occurredAt: '2026-08-12' }))
      .toBe(CLE_LEVEE)
    expect(canonicalKey(COMPTE, { type: 'sales_hiring' as any, temporality: 'undated_state' }))
      .toBe(CLE_POSTE)
  })

  it('la provenance survit à un aller-retour de sérialisation', () => {
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    const relue = JSON.parse(JSON.stringify(out.evidence[0]))
    expect(relue.acceptance).toEqual(out.evidence[0].acceptance)
  })
})

// ── R1a — DURCISSEMENT DES DEUX FRONTIÈRES ─────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001a — durcissement compte et date', () => {
  it('un préfixe `acc_siren_` contrefait ne franchit pas la frontière', () => {
    for (const compte of [
      'acc_siren_', 'acc_siren_abc', 'acc_siren_12', 'acc_siren_5521005544',
      'acc_siren_552100554x', 'acc_siren_55210055 ',
    ]) {
      const out = bridgeSignals({
        accountId: compte, observedAt: OBSERVED,
        sources: [src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')],
      })
      expect(out.evidence, compte).toEqual([])
      expect(out.refusals[0].reason).toBe('NO_VERIFIED_ACCOUNT')
    }
  })

  it('`DAY` annoncé sur une valeur invalide ne produit AUCUN objet promu', () => {
    // Le typage ne contrôle aucune donnée d'exécution : la revalidation a lieu
    // à la frontière.
    for (const d of ['garbage', '2026-02-30', '2026-13-01', '12/08/2026', '2026-08']) {
      const out = pont([src(
          leveeBouclee('https://acme.fr/p', { eventDate: d, eventDatePrecision: 'DAY' }),
          { kind: 'ORIGINAL' }, 'https://acme.fr',
        )])
      expect(out.evidence, d).toEqual([])
      expect(out.refusals[0].reason).toBe('NO_EXACT_EVENT_DATE')
    }
  })

  it('année bissextile : 2028-02-29 reste valide', () => {
    const out = pont([src(
        leveeBouclee('https://acme.fr/p', { eventDate: '2028-02-29', eventDatePrecision: 'DAY' }),
        { kind: 'ORIGINAL' }, 'https://acme.fr',
      )])
    expect(out.evidence).toHaveLength(1)
    expect((out.evidence[0] as any).occurredAt).toBe('2028-02-29')
  })
})

// ── TEMPORALITÉ ─────────────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — temporalité', () => {
  it('EVENT COMPLETED daté au jour → dated_event avec occurredAt', () => {
    const claim = mapClaim(leveeBouclee('https://x.fr/a'))
    expect(claim).toEqual({ type: 'recent_funding', temporality: 'dated_event', occurredAt: '2026-08-12' })
  })

  it('mois seul → aucune promotion d’événement daté', () => {
    expect(mapClaim(leveeBouclee('https://x.fr/a', {
      eventDate: '2026-08', eventDatePrecision: 'MONTH',
    }))).toBe('NO_EXACT_EVENT_DATE')
  })

  it('date de publication connue mais date métier inconnue → refus', () => {
    expect(mapClaim(leveeBouclee('https://x.fr/a', {
      eventDate: null, eventDatePrecision: 'UNKNOWN', sourcePublishedAt: '2026-08-19',
    }))).toBe('NO_EXACT_EVENT_DATE')
  })

  it('le champ hérité `date` ne sauve JAMAIS un événement sans date métier', () => {
    expect(mapClaim(leveeBouclee('https://x.fr/a', {
      eventDate: null, eventDatePrecision: 'UNKNOWN', date: '2026-08-12',
    }))).toBe('NO_EXACT_EVENT_DATE')
  })

  it('STATE observé → undated_state, sans occurredAt', () => {
    const claim = mapClaim(posteSalesOuvert('https://x.fr/a'))
    expect(claim).toEqual({ type: 'sales_hiring', temporality: 'undated_state' })
    expect((claim as any).occurredAt).toBeUndefined()
  })

  it('ANNOUNCED_FUTURE → jamais promu en fait réalisé', () => {
    expect(mapClaim(leveeBouclee('https://x.fr/a', { eventStatus: 'ANNOUNCED_FUTURE' })))
      .toBe('INTENT_NOT_REALIZED')
  })
})

// ── CORRESPONDANCES ET NO_MAP ───────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — correspondances', () => {
  it('poste Sales POURVU → NO_MAP : le contrat ne connaît aucune séniorité', () => {
    // ⚠️ `FILLED` + `SALES` ne prouve PAS un « nouveau responsable Sales ». Un
    // poste d'Account Executive pourvu satisfait exactement les mêmes champs.
    // Le contrat d'acquisition connaît une FONCTION, jamais une SÉNIORITÉ.
    expect(mapClaim(hit({
      signalType: 'actu', claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: '2026-07-01', eventDatePrecision: 'DAY',
      roleStatus: 'FILLED', roleFunction: 'SALES',
    }))).toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('aucune promotion ne peut produire new_sales_leader en V0', () => {
    const out = pont([src(hit({
        signalType: 'actu', sourceUrl: 'https://acme.fr/news',
        claimNature: 'EVENT', eventStatus: 'COMPLETED',
        eventDate: '2026-07-01', eventDatePrecision: 'DAY',
        roleStatus: 'FILLED', roleFunction: 'SALES',
      }), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence).toEqual([])
  })

  it('nomination de direction NON commerciale → NO_MAP', () => {
    expect(mapClaim(hit({
      signalType: 'actu', claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: '2026-07-01', eventDatePrecision: 'DAY',
      roleStatus: 'FILLED', roleFunction: 'EXEC_OTHER',
    }))).toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('poste TECH ouvert → NO_MAP', () => {
    expect(mapClaim(hit({ claimNature: 'STATE', roleStatus: 'OPEN', roleFunction: 'TECH' })))
      .toBe('NO_HONEST_EVIDENCE_TYPE')
  })

  it('rachat, lancement produit, prose vague → NO_MAP', () => {
    for (const h of [
      hit({ signalType: 'actu', claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-01', eventDatePrecision: 'DAY', detail: 'Acme rachète Beta.' }),
      hit({ signalType: 'actu', claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-01', eventDatePrecision: 'DAY', detail: 'Acme lance un nouveau produit.' }),
      hit({ signalType: 'autre', claimNature: 'UNKNOWN', detail: 'Acme connaît une croissance rapide.' }),
    ]) {
      expect(mapClaim(h)).toBe('NO_HONEST_EVIDENCE_TYPE')
    }
  })

  it('la prose ne fabrique jamais une correspondance', () => {
    // `detail` annonce une levée ; les champs structurés ne l'affirment pas.
    expect(mapClaim(hit({
      signalType: 'levée', detail: 'Acme a bouclé sa Série A de 12 M€ le 12 août 2026.',
      claimNature: 'UNKNOWN',
    }))).toBe('NO_HONEST_EVIDENCE_TYPE')
  })
})

// ── PROMOTION ───────────────────────────────────────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — promotion', () => {
  it('levée officielle datée → exactement UNE evidence recent_funding', () => {
    const out = pont([src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0]).toMatchObject({
      accountId: COMPTE, type: 'recent_funding', scope: 'account',
      assertionType: 'fact', temporality: 'dated_event', occurredAt: '2026-08-12',
      observedAt: OBSERVED,
    })
    expect(out.evidence[0].source.provider).toBe('web_signal_search')
    expect((out.evidence[0] as any).personId).toBeUndefined()
  })

  it('même levée sur 5 URL copiées → TOUJOURS une seule evidence', () => {
    const out = pont([
        src(leveeBouclee('https://acme.fr/presse'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        ...['maddyness.com', 'sifted.eu', 'tech.eu', 'frenchweb.fr'].map((d) =>
          src(leveeBouclee(`https://${d}/a`), { kind: 'CITES', sourceUrl: 'https://acme.fr/presse' })),
      ])
    expect(out.evidence).toHaveLength(1)
  })

  it('un seul article B → aucune evidence', () => {
    const out = pont([src(leveeBouclee('https://maddyness.com/a'))])
    expect(out.evidence).toEqual([])
    expect(out.refusals[0].reason).toBe('SOURCE_POLICY_FAILED')
  })

  it('deux articles B indépendants prouvés → une evidence', () => {
    const out = pont([
        src(leveeBouclee('https://maddyness.com/a')),
        src(leveeBouclee('https://sifted.eu/b')),
      ])
    expect(out.evidence).toHaveLength(1)
  })

  it('poste Sales ouvert, source officielle, sans date → sales_hiring undated_state', () => {
    const out = pont([src(posteSalesOuvert('https://acme.fr/jobs/ae'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0]).toMatchObject({ type: 'sales_hiring', temporality: 'undated_state' })
    expect((out.evidence[0] as any).occurredAt).toBeUndefined()
  })

  it('poste vu sur agrégateur faible seul → aucune evidence', () => {
    const out = pont([src(posteSalesOuvert('https://welcometothejungle.com/1'))])
    expect(out.evidence).toEqual([])
    expect(out.refusals[0].reason).toBe('SOURCE_POLICY_FAILED')
  })

  it('ouverture de bureau annoncée pour plus tard → aucun site_expansion', () => {
    const out = pont([src(hit({
        signalType: 'actu', sourceUrl: 'https://acme.fr/news',
        claimNature: 'EVENT', eventStatus: 'ANNOUNCED_FUTURE',
      }), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence).toEqual([])
    expect(out.refusals[0].reason).toBe('INTENT_NOT_REALIZED')
    expect(out.evidence.some((e) => e.type === 'site_expansion')).toBe(false)
  })

  it('la confiance acceptée vaut EXACTEMENT la constante V0', () => {
    const out = pont([src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')])
    expect(out.evidence[0].confidence).toBe(0.75)
    expect(out.evidence[0].confidence).toBe(ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0)
  })

  it('le nombre de sources ne change PAS la confiance', () => {
    const une = pont([src(leveeBouclee('https://maddyness.com/a')), src(leveeBouclee('https://sifted.eu/b'))])
    const cinq = pont(['maddyness.com', 'sifted.eu', 'tech.eu', 'frenchweb.fr', 'eu-startups.com']
      .map((d) => src(leveeBouclee(`https://${d}/a`))))
    expect(une.evidence[0].confidence).toBe(cinq.evidence[0].confidence)
  })

  it('deux exécutions rendent des identifiants identiques', () => {
    const sources = [src(leveeBouclee('https://acme.fr/p'), { kind: 'ORIGINAL' }, 'https://acme.fr')]
    expect(pont(sources).evidence[0].id).toBe(pont(sources).evidence[0].id)
  })
})

// ── LE TEST QUI COMPTE : LE KERNEL EST ATTEINT ─────────────────────────────

describe('SIGNAL-EVIDENCE-BRIDGE-001 — bout-en-bout jusqu’au Decision Kernel', () => {
  beforeEach(() => {
    const g = globalThis as any
    if (g.__prospectorStore) g.__prospectorStore.clear()
  })

  /** Compte importé et vérifié : SIREN data.gouv, site déclaré. */
  const compte: Lead = {
    id: 'ld_acme', kind: 'account', firstName: '', lastName: '', title: '',
    company: 'Acme', score: 0, temperature: 'warm', status: 'froid',
    stage: 'to_invite', email: null, phone: null,
    siren: '552100554', website: 'https://acme.fr',
  } as Lead

  /**
   * Deux faits distincts et légitimes, chacun d'une source officielle capturée,
   * chacun adjugé par une confirmation qui lui est propre : le pack sales-core
   * exige DEUX familles pour `sales_scale_up`. Aucune règle métier n'est
   * modifiée pour faire passer ce test.
   */
  const SOURCES_E2E = () => [
    src(leveeBouclee('https://acme.fr/presse/serie-a'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
    src(posteSalesOuvert('https://acme.fr/jobs/ae'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
  ]

  function pontE2E() {
    return pont(SOURCES_E2E())
  }


  // SIGNAL_TEMPORAL_WINDOW_V0_001 : un état externe (`sales_hiring`) soumis à
  // une fenêtre déclarée exige son AUTORITÉ TEMPORELLE (en production : le
  // side-car du gate canonique, dérivé des assertions immuables). Le test la
  // fournit explicitement — jamais un repli silencieux sur `observedAt`.
  const autoriteEtat = (evidence: readonly any[]) => Object.fromEntries(
    evidence
      .filter((e) => e.temporality === 'undated_state' && e.source?.provider === 'web_signal_search')
      .map((e) => [e.id, { basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-08-19' }]),
  )

  it('SignalHit → KnownEvidenceEvent → orchestrator.evaluate() → Situation réelle', () => {
    const out = pontE2E()
    expect(out.evidence).toHaveLength(2)

    const evaluation = evaluate({
      leads: [compte],
      now: NOW,
      tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT,
      externalEvidence: out.evidence,
      temporalAuthorityByEvidenceId: autoriteEtat(out.evidence),
      relevanceFor: () => 0.8,
    })

    // Les faits externes sont bien entrés dans le moteur…
    const types = evaluation.evidence.map((e) => e.type).sort()
    expect(types).toContain('recent_funding')
    expect(types).toContain('sales_hiring')

    // …et en sont ressortis une Situation produite par le pack de production.
    expect(evaluation.situations.length).toBeGreaterThan(0)
    const scale = evaluation.situations.find((s) => s.type === 'sales_scale_up')
    expect(scale).toBeDefined()
    expect(scale!.accountId).toBe(COMPTE)
    expect(scale!.evidenceIds.sort()).toEqual(out.evidence.map((e) => e.id).sort())
  })

  it('la Situation produite est traçable jusqu’aux evidences soumises', () => {
    const out = pontE2E()
    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: out.evidence,
      relevanceFor: () => 0.8,
    })
    const connus = new Set(evaluation.evidence.map((e) => e.id))
    for (const s of evaluation.situations) {
      expect(s.evidenceIds.length).toBeGreaterThan(0)
      for (const id of s.evidenceIds) expect(connus.has(id)).toBe(true)
    }
  })

  it('l’évaluation est persistée par le chemin de production existant', async () => {
    const out = pontE2E()
    // SIGNAL_EVIDENCE_STRENGTH_V0_001 : la fixture déclare l'autorité
    // structurelle et temporelle de ses Signaux externes — exactement ce que
    // le gate canonique fournit en production. Sans elle, « fort » échoue
    // fermé, et c'est voulu.
    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: out.evidence,
      temporalAuthorityByEvidenceId: autoriteEtat(out.evidence),
      evidenceStrengthByEvidenceId: Object.fromEntries(
        out.evidence.map((e: any) => [e.id, { kind: 'EXTERNAL_CONFIRMED_CANONICAL' }]),
      ),
      relevanceFor: () => 0.8,
    })
    const compte_ = await persistEvaluation(evaluation, 'ws_test')
    expect(compte_.evidence).toBeGreaterThanOrEqual(2)
    expect(compte_.situations).toBeGreaterThan(0)
  })

  it('deux évaluations successives ne créent aucun doublon', () => {
    const a = pontE2E()
    const b = pontE2E()
    const args = {
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] } as const,
      businessContext: TEST_BUSINESS_CONTEXT, relevanceFor: () => 0.8,
    }
    const e1 = evaluate({ ...args, externalEvidence: a.evidence })
    const e2 = evaluate({ ...args, externalEvidence: b.evidence })
    expect(e1.situations.map((s) => s.id)).toEqual(e2.situations.map((s) => s.id))
    expect(e1.evidence.map((e) => e.id)).toEqual(e2.evidence.map((e) => e.id))
  })

  it('sans evidence externe, le même compte ne produit AUCUNE situation', () => {
    // Preuve que la Situation vient bien des faits externes, et non des leads.
    const temoin = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, relevanceFor: () => 0.8,
    })
    expect(temoin.situations.find((s) => s.type === 'sales_scale_up')).toBeUndefined()
  })

  it('la MÊME candidate ancrée SANS autorité → zéro evidence, zéro Situation', () => {
    // ⚠️ LE TÉMOIN NÉGATIF DE TOUTE LA CHAÎNE. Entrées rigoureusement
    // identiques au test précédent, à une chose près : personne n'a adjugé.
    // Le Kernel ne voit rien.
    const sansAutorite = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [
        src(leveeBouclee('https://acme.fr/presse/serie-a'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
        src(posteSalesOuvert('https://acme.fr/jobs/ae'), { kind: 'ORIGINAL' }, 'https://acme.fr'),
      ],
    })
    expect(sansAutorite.evidence).toEqual([])

    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: sansAutorite.evidence,
      relevanceFor: () => 0.8,
    })
    expect(evaluation.situations.find((s) => s.type === 'sales_scale_up')).toBeUndefined()
  })

  it('une evidence EXTERNE FORGÉE sans adjudication n’atteint AUCUN Rule Pack', () => {
    // ⚠️ LE CONTOURNEMENT QUE `externalEvidence` OUVRAIT. Le typage n'est pas une
    // frontière de confiance : ces objets sont parfaitement formés — type,
    // confiance, dates, cible — et n'ont jamais été adjugés par personne. Ils
    // sautent tout le Bridge. Le filtre d'exécution les écarte.
    const legitimes = pontE2E().evidence
    const forgees = legitimes.map((e) => {
      const { acceptance, ...sans } = e as any
      return sans
    })

    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: forgees,
      relevanceFor: () => 0.8,
    })
    expect(evaluation.evidence.some((e) => e.source.provider === 'web_signal_search')).toBe(false)
    expect(evaluation.situations.find((s) => s.type === 'sales_scale_up')).toBeUndefined()

    // …tandis que les mêmes faits, réellement adjugés, restent exploitables.
    const legitime = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: legitimes,
      temporalAuthorityByEvidenceId: autoriteEtat(legitimes),
      relevanceFor: () => 0.8,
    })
    expect(legitime.situations.find((s) => s.type === 'sales_scale_up')).toBeDefined()
  })

  it('un fait CRM légitime survit pendant qu’une inférence web forgée est filtrée', () => {
    // ⚠️ LE TEST ADVERSE DU §A. Les deux entrent par la même porte ; seul le
    // fait interne, produit par le CRM, atteint les Rule Packs. L'objet web —
    // `assertionType: 'inference'`, sans adjudication — ne franchit rien, et son
    // rejet n'emporte pas le fait légitime avec lui.
    const legitimes = pontE2E().evidence
    const inferenceForgee = {
      ...(legitimes[0] as any),
      id: 'ev_ext_forgee',
      assertionType: 'inference',
      acceptance: undefined,
    }

    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT,
      externalEvidence: [...legitimes, inferenceForgee] as any,
      temporalAuthorityByEvidenceId: autoriteEtat(legitimes),
      relevanceFor: () => 0.8,
    })

    expect(evaluation.evidence.some((e) => e.id === 'ev_ext_forgee')).toBe(false)
    expect(evaluation.evidence.some((e) => (e as any).assertionType === 'inference')).toBe(false)
    // Les faits réellement adjugés, eux, passent.
    expect(evaluation.situations.find((s) => s.type === 'sales_scale_up')).toBeDefined()
  })

  it('une evidence externe à l’horodatage d’adjudication invalide est écartée', () => {
    const corrompues = pontE2E().evidence.map((e) => ({
      ...e, acceptance: { ...(e as any).acceptance, confirmedAt: '2026-08-20T24:00:00Z' },
    }))
    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: corrompues as any,
      relevanceFor: () => 0.8,
    })
    expect(evaluation.situations.find((s) => s.type === 'sales_scale_up')).toBeUndefined()
  })

  it('les evidences externes subissent les MÊMES gardes que celles du CRM', () => {
    // Une evidence dont la confiance serait sous le plancher universel du cœur
    // (0.6) doit être écartée par `evidenceIsUsable`, pas admise par faveur.
    const out = pontE2E()
    const affaiblies = out.evidence.map((e) => ({ ...e, confidence: 0.1 }))
    const evaluation = evaluate({
      leads: [compte], now: NOW, tasks: { complete: true, openTaskLeadIds: [] },
      businessContext: TEST_BUSINESS_CONTEXT, externalEvidence: affaiblies as any,
      relevanceFor: () => 0.8,
    })
    expect(evaluation.situations.find((s) => s.type === 'sales_scale_up')).toBeUndefined()
  })
})
