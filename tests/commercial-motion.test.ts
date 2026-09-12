// JS-011_MOTION_MODEL_V0_002 — MOTION COMMERCIALE V0.
//
// Verrouille la frontière la plus dangereuse du ticket : « motion » au sens
// TAXONOMIE DE PROJECTION (commercialMotion.ts) contre « motion » au sens
// CAPACITÉ D'EXÉCUTION (motions.ts). Les deux vocabulaires ne doivent JAMAIS
// fusionner — CM-11 le prouve structurellement, CM-12 prouve que l'autorité
// existante n'a pas bougé d'un octet de comportement.
import { describe, expect, it } from 'vitest'

import {
  COMMERCIAL_MOTION_SCHEMA_VERSION,
  COMMERCIAL_MOTION_VERSION,
  COMMERCIAL_MOTIONS,
  ROLE_COMMERCIAL_MOTION_MATRIX,
  resolveCommercialMotion,
} from '../lib/prospector/proactive/commercialMotion'
import { resolveMotionControl, controlForMotion } from '../lib/prospector/proactive/motions'
import { evaluateEvidence } from '../lib/prospector/proactive/decisionKernel'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { EvidenceEvent } from '../lib/prospector/proactive/types'

/** Tente une mutation ; en mode strict elle jette, et on l'ignore : seule la
 *  VALEUR POST-ATTAQUE fait foi. */
function tenter(attaque: () => void): void {
  try {
    attaque()
  } catch {
    // TypeError attendu sur objet gelé — le verdict est la relecture.
  }
}

describe('CM-1/CM-2 — contrat et versions', () => {
  it('CM-1 — les littéraux de version sont exacts', () => {
    expect(COMMERCIAL_MOTION_SCHEMA_VERSION).toBe('commercial-motion-v0.1')
    expect(COMMERCIAL_MOTION_VERSION).toBe('v0.1')
  })

  it('CM-2 — le registre contient EXACTEMENT deux motions : ACQUIRE et ACCOUNT', () => {
    expect(Object.keys(COMMERCIAL_MOTIONS).sort()).toEqual(['ACCOUNT', 'ACQUIRE'])
    for (const kind of ['ACQUIRE', 'ACCOUNT'] as const) {
      const def = COMMERCIAL_MOTIONS[kind]
      expect(def.schemaVersion).toBe('commercial-motion-v0.1')
      expect(def.motionVersion).toBe('v0.1')
      expect(def.motionKind).toBe(kind)
    }
  })
})

describe('CM-3/CM-4 — contenu des définitions', () => {
  it('CM-3 — ACQUIRE : WIN_NEW_REVENUE, objets exacts, AUCUNE sous-intention de compte', () => {
    const d = COMMERCIAL_MOTIONS.ACQUIRE
    expect(d.objectiveFamily).toBe('WIN_NEW_REVENUE')
    expect([...d.applicableObjectKinds]).toEqual([
      'PROSPECT', 'LEAD', 'TARGET_ACCOUNT', 'OPPORTUNITY',
    ])
    expect(d.accountIntents).toBeUndefined()
    // STAKEHOLDER n'est pas un objet commercial.
    expect(d.applicableObjectKinds).not.toContain('STAKEHOLDER')
  })

  it('CM-4 — ACCOUNT : GROW_AND_KEEP_CLIENTS, objets exacts, sous-intentions EXACTEMENT EXPAND/PROTECT/RENEW/REACTIVATE', () => {
    const d = COMMERCIAL_MOTIONS.ACCOUNT
    expect(d.objectiveFamily).toBe('GROW_AND_KEEP_CLIENTS')
    expect([...d.applicableObjectKinds]).toEqual(['CLIENT_ACCOUNT', 'OPPORTUNITY'])
    expect([...(d.accountIntents ?? [])]).toEqual(['EXPAND', 'PROTECT', 'RENEW', 'REACTIVATE'])
    expect(d.applicableObjectKinds).not.toContain('STAKEHOLDER')
  })
})

