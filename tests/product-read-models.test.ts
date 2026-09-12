// PFV0-1 — READ MODELS PRODUIT GÉNÉRIQUES — tests A–Z + verrous du fix borné.
//
// Ces tests verrouillent le CONTRAT de projection : sources d'admission
// fermées ET explicites, Recommendation jamais source, whatChanged jamais
// dérivé du rationale/type, zéro score, identité canonique, déterminisme,
// honnêteté des sections. Aucune E/S, aucun réseau.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ATTENTION_CANDIDATE_KINDS,
  projectAttentionCandidatesV0,
  accountHrefFor,
  type AttentionProjectionInputV0,
  type MonitoringCandidateInputV0,
  type RecommendationSourceV0,
  type QualifyingSituationChangeV0,
} from '../lib/prospector/product/attentionCandidate'
import { buildCompanyWorkspaceViewV0 } from '../lib/prospector/product/companyWorkspaceView'

const ACCOUNT = 'acc_siren_123456789'
const WHAT_CHANGED = 'Nomination CFO observée le 2026-08-30 (fait canonique cev_1).'

function qualifyingChange(
  over: Partial<QualifyingSituationChangeV0['situation']> = {},
  extra: Omit<Partial<QualifyingSituationChangeV0>, 'situation'> = {},
): QualifyingSituationChangeV0 {
  return {
    situation: {
      id: 'sit_001',
      accountId: ACCOUNT,
      type: 'PACK_OPAQUE_TYPE_A',
      evidenceIds: ['cev_1', 'cev_2'],
      rationale: 'Interprétation moteur : cette évolution correspond au motif du pack.',
      lastEvaluatedAt: '2026-09-01T10:00:00.000Z',
      ...over,
    },
    changeRef: extra.changeRef ?? 'chg_001',
    whatChanged: extra.whatChanged ?? WHAT_CHANGED,
    ...extra,
  }
}

function recommendation(over: Partial<RecommendationSourceV0> = {}): RecommendationSourceV0 {
  return {
    id: 'rec_001',
    situationId: 'sit_001',
    decision: 'recommend',
    reason: 'Interprétation domaine : fenêtre pertinente pour cette offre.',
    whyNow: 'La situation vient d’être ré-évaluée.',
    play: 'engage_or_reengage',
    recommendedAction: 'Approche suggérée, texte opaque amont.',
    ...over,
  }
}

function monitoringInput(over: Partial<MonitoringCandidateInputV0['run']> = {}): MonitoringCandidateInputV0 {
  return {
    run: {
      runId: 'run_777',
      businessAssessment: 'MATERIAL_CHANGE_FOUND',
      canonicalRefsMaterial: ['cev_9'],
      finishedAt: '2026-09-02T08:00:00.000Z',
      ...over,
    },
    accountRef: ACCOUNT,
    whatChanged: 'Changement matériel observé sur le compte (résolu amont).',
  }
}

function project(input: Partial<AttentionProjectionInputV0>): readonly any[] {
  return projectAttentionCandidatesV0({ qualifyingSituationChanges: [], recommendations: [], monitoring: [], ...input })
}

const sources = {
  attention: readFileSync(join(__dirname, '../lib/prospector/product/attentionCandidate.ts'), 'utf8'),
  workspace: readFileSync(join(__dirname, '../lib/prospector/product/companyWorkspaceView.ts'), 'utf8'),
}

