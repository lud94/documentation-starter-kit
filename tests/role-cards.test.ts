// JS-006_ROLE_CARDS_V0_002 — le rôle change la PROJECTION, jamais la vérité.
import { describe, expect, it } from 'vitest'

import {
  ROLE_CARDS,
  ROLE_KINDS,
  ROLECARD_SCHEMA_VERSION,
  resolveRoleCard,
  type RoleKind,
} from '../lib/prospector/proactive/roles/roleCard'
import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import { evaluateEvidence } from '../lib/prospector/proactive/decisionKernel'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { EvidenceEvent } from '../lib/prospector/proactive/types'

describe('R1/R2 — registre canonique', () => {
  it('R1 — exactement QUATRE cartes canoniques existent', () => {
    expect(ROLE_KINDS).toEqual([
      'SDR_BDR', 'ACCOUNT_EXECUTIVE', 'ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES',
    ])
    expect(Object.keys(ROLE_CARDS).sort()).toEqual([...ROLE_KINDS].sort())
  })

  it('R2 — chaque RoleKind canonique résout vers SA propre carte', () => {
    for (const kind of ROLE_KINDS) {
      const r = resolveRoleCard(kind)
      if (r.ok === false) throw new Error(`${kind}: ${r.state}`)
      expect(r.card.roleKind).toBe(kind)
      expect(r.card.roleCardId).toBe(`rolecard_${kind.toLowerCase()}`)
      expect(r.card.schemaVersion).toBe(ROLECARD_SCHEMA_VERSION)
      expect(r.card).toBe(ROLE_CARDS[kind]) // identité, pas une copie
    }
  })

  it('R3 — l’AE n’est PAS un SDR_BDR : identité, objectifs, portée et profondeur diffèrent', () => {
    const ae = ROLE_CARDS.ACCOUNT_EXECUTIVE
    const bdr = ROLE_CARDS.SDR_BDR
    expect(ae).not.toBe(bdr)
    expect(ae.roleCardId).not.toBe(bdr.roleCardId)
    expect(ae.objectives).not.toEqual(bdr.objectives)
    expect(ae.dataScopeDefaults.kind).toBe('OWNED_BOOK')
    expect(bdr.dataScopeDefaults.kind).toBe('PROSPECTS_AND_TARGETS')
    expect(ae.informationDepth).toBe('ACCOUNT_DOSSIER')
    expect(bdr.informationDepth).toBe('ACTIONABLE_SUMMARY')
    expect(ae.defaultMissionIntents).not.toEqual(bdr.defaultMissionIntents)
  })
})

describe('R4–R8 — résolution héritée FERMÉE, sans repli', () => {
  it('R4 — business_developer et BUSINESS_DEVELOPER résolvent EXACTEMENT SDR_BDR', () => {
    for (const heritage of ['business_developer', 'BUSINESS_DEVELOPER']) {
      const r = resolveRoleCard(heritage)
      if (r.ok === false) throw new Error(`${heritage}: ${r.state}`)
      expect(r.card.roleKind).toBe('SDR_BDR')
    }
  })

  it('R5 — sales_rep ⇒ ROLE_SELECTION_REQUIRED, JAMAIS SDR_BDR : l’ancien défaut d’espace ne choisit pas pour l’utilisateur', () => {
    expect(resolveRoleCard('sales_rep')).toEqual({ ok: false, state: 'ROLE_SELECTION_REQUIRED' })
  })

  it('R6 — broker ⇒ NO_ROLECARD_VERTICAL (Fabel n’est pas une carte Sales, et n’est pas blanchi en BDR)', () => {
    expect(resolveRoleCard('broker')).toEqual({ ok: false, state: 'NO_ROLECARD_VERTICAL' })
  })

  it('R7 — inconnu / vide / SalesRep / SDR / manager / admin ⇒ UNKNOWN_ROLE, jamais un rôle privilégié', () => {
    for (const inconnu of ['', 'SalesRep', 'SDR', 'BDR', 'AE', 'KAM', 'manager', 'admin', 'CEO',
      'toString', undefined, null, 42, {}]) {
      expect(resolveRoleCard(inconnu as any), String(inconnu))
        .toEqual({ ok: false, state: 'UNKNOWN_ROLE' })
    }
  })

  it('R8 — AUCUN repli flou : casse et variantes proches ne résolvent RIEN', () => {
    for (const variante of ['sdr_bdr', 'Sales_Rep', 'SALES_REP', ' sales_rep', 'sales_rep ',
      'business_developer2', 'BROKER', 'Business_Developer', 'head_of_sales']) {
      expect(resolveRoleCard(variante), variante).toEqual({ ok: false, state: 'UNKNOWN_ROLE' })
    }
    // Et le résolveur n'emploie aucune normalisation générique.
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/roles/roleCard.ts', 'utf8')
    for (const interdit of ['.toLowerCase() ===', '.toUpperCase() ===', '.includes(', '.startsWith(', '.trim() ===']) {
      expect(src.includes(interdit), `résolveur flou : « ${interdit} »`).toBe(false)
    }
  })
})