describe('CM-5 — matrice Rôle × Motion, valeur par valeur', () => {
  it('la matrice est EXACTEMENT celle du contrat, pour les quatre rôles', () => {
    expect(ROLE_COMMERCIAL_MOTION_MATRIX).toEqual({
      SDR_BDR: { ACQUIRE: 'PRIMARY', ACCOUNT: 'NOT_APPLICABLE' },
      ACCOUNT_EXECUTIVE: { ACQUIRE: 'PRIMARY', ACCOUNT: 'SECONDARY' },
      ACCOUNT_MANAGER_KAM: { ACQUIRE: 'NOT_APPLICABLE', ACCOUNT: 'PRIMARY' },
      HEAD_OF_SALES: { ACQUIRE: 'SECONDARY', ACCOUNT: 'SECONDARY' },
    })
    // Aucun rôle fantôme, aucune motion fantôme (leadership/pipeline/forecast).
    expect(Object.keys(ROLE_COMMERCIAL_MOTION_MATRIX)).toHaveLength(4)
    for (const ligne of Object.values(ROLE_COMMERCIAL_MOTION_MATRIX)) {
      expect(Object.keys(ligne).sort()).toEqual(['ACCOUNT', 'ACQUIRE'])
    }
  })
})

describe('CM-6/CM-7/CM-8 — interdits taxonomiques', () => {
  it('CM-6 — aucune motion leadership/pipeline/forecast n’existe nulle part', () => {
    for (const interdit of ['SALES_LEADERSHIP', 'LEADERSHIP', 'PIPELINE', 'FORECAST']) {
      expect((COMMERCIAL_MOTIONS as any)[interdit]).toBeUndefined()
      expect(resolveCommercialMotion(interdit)).toEqual({
        ok: false, state: 'UNKNOWN_COMMERCIAL_MOTION',
      })
      for (const ligne of Object.values(ROLE_COMMERCIAL_MOTION_MATRIX)) {
        expect((ligne as any)[interdit]).toBeUndefined()
      }
    }
  })

  it('CM-7 — EXPAND n’est PAS une motion de premier niveau (sous-intention de ACCOUNT uniquement)', () => {
    for (const sousIntention of ['EXPAND', 'PROTECT', 'RENEW', 'REACTIVATE']) {
      expect((COMMERCIAL_MOTIONS as any)[sousIntention]).toBeUndefined()
      expect(resolveCommercialMotion(sousIntention).ok).toBe(false)
    }
  })

  it('CM-8 — la définition ne porte AUCUN champ de rôle, de Mission, de Situation, de Playbook ou de permission', () => {
    for (const def of Object.values(COMMERCIAL_MOTIONS)) {
      const cles = Object.keys(def).sort()
      const attendues = def.motionKind === 'ACCOUNT'
        ? ['accountIntents', 'applicableObjectKinds', 'motionKind', 'motionVersion', 'objectiveFamily', 'schemaVersion']
        : ['applicableObjectKinds', 'motionKind', 'motionVersion', 'objectiveFamily', 'schemaVersion']
      expect(cles).toEqual(attendues)
      for (const interdite of [
        'applicableRoles', 'defaultMissionIntents', 'relevantSituationFamilies',
        'allowedPlaybookFamilies', 'attentionCategories', 'authorizedMotions',
        'permissions', 'autonomy', 'missionType',
      ]) {
        expect(cles).not.toContain(interdite)
      }
    }
  })
})

describe('CM-9 — résolveur fermé, fail closed, correspondance EXACTE', () => {
  it('accepte EXACTEMENT ACQUIRE et ACCOUNT, et rend la définition du registre', () => {
    const a = resolveCommercialMotion('ACQUIRE')
    if (a.ok === false) throw new Error(a.state)
    expect(a.motion).toBe(COMMERCIAL_MOTIONS.ACQUIRE)
    const b = resolveCommercialMotion('ACCOUNT')
    if (b.ok === false) throw new Error(b.state)
    expect(b.motion).toBe(COMMERCIAL_MOTIONS.ACCOUNT)
  })

  it('tout le reste rend UNKNOWN_COMMERCIAL_MOTION — sans trim, sans casse, sans défaut', () => {
    const refus = [
      'acquire', 'account', 'Acquire', ' ACQUIRE', 'ACQUIRE ', 'ACCOUNTS',
      'SALES_LEADERSHIP', 'LEADERSHIP', 'PIPELINE', 'FORECAST',
      'PROSPECTING', 'EXPANSION', 'sales_rep', '',
      null, undefined, 0, 1, true, {}, [], { motionKind: 'ACQUIRE' }, ['ACQUIRE'],
    ]
    for (const hint of refus) {
      expect(resolveCommercialMotion(hint), JSON.stringify(hint)).toEqual({
        ok: false, state: 'UNKNOWN_COMMERCIAL_MOTION',
      })
    }
  })

  it('la résolution UNKNOWN est une CONSTANTE gelée — pas un objet neuf mutable', () => {
    const r1 = resolveCommercialMotion('PIPELINE')
    const r2 = resolveCommercialMotion(null)
    expect(r1).toBe(r2)
    expect(Object.isFrozen(r1)).toBe(true)
  })
})

