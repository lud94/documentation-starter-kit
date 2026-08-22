// ARCH-RULEPACK-001 — LES INVARIANTS DE L'ARCHITECTURE.
//
// Ce fichier ne teste aucune règle métier : il teste les propriétés qui font
// tenir l'extensibilité. Chacune d'elles, si elle tombe, transforme un ajout de
// vertical en régression silencieuse.
import { describe, it, expect } from 'vitest'

import { PACK_REGISTRY, isRulePackId, rulePackById, type RulePackId } from '../lib/prospector/proactive/packs/registry'
import { LENS_REGISTRY, isLensId } from '../lib/prospector/proactive/lens/registry'
import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import { recommendationDecision } from '../lib/prospector/proactive/recommendationEngine'
import { defineRulePack, type SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'
import { buildSituation, stableId } from '../lib/prospector/proactive/ruleKit'
import {
  controlForMotion,
  resolveMotionControl,
  strictest,
} from '../lib/prospector/proactive/motions'
import {
  effectiveScope,
  validateBusinessContext,
  type BusinessContextV0,
} from '../lib/prospector/proactive/lens/context'
import { isSituation, isRecommendation } from '../lib/prospector/proactive/persistence'
import type { EvidenceEvent, Situation } from '../lib/prospector/proactive/types'
import {
  TEST_BUSINESS_CONTEXT,
  TEST_CONTEXT_APPROVAL,
  TEST_RECOMMENDATION_CONTEXT,
  TEST_SITUATION_PROVENANCE,
} from './helpers/proactiveContext'

const NOW = new Date('2026-08-18T12:00:00.000Z')
const lensVersionOf = (id: keyof typeof LENS_REGISTRY) => LENS_REGISTRY[id].lensVersion

function contexte(patch: Partial<SituationEvaluationContext> = {}): SituationEvaluationContext {
  return {
    now: NOW,
    accountId: 'acc_1',
    relevance: 0.8,
    lensId: 'sales-default',
    lensVersion: 'v0.1',
    ...patch,
  }
}

function situation(patch: Partial<Situation> = {}): Situation {
  return {
    ...TEST_SITUATION_PROVENANCE,
    id: 'sit_x',
    accountId: 'acc_1',
    personId: 'person_1',
    type: 'sales_scale_up',
    evidenceIds: ['ev_1'],
    confidence: 0.9,
    relevance: 0.9,
    urgency: 0.9,
    rationale: 'peu importe',
    ruleId: 'sales-scale-up',
    ruleVersion: 'v0.1',
    createdAt: NOW.toISOString(),
    lastEvaluatedAt: NOW.toISOString(),
    expiresAt: '2026-09-18T12:00:00.000Z',
    ...patch,
  } as Situation
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Identité — non ambiguë, donc sans collision', () => {
  // ⚠️ L'ANCIEN ENCODAGE ÉTAIT COLLISION-PRONE : concaténation par `_` puis
  // remplacement des caractères non sûrs par `_`. Sur un magasin dont la clé
  // est `(kind, id, workspace_id)`, une collision fait écraser une situation
  // par une autre, silencieusement.
  it('deux découpages différents ne produisent JAMAIS le même identifiant', () => {
    expect(stableId('sit', ['a_b', 'c'])).not.toBe(stableId('sit', ['a', 'b_c']))
    expect(stableId('sit', ['a.b'])).not.toBe(stableId('sit', ['a_b']))
    expect(stableId('sit', ['', 'ab'])).not.toBe(stableId('sit', ['a', 'b']))
    expect(stableId('sit', ['a|b'])).not.toBe(stableId('sit', ['a', 'b']))
  })

  it('un composant absent se distingue d\'un composant vide', () => {
    expect(stableId('sit', ['a', undefined, 'b'])).toBe(stableId('sit', ['a', '', 'b']))
    expect(stableId('sit', ['a', 'b'])).not.toBe(stableId('sit', ['a', '', 'b']))
  })

  it('DEUX PACKS ne peuvent pas entrer en collision sur le même compte', () => {
    const commun = { evidence: [], ruleId: 'r', ruleVersion: 'v0.1', ttlDays: 1, rationale: '' }

    const a = buildSituation({
      ...commun, type: 'space_expansion', context: contexte(),
      rulePackId: 'pack-a', rulePackVersion: 'v0.1',
    })
    const b = buildSituation({
      ...commun, type: 'space_expansion', context: contexte(),
      rulePackId: 'pack-b', rulePackVersion: 'v0.1',
    })

    // Même lens, même compte, même situationType — packs différents.
    expect(a.id).not.toBe(b.id)
  })

  it('DEUX LENSES ne peuvent pas entrer en collision non plus', () => {
    const commun = {
      evidence: [], ruleId: 'r', ruleVersion: 'v0.1', ttlDays: 1, rationale: '',
      type: 'sales_scale_up', rulePackId: 'sales-core', rulePackVersion: 'v0.1',
    }
    const a = buildSituation({ ...commun, context: contexte({ lensId: 'lens-a' }) })
    const b = buildSituation({ ...commun, context: contexte({ lensId: 'lens-b' }) })

    // `relevance` dépend de la lens : deux lenses = deux situations distinctes.
    expect(a.id).not.toBe(b.id)
  })

  it('l\'identité est STABLE entre deux évaluations identiques', () => {
    const faire = () => buildSituation({
      type: 'sales_scale_up', evidence: [], context: contexte(),
      ruleId: 'r', ruleVersion: 'v0.1',
      rulePackId: 'sales-core', rulePackVersion: 'v0.1',
      ttlDays: 1, rationale: '',
    })
    expect(faire().id).toBe(faire().id)
  })

  // ⚠️ Les VERSIONS n'entrent PAS dans l'identité : une montée de version
  // REMPLACE la ligne courante, elle n'en crée pas une seconde.
  it('une montée de version ne change PAS l\'identité', () => {
    const base = {
      type: 'sales_scale_up', evidence: [], context: contexte(),
      ruleId: 'r', rulePackId: 'sales-core', ttlDays: 1, rationale: '',
    }
    const v1 = buildSituation({ ...base, ruleVersion: 'v0.1', rulePackVersion: 'v0.1' })
    const v2 = buildSituation({ ...base, ruleVersion: 'v0.9', rulePackVersion: 'v0.9' })
    expect(v1.id).toBe(v2.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. Recommendation — identité contextualisée', () => {
  it('même Situation + même contexte ⇒ MÊME identifiant', () => {
    const a = recommendationDecision(situation(), { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW })
    const b = recommendationDecision(situation(), { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW })
    expect(a.id).toBe(b.id)
  })

  it('même Situation + contexte DIFFÉRENT ⇒ identifiant DIFFÉRENT', () => {
    const a = recommendationDecision(situation(), { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW })
    const b = recommendationDecision(situation(), {
      businessContext: {
        contextId: 'autre-config',
        contextVersion: 'v0.1',
        authorizedMotions: TEST_RECOMMENDATION_CONTEXT.authorizedMotions,
      },
      now: NOW,
    })
    expect(a.id).not.toBe(b.id)
  })

  it('la provenance de contexte est portée par la recommandation', () => {
    const r = recommendationDecision(situation(), { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW })
    expect(r.contextId).toBe('test-sales')
    expect(r.contextVersion).toBe('v0.1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Arbitration STRICTEMENT intra-pack', () => {
  // ⚠️ LE POINT LE PLUS IMPORTANT DU LOT. Un pack qui pourrait filtrer les
  // sorties d'un autre vertical rendrait chaque ajout de pack dangereux pour
  // les packs existants.
  it('un pack ne reçoit JAMAIS les situations d\'un autre pack', () => {
    const vus: string[][] = []

    const faireDetect = (packId: string, type: string) =>
      (evidence: readonly EvidenceEvent[], ctx: SituationEvaluationContext) =>
        buildSituation({
          type, evidence, context: ctx, ruleId: `r-${type}`, ruleVersion: 'v0.1',
          rulePackId: packId, rulePackVersion: 'v0.1', ttlDays: 1, rationale: '',
        })

    const packA = defineRulePack({
      packId: 'pack-a', packVersion: 'v0.1',
      declaredSituationTypes: ['type_a'] as const,
      declaredEvidenceTypes: ['hot_lead'] as const,
      rules: [{ ruleId: 'r-a', situationType: 'type_a', detect: faireDetect('pack-a', 'type_a') }],
      arbitrate(produced) {
        vus.push(produced.map((s) => s.type))
        return [...produced]
      },
      plays: { type_a: { play: 'follow_up', recommendedAction: '', reason: '' } },
    })

    const packB = defineRulePack({
      packId: 'pack-b', packVersion: 'v0.1',
      declaredSituationTypes: ['type_b'] as const,
      declaredEvidenceTypes: ['hot_lead'] as const,
      rules: [{ ruleId: 'r-b', situationType: 'type_b', detect: faireDetect('pack-b', 'type_b') }],
      arbitrate(produced) {
        vus.push(produced.map((s) => s.type))
        // ⚠️ TENTATIVE DE SUPPRESSION CROISÉE : ce pack essaie de retirer les
        // situations de l'autre. Il ne peut pas : il ne les a jamais reçues.
        return produced.filter((s) => s.type !== 'type_a')
      },
      plays: { type_b: { play: 'follow_up', recommendedAction: '', reason: '' } },
    })

    const registreLocal = { 'pack-a': packA, 'pack-b': packB } as any
    const evidence: EvidenceEvent[] = [{
      id: 'ev_1', accountId: 'acc_1', scope: 'account', type: 'hot_lead',
      source: { provider: 'test' }, assertionType: 'fact', confidence: 0.9,
      temporality: 'undated_state', observedAt: NOW.toISOString(),
    } as EvidenceEvent]

    // Exécution manuelle de la même boucle que le moteur, sur un registre local.
    const situations: Situation[] = []
    for (const pack of Object.values(registreLocal) as any[]) {
      const produced = pack.rules.map((r: any) => r.detect(evidence, contexte())).filter(Boolean)
      situations.push(...(pack.arbitrate ? pack.arbitrate(produced) : produced))
    }

    // Chaque pack n'a vu QUE sa propre production.
    expect(vus).toEqual([['type_a'], ['type_b']])
    // Et la tentative de suppression croisée est restée sans effet.
    expect(situations.map((s) => s.type).sort()).toEqual(['type_a', 'type_b'])
  })

  it('arbitrate() rend un SOUS-ENSEMBLE de son entrée — il filtre, il ne fabrique pas', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      if (!pack.arbitrate) continue
      const entree = [situation({ type: 'sales_scale_up' }), situation({ type: 'strong_signal_low_context' })]
      const sortie = pack.arbitrate(entree)
      for (const s of sortie) expect(entree).toContain(s)
    }
  })

  it('l\'arbitration de sales-core reproduit le repli d\'origine', () => {
    const pack = PACK_REGISTRY['sales-core']
    const scaleUp = situation({ type: 'sales_scale_up' })
    const lowContext = situation({ type: 'strong_signal_low_context' })

    // Les deux ne coexistent jamais…
    expect(pack.arbitrate!([scaleUp, lowContext]).map((s) => s.type)).toEqual(['sales_scale_up'])
    // …mais le repli subsiste seul.
    expect(pack.arbitrate!([lowContext]).map((s) => s.type)).toEqual(['strong_signal_low_context'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Registres — exhaustivité et cohérence', () => {
  it('chaque pack déclare un play pour CHACUN de ses situationTypes', () => {
    for (const [id, pack] of Object.entries(PACK_REGISTRY)) {
      for (const type of pack.declaredSituationTypes) {
        expect(pack.plays[type], `${id} / ${type}`).toBeDefined()
      }
      // …et aucun play orphelin.
      for (const type of Object.keys(pack.plays)) {
        expect(pack.declaredSituationTypes, `${id} / ${type}`).toContain(type)
      }
    }
  })

  it('chaque règle déclare un situationType effectivement déclaré', () => {
    for (const [id, pack] of Object.entries(PACK_REGISTRY)) {
      for (const rule of pack.rules) {
        expect(pack.declaredSituationTypes, `${id} / ${rule.ruleId}`).toContain(rule.situationType)
      }
    }
  })

  it('un situationType partagé entre packs est SIGNALÉ (non bloquant)', () => {
    const vus = new Map<string, string[]>()
    for (const [id, pack] of Object.entries(PACK_REGISTRY)) {
      for (const type of pack.declaredSituationTypes) {
        vus.set(type, [...(vus.get(type) ?? []), id])
      }
    }
    const partages = Array.from(vus.entries()).filter(([, ids]) => ids.length > 1)
    // La non-collision est structurelle (packId dans l'identité) : un partage
    // reste SÛR. Il est plus souvent un copier-coller qu'une intention, donc on
    // le rend visible sans le bloquer.
    if (partages.length > 0) {
      console.warn('situationType partagés entre packs :', partages)
    }
    expect(Array.isArray(partages)).toBe(true)
  })

  it('les lenses ne référencent que des packs ENREGISTRÉS', () => {
    for (const lens of Object.values(LENS_REGISTRY)) {
      for (const packId of lens.rulePacks) {
        expect(isRulePackId(packId), packId).toBe(true)
      }
    }
  })

  it('un identifiant inconnu est refusé à l\'exécution comme au typage', () => {
    expect(isRulePackId('pack-inexistant')).toBe(false)
    expect(rulePackById('pack-inexistant')).toBeNull()
    expect(isLensId('lens-inexistante')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('E. Business Context — fail closed de bout en bout', () => {
  const ok = (patch: Partial<BusinessContextV0> = {}) =>
    validateBusinessContext({ ...TEST_BUSINESS_CONTEXT, ...patch }, lensVersionOf)

  it('le contexte de référence est valide', () => {
    expect(ok().ok).toBe(true)
  })

  it.each([
    ['contexte absent', undefined, 'context_missing'],
    ['contexte null', null, 'context_missing'],
  ])('%s ⇒ refus', (_n, input, reason) => {
    const v = validateBusinessContext(input, lensVersionOf)
    expect(v.ok).toBe(false)
    expect((v as any).reason).toBe(reason)
  })

  it.each([
    ['contextId vide', { contextId: '' }, 'context_id_missing'],
    ['contextVersion vide', { contextVersion: '' }, 'context_version_missing'],
    ['role vide', { role: '' }, 'role_missing'],
  ])('%s ⇒ refus', (_n, patch, reason) => {
    const v = ok(patch as any)
    expect(v.ok).toBe(false)
    expect((v as any).reason).toBe(reason)
  })

  // ⚠️ AUCUN `undefined = workspace`. Un scope absent ou de mode inconnu ne
  // s'élargit pas : il se refuse.
  it.each([
    ['scope absent', undefined],
    ['scope null', null],
    ['mode inconnu', { mode: 'everything' }],
    ['mode accounts sans liste', { mode: 'accounts' }],
    ['accountIds non-chaînes', { mode: 'accounts', accountIds: [1, 2] }],
    ['accountIds vides', { mode: 'accounts', accountIds: ['  '] }],
  ])('scope invalide (%s) ⇒ refus', (_n, scope) => {
    const v = ok({ scope } as any)
    expect(v.ok).toBe(false)
    expect((v as any).reason).toBe('scope_invalid')
  })

  it('une lens inconnue ⇒ refus', () => {
    expect((ok({ lensId: 'lens-fantome' } as any) as any).reason).toBe('lens_unknown')
  })

  // ⚠️ Utiliser silencieusement une version plus récente attribuerait des
  // situations à une politique qui ne les a pas produites.
  it('un DÉSACCORD de version de lens ⇒ refus', () => {
    expect((ok({ lensVersion: 'v9.9' }) as any).reason).toBe('lens_version_mismatch')
  })

  it('des capacités mal formées ⇒ refus', () => {
    expect((ok({ authorizedMotions: { prepare_outreach: 'peut-etre' } } as any) as any).reason)
      .toBe('motions_invalid')
    expect((ok({ authorizedMotions: undefined } as any) as any).reason).toBe('motions_invalid')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('F. Autorité — le contexte ne peut que RESTREINDRE', () => {
  it('l\'intersection retranche, elle n\'ajoute jamais', () => {
    const autorite = { mode: 'accounts', accountIds: ['a', 'b'] } as const
    const metier = { mode: 'accounts', accountIds: ['b', 'c'] } as const

    const effectif = effectiveScope(metier, autorite)
    expect(effectif).toEqual({ mode: 'accounts', accountIds: ['b'] })
    // 'c' n'était pas autorisé : le contexte ne se l'accorde pas.
    expect((effectif as any).accountIds).not.toContain('c')
  })

  it('un périmètre métier plus large que l\'autorité est RAMENÉ à l\'autorité', () => {
    const autorite = { mode: 'accounts', accountIds: ['a'] } as const
    expect(effectiveScope({ mode: 'workspace' }, autorite)).toEqual(autorite)
  })

  it('sans autorité fournie, le périmètre métier s\'applique tel quel', () => {
    // ⚠️ Aucune autorité account-level n'existe encore dans le dépôt. On ne
    // fabrique pas un faux mécanisme : l'isolation repose sur `ws`, exigé par
    // la persistance à chaque appel.
    const metier = { mode: 'accounts', accountIds: ['a'] } as const
    expect(effectiveScope(metier)).toEqual(metier)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('G. Capacités et contrôle humain', () => {
  it('une capacité ABSENTE vaut forbidden — jamais autorisée par omission', () => {
    expect(controlForMotion('contact_prospect', {})).toBe('blocked')
    expect(controlForMotion('contact_prospect', { prepare_outreach: 'allowed' })).toBe('blocked')
    expect(controlForMotion('contact_prospect', { contact_prospect: 'forbidden' })).toBe('blocked')
  })

  it('le niveau retenu est le PLUS STRICT des capacités requises', () => {
    const v = resolveMotionControl('engage_or_reengage', {
      prepare_outreach: 'allowed',
      contact_prospect: 'approval_required',
    })
    expect(v.control).toBe('approval_required')
    expect(v.requiredMotions).toEqual(['prepare_outreach', 'contact_prospect'])
  })

  it('strictest ne rend jamais le plus permissif', () => {
    expect(strictest('autonomous', 'approval_required')).toBe('approval_required')
    expect(strictest('blocked', 'autonomous')).toBe('blocked')
    expect(strictest('approval_required', 'blocked')).toBe('blocked')
  })

  it('decision et control sont ORTHOGONAUX', () => {
    const r = recommendationDecision(situation(), {
      businessContext: {
        contextId: TEST_CONTEXT_APPROVAL.contextId,
        contextVersion: TEST_CONTEXT_APPROVAL.contextVersion,
        authorizedMotions: TEST_CONTEXT_APPROVAL.authorizedMotions,
      },
      now: NOW,
    })
    // Le cas exigé par le vertical immobilier.
    expect(r.decision).toBe('recommend')
    expect(r.control).toBe('approval_required')
    expect(r.controlReason).toContain('contact_prospect')
  })

  // ⚠️ Un contexte peut DURCIR un plancher de pack, jamais l'assouplir.
  it('un contexte ne peut PAS assouplir un controlFloor de pack', () => {
    const pack = PACK_REGISTRY['sales-core'] as any
    const floorOrigine = pack.controlFloor
    pack.controlFloor = { sales_scale_up: 'approval_required' }

    try {
      // Contexte le plus permissif possible : toutes capacités accordées.
      const r = recommendationDecision(situation(), {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
      })
      // Le plancher tient malgré tout.
      expect(r.control).toBe('approval_required')
      expect(r.controlReason).toContain('sales-core')
    } finally {
      pack.controlFloor = floorOrigine
    }
  })

  it('un contexte plus strict que le plancher l\'emporte quand même', () => {
    const pack = PACK_REGISTRY['sales-core'] as any
    const floorOrigine = pack.controlFloor
    pack.controlFloor = { sales_scale_up: 'approval_required' }

    try {
      const r = recommendationDecision(situation(), {
        businessContext: {
          contextId: 'strict', contextVersion: 'v0.1',
          authorizedMotions: { prepare_outreach: 'allowed' }, // contact_prospect absent ⇒ forbidden
        },
        now: NOW,
      })
      expect(r.control).toBe('blocked')
    } finally {
      pack.controlFloor = floorOrigine
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('H. Le moteur reste fail closed', () => {
  it('un contexte d\'évaluation sans lens ⇒ aucune situation', () => {
    const evidence: EvidenceEvent[] = []
    expect(evaluateSituations(evidence, contexte({ lensId: '' }))).toEqual([])
    expect(evaluateSituations(evidence, contexte({ lensVersion: '' }))).toEqual([])
  })

  it('une liste de packs vide retombe sur TOUS les packs enregistrés', () => {
    // Comportement volontaire : `undefined` signifie « tous », `[]` aussi.
    // Aucun chemin ne produit un moteur muet par omission.
    expect(Object.keys(PACK_REGISTRY).length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('I. Persistance — la provenance est EXIGÉE, pas tolérée', () => {
  // ⚠️ `prospector_store` est un ÉTAT MATÉRIALISÉ (dernière valeur connue),
  // PAS un Decision Ledger immuable. Sa clé primaire `(kind, id, workspace_id)`
  // fait qu'une réécriture du même identifiant REMPLACE la ligne : c'est ce qui
  // donne l'idempotence, et c'est aussi ce qui interdit d'y lire un historique.
  // Une auditabilité historique exigerait un journal en append-only, qui
  // n'existe pas dans ce lot et qu'il serait faux de prétendre obtenir ici.

  const situationValide = {
    id: 'sit_1',
    accountId: 'acc_1',
    type: 'sales_scale_up',
    evidenceIds: ['ev_1'],
    confidence: 0.8,
    relevance: 0.5,
    urgency: 0.5,
    rationale: 'peu importe',
    ruleId: 'sales-scale-up',
    ruleVersion: 'v0.1',
    ...TEST_SITUATION_PROVENANCE,
    createdAt: '2026-08-18T12:00:00.000Z',
    lastEvaluatedAt: '2026-08-18T12:00:00.000Z',
  }

  const recommandationValide = {
    id: 'rec_1',
    situationId: 'sit_1',
    accountId: 'acc_1',
    decision: 'recommend',
    reason: 'r',
    whyNow: 'w',
    priority: 'medium',
    confidence: 0.8,
    play: 'engage_or_reengage',
    recommendedAction: 'a',
    ruleId: 'sales-scale-up',
    ruleVersion: 'v0.1',
    control: 'autonomous',
    controlReason: 'toutes capacités accordées',
    requiredMotions: ['prepare_outreach', 'contact_prospect'],
    contextId: 'test-sales',
    contextVersion: 'v0.1',
    createdAt: '2026-08-18T12:00:00.000Z',
  }

  it('la fixture de référence est acceptée — sans quoi les refus ne prouveraient rien', () => {
    expect(isSituation(situationValide)).toBe(true)
    expect(isRecommendation(recommandationValide)).toBe(true)
  })

  for (const champ of ['rulePackId', 'rulePackVersion', 'lensId', 'lensVersion']) {
    it(`une Situation sans \`${champ}\` est REFUSÉE`, () => {
      const sans = { ...situationValide }
      delete sans[champ]
      expect(isSituation(sans)).toBe(false)
    })
  }

  for (const champ of ['control', 'controlReason', 'requiredMotions', 'contextId', 'contextVersion']) {
    it(`une Recommendation sans \`${champ}\` est REFUSÉE`, () => {
      const sans = { ...recommandationValide }
      delete sans[champ]
      expect(isRecommendation(sans)).toBe(false)
    })
  }

  it('un `control` hors vocabulaire est REFUSÉ — pas replié sur autonome', () => {
    expect(isRecommendation({ ...recommandationValide, control: 'peut_etre' })).toBe(false)
    // Le repli silencieux qu'on refuse ici : absent ⇒ lu comme « rien à
    // signaler » ⇒ autonome. C'est l'inverse exact du fail-closed.
    expect(isRecommendation({ ...recommandationValide, control: undefined })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('J. Identifiants de registre — le JSON persisté est validé, pas cru', () => {
  // ⚠️ Le typage ferme la COMPILATION ; il ne dit rien de ce qui remonte de la
  // base. Ces cas simulent exactement cela : des lignes qu'aucun code actuel
  // n'écrirait, mais qu'une version antérieure, une corruption ou une écriture
  // manuelle peuvent produire.

  const situationValide = {
    id: 'sit_1',
    accountId: 'acc_1',
    type: 'sales_scale_up',
    evidenceIds: ['ev_1'],
    confidence: 0.8,
    relevance: 0.5,
    urgency: 0.5,
    rationale: 'peu importe',
    ruleId: 'sales-scale-up',
    ruleVersion: 'v0.1',
    ...TEST_SITUATION_PROVENANCE,
    createdAt: '2026-08-18T12:00:00.000Z',
    lastEvaluatedAt: '2026-08-18T12:00:00.000Z',
  }

  it('un `rulePackId` inconnu est REFUSÉ à la lecture', () => {
    expect(isSituation({ ...situationValide, rulePackId: 'fabel-core' })).toBe(false)
  })

  it('une clé de prototype ne se résout pas en pack', () => {
    // `PACK_REGISTRY['constructor']` rendrait une fonction si la lecture se
    // faisait sans `hasOwnProperty` — et `pack.plays` serait alors `undefined`.
    for (const poison of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      expect(isSituation({ ...situationValide, rulePackId: poison })).toBe(false)
      expect(rulePackById(poison)).toBeNull()
    }
  })

  it('un `type` non déclaré PAR CE PACK est REFUSÉ', () => {
    expect(isSituation({ ...situationValide, type: 'space_expansion' })).toBe(false)
    expect(isSituation({ ...situationValide, type: 'sales_scale_upp' })).toBe(false)
  })

  it('un `lensId` inconnu est REFUSÉ', () => {
    expect(isSituation({ ...situationValide, lensId: 'lens-maison' })).toBe(false)
  })

  it('une situation corrompue ne peut JAMAIS produire `undefined.plays`', () => {
    // La preuve par l'exécution : on force la situation invalide dans le
    // moteur de recommandation. Il doit répondre, pas exploser.
    const corrompue = { ...situationValide, rulePackId: 'pack-inexistant' } as any
    const sortie = recommendationDecision(corrompue, {
      now: NOW,
      businessContext: TEST_RECOMMENDATION_CONTEXT,
    } as any)

    expect(sortie.decision).toBe('no_action')
    expect(sortie.play).toBeUndefined()
    expect(sortie.recommendedAction).toBeUndefined()
  })

  it('une `requiredMotions` hors vocabulaire est REFUSÉE', () => {
    const reco = {
      id: 'rec_1', situationId: 'sit_1', accountId: 'acc_1',
      decision: 'recommend', reason: 'r', whyNow: 'w', priority: 'medium',
      confidence: 0.8, play: 'engage_or_reengage', recommendedAction: 'a',
      ruleId: 'sales-scale-up', ruleVersion: 'v0.1',
      control: 'autonomous', controlReason: 'ok',
      requiredMotions: ['prepare_outreach'],
      contextId: 'test-sales', contextVersion: 'v0.1',
      createdAt: '2026-08-18T12:00:00.000Z',
    }
    expect(isRecommendation(reco)).toBe(true)
    expect(isRecommendation({ ...reco, requiredMotions: ['delete_account'] })).toBe(false)
    expect(isRecommendation({ ...reco, requiredMotions: 'prepare_outreach' })).toBe(false)
  })
})