describe('R9/R10 — sémantiques par rôle, jamais recopiées', () => {
  it('R9 — le KAM ne reçoit AUCUNE intention d’acquisition par défaut', () => {
    const kam = ROLE_CARDS.ACCOUNT_MANAGER_KAM
    for (const acquisition of ['FIND_NEW_OPPORTUNITIES', 'QUALIFY_NEW_LEADS', 'PREPARE_CALLS']) {
      expect(kam.defaultMissionIntents).not.toContain(acquisition)
    }
    expect(kam.attentionProfile.caresAbout).not.toContain('acquisition_signals')
    // Et ses défauts ne sont pas l'objet BDR partagé.
    expect(kam.defaultMissionIntents).not.toBe(ROLE_CARDS.SDR_BDR.defaultMissionIntents)
  })

  it('R10 — Head of Sales : TEAM_AGGREGATE / PER_PIPELINE — jamais le bruit prospect individuel', () => {
    const hos = ROLE_CARDS.HEAD_OF_SALES
    expect(hos.attentionProfile.scope).toBe('TEAM_AGGREGATE')
    expect(hos.attentionProfile.granularity).toBe('PER_PIPELINE')
    expect(hos.attentionProfile.scope).not.toBe('INDIVIDUAL_ITEMS')
    expect(hos.dataScopeDefaults.kind).toBe('TEAM_PIPELINE')
  })
})

describe('R11/R12/R14 — pureté, frontières, aucune activation', () => {
  it('R11 — le module RoleCard n’importe AUCUNE autorité d’exécution (verrou structurel)', () => {
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/roles/roleCard.ts', 'utf8')
    for (const interdit of [
      "from '../../../auth", 'lib/auth', 'supabase', 'store',
      'jarvisAgent', 'missions/plan', 'MissionTool', 'callClaude', 'anthropic',
      'fetch(', 'node:https', 'node:http', 'persistEvaluation', 'upsertItem',
      "from 'react'",
    ]) {
      expect(src.includes(interdit), `roleCard.ts importe « ${interdit} »`).toBe(false)
    }
    // Aucun import du tout : le contrat est autonome.
    expect(/^import /m.test(src)).toBe(false)
  })

  it('R12 — la résolution est PURE : mêmes entrées, mêmes sorties, aucune mutation', () => {
    const indice = { toString: () => 'SDR_BDR' }
    expect(resolveRoleCard(indice)).toEqual({ ok: false, state: 'UNKNOWN_ROLE' }) // pas une chaîne
    const a = resolveRoleCard('HEAD_OF_SALES')
    const b = resolveRoleCard('HEAD_OF_SALES')
    expect(b).toEqual(a)
    if (a.ok === false || b.ok === false) throw new Error('résolution attendue')
    expect(b.card).toBe(a.card) // constante du registre, jamais reconstruite
    expect(Object.isFrozen(a.card)).toBe(true)
    expect(Object.isFrozen(ROLE_CARDS)).toBe(true)
  })

  it('R14 — aucune carte ne crée ni n’active une Mission : les intentions sont des identifiants, rien d’autre', () => {
    for (const kind of ROLE_KINDS) {
      for (const intent of ROLE_CARDS[kind as RoleKind].defaultMissionIntents) {
        expect(typeof intent).toBe('string')
      }
    }
    // Verrou structurel : aucune fabrique/activation de Mission dans le module.
    const { readFileSync } = require('node:fs')
    const src = readFileSync('lib/prospector/proactive/roles/roleCard.ts', 'utf8')
    for (const interdit of ['createMission', 'activateMission', 'MissionRun', 'runMission']) {
      expect(src.includes(interdit)).toBe(false)
    }
  })
})