describe('PFV0-1 A–H — admission et identité', () => {
  it('A — un changement de situation qualifiant produit exactement UN candidat NEW_OR_UPDATED_SITUATION', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('NEW_OR_UPDATED_SITUATION')
    expect(out[0].sourceRef).toBe('sit_001')
    expect(out[0].situationRef).toBe('sit_001')
    expect(out[0].changeRef).toBe('chg_001')
  })

  it('B — un run MATERIAL_CHANGE_FOUND produit exactement UN candidat MONITORING_MATERIAL_CHANGE ; les autres verdicts ZÉRO', () => {
    const out = project({ monitoring: [monitoringInput()] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('MONITORING_MATERIAL_CHANGE')
    for (const verdict of ['NO_MATERIAL_CHANGE', 'NEEDS_REVIEW', 'NOT_EVALUATED'] as const) {
      expect(project({ monitoring: [monitoringInput({ businessAssessment: verdict })] })).toHaveLength(0)
    }
  })

  it('C — une Recommendation SEULE (situation absente de l’entrée) ne produit AUCUN candidat', () => {
    const out = project({ recommendations: [recommendation()] })
    expect(out).toHaveLength(0)
  })

  it('D — changement qualifiant + Recommendation liée ⇒ UN SEUL candidat, portant l’attachement', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [recommendation()] })
    expect(out).toHaveLength(1)
    expect(out[0].candidatePlay?.recommendationRef).toBe('rec_001')
  })

  it('E — le play est domaine (candidatePlay/suggestedApproach) — jamais selectedAction/action/nextBestAction', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [recommendation()] })
    const play = out[0].candidatePlay
    expect(play.suggestedApproach).toBe('Approche suggérée, texte opaque amont.')
    expect(play.playType).toBe('engage_or_reengage')
    const clefs = new Set([...Object.keys(out[0]), ...Object.keys(play)])
    for (const interdit of ['selectedAction', 'action', 'nextBestAction', 'finalAction', 'priority', 'finalTiming', 'missionSelection']) {
      expect(clefs.has(interdit)).toBe(false)
    }
  })

  it('F — aucun champ de score/rang sur le candidat', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], monitoring: [monitoringInput()] })
    for (const c of out) {
      for (const interdit of ['score', 'priorityScore', 'attentionScore', 'globalPriority', 'rank', 'urgencyRank', 'confidence', 'relevance', 'urgency']) {
        expect(Object.keys(c)).not.toContain(interdit)
      }
    }
  })

  it('G — organizationRef === accountId canonique, sur les deux kinds', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], monitoring: [monitoringInput()] })
    expect(out).toHaveLength(2)
    for (const c of out) expect(c.organizationRef).toBe(ACCOUNT)
  })

  it('H — un lead.id ne peut pas devenir l’identité : le contrat n’a aucun champ lead et l’identité vient de la source', () => {
    for (const src of [sources.attention, sources.workspace]) {
      expect(src.includes('lead.id')).toBe(false)
      expect(/\bleadId\b/.test(src)).toBe(false)
    }
    const out = project({ qualifyingSituationChanges: [qualifyingChange({ accountId: 'acc_siren_987654321' })] })
    expect(out[0].organizationRef).toBe('acc_siren_987654321')
  })
})

describe('PFV0-1 — FIX BORNÉ : whatChanged canonique, admission explicite', () => {
  it('FIX-A — Situation.rationale ne peuple JAMAIS whatChanged', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()] })
    expect(out[0].whatChanged).toBe(WHAT_CHANGED)
    expect(out[0].whatChanged.includes('Interprétation moteur')).toBe(false)
    expect(out[0].whatChanged).not.toBe(out[0].domainInterpretation)
    // verrou de source : le constructeur de candidat n'assemble pas rationale dans whatChanged
    const code = sources.attention.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    const affectations = code.match(/(?<!readonly )whatChanged:\s*[^\n,]+/g) ?? []
    expect(affectations.length).toBeGreaterThan(0)
    for (const a of affectations) {
      expect(/^whatChanged:\s*input\.whatChanged\s*$/.test(a.trim().replace(/,$/, ''))).toBe(true)
    }
  })

  it('FIX-B — Situation.type ne peuple JAMAIS whatChanged', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange({ type: 'TYPE_MARQUEUR_UNIQUE_XYZ' })] })
    expect(out[0].whatChanged.includes('TYPE_MARQUEUR_UNIQUE_XYZ')).toBe(false)
  })

  it('FIX-C — le whatChanged fourni par l’admission amont est préservé EXACTEMENT (verbatim)', () => {
    const exact = '  texte exact — espaces, tirets, «guillemets», \n conservés  '
    const out = project({ qualifyingSituationChanges: [qualifyingChange({}, { whatChanged: exact })] })
    expect(out[0].whatChanged).toBe(exact)
  })

  it('FIX-D — un Situation[] brut n’est pas une entrée : l’admission est portée par le type qualifiant', () => {
    // Le contrat public n'expose AUCUN champ `situations` : chaque élément
    // doit attester l'admission amont (changeRef + whatChanged requis).
    const code = sources.attention.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(/readonly situations\s*:/.test(code)).toBe(false)
    expect(/qualifyingSituationChanges\s*:/.test(code)).toBe(true)
    // @ts-expect-error — un tableau brut de Situations est rejeté par le type
    const rejet: AttentionProjectionInputV0 = { situations: [], recommendations: [], monitoring: [] }
    expect(rejet).toBeDefined()
  })

  it('FIX-I — aucun seuil temporel ni horloge courante : observedAt vient des sources uniquement', () => {
    const explicite = project({ qualifyingSituationChanges: [qualifyingChange({}, { observedAt: '2026-08-31T00:00:00.000Z' })] })
    expect(explicite[0].observedAt).toBe('2026-08-31T00:00:00.000Z')
    const repli = project({ qualifyingSituationChanges: [qualifyingChange()] })
    expect(repli[0].observedAt).toBe('2026-09-01T10:00:00.000Z')
    const code = sources.attention.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(/lastViewedAt|freshness|maxAge|thresholdMs/i.test(code)).toBe(false)
  })
})

