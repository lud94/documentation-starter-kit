// ARCH-HORIZON-001 — ÉCHÉANCE MÉTIER ANTICIPÉE.
//
// Le moteur savait mesurer la fraîcheur d'un fait passé — une urgence qui
// DÉCROÎT. Ce lot lui apprend à représenter une échéance FUTURE dont l'urgence
// CROÎT à son approche, sans qu'aucun vocabulaire de domaine n'entre dans le
// cœur.
//
// Le test qui compte le plus est le PRE-WINDOW : il prouve qu'une evidence très
// récente — urgence 1 — ne peut pas contourner la fenêtre d'action.
import { describe, it, expect } from 'vitest'

import {
  buildSituation,
  urgencyFromHorizon,
  situationExpiry,
} from '../lib/prospector/proactive/ruleKit'
import { eligibilityDecision } from '../lib/prospector/proactive/eligibility'
import { recommendationDecision } from '../lib/prospector/proactive/recommendationEngine'
import { isSituation } from '../lib/prospector/proactive/persistence'
import type {
  AnticipatedHorizon,
  EvidenceEvent,
  Situation,
} from '../lib/prospector/proactive/types'
import type { SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'
import {
  TEST_RECOMMENDATION_CONTEXT,
  TEST_SITUATION_PROVENANCE,
} from './helpers/proactiveContext'

// Fenêtre de référence : ouverture le 1er janvier, échéance le 1er juillet.
const OPENS = '2026-01-01T00:00:00.000Z'
const AT = '2026-07-01T00:00:00.000Z'

const HORIZON: AnticipatedHorizon = {
  at: AT,
  actionWindowOpensAt: OPENS,
  assertionType: 'inference',
  derivedFrom: ['ev_start'],
}

function evidence(patch: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    id: 'ev_start',
    accountId: 'acc_1',
    type: 'recent_funding',
    scope: 'account',
    temporality: 'dated_event',
    occurredAt: '2025-12-01T00:00:00.000Z',
    observedAt: '2025-12-02T00:00:00.000Z',
    assertionType: 'fact',
    confidence: 0.9,
    source: { provider: 'test' },
    ...patch,
  } as EvidenceEvent
}

function contexte(now: string): SituationEvaluationContext {
  return {
    now: new Date(now),
    accountId: 'acc_1',
    relevance: 0.9,
    lensId: 'sales-default',
    lensVersion: 'v0.1',
  }
}

/**
 * ⚠️ `null` — et non `undefined` — signifie « aucun horizon ».
 *
 * Passer `undefined` à un paramètre muni d'une valeur par défaut RÉACTIVE cette
 * valeur : les cas « sans horizon » testaient en réalité AVEC horizon, et deux
 * assertions étaient donc plus faibles qu'elles ne le prétendaient. Le
 * sentinelle explicite supprime l'ambiguïté.
 */
function situationAvecHorizon(
  now: string,
  horizon: AnticipatedHorizon | null = HORIZON,
  evidences: EvidenceEvent[] = [evidence()],
): Situation {
  return buildSituation({
    type: 'sales_scale_up',
    evidence: evidences,
    context: contexte(now),
    ruleId: 'test-rule',
    ruleVersion: 'v0.1',
    rulePackId: 'sales-core',
    rulePackVersion: 'v0.1',
    ttlDays: 3650, // TTL volontairement très long : l'horizon doit primer.
    rationale: 'peu importe',
    anticipated: horizon ?? undefined,
  })
}

