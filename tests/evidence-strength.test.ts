// SIGNAL_EVIDENCE_STRENGTH_V0_001 — LA FORCE EST STRUCTURELLE, PAS UN FLOTTANT.
//
// Classes fermées dérivées de FAITS DE PRODUCTION :
//   externe : gate canonique PASSÉ + adjudication humaine ⇒ EXTERNAL_CONFIRMED_CANONICAL
//   interne : conditions du producteur CRM ⇒ INTERNAL_RECORD / INTERNAL_CORROBORATED_RECORD
// Jamais persistée, jamais sur l'Evidence, jamais inférée de `confidence`,
// jamais fournie par un navigateur.
import { describe, expect, it } from 'vitest'

import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import {
  evidenceFromLeadsWithStrength,
  CORROBORATED_STATE_CONFIDENCE,
  RECORD_STATE_CONFIDENCE,
} from '../lib/prospector/proactive/dataBridge'
import { ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0 } from '../lib/prospector/proactive/signalBridge'
import { SALES_CORE, SALES_CORE_VERSION } from '../lib/prospector/proactive/packs/sales-core'
import { FABEL_PACK_VERSION } from '../lib/prospector/proactive/packs/real-estate-fabel'
import { validateEvalCase, EVAL_SCHEMA_VERSION } from '../lib/prospector/proactive/eval/caseSchema'
import { runEvalCase } from '../lib/prospector/proactive/eval/runCase'
import type { EvidenceEvent, EvidenceStrengthV0 } from '../lib/prospector/proactive/types'
import type { SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'
import type { Lead } from '../types/prospector'

const NOW = new Date('2026-09-05T12:00:00.000Z')
const COMPTE = 'acc_1'

function contexte(
  forces?: Readonly<Record<string, EvidenceStrengthV0>>,
): SituationEvaluationContext {
  return {
    now: NOW,
    accountId: COMPTE,
    relevance: 0.9,
    lensId: 'sales-default',
    lensVersion: 'v0.1',
    ...(forces ? { evidenceStrengthByEvidenceId: forces } : {}),
  }
}

/** Signal externe daté (dans la fenêtre) — la force vient du SIDE-CAR seul. */
function leveeExterne(patch: Record<string, unknown> = {}): EvidenceEvent {
  return {
    id: 'ev_fund', type: 'recent_funding', accountId: COMPTE, scope: 'account',
    temporality: 'dated_event', occurredAt: '2026-09-01',
    assertionType: 'fact', confidence: ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0,
    observedAt: NOW.toISOString(),
    acceptance: {
      kind: 'human_confirmed', actorId: 'alice',
      confirmedAt: NOW.toISOString(), canonicalKey: 'k', sourceUrls: [],
    },
    source: { provider: 'web_signal_search', url: 'https://acme.fr/presse' },
    ...patch,
  } as unknown as EvidenceEvent
}

function contexteManquant(): EvidenceEvent {
  return {
    id: 'ev_ctx', type: 'missing_context', accountId: COMPTE, scope: 'account',
    temporality: 'undated_state', assertionType: 'fact', confidence: 0.8,
    observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
  } as unknown as EvidenceEvent
}

const FORCE_FONDEE: Record<string, EvidenceStrengthV0> = {
  ev_fund: { kind: 'EXTERNAL_CONFIRMED_CANONICAL' },
}

const salesTypes = (evidence: EvidenceEvent[], forces?: Record<string, EvidenceStrengthV0>) =>
  evaluateSituations(evidence, contexte(forces), ['sales-core']).map((s) => s.type)

function lead(patch: Partial<Lead> = {}): Lead {
  return {
    id: 'ld_1', kind: 'account', firstName: '', lastName: '', title: '',
    company: 'Acme', score: 90, temperature: 'warm', status: 'froid',
    stage: 'to_invite', email: null, phone: null,
    siren: '552100554', website: 'https://acme.fr',
    ...patch,
  } as Lead
}

// ─────────────────────────────────────────────────────────────────────────────
describe('« signal fort » — autorité STRUCTURELLE, jamais une égalité de flottant', () => {
  it('2/15 — force structurelle présente ⇒ strong_signal_low_context ; absente ⇒ échec fermé', () => {
    expect(salesTypes([leveeExterne(), contexteManquant()], FORCE_FONDEE))
      .toContain('strong_signal_low_context')
    // MÊMES evidences, aucune autorité structurelle : jamais « fort ».
    expect(salesTypes([leveeExterne(), contexteManquant()]))
      .not.toContain('strong_signal_low_context')
  })

  it('3 — confidence 0.74 + autorité structurelle valide ⇒ fort quand même (aucune dépendance à 0.75)', () => {
    // 0.74 reste au-dessus du plancher de compatibilité global (0.6) mais SOUS
    // l'ancienne égalité 0.75 : la décision « fort » ne lit plus le flottant.
    expect(salesTypes(
      [leveeExterne({ confidence: 0.74 }), contexteManquant()],
      FORCE_FONDEE,
    )).toContain('strong_signal_low_context')
  })

  it('4 — confidence 0.99 SANS autorité structurelle ⇒ PAS fort — un flottant ne blanchit rien', () => {
    expect(salesTypes([leveeExterne({ confidence: 0.99 }), contexteManquant()]))
      .not.toContain('strong_signal_low_context')
  })

  it('19 — les règles qui n’exigent PAS la force structurelle sont inchangées', () => {
    // `sales_scale_up` (deux familles) ne lit pas la force : il se produit
    // avec ou sans carte — comportement antérieur préservé.
    const etat = {
      id: 'ev_jobs', type: 'sales_hiring', accountId: COMPTE, scope: 'account',
      temporality: 'undated_state', assertionType: 'fact', confidence: 0.8,
      observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    } as unknown as EvidenceEvent
    expect(salesTypes([leveeExterne(), etat])).toContain('sales_scale_up')
  })

  it('le détecteur ne lit PLUS le seuil numérique déprécié (verrou structurel)', () => {
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/packs/sales-core/index.ts', 'utf8')
    expect(src.includes('>= STRONG_EVIDENCE_CONFIDENCE')).toBe(false)
    // La règle décide sur la CLASSE, présente dans le détecteur.
    expect(src.includes("EXTERNAL_CONFIRMED_CANONICAL")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('force interne CRM — dérivée des CONDITIONS du producteur, jamais du flottant', () => {
  const forcesDe = (l: Lead) =>
    evidenceFromLeadsWithStrength([l], { now: NOW, tasks: { complete: false } })

  it('9 — temperature seule ⇒ INTERNAL_RECORD (et confidence héritée 0.8 inchangée)', () => {
    const r = forcesDe(lead({ temperature: 'hot', status: 'froid' }))
    const chaud = r.evidence.find((e) => e.type === 'hot_lead')
    if (!chaud) throw new Error('hot_lead attendu')
    expect(r.evidenceStrengthByEvidenceId[chaud.id]).toEqual({ kind: 'INTERNAL_RECORD' })
    expect(chaud.confidence).toBe(RECORD_STATE_CONFIDENCE)
  })

  it('10 — status seul ⇒ INTERNAL_RECORD', () => {
    const r = forcesDe(lead({ temperature: 'warm', status: 'chaud' }))
    const chaud = r.evidence.find((e) => e.type === 'hot_lead')
    if (!chaud) throw new Error('hot_lead attendu')
    expect(r.evidenceStrengthByEvidenceId[chaud.id]).toEqual({ kind: 'INTERNAL_RECORD' })
  })

  it('11 — temperature + status concordants ⇒ INTERNAL_CORROBORATED_RECORD (confidence héritée 0.9)', () => {
    const r = forcesDe(lead({ temperature: 'hot', status: 'chaud' }))
    const chaud = r.evidence.find((e) => e.type === 'hot_lead')
    if (!chaud) throw new Error('hot_lead attendu')
    expect(r.evidenceStrengthByEvidenceId[chaud.id])
      .toEqual({ kind: 'INTERNAL_CORROBORATED_RECORD' })
    expect(chaud.confidence).toBe(CORROBORATED_STATE_CONFIDENCE)
  })

  it('12/13 — la classe vient de la STRUCTURE : aucune dérivation depuis 0.8/0.9 (verrou structurel)', () => {
    // Le producteur SAIT combien de champs ont concordé ; relire le flottant
    // pour retrouver la classe re-sacrerait le scalaire hérité en autorité.
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/dataBridge.ts', 'utf8')
    for (const interdit of [
      'confidence === 0.8', 'confidence === 0.9',
      'confidence >= 0.9', 'confidence >= 0.8',
      '=== RECORD_STATE_CONFIDENCE', '=== CORROBORATED_STATE_CONFIDENCE',
      '.confidence ===', '.confidence >=',
    ]) {
      expect(src.includes(interdit), `dataBridge.ts dérive la classe de « ${interdit} »`).toBe(false)
    }
    // Toutes les autres evidences internes sont des enregistrements simples.
    const r = forcesDe(lead({ email: null, phone: null }))
    for (const e of r.evidence) {
      if (e.type === 'hot_lead') continue
      expect(r.evidenceStrengthByEvidenceId[e.id]).toEqual({ kind: 'INTERNAL_RECORD' })
    }
  })

  it('14 — les sorties numériques héritées restent inchangées (aucune falaise comportementale)', () => {
    expect(ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0).toBe(0.75)
    expect(RECORD_STATE_CONFIDENCE).toBe(0.8)
    expect(CORROBORATED_STATE_CONFIDENCE).toBe(0.9)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('versions, frontière de confiance, non-persistance', () => {
  it('16/17 — sales-core v0.3 ; Fabel INCHANGÉ v0.2', () => {
    expect(SALES_CORE_VERSION).toBe('v0.3')
    expect(SALES_CORE.packVersion).toBe('v0.3')
    expect(FABEL_PACK_VERSION).toBe('v0.2')
  })

  it('8 — la route promote ne lit la force QUE du gate canonique, jamais du corps de requête (verrou structurel)', () => {
    const { readFileSync } = require('node:fs')
    const src = readFileSync('pages/api/signals/promote.ts', 'utf8')
    const occurrences = src.split('evidenceStrengthByEvidenceId').length - 1
    // Exactement deux : le commentaire du bloc et le passage `porte.…`.
    expect(src.includes('evidenceStrengthByEvidenceId: porte.evidenceStrengthByEvidenceId')).toBe(true)
    expect(src.includes('corps.evidenceStrengthByEvidenceId')).toBe(false)
    expect(src.includes('body.evidenceStrengthByEvidenceId')).toBe(false)
    expect(occurrences).toBe(2)
    // Et le contrat de requête ne déclare pas le champ.
    expect(/interface PromoteRequest[\s\S]*?\n\}/.exec(src)![0].includes('evidenceStrength')).toBe(false)
  })

  it('20 — aucune écriture de force par la persistance (verrou structurel)', () => {
    // `persistEvaluation` ne connaît que evidence/situations/recommendations ;
    // la couche de persistance ne mentionne la force NULLE PART — la classe
    // est une métadonnée d'exécution, elle meurt avec l'évaluation.
    const { readFileSync } = require('node:fs')
    const persistance = readFileSync('lib/prospector/proactive/persistence.ts', 'utf8')
    expect(persistance.includes('Strength')).toBe(false)
    expect(persistance.includes('evidenceStrength')).toBe(false)
  })

  it('18 — parité runner : le cas déclare la force, le MÊME moteur décide', () => {
    const cas = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: '2026-09-05T12:00:00.000Z',
      businessContext: {
        contextId: 'strength-smoke', contextVersion: 'v0.1', role: 'sales_rep',
        scope: { mode: 'workspace' },
        authorizedMotions: {
          prepare_outreach: 'allowed', contact_prospect: 'allowed',
          enrich_data: 'allowed', schedule_reminder: 'allowed',
        },
        lensId: 'sales-default', lensVersion: 'v0.1',
      },
      targets: [{ accountId: COMPTE, relevance: 0.8 }],
      // Fixtures de la forme du smoke-case existant : le RUNNER ne fabrique
      // pas d'adjudication — il DÉCLARE la force comme vérité de fixture, et
      // c'est cette déclaration (pas un flottant) que le moteur consomme.
      evidence: [
        {
          id: 'ev_fund', accountId: COMPTE, type: 'recent_funding', scope: 'account',
          temporality: 'dated_event', occurredAt: '2026-09-01T00:00:00.000Z',
          observedAt: '2026-09-04T00:00:00.000Z', assertionType: 'fact',
          confidence: 0.75, source: { provider: 'smoke-fixture' },
        },
        {
          id: 'ev_ctx', accountId: COMPTE, type: 'missing_context', scope: 'account',
          temporality: 'undated_state', observedAt: '2026-09-04T00:00:00.000Z',
          assertionType: 'fact', confidence: 0.8, source: { provider: 'smoke-fixture' },
        },
      ],
      evidenceStrengthByEvidenceId: FORCE_FONDEE,
    }
    const v = validateEvalCase(cas)
    if (v.ok === false) throw new Error(JSON.stringify(v.errors))
    const avec = runEvalCase(v.case)
    expect(avec.situations.map((s) => s.type)).toContain('strong_signal_low_context')

    // Sans force déclarée : échec fermé — identique à la production.
    const sans = validateEvalCase({ ...cas, evidenceStrengthByEvidenceId: undefined })
    if (sans.ok === false) throw new Error(JSON.stringify(sans.errors))
    expect(runEvalCase(sans.case).situations.map((s) => s.type))
      .not.toContain('strong_signal_low_context')

    // Une classe INCONNUE est REFUSÉE fermée par le schéma.
    const invalide = validateEvalCase({
      ...cas,
      evidenceStrengthByEvidenceId: { ev_fund: { kind: 'PROBABLY_TRUE' } },
    })
    expect(invalide.ok).toBe(false)
  })
})