describe('PFV0-1.1 — DURCISSEMENT : identité, whatChanged monitoring, route canonique', () => {
  it('1.1-A — même changeRef porté par DEUX Situations différentes ⇒ deux itemRefs distincts', () => {
    const out = project({
      qualifyingSituationChanges: [
        qualifyingChange({ id: 'sit_001' }, { changeRef: 'chg_shared' }),
        qualifyingChange({ id: 'sit_002' }, { changeRef: 'chg_shared', whatChanged: 'Même changement, autre interprétation.' }),
      ],
    })
    expect(out).toHaveLength(2)
    expect(out[0].itemRef).not.toBe(out[1].itemRef)
  })

  it('1.1-B — même Situation + même changeRef ⇒ itemRef stable et déterministe', () => {
    const a = project({ qualifyingSituationChanges: [qualifyingChange()] })[0]
    const b = project({ qualifyingSituationChanges: [qualifyingChange()] })[0]
    expect(a.itemRef).toBe(b.itemRef)
  })

  it('1.1-C — même Situation + changeRef différent ⇒ itemRefs distincts', () => {
    const a = project({ qualifyingSituationChanges: [qualifyingChange({}, { changeRef: 'chg_A' })] })[0]
    const b = project({ qualifyingSituationChanges: [qualifyingChange({}, { changeRef: 'chg_B' })] })[0]
    expect(a.itemRef).not.toBe(b.itemRef)
  })

  it('1.1-D — permutation des entrées ⇒ ensemble de sortie identique (identité incluse)', () => {
    const q1 = qualifyingChange({ id: 'sit_001' }, { changeRef: 'chg_shared' })
    const q2 = qualifyingChange({ id: 'sit_002' }, { changeRef: 'chg_shared' })
    const a = project({ qualifyingSituationChanges: [q1, q2], monitoring: [monitoringInput()] })
    const b = project({ qualifyingSituationChanges: [q2, q1], monitoring: [monitoringInput()] })
    expect(a).toEqual(b)
  })

  it('1.1-E — monitoring MATERIAL_CHANGE_FOUND : whatChanged fourni préservé EXACTEMENT', () => {
    const out = project({ monitoring: [{ ...monitoringInput(), whatChanged: 'Changement source-backed précis.' }] })
    expect(out[0].whatChanged).toBe('Changement source-backed précis.')
  })

  it('1.1-F — businessAssessment n’est JAMAIS affecté à whatChanged (garde structurelle)', () => {
    const out = project({ monitoring: [monitoringInput()] })
    expect(out[0].whatChanged).not.toBe('MATERIAL_CHANGE_FOUND')
    expect(out[0].domainAssessment).toBe('MATERIAL_CHANGE_FOUND')
    const code = sources.attention.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(/whatChanged:\s*(input\.run\.businessAssessment|'MATERIAL_CHANGE_FOUND')/.test(code)).toBe(false)
  })

  it('1.1-G — verdicts non matériels ⇒ zéro candidat, inchangé même avec whatChanged fourni', () => {
    for (const verdict of ['NO_MATERIAL_CHANGE', 'NEEDS_REVIEW', 'NOT_EVALUATED'] as const) {
      expect(project({ monitoring: [monitoringInput({ businessAssessment: verdict })] })).toHaveLength(0)
    }
  })

  it('1.1-H — route canonique : accountHrefFor ⇒ /companies/<accountId encodé>', () => {
    expect(accountHrefFor(ACCOUNT)).toBe(`/companies/${encodeURIComponent(ACCOUNT)}`)
    const out = project({ qualifyingSituationChanges: [qualifyingChange()] })
    expect(out[0].accountHref).toBe(`/companies/${ACCOUNT}`)
  })
})