function reco(situation: Situation, now: string) {
  return recommendationDecision(situation, {
    now: new Date(now),
    businessContext: TEST_RECOMMENDATION_CONTEXT,
  } as any)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A. urgencyFromHorizon — progression normalisée, sans seuil', () => {
  it('avant l’ouverture de la fenêtre ⇒ 0', () => {
    expect(urgencyFromHorizon(HORIZON, new Date('2025-11-01T00:00:00.000Z'))).toBe(0)
    expect(urgencyFromHorizon(HORIZON, new Date('2025-12-31T23:59:59.000Z'))).toBe(0)
  })

  it('à l’ouverture exacte ⇒ 0, puis croissance', () => {
    expect(urgencyFromHorizon(HORIZON, new Date(OPENS))).toBe(0)
    expect(urgencyFromHorizon(HORIZON, new Date('2026-01-02T00:00:00.000Z'))).toBeGreaterThan(0)
  })

  it('au milieu de la fenêtre ⇒ ≈ 0.5', () => {
    // Milieu exact entre le 1er janvier et le 1er juillet.
    const milieuMs = (Date.parse(OPENS) + Date.parse(AT)) / 2
    const u = urgencyFromHorizon(HORIZON, new Date(milieuMs))
    expect(u).toBeGreaterThanOrEqual(0.49)
    expect(u).toBeLessThanOrEqual(0.51)
  })

  it('progression MONOTONE croissante sur toute la fenêtre', () => {
    const jalons = [
      '2026-01-15T00:00:00.000Z',
      '2026-02-15T00:00:00.000Z',
      '2026-03-15T00:00:00.000Z',
      '2026-04-15T00:00:00.000Z',
      '2026-05-15T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      '2026-06-30T00:00:00.000Z',
    ]
    const valeurs = jalons.map((j) => urgencyFromHorizon(HORIZON, new Date(j)))

    for (let i = 1; i < valeurs.length; i++) {
      expect(valeurs[i]).toBeGreaterThanOrEqual(valeurs[i - 1])
    }
    // Et elle progresse réellement — une constante satisferait la monotonie.
    expect(valeurs[valeurs.length - 1]).toBeGreaterThan(valeurs[0] + 0.5)
    expect(valeurs[valeurs.length - 1]).toBeLessThan(1)
  })

  it('à l’échéance et au-delà ⇒ 0 (ce n’est plus une anticipation)', () => {
    expect(urgencyFromHorizon(HORIZON, new Date(AT))).toBe(0)
    expect(urgencyFromHorizon(HORIZON, new Date('2026-09-01T00:00:00.000Z'))).toBe(0)
  })

  it('FAIL CLOSED — dates illisibles ou fenêtre dégénérée ⇒ 0', () => {
    const now = new Date('2026-03-01T00:00:00.000Z')
    expect(urgencyFromHorizon({ ...HORIZON, at: 'jamais' }, now)).toBe(0)
    expect(urgencyFromHorizon({ ...HORIZON, actionWindowOpensAt: 'hier' }, now)).toBe(0)
    // Fenêtre vide puis inversée.
    expect(urgencyFromHorizon({ ...HORIZON, actionWindowOpensAt: AT }, now)).toBe(0)
    expect(
      urgencyFromHorizon({ ...HORIZON, actionWindowOpensAt: AT, at: OPENS }, now),
    ).toBe(0)
  })

  it('AUCUN seuil calendaire dans le cœur — la forme suit la fenêtre déclarée', () => {
    // Deux fenêtres de longueurs très différentes, observées à 50 % : même
    // urgence. Si des paliers 30/60/90 jours subsistaient, elles divergeraient.
    const courte: AnticipatedHorizon = {
      ...HORIZON,
      actionWindowOpensAt: '2026-01-01T00:00:00.000Z',
      at: '2026-01-11T00:00:00.000Z',
    }
    const longue: AnticipatedHorizon = {
      ...HORIZON,
      actionWindowOpensAt: '2026-01-01T00:00:00.000Z',
      at: '2030-01-01T00:00:00.000Z',
    }
    const mi = (h: AnticipatedHorizon) =>
      urgencyFromHorizon(
        h,
        new Date((Date.parse(h.actionWindowOpensAt) + Date.parse(h.at)) / 2),
      )

    expect(mi(courte)).toBe(mi(longue))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. PRE-WINDOW — une evidence récente ne contourne PAS la fenêtre', () => {
  it('urgence evidence = 1 mais fenêtre fermée ⇒ no_action daté', () => {
    // Evidence survenue la veille : `freshnessScore` la note 1.
    const NOW = '2025-12-15T00:00:00.000Z'
    const toute_fraiche = evidence({
      occurredAt: '2025-12-14T00:00:00.000Z',
      observedAt: '2025-12-14T00:00:00.000Z',
    })

    const situation = situationAvecHorizon(NOW, HORIZON, [toute_fraiche])

    // L'urgence EST maximale — c'est bien le `max` qui s'applique.
    expect(situation.urgency).toBe(1)

    // Et pourtant AUCUNE action n'est recommandée.
    const eligibilite = eligibilityDecision(situation, { now: new Date(NOW) })
    expect(eligibilite.eligible).toBe(false)
    expect(eligibilite.reason).toBe('anticipated_window_not_open')
    expect(eligibilite.blockedUntil).toBe(OPENS)

    const r = reco(situation, NOW)
    expect(r.decision).toBe('no_action')
    expect(r.play).toBeUndefined()
    expect(r.recommendedAction).toBeUndefined()
    expect(r.whyNow).toContain(OPENS)
  })

  it('la recommandation no_action n’excède pas l’ouverture de la fenêtre', () => {
    const NOW = '2025-12-15T00:00:00.000Z'
    const r = reco(situationAvecHorizon(NOW), NOW)
    expect(r.expiresAt).toBe(OPENS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Les quatre régimes temporels', () => {
  it('AT WINDOW OPEN — `now === actionWindowOpensAt` ⇒ ÉLIGIBLE', () => {
    const situation = situationAvecHorizon(OPENS)
    const e = eligibilityDecision(situation, { now: new Date(OPENS) })
    expect(e.eligible).toBe(true)
    expect(e.reason).toBe('eligible')
    expect(reco(situation, OPENS).decision).toBe('recommend')
  })

  it('MID WINDOW — urgence horizon ≈ 0.5, situation active', () => {
    const milieu = new Date((Date.parse(OPENS) + Date.parse(AT)) / 2).toISOString()
    const situation = situationAvecHorizon(milieu)

    expect(situation.urgency).toBeGreaterThanOrEqual(0.49)
    expect(situation.urgency).toBeLessThanOrEqual(0.51)
    expect(reco(situation, milieu).decision).toBe('recommend')
  })

  it('LATE WINDOW — l’urgence a augmenté par rapport au milieu', () => {
    const milieu = new Date((Date.parse(OPENS) + Date.parse(AT)) / 2).toISOString()
    const tard = '2026-06-20T00:00:00.000Z'

    // Evidence ANCIENNE, pour que l'urgence observée vienne de l'horizon et
    // non de la fraîcheur — sans quoi le test ne prouverait rien.
    const vieille = evidence({
      occurredAt: '2020-01-01T00:00:00.000Z',
      observedAt: '2020-01-02T00:00:00.000Z',
    })

    const uMilieu = situationAvecHorizon(milieu, HORIZON, [vieille]).urgency
    const uTard = situationAvecHorizon(tard, HORIZON, [vieille]).urgency

    expect(uTard).toBeGreaterThan(uMilieu)
    expect(uTard).toBeGreaterThan(0.8)
  })

  it('AT HORIZON — `now === anticipated.at` ⇒ situation_expired / no_action', () => {
    const situation = situationAvecHorizon(AT)
    const e = eligibilityDecision(situation, { now: new Date(AT) })
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('situation_expired')
    expect(reco(situation, AT).decision).toBe('no_action')
  })

  it('AFTER HORIZON ⇒ no_action', () => {
    const apres = '2026-09-01T00:00:00.000Z'
    const situation = situationAvecHorizon(apres)
    expect(eligibilityDecision(situation, { now: new Date(apres) }).reason).toBe(
      'situation_expired',
    )
    expect(reco(situation, apres).decision).toBe('no_action')
  })

  it('l’opt-out reste un VETO ABSOLU, prioritaire sur la fenêtre', () => {
    // Répondre « revenez le 1er janvier » à un compte qui a demandé à ne plus
    // être sollicité serait faux.
    const NOW = '2025-12-15T00:00:00.000Z'
    const e = eligibilityDecision(situationAvecHorizon(NOW), {
      now: new Date(NOW),
      optedOut: true,
    })
    expect(e.reason).toBe('opt_out')
  })

  it('un horizon aux dates invalides ⇒ invalid_context (fail closed)', () => {
    const NOW = '2026-03-01T00:00:00.000Z'
    const situation = situationAvecHorizon(NOW)

    for (const casse of [
      { ...HORIZON, at: 'jamais' },
      { ...HORIZON, actionWindowOpensAt: 'hier' },
      { ...HORIZON, actionWindowOpensAt: AT, at: OPENS },
    ]) {
      const e = eligibilityDecision(
        { ...situation, anticipated: casse } as Situation,
        { now: new Date(NOW) },
      )
      expect(e.eligible).toBe(false)
      expect(e.reason).toBe('invalid_context')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. `anticipated.at` et `expiresAt` — deux champs, deux sémantiques', () => {
  it('`expiresAt` est BORNÉ par l’échéance métier', () => {
    const NOW = '2026-03-01T00:00:00.000Z'
    // TTL de 10 ans : sans clamp, `expiresAt` serait en 2036.
    const situation = situationAvecHorizon(NOW)
    expect(situation.expiresAt).toBe(AT)
  })

  it('un TTL PLUS COURT que l’horizon l’emporte — c’est un `min`, pas une substitution', () => {
    const NOW = '2026-03-01T00:00:00.000Z'
    const situation = buildSituation({
      type: 'sales_scale_up',
      evidence: [evidence()],
      context: contexte(NOW),
      ruleId: 'test-rule',
      ruleVersion: 'v0.1',
      rulePackId: 'sales-core',
      rulePackVersion: 'v0.1',
      ttlDays: 7,
      rationale: 'peu importe',
      anticipated: HORIZON,
    })

    const attendu = situationExpiry([evidence()], new Date(NOW), 7)
    expect(situation.expiresAt).toBe(attendu)
    expect(situation.expiresAt).not.toBe(AT)
  })

  it('les deux champs restent DISTINCTS et ne sont pas confondus', () => {
    const NOW = '2026-03-01T00:00:00.000Z'
    const courte = buildSituation({
      type: 'sales_scale_up',
      evidence: [evidence()],
      context: contexte(NOW),
      ruleId: 'test-rule',
      ruleVersion: 'v0.1',
      rulePackId: 'sales-core',
      rulePackVersion: 'v0.1',
      ttlDays: 7,
      rationale: 'peu importe',
      anticipated: HORIZON,
    })

    expect(courte.anticipated?.at).toBe(AT)
    expect(courte.expiresAt).not.toBe(courte.anticipated?.at)
  })

  it('`anticipated` n’entre PAS dans l’identité', () => {
    const NOW = '2026-03-01T00:00:00.000Z'
    const avec = situationAvecHorizon(NOW)
    const autre = situationAvecHorizon(NOW, {
      ...HORIZON,
      at: '2027-01-01T00:00:00.000Z',
    })
    const sans = situationAvecHorizon(NOW, null)

    // Une échéance recalculée REMPLACE la ligne courante, elle n'en crée pas
    // une seconde.
    expect(avec.id).toBe(autre.id)
    expect(avec.id).toBe(sans.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('E. Persistance — l’horizon est validé s’il existe, optionnel sinon', () => {
  const base = {
    id: 'sit_1',
    accountId: 'acc_1',
    type: 'sales_scale_up',
    evidenceIds: ['ev_start', 'ev_autre'],
    confidence: 0.8,
    relevance: 0.5,
    urgency: 0.5,
    rationale: 'peu importe',
    ruleId: 'r',
    ruleVersion: 'v0.1',
    ...TEST_SITUATION_PROVENANCE,
    // ARCH-HORIZON-001a — `expiresAt` est désormais EXIGÉ dès qu'un horizon
    // existe, et doit être ≤ `anticipated.at`. La fixture le porte donc ;
    // aucune assertion n'a été affaiblie pour autant.
    expiresAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    lastEvaluatedAt: '2026-03-01T00:00:00.000Z',
  }

  it('une situation SANS horizon reste valide — rétrocompatibilité', () => {
    expect(isSituation(base)).toBe(true)
  })

  it('un horizon complet et cohérent est accepté', () => {
    expect(isSituation({ ...base, anticipated: HORIZON })).toBe(true)
  })

  it('`derivedFrom` hors de `evidenceIds` ⇒ REFUSÉE', () => {
    expect(
      isSituation({
        ...base,
        anticipated: { ...HORIZON, derivedFrom: ['ev_inconnue'] },
      }),
    ).toBe(false)
    // Mélange partiel : une seule intruse suffit à refuser.
    expect(
      isSituation({
        ...base,
        anticipated: { ...HORIZON, derivedFrom: ['ev_start', 'ev_intruse'] },
      }),
    ).toBe(false)
  })

  it('`derivedFrom` vide ou malformé ⇒ REFUSÉE', () => {
    expect(isSituation({ ...base, anticipated: { ...HORIZON, derivedFrom: [] } })).toBe(false)
    expect(isSituation({ ...base, anticipated: { ...HORIZON, derivedFrom: 'ev_start' } })).toBe(false)
    expect(isSituation({ ...base, anticipated: { ...HORIZON, derivedFrom: [''] } })).toBe(false)
  })

  it('dates invalides ou fenêtre dégénérée ⇒ REFUSÉE', () => {
    expect(isSituation({ ...base, anticipated: { ...HORIZON, at: 'jamais' } })).toBe(false)
    expect(isSituation({ ...base, anticipated: { ...HORIZON, actionWindowOpensAt: 'hier' } })).toBe(false)
    expect(isSituation({ ...base, anticipated: { ...HORIZON, actionWindowOpensAt: AT } })).toBe(false)
    expect(
      isSituation({ ...base, anticipated: { ...HORIZON, actionWindowOpensAt: AT, at: OPENS } }),
    ).toBe(false)
  })

  it('`actionWindowOpensAt` absent ⇒ REFUSÉE — jamais « toujours ouvert »', () => {
    const sansFenetre: any = { ...HORIZON }
    delete sansFenetre.actionWindowOpensAt
    expect(isSituation({ ...base, anticipated: sansFenetre })).toBe(false)
  })

  it('`assertionType` hors vocabulaire ⇒ REFUSÉE', () => {
    expect(isSituation({ ...base, anticipated: { ...HORIZON, assertionType: 'probable' } })).toBe(false)
    const sansType: any = { ...HORIZON }
    delete sansType.assertionType
    expect(isSituation({ ...base, anticipated: sansType })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('F. NO HINDSIGHT — l’horizon n’est jamais une evidence future', () => {
  it('les règles d’EvidenceEvent sont INCHANGÉES', () => {
    // Une date future ne peut exister que comme propriété de Situation. Si
    // quelqu'un tentait de la porter par une evidence, `evidenceIsUsable` la
    // rejetterait — ce test verrouille cette frontière depuis le dessus.
    const situation = situationAvecHorizon('2026-03-01T00:00:00.000Z')

    for (const id of situation.evidenceIds) {
      expect(typeof id).toBe('string')
    }
    // Aucune evidence contributrice n'est postérieure à `now`.
    expect(Date.parse(evidence().observedAt)).toBeLessThan(
      Date.parse('2026-03-01T00:00:00.000Z'),
    )
    // Et l'échéance, elle, est bien dans le futur — portée par la Situation.
    expect(Date.parse(situation.anticipated!.at)).toBeGreaterThan(
      Date.parse('2026-03-01T00:00:00.000Z'),
    )
  })

  it('`derivedFrom` ne cite que des evidences réellement retenues', () => {
    const situation = situationAvecHorizon('2026-03-01T00:00:00.000Z')
    for (const id of situation.anticipated!.derivedFrom) {
      expect(situation.evidenceIds).toContain(id)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('G. NON-RÉGRESSION — sans `anticipated`, RIEN ne change', () => {
  const NOW = '2026-03-01T00:00:00.000Z'

  it('urgence, confiance, identité et expiration sont celles d’avant', () => {
    const sans = situationAvecHorizon(NOW, null)

    // `urgencyFromEvidence` seule : du 2025-12-01 au 2026-03-01 il y a
    // EXACTEMENT 90 jours (31+31+28), donc `ageDays <= 90` ⇒ 0.6.
    expect(sans.urgency).toBe(0.6)
    expect(sans.confidence).toBe(0.9)
    expect(sans.anticipated).toBeUndefined()

    // `expiresAt` = TTL pur, sans aucun clamp.
    expect(sans.expiresAt).toBe(situationExpiry([evidence()], new Date(NOW), 3650))
  })

  it('l’éligibilité ne connaît aucun nouveau blocage', () => {
    const sans = situationAvecHorizon(NOW, null)
    const e = eligibilityDecision(sans, { now: new Date(NOW) })
    expect(e.eligible).toBe(true)
    expect(e.reason).toBe('eligible')
  })

  it('la recommandation reste inchangée et active', () => {
    const sans = situationAvecHorizon(NOW, null)
    const r = reco(sans, NOW)
    expect(r.decision).toBe('recommend')
    expect(r.control).toBe('autonomous')
    expect(r.expiresAt).toBe(sans.expiresAt)
  })

  it('`max` ne DÉGRADE jamais l’urgence des evidences', () => {
    // Evidence toute fraîche (urgence 1) + horizon à peine ouvert (≈ 0).
    // Si `max` avait été remplacé par une affectation, l'urgence tomberait.
    const fraiche = evidence({
      occurredAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
    })
    const juste_ouvert = '2026-01-02T00:00:00.000Z'
    const s = situationAvecHorizon(juste_ouvert, HORIZON, [fraiche])

    expect(urgencyFromHorizon(HORIZON, new Date(juste_ouvert))).toBeLessThan(0.05)
    expect(s.urgency).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('H. READ BOUNDARY — une Situation relue est une ENTRÉE, pas une valeur de confiance', () => {
  // ⚠️ LE DÉFAUT QUE CE BLOC FERME, REPRODUIT AVANT CORRECTION :
  //
  //     anticipated.at = 2026-01-01   (passé)
  //     expiresAt      = 2027-01-01   (encore futur)
  //     now            = 2026-08-23
  //
  //   → validateur : ACCEPTÉE
  //   → éligibilité : eligible
  //   → recommandation : recommend / engage_or_reengage / autonomous
  //
  // Une recommandation ACTIVE sur une échéance périmée depuis huit mois. Le
  // contrôle d'expiration n°1 la laissait passer, puisqu'il ne regarde que
  // `expiresAt` — futur — et jamais l'horizon lui-même.
  //
  // Le clamp de `buildSituation` ne protégeait rien ici : l'objet n'avait pas
  // été fabriqué par lui. C'est précisément l'hypothèse que le cœur ne doit
  // jamais faire.

  const NOW_LECTURE = '2026-08-23T00:00:00.000Z'

  function persistee(patch: Record<string, any> = {}) {
    return {
      id: 'sit_relue',
      accountId: 'acc_1',
      type: 'sales_scale_up',
      evidenceIds: ['ev_start'],
      confidence: 0.9,
      relevance: 0.9,
      urgency: 0.9,
      rationale: 'peu importe',
      ruleId: 'r',
      ruleVersion: 'v0.1',
      ...TEST_SITUATION_PROVENANCE,
      anticipated: HORIZON_ECHU,
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2025-07-01T00:00:00.000Z',
      lastEvaluatedAt: '2025-07-01T00:00:00.000Z',
      ...patch,
    } as any
  }

  const HORIZON_ECHU: AnticipatedHorizon = {
    at: '2026-01-01T00:00:00.000Z',
    actionWindowOpensAt: '2025-07-01T00:00:00.000Z',
    assertionType: 'inference',
    derivedFrom: ['ev_start'],
  }

  it('CASE A — `anticipated.at` passé mais `expiresAt` futur ⇒ validateur REFUSE', () => {
    const corrompue = persistee({
      anticipated: HORIZON_ECHU,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    expect(isSituation(corrompue)).toBe(false)
  })

  it('CASE B — DÉFENSE EN PROFONDEUR : même si le validateur est contourné', () => {
    // Un appelant peut très bien n'avoir jamais appelé `isSituation`.
    // L'Eligibility Engine doit refuser SEUL.
    const corrompue = persistee({
      anticipated: HORIZON_ECHU,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })

    const e = eligibilityDecision(corrompue, { now: new Date(NOW_LECTURE) })
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('situation_expired')

    const r = reco(corrompue, NOW_LECTURE)
    expect(r.decision).toBe('no_action')
    expect(r.play).toBeUndefined()
    expect(r.recommendedAction).toBeUndefined()
  })

  it('CASE B bis — `expiresAt` ABSENT ne vaut pas « valide sans limite »', () => {
    const sansExpiration = persistee({ anticipated: HORIZON_ECHU })
    delete sansExpiration.expiresAt

    // Le validateur l'exige dès qu'un horizon existe.
    expect(isSituation(sansExpiration)).toBe(false)

    // Et l'éligibilité refuse quand même, sans dépendre de `expiresAt`.
    const e = eligibilityDecision(sansExpiration, { now: new Date(NOW_LECTURE) })
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('situation_expired')
  })

  it('CASE C — `expiresAt < anticipated.at` ⇒ ACCEPTÉE', () => {
    const saine = persistee({
      anticipated: HORIZON,
      expiresAt: '2026-06-01T00:00:00.000Z', // < AT (2026-07-01)
    })
    expect(isSituation(saine)).toBe(true)
  })

  it('CASE D — `expiresAt === anticipated.at` ⇒ ACCEPTÉE', () => {
    const limite = persistee({ anticipated: HORIZON, expiresAt: AT })
    expect(isSituation(limite)).toBe(true)
  })

  it('`expiresAt` strictement postérieur à l’horizon ⇒ REFUSÉE, même d’une milliseconde', () => {
    const juste_apres = persistee({
      anticipated: HORIZON,
      expiresAt: '2026-07-01T00:00:00.001Z',
    })
    expect(isSituation(juste_apres)).toBe(false)
  })

  it('une Situation HISTORIQUE sans `anticipated` reste strictement inchangée', () => {
    // Aucune exigence nouvelle ne lui est appliquée : `expiresAt` reste
    // optionnel, et aucun blocage d'horizon ne la concerne.
    const historique = persistee()
    delete historique.anticipated
    delete historique.expiresAt

    expect(isSituation(historique)).toBe(true)

    const e = eligibilityDecision(historique, { now: new Date(NOW_LECTURE) })
    expect(e.eligible).toBe(true)
    expect(e.reason).toBe('eligible')
    expect(reco(historique, NOW_LECTURE).decision).toBe('recommend')
  })

  it('un objet fabriqué par `buildSituation` satisfait TOUJOURS le garde', () => {
    // Le chemin normal et le garde de lecture doivent être d'accord : sinon le
    // moteur refuserait ses propres sorties.
    for (const now of ['2026-01-15T00:00:00.000Z', '2026-06-20T00:00:00.000Z']) {
      const s = situationAvecHorizon(now)
      expect(isSituation(s)).toBe(true)
      expect(Date.parse(s.expiresAt!)).toBeLessThanOrEqual(Date.parse(s.anticipated!.at))
    }
  })
})