describe('R1 — immutabilité PROFONDE à l’exécution, valeurs POST-ATTAQUE vérifiées', () => {
  const tenter = (fn: () => void) => { try { fn() } catch { /* strict : lève — l'attaque échoue */ } }

  it('R1-B — les quatre cartes sont gelées EN PROFONDEUR (chaque structure imbriquée)', () => {
    for (const kind of ROLE_KINDS) {
      const c = ROLE_CARDS[kind as RoleKind]
      for (const [nom, o] of [
        ['card', c], ['objectives', c.objectives], ['attentionProfile', c.attentionProfile],
        ['caresAbout', c.attentionProfile.caresAbout],
        ['defaultMissionIntents', c.defaultMissionIntents],
        ['dataScopeDefaults', c.dataScopeDefaults], ['autonomyDefaults', c.autonomyDefaults],
      ] as const) {
        expect(Object.isFrozen(o), `${kind}.${nom}`).toBe(true)
      }
    }
    expect(Object.isFrozen(ROLE_CARDS)).toBe(true)
    expect(Object.isFrozen(ROLE_KINDS)).toBe(true)
  })

  it('R1-B — chaque RoleResolution de la table fermée est GELÉE, y compris UNKNOWN_ROLE', () => {
    for (const heritage of ['SDR_BDR', 'ACCOUNT_EXECUTIVE', 'ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES',
      'business_developer', 'BUSINESS_DEVELOPER', 'sales_rep', 'broker', 'inconnu-total']) {
      expect(Object.isFrozen(resolveRoleCard(heritage)), heritage).toBe(true)
    }
  })

  it('R1-B — ADVERSARIAL : remplacer `.card` de la résolution SDR par Head of Sales ne change RIEN aux résolutions futures', () => {
    const r = resolveRoleCard('SDR_BDR')
    if (r.ok === false) throw new Error(r.state)
    tenter(() => { (r as any).card = ROLE_CARDS.HEAD_OF_SALES })
    // ⚠️ PAS seulement « ça lève » : la VALEUR post-attaque est vérifiée.
    expect(r.card).toBe(ROLE_CARDS.SDR_BDR)
    const apres = resolveRoleCard('SDR_BDR')
    if (apres.ok === false) throw new Error(apres.state)
    expect(apres.card).toBe(ROLE_CARDS.SDR_BDR)
    expect(apres.card.roleKind).toBe('SDR_BDR')
  })

  it('R1-B — ADVERSARIAL : un état d’échec rendu (sales_rep) ne peut pas être muté durablement', () => {
    const r = resolveRoleCard('sales_rep')
    tenter(() => { (r as any).state = 'UNKNOWN_ROLE' })
    tenter(() => { (r as any).ok = true })
    expect(r).toEqual({ ok: false, state: 'ROLE_SELECTION_REQUIRED' })
    expect(resolveRoleCard('sales_rep')).toEqual({ ok: false, state: 'ROLE_SELECTION_REQUIRED' })
  })

  it('R1-B — ADVERSARIAL : mutations imbriquées tentées, sémantique du registre INCHANGÉE après attaque', () => {
    const r = resolveRoleCard('SDR_BDR')
    if (r.ok === false) throw new Error(r.state)
    tenter(() => { (r.card.objectives as any).push('MUTATED') })
    tenter(() => { (r.card.attentionProfile as any).scope = 'TEAM_AGGREGATE' })
    tenter(() => { (r.card.dataScopeDefaults as any).kind = 'TEAM_PIPELINE' })
    tenter(() => { (r.card.autonomyDefaults as any).posture = 'READ_ONLY' })
    // Valeurs POST-ATTAQUE — sur l'objet rendu ET via une nouvelle résolution.
    const apres = resolveRoleCard('SDR_BDR')
    if (apres.ok === false) throw new Error(apres.state)
    expect(apres.card.objectives.length).toBe(4)
    expect(apres.card.objectives).not.toContain('MUTATED')
    expect(apres.card.attentionProfile.scope).toBe('INDIVIDUAL_ITEMS')
    expect(apres.card.dataScopeDefaults.kind).toBe('PROSPECTS_AND_TARGETS')
    expect(apres.card.autonomyDefaults.posture).toBe('DRAFT_ALLOWED')
  })
})

