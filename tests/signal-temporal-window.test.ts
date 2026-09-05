// SIGNAL_TEMPORAL_WINDOW_V0_001 — VRAI ≠ ACTUEL.
//
// Quatre quantités STRICTEMENT séparées, et ces tests verrouillent la frontière :
//   validité du FAIT        → jamais touchée ici (un fait ancien reste vrai)
//   autorité TEMPORELLE     → occurredAt (événement) / side-car du gate (état
//                             externe) / observedAt (état CRM interne)
//   fenêtre MÉTIER          → déclarée par la RÈGLE, appliquée par le CŒUR
//   urgence de SITUATION    → inchangée pour les evidences admissibles
//
// L'invariant central : LA REDÉCOUVERTE NE RAJEUNIT JAMAIS UN FAIT.
import { describe, expect, it } from 'vitest'

import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import {
  bestEvidenceByType,
  freshnessDeadlineMs,
  temporalReference,
  temporalWindowLookup,
  withinMaxAgeDays,
} from '../lib/prospector/proactive/ruleKit'
import { SALES_CORE } from '../lib/prospector/proactive/packs/sales-core'
import { eligibilityDecision } from '../lib/prospector/proactive/eligibility'
import type { EvidenceEvent, SignalTemporalAuthority } from '../lib/prospector/proactive/types'
import type { SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'

const NOW = new Date('2026-09-05T12:00:00.000Z')
const COMPTE = 'acc_1'

function contexte(
  autorite?: Readonly<Record<string, SignalTemporalAuthority>>,
): SituationEvaluationContext {
  return {
    now: NOW,
    accountId: COMPTE,
    relevance: 0.9,
    lensId: 'sales-default',
    lensVersion: 'v0.1',
    ...(autorite ? { temporalAuthorityByEvidenceId: autorite } : {}),
  }
}

/** Levée EXTERNE datée — l'autorité d'un événement daté est `occurredAt`. */
function levee(jour: string, patch: Record<string, unknown> = {}): EvidenceEvent {
  return {
    id: 'ev_fund', type: 'recent_funding', accountId: COMPTE, scope: 'account',
    temporality: 'dated_event', occurredAt: jour,
    assertionType: 'fact', confidence: 0.8,
    observedAt: NOW.toISOString(),
    source: { provider: 'web_signal_search', url: 'https://acme.fr/presse' },
    ...patch,
  } as unknown as EvidenceEvent
}

/** État de recrutement EXTERNE — l'autorité vient du SIDE-CAR, jamais d'ailleurs. */
function posteExterne(patch: Record<string, unknown> = {}): EvidenceEvent {
  return {
    id: 'ev_jobs', type: 'sales_hiring', accountId: COMPTE, scope: 'account',
    temporality: 'undated_state',
    assertionType: 'fact', confidence: 0.8,
    // ⚠️ VOLONTAIREMENT « frais » : ces deux horloges d'adjudication du jour
    // ne doivent JAMAIS rajeunir l'état — seul le side-car fait autorité.
    observedAt: NOW.toISOString(),
    acceptance: {
      kind: 'human_confirmed', actorId: 'alice',
      confirmedAt: NOW.toISOString(), canonicalKey: 'k', sourceUrls: [],
    },
    source: { provider: 'web_signal_search', url: 'https://acme.fr/jobs' },
    ...patch,
  } as unknown as EvidenceEvent
}

/** État CRM interne — là, et là seulement, `observedAt` EST l'observation. */
function etatCrm(id: string, type: string, observedAt = NOW.toISOString()): EvidenceEvent {
  return {
    id, type, accountId: COMPTE, scope: 'account',
    temporality: 'undated_state', assertionType: 'fact', confidence: 0.8,
    observedAt, source: { provider: 'prospector_crm' },
  } as unknown as EvidenceEvent
}

const AUTORITE_FRAICHE: Record<string, SignalTemporalAuthority> = {
  ev_jobs: { basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-09-04' },
}

const sales = (evidence: EvidenceEvent[], autorite?: Record<string, SignalTemporalAuthority>) =>
  evaluateSituations(evidence, contexte(autorite), ['sales-core']).map((s) => s.type)

describe('événements datés — la fenêtre de 90 jours de « recent_funding »', () => {
  it('1/2 — âge 0 jour et âge 90 jours (borne INCLUSE) ⇒ utilisables, sales_scale_up', () => {
    for (const jour of ['2026-09-05', '2026-06-07' /* exactement 90 jours */]) {
      expect(sales([levee(jour), posteExterne()], AUTORITE_FRAICHE), jour)
        .toContain('sales_scale_up')
    }
  })

  it('3/4 — âge 91 jours et âge 5 ans ⇒ EXCLUS de la règle, aucune sales_scale_up', () => {
    for (const jour of ['2026-06-06' /* 91 jours */, '2021-09-05']) {
      expect(sales([levee(jour), posteExterne()], AUTORITE_FRAICHE), jour)
        .not.toContain('sales_scale_up')
    }
  })

  it('5/6/7 — récupérée, adjugée ou RECAPTURÉE aujourd’hui : une vieille levée reste périmée (occurredAt fait foi)', () => {
    // `observedAt`, `acceptance.confirmedAt` ET la date de publication de la
    // source valent AUJOURD'HUI — aucune de ces horloges ne rajeunit le fait.
    const vieille = levee('2021-09-05', {
      observedAt: NOW.toISOString(),
      acceptance: {
        kind: 'human_confirmed', actorId: 'alice',
        confirmedAt: NOW.toISOString(), canonicalKey: 'k', sourceUrls: [],
      },
      source: {
        provider: 'web_signal_search', url: 'https://acme.fr/presse',
        // Publication récente AU FORMAT JOUR : le seul format qu'un substitut
        // d'horloge pourrait faire passer pour une date métier — il ne doit
        // JAMAIS servir de référence.
        provenance: { sourcePublishedAt: '2026-09-01', retrievedAt: NOW.toISOString() },
      },
    })
    expect(sales([vieille, posteExterne()], AUTORITE_FRAICHE)).not.toContain('sales_scale_up')
  })

  it('8 — à confiance ÉGALE, deux événements datés se départagent par occurredAt, jamais par observedAt', () => {
    const ancienReadjuge = levee('2026-08-01', { id: 'ev_vieux', observedAt: NOW.toISOString() })
    const recent = levee('2026-09-01', { id: 'ev_recent', observedAt: '2026-09-02T00:00:00.000Z' })
    const [choisi] = bestEvidenceByType([ancienReadjuge, recent], ['recent_funding'])
    expect(choisi.id).toBe('ev_recent')
  })
})

describe('états externes — l’autorité est le side-car immuable, fenêtre de 30 jours', () => {
  const enFenetre = (jour: string): Record<string, SignalTemporalAuthority> => ({
    ev_jobs: { basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: jour },
  })
  const LEVEE_OK = levee('2026-09-01')

  it('9 — dernier jour d’observation immuable à 30 jours (borne incluse) ⇒ utilisable', () => {
    expect(sales([LEVEE_OK, posteExterne()], enFenetre('2026-08-06'))).toContain('sales_scale_up')
  })

  it('10 — jour d’observation à 31 jours ⇒ EXCLU de la règle', () => {
    expect(sales([LEVEE_OK, posteExterne()], enFenetre('2026-08-05'))).not.toContain('sales_scale_up')
  })

  it('11 — ré-adjuger AUJOURD’HUI sans nouveau jour d’observation ne rafraîchit RIEN', () => {
    // `observedAt` et `confirmedAt` de la fixture valent NOW — seul le side-car
    // (vieux de 60 jours) fait autorité : l'état reste périmé.
    expect(sales([LEVEE_OK, posteExterne()], enFenetre('2026-07-07'))).not.toContain('sales_scale_up')
  })

  it('12 — une VRAIE ré-observation (nouveau jour immuable) rend l’état frais à nouveau', () => {
    expect(sales([LEVEE_OK, posteExterne()], enFenetre('2026-09-04'))).toContain('sales_scale_up')
  })

  it('13 — side-car ABSENT sous politique déclarée ⇒ échec fermé pour la règle', () => {
    expect(sales([LEVEE_OK, posteExterne()] /* aucune autorité */)).not.toContain('sales_scale_up')
  })

  it('15/16 — autorité FUTURE ou INVALIDE ⇒ exclue', () => {
    for (const jour of ['2026-09-06', 'pas-un-jour']) {
      expect(sales([LEVEE_OK, posteExterne()], enFenetre(jour)), jour).not.toContain('sales_scale_up')
    }
  })
})

describe('classification temporelle pure — les horloges légitimes, et elles seules', () => {
  it('14 — état CRM interne : observedAt EST la référence (durée exacte)', () => {
    const r = temporalReference(etatCrm('ev_hot', 'hot_lead', '2026-09-04T12:00:00.000Z'), NOW)
    expect(r).toEqual({ state: 'KNOWN', granularity: 'INSTANT', ms: Date.parse('2026-09-04T12:00:00.000Z') })
    expect(withinMaxAgeDays(r, NOW, 1)).toBe(true)
    expect(withinMaxAgeDays(r, NOW, 0)).toBe(false)
  })

  it('INCONNU ne satisfait JAMAIS une fenêtre déclarée', () => {
    const r = temporalReference(posteExterne(), NOW) // externe, sans autorité
    expect(r).toEqual({ state: 'UNKNOWN' })
    expect(withinMaxAgeDays(r, NOW, 36500)).toBe(false)
  })

  it('événement daté FUTUR ⇒ INVALID_OR_FUTURE, jamais utilisable', () => {
    const r = temporalReference(levee('2026-09-06'), NOW)
    expect(r).toEqual({ state: 'INVALID_OR_FUTURE' })
    expect(withinMaxAgeDays(r, NOW, 36500)).toBe(false)
    expect(freshnessDeadlineMs(r, 90)).toBeNull()
  })

  it('la sémantique de borne est documentée et EXACTE : jour N utilisable, jour N+1 périmé', () => {
    // Exemple du contrat : referenceDay 2026-06-07, maxAgeDays 90.
    const r = temporalReference(levee('2026-06-07'), NOW)
    expect(withinMaxAgeDays(r, new Date('2026-09-05T23:59:59.000Z'), 90)).toBe(true) // jour 90
    expect(withinMaxAgeDays(r, new Date('2026-09-06T00:00:00.000Z'), 90)).toBe(false) // jour 91
    // L'échéance persistable est le PREMIER instant périmé : minuit UTC du jour 91.
    expect(freshnessDeadlineMs(r, 90)).toBe(Date.parse('2026-09-06T00:00:00.000Z'))
  })
})

describe('borne de validité PERSISTÉE — la Situation n’enjambe pas la péremption de ses Signaux', () => {
  it('19 — levée à 89 jours, TTL 30 jours ⇒ expiresAt CLAMPÉ à l’échéance de fraîcheur, la PLUS PROCHE', () => {
    // Levée observée au jour 89 de sa fenêtre de 90 : périmée le 2026-09-07 à
    // minuit UTC. L'état externe, lui, expire bien plus tard (2026-10-05) : le
    // clamp doit retenir la PLUS PROCHE échéance, jamais la plus lointaine —
    // et sûrement pas le TTL réglementaire (now + 30 jours).
    const situations = evaluateSituations(
      [levee('2026-06-08'), posteExterne()],
      contexte(AUTORITE_FRAICHE),
      ['sales-core'],
    )
    const scale = situations.find((s) => s.type === 'sales_scale_up')
    if (!scale) throw new Error('sales_scale_up attendu')
    expect(scale.expiresAt).toBe('2026-09-07T00:00:00.000Z')
  })

  it('20 — passé l’échéance de fraîcheur, l’Eligibility EXISTANTE rejette la Situation persistée', () => {
    const situations = evaluateSituations(
      [levee('2026-06-08'), posteExterne()],
      contexte(AUTORITE_FRAICHE),
      ['sales-core'],
    )
    const scale = situations.find((s) => s.type === 'sales_scale_up')
    if (!scale) throw new Error('sales_scale_up attendu')
    const decision = eligibilityDecision(scale, { now: new Date('2026-09-07T00:00:00.001Z') } as any)
    expect(decision).toMatchObject({ eligible: false, reason: 'situation_expired' })
  })
})

describe('R1 — politique déclarée MALFORMÉE : jamais un échec ouvert', () => {
  it('lecture fermée : ABSENT ⇒ NONE ; entier valide ⇒ VALID ; tout le reste ⇒ INVALID', () => {
    expect(temporalWindowLookup({ recent_funding: 90 }, 'sales_hiring')).toEqual({ kind: 'NONE' })
    expect(temporalWindowLookup(undefined, 'recent_funding')).toEqual({ kind: 'NONE' })
    expect(temporalWindowLookup({ recent_funding: 90 }, 'recent_funding'))
      .toEqual({ kind: 'VALID', maxAgeDays: 90 })
    expect(temporalWindowLookup({ recent_funding: 0 }, 'recent_funding'))
      .toEqual({ kind: 'VALID', maxAgeDays: 0 })
    // ⚠️ AUCUNE COERCITION : « "90" » n'est pas 90 — l'unité est le jour ENTIER.
    for (const mauvaise of ['90', NaN, Infinity, -Infinity, -1, 1.5, null, {}, undefined]) {
      expect(temporalWindowLookup({ recent_funding: mauvaise }, 'recent_funding'), String(mauvaise))
        .toEqual({ kind: 'INVALID' })
    }
  })

  /** Corrompt LA politique de `sales-scale-up` à l'exécution, puis restaure. */
  function avecFenetreLeveeCorrompue(valeur: unknown, fn: () => void) {
    const regle: any = SALES_CORE.rules.find((r: any) => r.ruleId === 'sales-scale-up')
    const originale = regle.temporalPolicy
    regle.temporalPolicy = {
      maxAgeDaysByEvidenceType: {
        ...originale.maxAgeDaysByEvidenceType,
        recent_funding: valeur,
      },
    }
    try { fn() } finally { regle.temporalPolicy = originale }
  }

  it('A — clé ABSENTE ⇒ comportement antérieur préservé pour CE type', () => {
    const regle: any = SALES_CORE.rules.find((r: any) => r.ruleId === 'sales-scale-up')
    const originale = regle.temporalPolicy
    // Politique sans AUCUNE clé pour `recent_funding` : une levée de 5 ans
    // redevient consommable — c'est l'ancien comportement, et il est VOULU
    // pour une clé absente (aucune fenêtre déclarée).
    regle.temporalPolicy = { maxAgeDaysByEvidenceType: { sales_hiring: 30 } }
    try {
      expect(sales([levee('2021-09-05'), posteExterne()], AUTORITE_FRAICHE))
        .toContain('sales_scale_up')
    } finally { regle.temporalPolicy = originale }
  })

  it('B/C/D/E — valeur « "90" », NaN, ±Infinity, négative ⇒ l’evidence est EXCLUE, même toute fraîche', () => {
    for (const mauvaise of ['90', NaN, Infinity, -Infinity, -1]) {
      avecFenetreLeveeCorrompue(mauvaise, () => {
        // La levée date d'AUJOURD'HUI : sous une politique malformée elle est
        // quand même exclue — une fenêtre illisible RETIRE, elle n'élargit pas.
        expect(sales([levee('2026-09-05'), posteExterne()], AUTORITE_FRAICHE), String(mauvaise))
          .not.toContain('sales_scale_up')
      })
    }
  })

  it('M16 (comportemental) — une politique malformée ne redevient JAMAIS « aucune fenêtre »', () => {
    avecFenetreLeveeCorrompue('90', () => {
      // Une levée de 5 ans sous « "90" » : un effondrement INVALID → NONE la
      // laisserait passer sans AUCUNE fenêtre — l'échec ouvert exact du R1.
      expect(sales([levee('2021-09-05'), posteExterne()], AUTORITE_FRAICHE))
        .not.toContain('sales_scale_up')
    })
  })

  it('F/G — la politique VALIDE garde exactement ses bornes, et aucune Situation issue d’une politique malformée n’existe pour échapper au clamp', () => {
    // F : le contrat 90 jours inchangé (borne incluse / jour suivant périmé).
    expect(sales([levee('2026-06-07'), posteExterne()], AUTORITE_FRAICHE)).toContain('sales_scale_up')
    expect(sales([levee('2026-06-06'), posteExterne()], AUTORITE_FRAICHE)).not.toContain('sales_scale_up')
    // G : sous politique malformée, l'evidence n'atteint jamais `detect`, donc
    // AUCUNE Situation ne se forme qui pourrait enjamber le clamp d'expiration.
    avecFenetreLeveeCorrompue(NaN, () => {
      const situations = evaluateSituations(
        [levee('2026-09-05'), posteExterne()],
        contexte(AUTORITE_FRAICHE),
        ['sales-core'],
      )
      expect(situations.map((s) => s.type)).not.toContain('sales_scale_up')
    })
  })
})

describe('périmètre de la fenêtre — par RÈGLE, jamais globale', () => {
  it('21 — une règle SANS politique temporelle conserve le comportement antérieur à l’identique', () => {
    // `space-contraction` (Fabel) ne déclare aucune fenêtre : deux signaux de
    // 2021 la produisent toujours — le fait historique reste consommable.
    const vieux = (id: string, type: string) => ({
      id, type, accountId: COMPTE, scope: 'account',
      temporality: 'dated_event', occurredAt: '2021-06-01T00:00:00.000Z',
      assertionType: 'fact', confidence: 0.8,
      observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    }) as unknown as EvidenceEvent
    const types = evaluateSituations(
      [vieux('ev_down', 'workforce_contraction'), vieux('ev_reorg', 'restructuring_announced')],
      { ...contexte(), lensId: 'fabel-broker' },
      ['real-estate-fabel'],
    ).map((s) => s.type)
    expect(types).toContain('space_contraction')
  })

  it('17 — Fabel : une levée de 2021 ne co-fonde PLUS une expansion de 2026', () => {
    const site = {
      id: 'ev_site', type: 'site_expansion', accountId: COMPTE, scope: 'account',
      temporality: 'dated_event', occurredAt: '2026-08-20T00:00:00.000Z',
      assertionType: 'fact', confidence: 0.8,
      observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    } as unknown as EvidenceEvent
    const types = evaluateSituations(
      [levee('2021-09-05'), site],
      { ...contexte(), lensId: 'fabel-broker' },
      ['real-estate-fabel'],
    ).map((s) => s.type)
    expect(types).not.toContain('space_expansion')
  })

  it('18 — Fabel : une levée DANS la fenêtre + signal dynamique frais ⇒ sémantique préservée', () => {
    const site = {
      id: 'ev_site', type: 'site_expansion', accountId: COMPTE, scope: 'account',
      temporality: 'dated_event', occurredAt: '2026-08-20T00:00:00.000Z',
      assertionType: 'fact', confidence: 0.8,
      observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    } as unknown as EvidenceEvent
    const types = evaluateSituations(
      [levee('2026-07-01'), site],
      { ...contexte(), lensId: 'fabel-broker' },
      ['real-estate-fabel'],
    ).map((s) => s.type)
    expect(types).toContain('space_expansion')
  })

  it('LE PACK DÉCLARE, LE CŒUR APPLIQUE — aucun pack n’implémente le filtre lui-même (verrou structurel)', () => {
    const { readFileSync } = require('node:fs')
    for (const fichier of [
      'lib/prospector/proactive/packs/sales-core/index.ts',
      'lib/prospector/proactive/packs/real-estate-fabel/index.ts',
    ]) {
      const src = readFileSync(fichier, 'utf8')
      for (const interdit of ['withinMaxAgeDays', 'temporalReference', 'freshnessDeadlineMs']) {
        expect(src.includes(interdit), `${fichier} implémente « ${interdit} »`).toBe(false)
      }
    }
    // Et l'application vit bien dans le cœur.
    const moteur = readFileSync('lib/prospector/proactive/situationEngine.ts', 'utf8')
    expect(moteur.includes('withinMaxAgeDays')).toBe(true)
    expect(moteur.includes('freshnessDeadlineMs')).toBe(true)
  })
})