describe('PFV0-1 I–P — sémantique et déterminisme', () => {
  it('I — whatChanged / domainInterpretation / whyItMatters : trois champs séparés, jamais fusionnés', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [recommendation()] })
    const c = out[0]
    expect(c.whatChanged).toBe(WHAT_CHANGED)
    expect(c.domainInterpretation).toContain('Interprétation moteur')
    expect(c.whyItMatters).toBe('Interprétation domaine : fenêtre pertinente pour cette offre.')
    expect(c.whatChanged.includes(c.whyItMatters)).toBe(false)
    expect(c.whatChanged.includes(c.domainInterpretation)).toBe(false)
  })

  it('J — Situation.type OPAQUE : deux types différents ⇒ structure de candidat identique', () => {
    const a = project({ qualifyingSituationChanges: [qualifyingChange({ type: 'TYPE_X' })] })[0]
    const b = project({ qualifyingSituationChanges: [qualifyingChange({ type: 'TYPE_TOTALEMENT_AUTRE' })] })[0]
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
  })

  it('K — portabilité : un type « Fabel-like » et un type hors immobilier produisent le MÊME contrat structurel', () => {
    const fabel = project({ qualifyingSituationChanges: [qualifyingChange({ type: 'fabel.office_move_like', rationale: 'r1' })] })[0]
    const cyber = project({ qualifyingSituationChanges: [qualifyingChange({ type: 'cyber.security_incident', rationale: 'r2' })] })[0]
    expect(Object.keys(fabel).sort()).toEqual(Object.keys(cyber).sort())
    expect(fabel.kind).toBe(cyber.kind)
  })

  it('L — counterSignalRefs et uncertainties : collections séparées, transportées verbatim', () => {
    const out = project({
      qualifyingSituationChanges: [qualifyingChange({}, { uncertainties: ['date incertaine'], counterSignalRefs: ['cev_cs_1'] })],
    })
    expect(out[0].uncertainties).toEqual(['date incertaine'])
    expect(out[0].counterSignalRefs).toEqual(['cev_cs_1'])
  })

  it('M — collections vides VALIDES : rien n’est fabriqué', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange({ evidenceIds: [] })] })
    expect(out[0].evidenceRefs).toEqual([])
    expect(out[0].uncertainties).toEqual([])
    expect(out[0].counterSignalRefs).toEqual([])
  })

  it('N — evidenceRefs = exactement les refs de la source', () => {
    const sit = project({ qualifyingSituationChanges: [qualifyingChange()] })[0]
    expect(sit.evidenceRefs).toEqual(['cev_1', 'cev_2'])
    const mon = project({ monitoring: [monitoringInput()] })[0]
    expect(mon.evidenceRefs).toEqual(['cev_9'])
  })

  it('O — aucune sélection par ordre de tableau : deux Recommendations liées ⇒ attachement OMIS, jamais « la première »', () => {
    const recs = [recommendation({ id: 'rec_A' }), recommendation({ id: 'rec_B' })]
    const direct = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: recs })
    const inverse = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [...recs].reverse() })
    expect(direct).toHaveLength(1)
    expect(direct[0].candidatePlay).toBeUndefined()
    expect(inverse[0].candidatePlay).toBeUndefined()
  })

  it('P — déterminisme : permuter l’ordre des entrées produit une sortie IDENTIQUE', () => {
    const q1 = qualifyingChange()
    const q2 = qualifyingChange({ id: 'sit_002' }, { changeRef: 'chg_002', whatChanged: 'Autre changement observé.' })
    const m1 = monitoringInput()
    const a = projectAttentionCandidatesV0({ qualifyingSituationChanges: [q1, q2], recommendations: [recommendation()], monitoring: [m1] })
    const b = projectAttentionCandidatesV0({ qualifyingSituationChanges: [q2, q1], recommendations: [recommendation()], monitoring: [m1] })
    expect(a).toEqual(b)
    expect(a.map((c) => c.itemRef)).toEqual(b.map((c) => c.itemRef))
    // itemRef stable, dérivé de la source — jamais aléatoire
    const encore = projectAttentionCandidatesV0({ qualifyingSituationChanges: [q1], recommendations: [], monitoring: [] })
    expect(encore[0].itemRef).toBe(a.find((c) => c.changeRef === 'chg_001')!.itemRef)
  })
})