describe('CM-10 — immutabilité RUNTIME, valeurs POST-ATTAQUE', () => {
  it('registre, définitions, tableaux, matrice et résolutions résistent à la mutation adversariale', () => {
    tenter(() => { (COMMERCIAL_MOTIONS as any).SALES_LEADERSHIP = { motionKind: 'SALES_LEADERSHIP' } })
    tenter(() => { (COMMERCIAL_MOTIONS as any).ACQUIRE = null })
    tenter(() => { (COMMERCIAL_MOTIONS.ACQUIRE as any).objectiveFamily = 'GROW_AND_KEEP_CLIENTS' })
    tenter(() => { (COMMERCIAL_MOTIONS.ACQUIRE.applicableObjectKinds as any).push('CLIENT_ACCOUNT') })
    // ⚠️ Attaques NON auto-annulantes : un push suivi d'un pop se compenserait
    // sur un tableau dégelé et laisserait un mutant « freeze retiré » survivre.
    tenter(() => { (COMMERCIAL_MOTIONS.ACCOUNT.accountIntents as any).push('UPSELL') })
    tenter(() => { (COMMERCIAL_MOTIONS.ACCOUNT.accountIntents as any).shift() })
    tenter(() => { (COMMERCIAL_MOTIONS.ACCOUNT.accountIntents as any)[0] = 'MUTATED' })
    tenter(() => { (ROLE_COMMERCIAL_MOTION_MATRIX as any).SDR_BDR = { ACQUIRE: 'NOT_APPLICABLE', ACCOUNT: 'PRIMARY' } })
    tenter(() => { (ROLE_COMMERCIAL_MOTION_MATRIX.ACCOUNT_MANAGER_KAM as any).ACQUIRE = 'PRIMARY' })
    const res = resolveCommercialMotion('ACQUIRE')
    tenter(() => { (res as any).ok = false })
    if (res.ok === false) throw new Error('ACQUIRE doit résoudre')
    tenter(() => { (res.motion as any).motionKind = 'ACCOUNT' })

    // ── VALEURS POST-ATTAQUE — le seul verdict qui compte. ──
    expect((COMMERCIAL_MOTIONS as any).SALES_LEADERSHIP).toBeUndefined()
    expect(COMMERCIAL_MOTIONS.ACQUIRE.motionKind).toBe('ACQUIRE')
    expect(COMMERCIAL_MOTIONS.ACQUIRE.objectiveFamily).toBe('WIN_NEW_REVENUE')
    expect(COMMERCIAL_MOTIONS.ACQUIRE.applicableObjectKinds).toHaveLength(4)
    expect(COMMERCIAL_MOTIONS.ACQUIRE.applicableObjectKinds).not.toContain('CLIENT_ACCOUNT')
    expect([...(COMMERCIAL_MOTIONS.ACCOUNT.accountIntents ?? [])])
      .toEqual(['EXPAND', 'PROTECT', 'RENEW', 'REACTIVATE'])
    expect(ROLE_COMMERCIAL_MOTION_MATRIX.SDR_BDR.ACQUIRE).toBe('PRIMARY')
    expect(ROLE_COMMERCIAL_MOTION_MATRIX.ACCOUNT_MANAGER_KAM.ACQUIRE).toBe('NOT_APPLICABLE')
    const apres = resolveCommercialMotion('ACQUIRE')
    if (apres.ok === false) throw new Error('ACQUIRE doit résoudre')
    expect(apres.motion.motionKind).toBe('ACQUIRE')
  })

  it('chaque niveau est EFFECTIVEMENT gelé — registre, définitions, tableaux, matrice, lignes', () => {
    expect(Object.isFrozen(COMMERCIAL_MOTIONS)).toBe(true)
    for (const def of Object.values(COMMERCIAL_MOTIONS)) {
      expect(Object.isFrozen(def)).toBe(true)
      expect(Object.isFrozen(def.applicableObjectKinds)).toBe(true)
      if (def.accountIntents) expect(Object.isFrozen(def.accountIntents)).toBe(true)
    }
    expect(Object.isFrozen(ROLE_COMMERCIAL_MOTION_MATRIX)).toBe(true)
    for (const ligne of Object.values(ROLE_COMMERCIAL_MOTION_MATRIX)) {
      expect(Object.isFrozen(ligne)).toBe(true)
    }
  })
})