describe('R13 — le moteur reste AVEUGLE au rôle : une seule vérité métier', () => {
  it('R13 (renforcé) — deux BusinessContext IDENTIQUES sauf le rôle ⇒ Situations ET Recommendations identiques via le kernel de PRODUCTION', () => {
    const NOW = new Date('2026-09-05T12:00:00.000Z')
    const evidence = [
      {
        id: 'ev_fund', type: 'recent_funding', accountId: 'acc_1', scope: 'account',
        temporality: 'dated_event', occurredAt: '2026-09-01',
        assertionType: 'fact', confidence: 0.8,
        observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
      },
      {
        id: 'ev_jobs', type: 'sales_hiring', accountId: 'acc_1', scope: 'account',
        temporality: 'undated_state', assertionType: 'fact', confidence: 0.8,
        observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
      },
    ] as unknown as EvidenceEvent[]
    const targets = [{ accountId: 'acc_1', relevance: 0.9 }]
    // ⚠️ SEUL le rôle diffère — tout le reste (contextId, version, scope,
    // lens, motions, evidence, cible, horloge) est STRICTEMENT identique.
    const ctxBdr = { ...TEST_BUSINESS_CONTEXT, role: 'business_developer' }
    const ctxKam = { ...TEST_BUSINESS_CONTEXT, role: 'ACCOUNT_MANAGER_KAM' }
    expect(ctxBdr.role).not.toBe(ctxKam.role) // le test lui-même ne peut pas se vider
    const pourBdr = evaluateEvidence({ now: NOW, businessContext: ctxBdr as any, evidence, targets })
    const pourKam = evaluateEvidence({ now: NOW, businessContext: ctxKam as any, evidence, targets })
    // Le chemin de décision de PRODUCTION (kernel → Situation Engine →
    // Recommendation) rend une sortie STRICTEMENT identique : le rôle ne
    // crée aucune vérité séparée tant que les projections de rôle ne sont
    // pas introduites explicitement.
    expect(pourKam.situations).toEqual(pourBdr.situations)
    expect(pourKam.recommendations).toEqual(pourBdr.recommendations)
    expect(pourBdr.situations.map((s) => s.type)).toContain('sales_scale_up')
    expect(pourBdr.recommendations.length).toBeGreaterThan(0)
  })

  it('changer l’indice de rôle hérité ne change NI les Situations NI leur contenu', () => {
    const NOW = new Date('2026-09-05T12:00:00.000Z')
    const evidence = [
      {
        id: 'ev_fund', type: 'recent_funding', accountId: 'acc_1', scope: 'account',
        temporality: 'dated_event', occurredAt: '2026-09-01',
        assertionType: 'fact', confidence: 0.8,
        observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
      },
      {
        id: 'ev_jobs', type: 'sales_hiring', accountId: 'acc_1', scope: 'account',
        temporality: 'undated_state', assertionType: 'fact', confidence: 0.8,
        observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
      },
    ] as unknown as EvidenceEvent[]
    // Le contexte d'évaluation NE PORTE PAS de rôle : le moteur est structurellement
    // aveugle — les projections de rôle seront introduites EXPLICITEMENT plus tard.
    // Deux « utilisateurs » de rôles hérités différents obtiennent la même vérité.
    const ctx = {
      now: NOW, accountId: 'acc_1', relevance: 0.9,
      lensId: 'sales-default', lensVersion: 'v0.1',
    }
    const pourBdr = evaluateSituations(evidence, ctx as any, ['sales-core'])
    const pourKam = evaluateSituations(evidence, ctx as any, ['sales-core'])
    expect(pourKam).toEqual(pourBdr)
    expect(pourBdr.map((s) => s.type)).toContain('sales_scale_up')
    // Et les cartes de ces deux rôles sont pourtant bien DIFFÉRENTES.
    expect(ROLE_CARDS.SDR_BDR).not.toEqual(ROLE_CARDS.ACCOUNT_MANAGER_KAM)
  })
})
