// JS-012_BUSINESS_CONTEXT_V0_002 — PROFIL D'ENTREPRISE V0 (BC-1 … BC-25).
//
// Verrouille les trois frontières du ticket :
//   1. le profil DÉCRIT et n'accorde RIEN (aucun champ/import d'autorité) ;
//   2. INCONNU ≠ VIDE CONNU, structurellement et après aller-retour magasin ;
//   3. la configuration runtime proactive existante est BYTE-INCHANGÉE et le
//      profil n'a AUCUN consommateur runtime.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  session: { tenant: { id: 'ws_a' }, actorId: 'user_1' } as any,
  store: new Map<string, any>(),
  persisted: [] as Array<{ kind: string; id: string; ws: string; data: any }>,
  lectures: [] as Array<{ kind: string; id: string; ws: string }>,
  storeDown: false,
  writesFail: false,
}))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etat.session,
}))

vi.mock('../lib/supabase/store', () => ({
  getItemStrict: async (kind: string, id: string, ws: string) => {
    etat.lectures.push({ kind, id, ws })
    return etat.storeDown
      ? { ok: false }
      : { ok: true, value: etat.store.get(`${kind}|${id}|${ws}`) ?? null }
  },
  upsertItem: async (kind: string, id: string, data: any, ws: string) => {
    if (etat.writesFail) return false
    etat.store.set(`${kind}|${id}|${ws}`, data)
    etat.persisted.push({ kind, id, ws, data })
    return true
  },
}))

import handler from '../pages/api/business-profile'
import {
  COMPANY_PROFILE_SCHEMA_VERSION,
  PROFILE_CONTENT_FIELDS,
  validateCompanyProfileInput,
  validateStoredCompanyProfile,
} from '../lib/prospector/proactive/profile/companyProfile'
import {
  ACTIVE_PROFILE_ID,
  COMPANY_PROFILE_KIND,
  loadCompanyProfile,
  saveCompanyProfile,
} from '../lib/prospector/proactive/profile/companyProfileStore'
import { resolveMotionControl } from '../lib/prospector/proactive/motions'
import { recommendationDecision } from '../lib/prospector/proactive/recommendationEngine'

const UNKNOWN = { state: 'UNKNOWN' } as const

/** Contenu valide complet — la base de chaque variation. */
function contenu(patch: Record<string, unknown> = {}) {
  return {
    whatWeSell: { state: 'KNOWN', value: 'Logiciel de prospection B2B' },
    offers: { state: 'KNOWN', value: [{ name: 'Prospector', description: 'SaaS' }] },
    icp: { state: 'KNOWN', value: 'PME françaises en croissance' },
    targetPersonas: { state: 'KNOWN', value: ['Head of Sales'] },
    sectors: { state: 'KNOWN', value: ['tech'] },
    geographies: { state: 'KNOWN', value: ['France'] },
    competitors: UNKNOWN,
    commercialObjectives: UNKNOWN,
    ...patch,
  }
}

async function appeler(method: 'GET' | 'PUT', body?: any, query: any = {}) {
  const req: any = { method, body, query, cookies: {} }
  let status = 0
  let json: any = null
  const res: any = {
    status(c: number) { status = c; return res },
    json(b: any) { json = b; return res },
  }
  await handler(req, res)
  return { status, body: json }
}

beforeEach(() => {
  etat.session = { tenant: { id: 'ws_a' }, actorId: 'user_1' }
  etat.store.clear()
  etat.persisted = []
  etat.lectures = []
  etat.storeDown = false
  etat.writesFail = false
})

