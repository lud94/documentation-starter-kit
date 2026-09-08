// JS-015_MESSAGING_ARCHITECTURE_V0_001 — B1 (post-R4) : FONDATIONS MESSAGING.
//
// Verrouille : validation fail-closed (version de schéma incluse — R4-C3),
// identité RESOLVED-only, refus WhatsApp, Recommendation ≠ selectedAction,
// budgets ZÉRO légitimes, types épistémiques CANONIQUES (R4-C2),
// CONTRE-SIGNAL ≠ INCERTITUDE (R4-C4) + validation stricte des refs
// incertaines (R4-C5), termes interdits sûrs au runtime (R4-C6), fixtures :
// mécaniques anonymes ≠ Goldens nommés sans décision inventée (R4-C1),
// SQUAD non-activation, Shown ⊆ Used, provenance obligatoire, politique de
// canal qualitative, frontière du moteur, zéro LLM, zéro envoi.
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  MESSAGE_CHANNELS_V0,
  SELECTED_ACTIONS_V0,
  validateMessageReadyContext,
  isValidatedContext,
  type MessageReadyContextV0,
} from '../lib/prospector/messaging/messageContext'
import { projectCommunicationEvidence } from '../lib/prospector/messaging/communicationEvidence'
import {
  checkForbiddenClaims,
  deriveClaimConstraints,
  forbiddenClaimsFromReferentiel,
} from '../lib/prospector/messaging/claimPolicy'
import { CHANNEL_POLICIES_V0, resolveChannelPolicy } from '../lib/prospector/messaging/channelPolicy'
import { admitToEngine } from '../lib/prospector/messaging/messageEngineBoundary'
import {
  CONTRACT_MECHANICS_CASES_V0,
  GOLDEN_MESSAGING_FIXTURES_V0,
  PENDING_GOLDEN_SOURCE,
  UNSUPPORTED_FACT,
} from './fixtures/messaging/goldenFixtures'
import { getReferentiel } from '../lib/prospector/capabilities'

const MESSAGING_DIR = join(__dirname, '..', 'lib', 'prospector', 'messaging')
const MESSAGING_FILES = [
  'messageContext.ts', 'communicationEvidence.ts', 'claimPolicy.ts',
  'channelPolicy.ts', 'messageEngineBoundary.ts',
]
const lireSource = (f: string) => readFileSync(join(MESSAGING_DIR, f), 'utf8')

const EV = (n: number) => ({
  evidenceRef: `ev_${n}`,
  statement: `fait vérifiable ${n}`,
  provenance: { sourceRef: `sa_${n}`, observedAt: '2026-09-01' },
})

function contexteValide(over: Partial<MessageReadyContextV0> = {}): MessageReadyContextV0 {
  const evidence = [EV(1), EV(2)]
  return {
    schemaVersion: 'message-ready-context-v0.1',
    recipientRef: 'person_1',
    recipientIdentityState: 'RESOLVED',
    selectedAction: 'START_OUTREACH',
    outreachObjective: 'OPEN_CONVERSATION',
    selectedSituation: 'sit_1',
    whyNow: 'signal de croissance daté sur le compte',
    whyTalk: 'responsable du périmètre concerné',
    offerRef: 'offer_core',
    offerAngle: 'structuration acquisition',
    personaRole: 'HEAD_OF_SALES',
    relationshipState: 'COLD',
    channel: 'email',
    budgets: { assertionBudget: 3, evidenceBudget: 2, researchShownBudget: 1 },
    claimConstraints: {
      showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 3, epistemicByRef: {},
    },
    forbiddenClaims: { terms: ['copilote IA'] },
    communicationEvidence: evidence,
    ...over,
  }
}

describe('validation STRICTE fail-closed, zéro inférence', () => {
  it('identité non résolue (NEEDS_REVIEW et UNRESOLVED) ⇒ fermé', () => {
    for (const state of ['NEEDS_REVIEW', 'UNRESOLVED'] as const) {
      const r = validateMessageReadyContext(contexteValide({ recipientIdentityState: state }))
      expect(r.ok).toBe(false)
      expect((r as any).reasons).toContain('IDENTITY_NOT_RESOLVED')
    }
    expect(validateMessageReadyContext(contexteValide()).ok).toBe(true)
  })

  it('WhatsApp (et tout canal inconnu) ⇒ UNSUPPORTED_CHANNEL, sans supprimer le legacy', () => {
    for (const channel of ['whatsapp', 'sms', ''] as const) {
      const r = validateMessageReadyContext(contexteValide({ channel: channel as any }))
      expect(r.ok, channel).toBe(false)
      expect((r as any).reasons).toContain('UNSUPPORTED_CHANNEL')
    }
    expect(MESSAGE_CHANNELS_V0).toEqual(['linkedin', 'email'])
    expect(resolveChannelPolicy('whatsapp')).toEqual({ ok: false, reason: 'UNSUPPORTED_CHANNEL_V0' })
  })

  it('selectedAction absent/hors vocabulaire et Recommendation-like ⇒ fermés', () => {
    for (const action of [undefined, '', 'SEND_EMAIL',
      { recommendedAction: 'contact_prospect', whyNow: 'x' }] as const) {
      const r = validateMessageReadyContext(contexteValide({ selectedAction: action as any }))
      expect(r.ok).toBe(false)
      expect((r as any).reasons).toContain('MISSING_SELECTED_ACTION')
    }
    expect(SELECTED_ACTIONS_V0).toEqual(['START_OUTREACH', 'FOLLOW_UP', 'REPLY'])
    for (const f of MESSAGING_FILES) {
      const src = lireSource(f)
      expect(src.includes('recommendationEngine'), f).toBe(false)
      expect(src.includes('recommendedAction'), f).toBe(false)
    }
  })

  it('WHY NOW / WHY TALK / offre / angle absents ⇒ fermés, indépendamment', () => {
    expect((validateMessageReadyContext(contexteValide({ whyNow: ' ' })) as any).reasons).toContain('MISSING_WHY_NOW')
    expect((validateMessageReadyContext(contexteValide({ whyTalk: '' })) as any).reasons).toContain('MISSING_WHY_TALK')
    expect((validateMessageReadyContext(contexteValide({ offerRef: '' })) as any).reasons).toContain('MISSING_OFFER_REF')
    expect((validateMessageReadyContext(contexteValide({ offerAngle: '' })) as any).reasons).toContain('MISSING_OFFER_ANGLE')
  })
})