describe('PFV0-1 Q–V — Company Workspace View', () => {
  const vue = buildCompanyWorkspaceViewV0({
    organizationRef: ACCOUNT,
    organizationName: 'ACME',
    currentSituations: [{
      situationRef: 'sit_001', situationType: 'TYPE_X', rationale: 'r',
      evidenceRefs: ['cev_1'], observedAt: '2026-09-01T10:00:00.000Z',
    }],
    domainAssessments: [{ runRef: 'run_777', businessAssessment: 'MATERIAL_CHANGE_FOUND', observedAt: '2026-09-02T08:00:00.000Z' }],
    people: [{ personKey: 'pk2_abc', displayName: 'J. Doe', role: 'CFO' }],
  })

  it('Q — identité canonique par accountId ; aucune section PhysicalSite', () => {
    expect(vue.identity.organizationRef).toBe(ACCOUNT)
    expect(vue.identity.accountHref).toBe(accountHrefFor(ACCOUNT))
    expect(Object.keys(vue)).not.toContain('physicalSites')
    expect(/PhysicalSite|physicalSite/.test(sources.workspace.replace(/PAS de PhysicalSite[^\n]*/, ''))).toBe(false)
  })

  it('R — aucun producteur High-Value Unknown requis : pas de section HVU', () => {
    for (const clef of Object.keys(vue)) {
      expect(/hvu|highValueUnknown/i.test(clef)).toBe(false)
    }
  })

  it('S — timeline = observedHistory adossé aux sources fournies uniquement', () => {
    expect(vue.observedHistory).toHaveLength(2)
    expect(vue.observedHistory.map((e) => e.sourceRef)).toEqual(['sit_001', 'run_777'])
    const vide = buildCompanyWorkspaceViewV0({ organizationRef: ACCOUNT })
    expect(vide.observedHistory).toEqual([])
  })

  it('T — aucun champ prédictif dans la vue ni dans la timeline', () => {
    const clefs = [...Object.keys(vue), ...vue.observedHistory.flatMap((e) => Object.keys(e))]
    for (const interdit of ['likelyNextDecisions', 'predictedState', 'futureTrajectory', 'forecast', 'prediction']) {
      expect(clefs).not.toContain(interdit)
    }
    for (const src of [sources.attention, sources.workspace]) {
      expect(/likelyNextDecisions|predictedState|futureTrajectory/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))).toBe(false)
    }
  })

  it('U — le texte de Recommendation n’écrase jamais whatChanged', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [recommendation()] })
    expect(out[0].whatChanged).toBe(WHAT_CHANGED)
    expect(out[0].whatChanged).not.toContain('Interprétation domaine')
    expect(out[0].candidatePlay?.rationale).toContain('Interprétation domaine')
  })

  it('V — rationale (interprétation) et évidence (refs) restent des champs distincts', () => {
    const out = project({ qualifyingSituationChanges: [qualifyingChange()], recommendations: [recommendation()] })
    expect(Array.isArray(out[0].evidenceRefs)).toBe(true)
    expect(typeof out[0].candidatePlay?.rationale).toBe('string')
    expect(out[0].evidenceRefs).not.toContain(out[0].candidatePlay?.rationale)
  })
})

describe('PFV0-1 W–Z — frontières', () => {
  it('W — un SignalHit brut n’a AUCUNE voie d’admission : kinds fermés à deux, aucune entrée signal', () => {
    expect([...ATTENTION_CANDIDATE_KINDS]).toEqual(['NEW_OR_UPDATED_SITUATION', 'MONITORING_MATERIAL_CHANGE'])
    for (const src of [sources.attention, sources.workspace]) {
      expect(/SignalHit|signalHits/.test(src)).toBe(false)
    }
  })

  it('X — capabilities.ts (mock navigateur) jamais importé ; aucune source legacy Dossier', () => {
    for (const src of [sources.attention, sources.workspace]) {
      expect(src.includes("from '../capabilities'")).toBe(false)
      expect(src.includes('capabilities')).toBe(false)
      for (const legacy of ['icebreaker', 'questionAPoser', 'accrochePivot', 'REFERENTIEL', 'generateMessage']) {
        expect(src.includes(legacy)).toBe(false)
      }
    }
  })

  it('Y — aucune branche sur une valeur domaine (pas de if sur un type métier concret)', () => {
    const code = sources.attention.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(/situation\.type\s*===|s\.type\s*===/.test(code)).toBe(false)
    expect(/OFFICE_MOVE|office_move|immobili|square|lease/i.test(code)).toBe(false)
  })

  it('Z — aucune dépendance messaging, réseau, React/Next, Supabase, tenant/authz, ni horloge', () => {
    for (const src of [sources.attention, sources.workspace]) {
      const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      for (const interdit of ["from 'react'", 'next/', 'supabase', "'../messaging", 'callClaude', 'fetch(', "from '../tenant", "from '../authz", 'Date.now', 'new Date(', 'Math.random']) {
        expect(code.includes(interdit)).toBe(false)
      }
    }
  })
})