describe('BC-6/7/8/9/10 — validation : INCONNU ≠ VIDE CONNU, fail closed', () => {
  it('BC-8 — liste KNOWN [] est VALIDE (« aucun » affirmé)', () => {
    const v = validateCompanyProfileInput(contenu({ competitors: { state: 'KNOWN', value: [] } }))
    expect(v.ok).toBe(true)
  })

  it('BC-6 — UNKNOWN et KNOWN [] restent DISTINCTS après validation + aller-retour magasin', async () => {
    const saveA = await saveCompanyProfile(contenu({ competitors: UNKNOWN }), 'ws_a')
    expect(saveA.ok).toBe(true)
    const luA = await loadCompanyProfile('ws_a')
    if (luA.ok === false) throw new Error(luA.state)
    expect(luA.profile.competitors).toEqual({ state: 'UNKNOWN' })

    const saveB = await saveCompanyProfile(
      contenu({ competitors: { state: 'KNOWN', value: [] } }), 'ws_a')
    expect(saveB.ok).toBe(true)
    const luB = await loadCompanyProfile('ws_a')
    if (luB.ok === false) throw new Error(luB.state)
    expect(luB.profile.competitors).toEqual({ state: 'KNOWN', value: [] })
    // Les deux représentations ne se confondent JAMAIS.
    expect(luA.profile.competitors).not.toEqual(luB.profile.competitors)
  })

  it('BC-7 — texte KNOWN blanc ⇒ INVALIDE (le vide d’un texte se déclare en UNKNOWN)', () => {
    for (const blanc of ['', '   ', '\n\t']) {
      const v = validateCompanyProfileInput(contenu({ icp: { state: 'KNOWN', value: blanc } }))
      expect(v.ok, JSON.stringify(blanc)).toBe(false)
      if (v.ok === false) expect(v.reason).toBe('text_blank')
    }
  })

  it('BC-9 — champ requis ABSENT ⇒ field_missing explicite, JAMAIS converti en UNKNOWN', () => {
    const sans: any = contenu()
    delete sans.competitors
    const v = validateCompanyProfileInput(sans)
    expect(v.ok).toBe(false)
    if (v.ok === false) {
      expect(v.reason).toBe('field_missing')
      expect(v.field).toBe('competitors')
    }
  })

  it('BC-10 — clé inconnue au premier niveau ⇒ unknown_key explicite', () => {
    const v = validateCompanyProfileInput(contenu({ pipeline: UNKNOWN }))
    expect(v.ok).toBe(false)
    if (v.ok === false) expect(v.reason).toBe('unknown_key')
  })

  it('états malformés : UNKNOWN avec valeur, KNOWN sans valeur, state étranger, liste non-tableau, entrée blanche, offre sans nom', () => {
    const cas: Array<[Record<string, unknown>, string]> = [
      [{ competitors: { state: 'UNKNOWN', value: [] } }, 'unknown_carries_value'],
      [{ icp: { state: 'KNOWN' } }, 'known_missing_value'],
      [{ icp: { state: 'MAYBE', value: 'x' } }, 'field_state_invalid'],
      [{ icp: 'juste une chaîne' }, 'field_state_invalid'],
      [{ sectors: { state: 'KNOWN', value: 'tech' } }, 'list_invalid'],
      [{ sectors: { state: 'KNOWN', value: ['tech', '  '] } }, 'list_entry_invalid'],
      [{ offers: { state: 'KNOWN', value: [{ description: 'sans nom' }] } }, 'offer_invalid'],
      [{ offers: { state: 'KNOWN', value: [{ name: 'X', description: '  ' }] } }, 'offer_invalid'],
      [{ offers: { state: 'KNOWN', value: [{ name: 'X', extra: 1 }] } }, 'offer_invalid'],
    ]
    for (const [patch, attendu] of cas) {
      const v = validateCompanyProfileInput(contenu(patch))
      expect(v.ok, JSON.stringify(patch)).toBe(false)
      if (v.ok === false) expect(v.reason, JSON.stringify(patch)).toBe(attendu)
    }
  })
})

describe('BC-2/3/4/5/11 — frontières de sécurité du CONTRAT', () => {
  const SOURCES = [
    'lib/prospector/proactive/profile/companyProfile.ts',
    'lib/prospector/proactive/profile/companyProfileStore.ts',
    'pages/api/business-profile.ts',
  ]

  it('aucun identifiant d’autorité dans les trois sources (verrou structurel)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    for (const rel of SOURCES) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8') as string
      for (const interdit of [
        'RoleKind', 'roleCard', 'AuthorizedMotion', 'MotionControl', 'HumanControl',
        'authorizedMotions', 'resolveMotionControl', 'PLAY_MOTIONS',
        'CommercialMotion', 'COMMERCIAL_MOTIONS',
        'lensId', 'lensVersion', 'LENS_REGISTRY',
        'contextId', 'contextVersion', 'BusinessContextV0',
        'BusinessScope', 'salesV0Context', 'proactive_business_context',
      ]) {
        expect(src.includes(interdit), `${rel} mentionne « ${interdit} »`).toBe(false)
      }
    }
  })

  it('BC-11 — companyName n’existe PAS (l’espace possède déjà son nom canonique)', () => {
    expect([...PROFILE_CONTENT_FIELDS]).not.toContain('companyName')
    const v = validateCompanyProfileInput(
      contenu({ companyName: { state: 'KNOWN', value: 'Acme' } }))
    expect(v.ok).toBe(false)
    if (v.ok === false) expect(v.reason).toBe('unknown_key')
  })

  it('le contrat porte EXACTEMENT les 8 champs descriptifs', () => {
    expect([...PROFILE_CONTENT_FIELDS].sort()).toEqual([
      'commercialObjectives', 'competitors', 'geographies', 'icp',
      'offers', 'sectors', 'targetPersonas', 'whatWeSell',
    ])
  })
})