describe('R4-C3 — la version de schéma échoue FERMÉ', () => {
  it('15 — v0.1 exacte : acceptée', () => {
    expect(validateMessageReadyContext(contexteValide()).ok).toBe(true)
  })
  it('16/17/18 — absente, arbitraire, future : REJETÉES', () => {
    for (const schemaVersion of [undefined, '', 'n-importe-quoi', 'message-ready-context-v0.2'] as const) {
      const r = validateMessageReadyContext(contexteValide({ schemaVersion: schemaVersion as any }))
      expect(r.ok, String(schemaVersion)).toBe(false)
      expect((r as any).reasons).toContain('UNSUPPORTED_SCHEMA_VERSION')
    }
  })
})

describe('budgets ZÉRO légitimes ; négatif/non-entier fermés', () => {
  const zeroCtx = (budgets: any, cc: any) => contexteValide({ budgets, claimConstraints: cc })

  it('assertionBudget = 0 valide, impose maxAssertions = 0', () => {
    const ok = validateMessageReadyContext(zeroCtx(
      { assertionBudget: 0, evidenceBudget: 2, researchShownBudget: 1 },
      { showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 0, epistemicByRef: {} },
    ))
    expect(ok.ok).toBe(true)
    const ko = validateMessageReadyContext(zeroCtx(
      { assertionBudget: 0, evidenceBudget: 2, researchShownBudget: 1 },
      { showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 1, epistemicByRef: {} },
    ))
    expect(ko.ok).toBe(false)
  })

  it('evidenceBudget = 0 et researchShownBudget = 0 valides, zéro octroi', () => {
    const ok = validateMessageReadyContext(zeroCtx(
      { assertionBudget: 0, evidenceBudget: 0, researchShownBudget: 0 },
      { showableEvidenceRefs: [], uncertainAssertionRefs: [], maxAssertions: 0, epistemicByRef: {} },
    ))
    expect(ok.ok).toBe(true)
    const cc0 = deriveClaimConstraints([EV(1), EV(2)] as any, { assertionBudget: 3, evidenceBudget: 0, researchShownBudget: 0 })
    expect(cc0.showableEvidenceRefs).toEqual([])
    const ccShown0 = deriveClaimConstraints([EV(1)] as any, { assertionBudget: 2, evidenceBudget: 2, researchShownBudget: 0 })
    expect(ccShown0.showableEvidenceRefs).toEqual([])
    const ko = validateMessageReadyContext(zeroCtx(
      { assertionBudget: 2, evidenceBudget: 2, researchShownBudget: 0 },
      { showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 2, epistemicByRef: {} },
    ))
    expect(ko.ok).toBe(false)
  })

  it('négatif, non-entier et Shown > Used restent INVALIDES', () => {
    for (const budgets of [
      { assertionBudget: -1, evidenceBudget: 2, researchShownBudget: 1 },
      { assertionBudget: 3, evidenceBudget: 1.5, researchShownBudget: 1 },
      { assertionBudget: 3, evidenceBudget: 2, researchShownBudget: 3 },
      undefined,
    ]) {
      const r = validateMessageReadyContext(contexteValide({ budgets: budgets as any }))
      expect(r.ok).toBe(false)
      expect((r as any).reasons).toContain('MALFORMED_BUDGETS')
    }
  })
})