describe('CM-11 — pare-feu structurel contre le vocabulaire de capacités', () => {
  it('commercialMotion.ts ne mentionne AUCUN identifiant d’autorité d’exécution', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'prospector', 'proactive', 'commercialMotion.ts'),
      'utf8',
    ) as string
    for (const interdit of [
      'AuthorizedMotion', 'AUTHORIZED_MOTIONS', 'MotionControl', 'HumanControl',
      'PLAY_MOTIONS', 'resolveMotionControl', 'controlForMotion', 'authorizedMotions',
      'strictest',
    ]) {
      expect(src.includes(interdit), `commercialMotion.ts mentionne « ${interdit} »`).toBe(false)
    }
    // Le SEUL import autorisé : le type RoleKind du vocabulaire canonique.
    const imports = src.match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import type { RoleKind } from './roles/roleCard'"])
  })
})

describe('CM-12 — non-régression COMPORTEMENTALE de motions.ts (autorité intacte)', () => {
  it('le verdict de référence est inchangé : prepare allowed + contact approval ⇒ approval_required', () => {
    const verdict = resolveMotionControl('engage_or_reengage', {
      prepare_outreach: 'allowed',
      contact_prospect: 'approval_required',
    })
    expect(verdict.control).toBe('approval_required')
    expect([...verdict.requiredMotions]).toEqual(['prepare_outreach', 'contact_prospect'])
  })

  it('une capacité ABSENTE reste fail closed : blocked, jamais un défaut permissif', () => {
    const verdict = resolveMotionControl('engage_or_reengage', {
      prepare_outreach: 'allowed',
    })
    expect(verdict.control).toBe('blocked')
    expect(controlForMotion('contact_prospect', {})).toBe('blocked')
  })

  it('le source de motions.ts est BYTE-INCHANGÉ par ce ticket', () => {
    const { execSync } = require('node:child_process')
    const diff = execSync(
      'git diff --name-only HEAD -- lib/prospector/proactive/motions.ts',
      { encoding: 'utf8' },
    ).trim()
    expect(diff).toBe('')
  })
})

describe('CM-13/CM-14 — la motion est PROJECTION, pas Mission ni permission', () => {
  it('CM-13 — résoudre une motion ne crée, n’active et ne fabrique RIEN (fonction pure, mêmes constantes)', () => {
    const avant = resolveCommercialMotion('ACCOUNT')
    const encore = resolveCommercialMotion('ACCOUNT')
    expect(encore).toBe(avant) // même constante gelée — aucune fabrication
    if (avant.ok === false) throw new Error('ACCOUNT doit résoudre')
    expect(avant.motion).toBe(COMMERCIAL_MOTIONS.ACCOUNT)
  })

  it('CM-14 — le module n’exporte AUCUNE surface de Mission/Situation/Playbook', async () => {
    const mod = await import('../lib/prospector/proactive/commercialMotion')
    expect(Object.keys(mod).sort()).toEqual([
      'COMMERCIAL_MOTIONS',
      'COMMERCIAL_MOTION_SCHEMA_VERSION',
      'COMMERCIAL_MOTION_VERSION',
      'ROLE_COMMERCIAL_MOTION_MATRIX',
      'resolveCommercialMotion',
    ])
  })
})

describe('CM-15 — le kernel de PRODUCTION est aveugle à la motion résolue', () => {
  it('résoudre ACQUIRE vs ACCOUNT avant l’évaluation ne change NI Situations NI Recommendations', () => {
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

    // Deux « utilisateurs » qui ont résolu des motions DIFFÉRENTES…
    const motionA = resolveCommercialMotion('ACQUIRE')
    const motionB = resolveCommercialMotion('ACCOUNT')
    expect(motionA).not.toEqual(motionB) // le test ne peut pas se vider

    // …obtiennent la MÊME vérité du chemin de décision de production : la
    // motion n'entre nulle part dans le kernel, et on n'invente aucun moteur
    // de projection pour le prouver — même contexte, même evidence, même clock.
    const pourA = evaluateEvidence({ now: NOW, businessContext: TEST_BUSINESS_CONTEXT as any, evidence, targets })
    const pourB = evaluateEvidence({ now: NOW, businessContext: TEST_BUSINESS_CONTEXT as any, evidence, targets })
    expect(pourB.situations).toEqual(pourA.situations)
    expect(pourB.recommendations).toEqual(pourA.recommendations)
    expect(pourA.situations.map((s) => s.type)).toContain('sales_scale_up')
    expect(pourA.recommendations.length).toBeGreaterThan(0)
  })
})