describe('BC-12/13/14 + §17 — métadonnées SERVEUR, identifiant opaque, pas de séquence', () => {
  it('BC-12 — le client ne peut PAS fournir revisionId/updatedAt/schemaVersion (unknown_key)', () => {
    for (const cle of ['revisionId', 'updatedAt', 'schemaVersion', 'workspace', 'workspaceId']) {
      const v = validateCompanyProfileInput(contenu({ [cle]: 'valeur_client' }))
      expect(v.ok, cle).toBe(false)
      if (v.ok === false) expect(v.reason).toBe('unknown_key')
    }
  })

  it('BC-12/14 — revisionId et updatedAt sont générés par le SERVEUR à l’enregistrement', async () => {
    const avant = Date.now()
    const r = await saveCompanyProfile(contenu(), 'ws_a')
    if (r.ok === false) throw new Error(r.reason)
    const ligne = etat.persisted[0].data
    expect(ligne.schemaVersion).toBe(COMPANY_PROFILE_SCHEMA_VERSION)
    expect(ligne.revisionId).toBe(r.revisionId)
    expect(ligne.revisionId).toMatch(/^[0-9a-f-]{36}$/) // UUID opaque
    const t = Date.parse(ligne.updatedAt)
    expect(t).toBeGreaterThanOrEqual(avant - 1000)
    expect(t).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('BC-13 — deux enregistrements acceptés ⇒ deux revisionId DIFFÉRENTS (aucune assertion de séquence)', async () => {
    const a = await saveCompanyProfile(contenu(), 'ws_a')
    const b = await saveCompanyProfile(contenu(), 'ws_a')
    if (a.ok === false || b.ok === false) throw new Error('saves attendus')
    expect(a.revisionId).not.toBe(b.revisionId)
  })

  it('§17 — l’enregistrement ne fait AUCUNE lecture préalable (pas de « lire N, écrire N+1 »)', async () => {
    etat.lectures = []
    const r = await saveCompanyProfile(contenu(), 'ws_a')
    expect(r.ok).toBe(true)
    // Dernier-écrit-gagnant assumé : zéro lecture pendant la sauvegarde, donc
    // aucun compteur lu-puis-incrémenté ne peut exister.
    expect(etat.lectures).toEqual([])
    const ligne = etat.persisted[0].data
    expect(Number.isFinite(Number(ligne.revisionId))).toBe(false) // opaque, pas un entier
  })
})

describe('BC-15/16/17 — états de lecture, fail closed', () => {
  it('BC-15 — aucune ligne ⇒ PROFILE_NOT_CONFIGURED, AUCUN profil synthétisé', async () => {
    const r = await loadCompanyProfile('ws_a')
    expect(r).toEqual({ ok: false, state: 'PROFILE_NOT_CONFIGURED' })
    expect(etat.persisted).toEqual([]) // rien n'a été écrit pour « aider »
  })

  it('BC-16 — ligne malformée ⇒ PROFILE_INVALID avec raison, jamais réparée', async () => {
    etat.store.set(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_a`, {
      schemaVersion: 'company-profile-v9.9', whatWeSell: UNKNOWN,
    })
    const r = await loadCompanyProfile('ws_a')
    expect(r.ok).toBe(false)
    if (r.ok === false && r.state === 'PROFILE_INVALID') {
      expect(r.reason).toBe('schema_version_invalid')
    } else {
      throw new Error('PROFILE_INVALID attendu')
    }
    expect(etat.persisted).toEqual([]) // pas de réécriture corrective
  })

  it('R1 — une ligne FALSY PRÉSENTE (false / 0 / \'\') est INVALID, jamais NOT_CONFIGURED', async () => {
    for (const falsy of [false, 0, ''] as const) {
      etat.store.clear()
      etat.persisted = []
      etat.store.set(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_a`, falsy)
      const r = await loadCompanyProfile('ws_a')
      // ABSENT ≠ MALFORMÉ : la ligne EXISTE, elle est corrompue — pas absente.
      expect(r, JSON.stringify(falsy)).toEqual({
        ok: false, state: 'PROFILE_INVALID', reason: 'profile_missing',
      })
      // Aucune écriture corrective ; la ligne n'est ni réécrite ni effacée.
      expect(etat.persisted).toEqual([])
      expect(etat.store.get(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_a`)).toBe(falsy)
    }
    // La VRAIE absence (value null / aucune ligne) reste NOT_CONFIGURED — sans
    // profil synthétisé.
    etat.store.clear()
    etat.persisted = []
    expect(await loadCompanyProfile('ws_a')).toEqual({ ok: false, state: 'PROFILE_NOT_CONFIGURED' })
    expect(etat.persisted).toEqual([])
  })

  it('R1 — GET réel sur une ligne falsy stockée ⇒ 200 PROFILE_INVALID, pas NOT_CONFIGURED', async () => {
    etat.store.set(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_a`, false)
    const r = await appeler('GET')
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('PROFILE_INVALID')
    expect(r.body.state).not.toBe('PROFILE_NOT_CONFIGURED')
    expect(etat.persisted).toEqual([])
  })

  it('BC-17 — magasin muet ⇒ PROFILE_UNAVAILABLE ; écriture refusée ⇒ échec explicite', async () => {
    etat.storeDown = true
    expect(await loadCompanyProfile('ws_a')).toEqual({ ok: false, state: 'PROFILE_UNAVAILABLE' })
    etat.storeDown = false
    etat.writesFail = true
    const r = await saveCompanyProfile(contenu(), 'ws_a')
    expect(r).toEqual({ ok: false, reason: 'store_write_failed' })
  })

  it('métadonnées stockées invalides ⇒ PROFILE_INVALID (revisionId/updatedAt vérifiés à la relecture)', () => {
    const base = {
      ...contenu(), schemaVersion: COMPANY_PROFILE_SCHEMA_VERSION,
      revisionId: 'r-1', updatedAt: '2026-09-05T12:00:00.000Z',
    }
    expect(validateStoredCompanyProfile(base).ok).toBe(true)
    expect(validateStoredCompanyProfile({ ...base, revisionId: '  ' }).ok).toBe(false)
    expect(validateStoredCompanyProfile({ ...base, updatedAt: 'pas-une-date' }).ok).toBe(false)
  })
})

describe('BC-18/19/20/21 — route et cloisonnement', () => {
  it('BC-18 — GET ne provoque AUCUNE écriture, quel que soit l’état', async () => {
    await appeler('GET') // non configuré
    await saveCompanyProfile(contenu(), 'ws_a')
    etat.persisted = []
    const r = await appeler('GET') // configuré
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('PROFILE_CONFIGURED')
    expect(etat.persisted).toEqual([]) // zéro upsert sur les deux GET
  })

  it('GET rend les quatre états produits', async () => {
    expect((await appeler('GET')).body.state).toBe('PROFILE_NOT_CONFIGURED')
    etat.store.set(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_a`, { corrompu: true })
    expect((await appeler('GET')).body.state).toBe('PROFILE_INVALID')
    etat.storeDown = true
    const down = await appeler('GET')
    expect(down.status).toBe(503)
    expect(down.body.state).toBe('PROFILE_UNAVAILABLE')
    etat.storeDown = false
    etat.store.clear()
    await saveCompanyProfile(contenu(), 'ws_a')
    expect((await appeler('GET')).body.state).toBe('PROFILE_CONFIGURED')
  })

  it('PUT valide ⇒ écrit puis RELIT ; PUT invalide ⇒ 422 PROFILE_REJECTED sans écriture', async () => {
    const ok = await appeler('PUT', contenu())
    expect(ok.status).toBe(200)
    expect(ok.body.state).toBe('PROFILE_CONFIGURED')
    expect(ok.body.profile.revisionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ok.body.profile.whatWeSell.value).toBe('Logiciel de prospection B2B')

    etat.persisted = []
    const ko = await appeler('PUT', contenu({ icp: { state: 'KNOWN', value: '  ' } }))
    expect(ko.status).toBe(422)
    expect(ko.body.state).toBe('PROFILE_REJECTED')
    expect(etat.persisted).toEqual([])
  })

  it('BC-19 — l’espace vient de la SESSION seule : query/body ne peuvent pas le désigner', async () => {
    // Une query `ws` hostile est ignorée ; une clé workspace dans le corps est refusée.
    const r = await appeler('PUT', contenu(), { ws: 'ws_victime', workspaceId: 'ws_victime' })
    expect(r.status).toBe(200)
    expect(etat.persisted.every((p) => p.ws === 'ws_a')).toBe(true)
    expect(etat.store.has(`${COMPANY_PROFILE_KIND}|${ACTIVE_PROFILE_ID}|ws_victime`)).toBe(false)

    const corps = await appeler('PUT', contenu({ workspace: 'ws_victime' }))
    expect(corps.status).toBe(422)

    etat.session = null // non authentifié ⇒ 403, aucune écriture
    etat.persisted = []
    expect((await appeler('PUT', contenu())).status).toBe(403)
    expect(etat.persisted).toEqual([])
  })

  it('BC-20 — le profil du tenant A est INATTEIGNABLE depuis le tenant B', async () => {
    await saveCompanyProfile(contenu(), 'ws_a')
    expect(await loadCompanyProfile('ws_b')).toEqual({ ok: false, state: 'PROFILE_NOT_CONFIGURED' })
    etat.session = { tenant: { id: 'ws_b' }, actorId: 'user_2' }
    expect((await appeler('GET')).body.state).toBe('PROFILE_NOT_CONFIGURED')
  })

  it('BC-21 — l’enregistrement écrit UNIQUEMENT kind=company_business_profile / id=active', async () => {
    await saveCompanyProfile(contenu(), 'ws_a')
    expect(etat.persisted).toHaveLength(1)
    expect(etat.persisted[0].kind).toBe('company_business_profile')
    expect(etat.persisted[0].id).toBe('active')
    expect(COMPANY_PROFILE_KIND).toBe('company_business_profile')
    expect(ACTIVE_PROFILE_ID).toBe('active')
  })

  it('méthodes hors GET/PUT ⇒ 405', async () => {
    for (const m of ['POST', 'PATCH', 'DELETE']) {
      expect((await appeler(m as any)).status).toBe(405)
    }
  })
})

describe('BC-1/22/23/24/25 — non-régression et indépendance', () => {
  it('BC-1/24 — configuration runtime, RoleCards, Motion Commerciale : sources BYTE-INCHANGÉES', () => {
    const { execSync } = require('node:child_process')
    const diff = execSync(
      'git diff --name-only HEAD -- ' +
      'lib/prospector/proactive/lens/context.ts ' +
      'lib/prospector/proactive/lens/contextStore.ts ' +
      'pages/api/proactive/context.ts ' +
      'lib/prospector/proactive/motions.ts ' +
      'lib/prospector/proactive/roles/roleCard.ts ' +
      'lib/prospector/proactive/commercialMotion.ts ' +
      'lib/prospector/proactive/recommendationEngine.ts ' +
      'lib/prospector/proactive/decisionKernel.ts',
      { encoding: 'utf8' },
    ).trim()
    expect(diff).toBe('')
  })

  it('BC-25 — AUCUN consommateur runtime : seuls contrat/magasin/route mentionnent le profil', () => {
    const { execSync } = require('node:child_process')
    const hits = execSync(
      "grep -rl 'companyProfile\\|company_business_profile\\|CompanyBusinessProfile' " +
      'lib pages --include="*.ts" --include="*.tsx"',
      { encoding: 'utf8' },
    ).trim().split('\n').sort()
    expect(hits).toEqual([
      'lib/prospector/proactive/profile/companyProfile.ts',
      'lib/prospector/proactive/profile/companyProfileStore.ts',
      'pages/api/business-profile.ts',
    ])
  })

  it('BC-23 — comportement AuthorizedMotion de référence inchangé (fail closed compris)', () => {
    const verdict = resolveMotionControl('engage_or_reengage', {
      prepare_outreach: 'allowed', contact_prospect: 'approval_required',
    })
    expect(verdict.control).toBe('approval_required')
    expect(resolveMotionControl('engage_or_reengage', {}).control).toBe('blocked')
  })

  it('BC-22 — identité de Recommendation inchangée : contextId identifie, contextVersion reste provenance', () => {
    const NOW = new Date('2026-09-05T12:00:00.000Z')
    const situation: any = {
      id: 'sit_1', type: 'sales_scale_up', accountId: 'acc_1',
      confidence: 0.8, relevance: 0.9, urgency: 'medium',
      detectedAt: NOW.toISOString(), evidenceIds: ['ev_1'],
      ruleVersion: 'v0.4', lensId: 'sales-default', lensVersion: 'v0.1',
    }
    const ctx = (contextVersion: string, contextId = 'sales-v0') => ({
      now: NOW,
      businessContext: {
        contextId, contextVersion,
        authorizedMotions: { prepare_outreach: 'allowed', contact_prospect: 'allowed' },
      },
    }) as any
    const a = recommendationDecision(situation, ctx('v0.1'))
    const b = recommendationDecision(situation, ctx('v0.2'))
    const c = recommendationDecision(situation, ctx('v0.1', 'autre-contexte'))
    expect((b as any).id).toBe((a as any).id) // version = provenance, pas identité
    expect((c as any).id).not.toBe((a as any).id) // contextId = identité
  })
})