describe('R4-C2 — types épistémiques CANONIQUES, préservés exactement', () => {
  const evidenceRiche = [
    { ...EV(1), uncertainty: 'signal unique', temporalAuthority: { basis: 'DATED_EVENT_DAY', referenceDay: '2026-01-10' } as const },
    { ...EV(2), counterSignalRefs: ['ev_contra'], strength: { kind: 'INTERNAL_RECORD' } as const },
    { ...EV(3), strength: { kind: 'EXTERNAL_CONFIRMED_CANONICAL' } as const, temporalAuthority: { basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-08-13' } as const },
  ]
  const budgets = { assertionBudget: 3, evidenceBudget: 3, researchShownBudget: 2 }

  it('10 — EvidenceStrengthV0 canonique survit EXACTEMENT (projection + dérivation)', () => {
    const proj = projectCommunicationEvidence([{
      evidenceRef: 'ev_1', statement: 'x', sourceRef: 'sa_1', observedAt: '2026-08-13',
      strength: { kind: 'EXTERNAL_CONFIRMED_CANONICAL' },
    }])
    expect(proj.ok).toBe(true)
    expect((proj as any).items[0].strength).toEqual({ kind: 'EXTERNAL_CONFIRMED_CANONICAL' })
    const cc = deriveClaimConstraints(evidenceRiche as any, budgets)
    expect(cc.epistemicByRef.ev_2.strength).toEqual({ kind: 'INTERNAL_RECORD' })
    expect(cc.epistemicByRef.ev_3.strength).toEqual({ kind: 'EXTERNAL_CONFIRMED_CANONICAL' })
  })

  it('11/12 — DATED_EVENT_DAY et EXTERNAL_STATE_OBSERVED_DAY survivent EXACTEMENT (même valeur)', () => {
    const cc = deriveClaimConstraints(evidenceRiche as any, budgets)
    expect(cc.epistemicByRef.ev_1.temporalAuthority).toEqual({ basis: 'DATED_EVENT_DAY', referenceDay: '2026-01-10' })
    expect(cc.epistemicByRef.ev_1.temporalAuthority).toBe((evidenceRiche[0] as any).temporalAuthority)
    expect(cc.epistemicByRef.ev_3.temporalAuthority).toEqual({ basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-08-13' })
  })

  it('13 — aucune forme temporelle FACTICE ne subsiste dans les sources/tests B1', () => {
    const motifFactice = "kind: '" + "DATED'"
    for (const f of MESSAGING_FILES) {
      expect(lireSource(f).includes(motifFactice), f).toBe(false)
    }
    expect(readFileSync(join(__dirname, 'fixtures', 'messaging', 'goldenFixtures.ts'), 'utf8').includes(motifFactice)).toBe(false)
    expect(readFileSync(join(__dirname, 'messaging-foundations.test.ts'), 'utf8').includes(motifFactice)).toBe(false)
  })

  it('14 — plus aucun `unknown` pour force/autorité temporelle dans les contrats épistémiques', () => {
    const src = lireSource('messageContext.ts')
    expect(src.includes('strength?: unknown')).toBe(false)
    expect(src.includes('temporalAuthority?: unknown')).toBe(false)
    expect(src.includes('strength?: EvidenceStrengthV0')).toBe(true)
    expect(src.includes('temporalAuthority?: SignalTemporalAuthority')).toBe(true)
    expect(src.includes("import type { EvidenceStrengthV0, SignalTemporalAuthority } from '../proactive/types'")).toBe(true)
  })

  it('AUCUN seuil de fraîcheur/score inventé : transport, pas interprétation', () => {
    const src = lireSource('claimPolicy.ts')
    expect(/\b(30|60|90)\s*(jours|days)\b/i.test(src)).toBe(false)
    expect(/freshness|péremption|stale/i.test(src)).toBe(false)
  })
})

describe('R4-C4/C5 — CONTRE-SIGNAL ≠ INCERTITUDE, validation stricte', () => {
  const evidenceMixte = [
    { ...EV(1), uncertainty: 'montant non corroboré' },
    { ...EV(2), counterSignalRefs: ['ev_contra'] }, // contre-signal SEUL
    { ...EV(3) },
  ]
  const budgets = { assertionBudget: 3, evidenceBudget: 3, researchShownBudget: 1 }

  it('19/20/21 — la dérivation : incertitude ⇒ uncertain ; contre-signal seul ⇏ uncertain mais PRÉSERVÉ', () => {
    const cc = deriveClaimConstraints(evidenceMixte as any, budgets)
    expect(cc.uncertainAssertionRefs).toEqual(['ev_1'])                       // 19
    expect(cc.uncertainAssertionRefs).not.toContain('ev_2')                   // 20
    expect(cc.epistemicByRef.ev_2.counterSignalRefs).toEqual(['ev_contra'])   // 21 — identifiable COMME contre-signal
    expect(cc.epistemicByRef.ev_2.uncertainty).toBeUndefined()
  })

  it('22/23 — ref fantôme et ref « incertaine » sans incertitude réelle ⇒ rejet', () => {
    const fantome = validateMessageReadyContext(contexteValide({
      claimConstraints: { showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: ['ev_fantome'], maxAssertions: 3, epistemicByRef: {} },
    }))
    expect(fantome.ok).toBe(false)
    expect((fantome as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
    const sansPayload = validateMessageReadyContext(contexteValide({
      claimConstraints: {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: ['ev_2'], maxAssertions: 3,
        epistemicByRef: { ev_2: { counterSignalRefs: ['ev_contra'] } }, // pas d'uncertainty
      },
    }))
    expect(sansPayload.ok).toBe(false)
    expect((sansPayload as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
  })

  it('24 — incertitude portée par epistemicByRef mais OMISE de uncertainAssertionRefs ⇒ rejet', () => {
    const omise = validateMessageReadyContext(contexteValide({
      claimConstraints: {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 3,
        epistemicByRef: { ev_2: { uncertainty: 'incertitude vivante' } },
      },
    }))
    expect(omise.ok).toBe(false)
    expect((omise as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
    // Et la forme COHÉRENTE passe — l'incertitude vit dans l'ÉVIDENCE et sa
    // préservation dérivée, à l'identique (micro-patch : lignée exigée).
    const coherente = validateMessageReadyContext(contexteValide({
      communicationEvidence: [EV(1), { ...EV(2), uncertainty: 'incertitude vivante' }],
      claimConstraints: {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: ['ev_2'], maxAssertions: 3,
        epistemicByRef: { ev_2: { uncertainty: 'incertitude vivante' } },
      },
    }))
    expect(coherente.ok).toBe(true)
  })
})

describe('R4-C6 — termes interdits SÛRS au runtime', () => {
  it('25…30 — termes malformés ⇒ REJET de la validation, jamais une exception', () => {
    for (const terms of [
      [42], [null], [{}], [''], ['   '], ['copilote IA', 42],
    ]) {
      const r = validateMessageReadyContext(contexteValide({ forbiddenClaims: { terms: terms as any } }))
      expect(r.ok, JSON.stringify(terms)).toBe(false)
      expect((r as any).reasons).toContain('MISSING_FORBIDDEN_CLAIMS')
    }
  })

  it('31/32 — un tableau de chaînes valides passe, et checkForbiddenClaims ne peut pas lever sur un contexte validé', async () => {
    const v = validateMessageReadyContext(contexteValide({ forbiddenClaims: { terms: ['copilote IA', 'Revenue OS'] } }))
    expect(v.ok).toBe(true)
    const ctx = (v as any).validated.context
    expect(() => checkForbiddenClaims('Notre Revenue OS booste tout.', ctx.forbiddenClaims)).not.toThrow()
    expect(checkForbiddenClaims('Notre Revenue OS booste tout.', ctx.forbiddenClaims).ok).toBe(false)
    // L'adaptateur legacy continue de filtrer SON entrée de compatibilité.
    const referentiel = await getReferentiel()
    const forbidden = forbiddenClaimsFromReferentiel(referentiel)
    expect(forbidden.terms).toContain('copilote IA')
    expect(checkForbiddenClaims('Nous sommes votre Copilote IA.', forbidden).ok).toBe(false)
  })
})

describe('évidence, provenance, Shown ⊆ Used', () => {
  it('un icebreaker BRUT (texte sans ref/source/date) n’est PAS une évidence éligible', () => {
    const r = projectCommunicationEvidence([
      { evidenceRef: '', statement: 'Ils viennent de lever 10M€', sourceRef: '', observedAt: '' } as any,
    ])
    expect(r.ok).toBe(false)
    const v = validateMessageReadyContext(contexteValide({
      communicationEvidence: [{ evidenceRef: 'ev_1', statement: 'x', provenance: { sourceRef: '', observedAt: '' } } as any],
    }))
    expect(v.ok).toBe(false)
    expect((v as any).reasons).toContain('EVIDENCE_WITHOUT_PROVENANCE')
  })

  it('Research Shown ne peut PAS excéder l’éligible Research Used', () => {
    const horsUsed = validateMessageReadyContext(contexteValide({
      claimConstraints: { showableEvidenceRefs: ['ev_inconnu'], uncertainAssertionRefs: [], maxAssertions: 3, epistemicByRef: {} },
    }))
    expect(horsUsed.ok).toBe(false)
    const tropMontre = validateMessageReadyContext(contexteValide({
      claimConstraints: { showableEvidenceRefs: ['ev_1', 'ev_2'], uncertainAssertionRefs: [], maxAssertions: 3, epistemicByRef: {} },
    }))
    expect(tropMontre.ok).toBe(false)
  })
})

describe('politique de canal QUALITATIVE', () => {
  it('LinkedIn et Email diffèrent STRUCTURELLEMENT ; aucun seuil numérique', () => {
    const li = CHANNEL_POLICIES_V0.linkedin
    const em = CHANNEL_POLICIES_V0.email
    expect(li.lengthPosture).toBe('SHORT')
    expect(em.lengthPosture).toBe('EXTENDED')
    expect(li.register).toBe('CONVERSATIONAL')
    expect(em.register).toBe('BUSINESS_EXPLICIT')
    expect(li.researchExposurePosture).toBe('MINIMAL')
    expect(em.researchExposurePosture).toBe('HIGHER')
    expect(li.surveillanceTolerance).toBe('LOW')
    expect(li.ctaStyle).toBe('SOFT_ASK')
    expect(em.ctaStyle).toBe('EXPLICIT_ALLOWED')
    expect(em.contextDepth).toBe('EXTENDED')
    for (const policy of Object.values(CHANNEL_POLICIES_V0)) {
      for (const [key, value] of Object.entries(policy)) {
        expect(typeof value, `${policy.channel}.${key}`).toBe('string')
      }
    }
    expect(/maxLength|maxResearchShown|\b(500|1400)\b/.test(lireSource('channelPolicy.ts'))).toBe(false)
  })
})

describe('frontière du moteur, zéro LLM, zéro envoi', () => {
  it('la frontière REFUSE tout ce qui n’est pas un contexte VALIDÉ (fiche brute incluse)', () => {
    const ficheBrute = { id: 'l1', firstName: 'Karine', company: 'ACME', icebreaker: 'Ils ont levé 10M€' }
    expect(admitToEngine(ficheBrute)).toEqual({ ok: false, reason: 'CONTEXT_NOT_VALIDATED' })
    expect(admitToEngine(contexteValide())).toEqual({ ok: false, reason: 'CONTEXT_NOT_VALIDATED' })
    expect(isValidatedContext(contexteValide())).toBe(false)
    const v = validateMessageReadyContext(contexteValide())
    expect(v.ok).toBe(true)
    const admission = admitToEngine((v as any).validated)
    expect(admission.ok).toBe(true)
    const src = lireSource('messageEngineBoundary.ts')
    expect(src.includes('Lead')).toBe(false)
    expect(src.includes('capabilities')).toBe(false)
  })

  it('AUCUN LLM et AUCUN effet d’envoi dans les fondations (structurel)', () => {
    for (const f of MESSAGING_FILES) {
      const src = lireSource(f)
      for (const interdit of ['callClaude', "from '../llm'", 'anthropic', 'fetch(',
        'sendMessage', 'unipile', 'storeSave', 'upsertItem', "from '../../supabase"]) {
        expect(src.includes(interdit), `${f}:${interdit}`).toBe(false)
      }
    }
  })
})

describe('R4-C1 — mécaniques anonymes ≠ Goldens nommés ; SQUAD non-activation', () => {
  it('fixtures synthétiques TEST-ONLY : hors lib, non importées par la production', () => {
    expect(existsSync(join(MESSAGING_DIR, 'goldenFixtures.ts'))).toBe(false)
    for (const f of MESSAGING_FILES) {
      const src = lireSource(f)
      expect(src.includes('goldenFixtures'), f).toBe(false)
      expect(src.includes('ev_synthetic'), f).toBe(false)
    }
  })

  it('1 — les cas MÉCANIQUES anonymes exercent des contextes valides (3 actions, 2 canaux, 3 objectifs)', () => {
    expect(new Set(CONTRACT_MECHANICS_CASES_V0.map((c) => c.selectedAction)))
      .toEqual(new Set(['START_OUTREACH', 'FOLLOW_UP', 'REPLY']))
    expect(new Set(CONTRACT_MECHANICS_CASES_V0.map((c) => c.channel))).toEqual(new Set(['email', 'linkedin']))
    expect(new Set(CONTRACT_MECHANICS_CASES_V0.map((c) => c.outreachObjective)))
      .toEqual(new Set(['OPEN_CONVERSATION', 'LEARN_HIGH_VALUE_UNKNOWN', 'ADVANCE_CONVERSATION']))
    for (const cas of CONTRACT_MECHANICS_CASES_V0) {
      expect(cas.caseId.startsWith('CONTRACT_CASE_')).toBe(true) // anonymes, jamais nommés
      const evidence = cas.usableEvidenceRefs.map((r, i) => ({
        evidenceRef: r, statement: `mécanique ${i}`,
        provenance: { sourceRef: `sa_${r}`, observedAt: '2026-09-01' },
        ...(cas.uncertainRefs.includes(r) ? { uncertainty: 'incertitude vivante' } : {}),
        ...(cas.counterSignalOnlyRefs.includes(r) ? { counterSignalRefs: ['ev_contra'] } : {}),
      }))
      const budgets = {
        assertionBudget: 3,
        evidenceBudget: cas.usableEvidenceRefs.length,
        researchShownBudget: cas.showableEvidenceRefs.length,
      }
      const cc = deriveClaimConstraints(evidence as any, budgets)
      expect(cc.showableEvidenceRefs, cas.caseId).toEqual(cas.showableEvidenceRefs)
      expect(cc.uncertainAssertionRefs, cas.caseId).toEqual(cas.uncertainRefs) // contre-signal seul EXCLU
      const base = contexteValide({
        selectedAction: cas.selectedAction,
        outreachObjective: cas.outreachObjective,
        channel: cas.channel,
        budgets,
        communicationEvidence: evidence,
        claimConstraints: cc,
        forbiddenClaims: { terms: cas.forbiddenTerms },
      })
      expect(validateMessageReadyContext(base).ok, cas.caseId).toBe(true)
      const casse: any = { ...base }
      if (cas.failureModeWhenIncomplete === 'MISSING_WHY_NOW') casse.whyNow = ''
      if (cas.failureModeWhenIncomplete === 'MISSING_WHY_TALK') casse.whyTalk = ''
      if (cas.failureModeWhenIncomplete === 'IDENTITY_NOT_RESOLVED') casse.recipientIdentityState = 'UNRESOLVED'
      if (cas.failureModeWhenIncomplete === 'UNSUPPORTED_CHANNEL') casse.channel = 'whatsapp'
      const echec = validateMessageReadyContext(casse)
      expect(echec.ok, cas.caseId).toBe(false)
      expect((echec as any).reasons).toContain(cas.failureModeWhenIncomplete)
      expect(checkForbiddenClaims(`texte avec ${cas.forbiddenTerms[0]}`, { terms: cas.forbiddenTerms }).ok).toBe(false)
    }
  })

  it('2…7 — les Goldens NOMMÉS n’inventent AUCUNE décision et ne produisent AUCUN contexte', () => {
    const nommes = GOLDEN_MESSAGING_FIXTURES_V0.filter((f) => f.fixtureKind === 'NAMED_GOLDEN_PLACEHOLDER')
    expect(nommes.map((f) => (f as any).fixtureId).sort()).toEqual(['AEROW_KIMEIA', 'REDSEN', 'WALLIX'])
    for (const golden of nommes) {
      const g: any = golden
      expect(g.selectedAction, g.fixtureId).toBeUndefined()        // 2/5/6
      expect(g.outreachObjective, g.fixtureId).toBeUndefined()     // 3/5/6
      expect(g.channel, g.fixtureId).toBeUndefined()               // 4/5/6
      expect(g.expectations).toBeUndefined()
      expect(g.usableEvidenceRefs).toBeUndefined()
      expect(g.showableEvidenceRefs).toBeUndefined()
      expect(g.failureModeWhenIncomplete).toBeUndefined()
      expect(g.companyFacts).toBe(UNSUPPORTED_FACT)
      expect(g.behavioralExpectations).toBe(PENDING_GOLDEN_SOURCE)
      // 7 — aucun contexte positif fabricable depuis le placeholder.
      const tentative = {
        schemaVersion: 'message-ready-context-v0.1',
        recipientRef: g.fixtureId,
        recipientIdentityState: 'RESOLVED',
        selectedAction: g.selectedAction,       // undefined
        outreachObjective: g.outreachObjective, // undefined
        channel: g.channel,                     // undefined
      }
      const v = validateMessageReadyContext(tentative)
      expect(v.ok, g.fixtureId).toBe(false)
      expect((v as any).reasons).toContain('MISSING_SELECTED_ACTION')
      expect(admitToEngine(tentative)).toEqual({ ok: false, reason: 'CONTEXT_NOT_VALIDATED' })
    }
  })

  it('8/9 — SQUAD reste DOMAIN_NON_ACTIVATION, arrêt AVANT MessageReadyContext', () => {
    const squad = GOLDEN_MESSAGING_FIXTURES_V0.find((f) => (f as any).fixtureId === 'SQUAD')!
    expect(squad.fixtureKind).toBe('DOMAIN_NON_ACTIVATION')
    expect((squad as any).selectedAction).toBeUndefined()
    expect((squad as any).outreachObjective).toBeUndefined()
    expect((squad as any).channel).toBeUndefined()
    expect((squad as any).behavioralExpectations).toBeUndefined()
    expect((squad as any).nonActivation).toEqual({
      expectation: 'STOP_BEFORE_MESSAGE_READY_CONTEXT',
      invariant: 'STRATEGICALLY_INTERESTING_IS_NOT_COMMERCIALLY_PRIORITIZED',
    })
    const tentative = {
      schemaVersion: 'message-ready-context-v0.1',
      recipientRef: 'squad_contact',
      recipientIdentityState: 'RESOLVED',
      selectedAction: (squad as any).selectedAction,
      outreachObjective: (squad as any).outreachObjective,
      channel: (squad as any).channel,
    }
    const v = validateMessageReadyContext(tentative)
    expect(v.ok).toBe(false)
    expect(admitToEngine(tentative)).toEqual({ ok: false, reason: 'CONTEXT_NOT_VALIDATED' })
  })
})

// ═══ MICRO-PATCH — CLÔTURE ÉPISTÉMIQUE RUNTIME + PROJECTION CANONIQUE ═══════

describe('micro-patch — gardes runtime des types épistémiques canoniques', () => {
  const avecEvidence = (item: any, cc?: any) => contexteValide({
    communicationEvidence: [item],
    budgets: { assertionBudget: 3, evidenceBudget: 1, researchShownBudget: 1 },
    claimConstraints: cc ?? { showableEvidenceRefs: [item.evidenceRef], uncertainAssertionRefs: [], maxAssertions: 3, epistemicByRef: {} },
  })

  it('1/2/3 — les trois forces canoniques passent (lignée cohérente)', () => {
    for (const kind of ['EXTERNAL_CONFIRMED_CANONICAL', 'INTERNAL_RECORD', 'INTERNAL_CORROBORATED_RECORD'] as const) {
      const item = { ...EV(1), strength: { kind } }
      const r = validateMessageReadyContext(avecEvidence(item, {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 3,
        epistemicByRef: { ev_1: { strength: { kind } } },
      }))
      expect(r.ok, kind).toBe(true)
    }
  })

  it('4/5 — force non canonique rejetée : {kind:BOGUS}, null, chaîne, nombre, tableau, {}', () => {
    for (const strength of [{ kind: 'BOGUS' }, {}, null, 'forte', 3, [{ kind: 'INTERNAL_RECORD' }]]) {
      const r = validateMessageReadyContext(avecEvidence({ ...EV(1), strength }))
      expect(r.ok, JSON.stringify(strength)).toBe(false)
      expect((r as any).reasons).toContain('INVALID_EPISTEMIC_EVIDENCE')
    }
  })

  it('6/7 — les deux formes temporelles canoniques avec jour RÉEL passent', () => {
    for (const basis of ['DATED_EVENT_DAY', 'EXTERNAL_STATE_OBSERVED_DAY'] as const) {
      const temporalAuthority = { basis, referenceDay: '2026-08-13' }
      const item = { ...EV(1), temporalAuthority }
      const r = validateMessageReadyContext(avecEvidence(item, {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 3,
        epistemicByRef: { ev_1: { temporalAuthority } },
      }))
      expect(r.ok, basis).toBe(true)
    }
  })

  it('8/9/10/11 — temporel non canonique rejeté : basis inconnue, jour poubelle, 30 février, forme factice', () => {
    for (const temporalAuthority of [
      { basis: 'NONSENSE', referenceDay: '2026-09-01' },
      { basis: 'DATED_EVENT_DAY', referenceDay: 'garbage' },
      { basis: 'DATED_EVENT_DAY', referenceDay: '2026-02-30' },
      { ['ki' + 'nd']: 'DATED', occurredAt: '2026-09-01' },
      null, 'hier', [],
    ]) {
      const r = validateMessageReadyContext(avecEvidence({ ...EV(1), temporalAuthority }))
      expect(r.ok, JSON.stringify(temporalAuthority)).toBe(false)
      expect((r as any).reasons).toContain('INVALID_EPISTEMIC_EVIDENCE')
    }
  })

  it('12/13/14/15 — incertitude non-chaîne/blanche, contre-signaux malformés, ref dupliquée : rejetés', () => {
    for (const item of [
      { ...EV(1), uncertainty: 42 },
      { ...EV(1), uncertainty: '   ' },
      { ...EV(1), counterSignalRefs: ['ok', ''] },
      { ...EV(1), counterSignalRefs: 'ev_x' },
    ]) {
      const r = validateMessageReadyContext(avecEvidence(item))
      expect(r.ok).toBe(false)
      expect((r as any).reasons).toContain('INVALID_EPISTEMIC_EVIDENCE')
    }
    const duplique = validateMessageReadyContext(contexteValide({
      communicationEvidence: [EV(1), { ...EV(1) }], // même evidenceRef
    }))
    expect(duplique.ok).toBe(false)
    expect((duplique as any).reasons).toContain('INVALID_EPISTEMIC_EVIDENCE')
  })

  it('16/17/18 — entrées epistemicByRef malformées rejetées (force/temporel/contre-signaux)', () => {
    for (const epistemicByRef of [
      { ev_1: { strength: { kind: 'BOGUS' } } },
      { ev_1: { temporalAuthority: { basis: 'DATED_EVENT_DAY', referenceDay: 'garbage' } } },
      { ev_1: { counterSignalRefs: [''] } },
    ]) {
      const r = validateMessageReadyContext(contexteValide({
        claimConstraints: { showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: [], maxAssertions: 3, epistemicByRef: epistemicByRef as any },
      }))
      expect(r.ok, JSON.stringify(epistemicByRef)).toBe(false)
      expect((r as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
    }
  })
})

describe('micro-patch — cohérence de lignée évidence ↔ epistemicByRef', () => {
  const S1 = { kind: 'INTERNAL_RECORD' } as const
  const S2 = { kind: 'EXTERNAL_CONFIRMED_CANONICAL' } as const
  const T1 = { basis: 'DATED_EVENT_DAY', referenceDay: '2026-01-10' } as const
  const T2 = { basis: 'EXTERNAL_STATE_OBSERVED_DAY', referenceDay: '2026-02-11' } as const
  const ctx = (item: any, entree: any, uncertain: string[] = []) => contexteValide({
    communicationEvidence: [item],
    budgets: { assertionBudget: 3, evidenceBudget: 1, researchShownBudget: 1 },
    claimConstraints: {
      showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: uncertain, maxAssertions: 3,
      epistemicByRef: entree === undefined ? {} : { ev_1: entree },
    },
  })

  it('19/20/21/22 — toute DIVERGENCE de valeur (force/temporel/contre-signaux/incertitude) rejette', () => {
    for (const [item, entree] of [
      [{ ...EV(1), strength: S1 }, { strength: S2 }],
      [{ ...EV(1), temporalAuthority: T1 }, { temporalAuthority: T2 }],
      [{ ...EV(1), counterSignalRefs: ['ev_a'] }, { counterSignalRefs: ['ev_b'] }],
      [{ ...EV(1), uncertainty: 'source unique' }, { uncertainty: 'autre texte' }],
    ] as const) {
      const uncertain = (item as any).uncertainty || (entree as any).uncertainty ? ['ev_1'] : []
      const r = validateMessageReadyContext(ctx(item, entree, uncertain as string[]))
      expect(r.ok).toBe(false)
      expect((r as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
    }
  })

  it('23/24 — fait épistémique DISPARU de epistemicByRef, ou INVENTÉ dedans : rejetés', () => {
    const disparu = validateMessageReadyContext(ctx({ ...EV(1), strength: S1 }, undefined))
    expect(disparu.ok).toBe(false)
    expect((disparu as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
    const invente = validateMessageReadyContext(ctx(EV(1), { strength: S1 }))
    expect(invente.ok).toBe(false)
    expect((invente as any).reasons).toContain('CLAIM_CONSTRAINT_INCONSISTENT')
  })

  it('25/26/27 — projection épistémique COMPLÈTE et cohérente : passe ; contre-signal seul hors uncertain ; vraie incertitude dedans', () => {
    const evidence = [
      { ...EV(1), uncertainty: 'signal unique', temporalAuthority: T1, strength: S1 },
      { ...EV(2), counterSignalRefs: ['ev_contra'] },
    ]
    const cc = deriveClaimConstraints(evidence as any, { assertionBudget: 3, evidenceBudget: 2, researchShownBudget: 1 })
    expect(cc.uncertainAssertionRefs).toEqual(['ev_1'])          // 27
    expect(cc.uncertainAssertionRefs).not.toContain('ev_2')      // 26
    const r = validateMessageReadyContext(contexteValide({
      communicationEvidence: evidence,
      claimConstraints: cc,
    }))
    expect(r.ok).toBe(true)                                       // 25 — la dérivation EST la préservation
  })
})

describe('micro-patch — projection canonique de sortie (aucun champ parasite)', () => {
  it('28/29 — rawLead / rawResearchDump au sommet n’atteignent JAMAIS validated.context', () => {
    const entree: any = { ...contexteValide(), rawLead: { id: 'l1', notes: 'secret' }, rawResearchDump: { blob: true } }
    const v = validateMessageReadyContext(entree)
    expect(v.ok).toBe(true)
    const ctx = (v as any).validated.context
    expect(ctx.rawLead).toBeUndefined()
    expect(ctx.rawResearchDump).toBeUndefined()
    expect(Object.keys(ctx).sort()).toEqual([
      'budgets', 'channel', 'claimConstraints', 'communicationEvidence', 'forbiddenClaims',
      'offerAngle', 'offerRef', 'outreachObjective', 'personaRole', 'recipientIdentityState',
      'recipientRef', 'relationshipState', 'schemaVersion', 'selectedAction', 'selectedSituation',
      'whyNow', 'whyTalk',
    ])
  })

  it('30/31 — propriétés parasites IMBRIQUÉES (évidence, epistemicByRef) ne survivent pas', () => {
    const entree: any = contexteValide({
      communicationEvidence: [{ ...EV(1), rawScrape: { html: '<div>' }, uncertainty: 'source unique' }] as any,
      budgets: { assertionBudget: 3, evidenceBudget: 1, researchShownBudget: 1 },
      claimConstraints: {
        showableEvidenceRefs: ['ev_1'], uncertainAssertionRefs: ['ev_1'], maxAssertions: 3,
        epistemicByRef: { ev_1: { uncertainty: 'source unique', internalScore: 0.93 } as any },
      },
    })
    const v = validateMessageReadyContext(entree)
    expect(v.ok).toBe(true)
    const ctx = (v as any).validated.context
    expect(ctx.communicationEvidence[0].rawScrape).toBeUndefined()
    expect(ctx.communicationEvidence[0].uncertainty).toBe('source unique')
    expect(ctx.claimConstraints.epistemicByRef.ev_1.internalScore).toBeUndefined()
    expect(ctx.claimConstraints.epistemicByRef.ev_1.uncertainty).toBe('source unique')
  })

  it('32 — le contexte canonique marqué passe toujours admitToEngine ; les optionnels valides survivent', () => {
    const v = validateMessageReadyContext(contexteValide({
      relationshipContextRef: 'thread_42', highValueUnknown: 'taille réelle de l’équipe SDR',
    }))
    expect(v.ok).toBe(true)
    const admission = admitToEngine((v as any).validated)
    expect(admission.ok).toBe(true)
    const ctx = (v as any).validated.context
    expect(ctx.relationshipContextRef).toBe('thread_42')
    expect(ctx.highValueUnknown).toBe('taille réelle de l’équipe SDR')
    // Optionnel malformé : n'atteint pas la sortie canonique (jamais inventé).
    const v2 = validateMessageReadyContext({ ...contexteValide(), relationshipContextRef: '   ' } as any)
    expect(v2.ok).toBe(true)
    expect((v2 as any).validated.context.relationshipContextRef).toBeUndefined()
  })
})
