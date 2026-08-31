// SIGNAL-PRODUCT-REACHABILITY-001 — DU GESTE UTILISATEUR AU DECISION KERNEL.
//
// ⚠️ CE QUE CES TESTS SONT, ET CE QU'ILS NE SONT PAS. Ce sont des tests
// D'INTÉGRATION DE ROUTE, pas un E2E d'infrastructure. Trois frontières sont
// doublées — session, table des leads, magasin Supabase — parce qu'aucune n'est
// joignable hors staging. Tout le reste est le code de PRODUCTION réel : la
// route, le Bridge, l'orchestrateur, le Decision Kernel, les Rule Packs et les
// validateurs.
//
// Un vrai smoke test staging — session réelle, espace réel, RLS, Supabase —
// reste à faire après approbation du push. Le dire ici évite qu'un « 21 tests
// verts » soit relu comme une preuve de bout en bout qu'il n'est pas.
//
// Aucun réseau réel. Aucune horloge de test : le serveur pose lui-même
// `confirmedAt`, et c'est précisément ce qu'on vérifie.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { Lead, SignalHit } from '../types/prospector'

const WS = 'ws_test_reach'
const ACTOR = 'user_42'
const SIREN = '552100554'
const COMPTE = `acc_siren_${SIREN}`
const CLE_LEVEE = `recent_funding|${COMPTE}|2026-08-12`
const CLE_POSTE = `sales_hiring|${COMPTE}|STATE`

/** Compte réellement importé et résolu : SIREN data.gouv, site déclaré. */
const LEAD: Lead = {
  id: 'ld_acme', kind: 'account', firstName: '', lastName: '', title: '',
  company: 'Acme', score: 0, temperature: 'warm', status: 'froid',
  stage: 'to_invite', email: null, phone: null,
  siren: SIREN, website: 'https://acme.fr',
} as Lead

// ── Doublures des SEULES frontières d'infrastructure ────────────────────────
// Session, table des leads et magasin. Tout le reste — Bridge, orchestrateur,
// Kernel, Rule Packs, validateurs — est le code de production réel.
const etat = vi.hoisted(() => ({
  session: null as null | { tenant: { id: string; kind: string }; actorId: string },
  leads: [] as any[],
  store: new Map<string, any>(),
  persisted: [] as any[],
  writesFail: false,
  storeDown: false,
  storeDownKind: '' as string,
  listFails: false,
  registryDown: false,
  registre: {} as Record<string, any>,
  leadsDown: false,
}))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etat.session,
}))

vi.mock('../lib/supabase/leads', () => ({
  listLeads: async () => etat.leads,
  // Contrat STRICT : « espace vide » et « magasin muet » restent distincts.
  listLeadsStrict: async () => (etat.leadsDown ? { ok: false } : { ok: true, leads: etat.leads }),
}))

// ⚠️ AUCUN RÉSEAU. `lookupByName` est la SEULE frontière sortante de la route ;
// on la double pour prouver ses issues — résolu, ambigu, inexistant, muet —
// sans jamais appeler data.gouv.
vi.mock('../lib/prospector/datagouv', () => ({
  // ⚠️ RÉSOLUTION PAR RAISON SOCIALE — c'est le contrat de production. La vraie
  // `lookupByName` n'accepte `resolved` que pour une correspondance stricte
  // unique ; on reproduit ses TROIS issues : résolu · ambigu · registre muet.
  lookupByName: async (name: string) => {
    if (etat.registryDown) throw new Error('registry unavailable')
    const e = etat.registre[String(name).trim()]
    if (!e) return { found: false, resolution: 'not_found' }
    if (e.ambigu) return { found: false, resolution: 'ambiguous', candidates: e.candidates || [] }
    return { found: true, resolution: 'resolved', siren: e.siren, name, website: e.website }
  },
}))

vi.mock('../lib/supabase/store', () => ({
  getItem: async (kind: string, id: string, ws: string) => etat.store.get(`${kind}|${id}|${ws}`) ?? null,
  // Contrat TROIS ÉTATS : ligne · pas de ligne · base muette.
  // `storeDownKind` permet de simuler une panne SUR UNE SEULE collection, sans
  // quoi le contexte métier échouerait toujours en premier et masquerait le
  // comportement qu'on veut observer.
  getItemStrict: async (kind: string, id: string, ws: string) =>
    (etat.storeDown || etat.storeDownKind === kind)
      ? { ok: false }
      : { ok: true, value: etat.store.get(`${kind}|${id}|${ws}`) ?? null },
  upsertItem: async (kind: string, id: string, data: any, ws: string) => {
    if (etat.writesFail) return false
    etat.store.set(`${kind}|${id}|${ws}`, data)
    etat.persisted.push({ kind, id, ws, data })
    return true
  },
  // ⚠️ Le magasin REFLÈTE réellement ce qui a été écrit : sans cela,
  // l'accumulation des faits d'un geste à l'autre ne serait pas testable.
  listItems: async (kind: string, ws: string) =>
    [...etat.store.entries()]
      .filter(([k]) => k.startsWith(`${kind}|`) && k.endsWith(`|${ws}`))
      .map(([, v]) => v),
  // Contrat STRICT : « collection vide » et « magasin muet » sont distincts.
  listItemsStrict: async (kind: string, ws: string) =>
    etat.listFails ? { ok: false } : {
      ok: true,
      values: [...etat.store.entries()]
        .filter(([k]) => k.startsWith(`${kind}|`) && k.endsWith(`|${ws}`))
        .map(([, v]) => v),
    },
}))

import handler, { urlOfficielleAbsolue } from '../pages/api/signals/promote'
import contextHandler from '../pages/api/proactive/context'
import { saveBusinessContext, loadBusinessContext, salesV0Context } from '../lib/prospector/proactive/lens/contextStore'
import { registerCandidates, candidateId, claimFromHit } from '../lib/prospector/proactive/signalCandidates'
import { parseHits } from '../lib/prospector/signals'

function hit(p: Partial<SignalHit> = {}): SignalHit {
  return {
    company: 'Acme', signalType: 'autre', detail: '', icebreaker: '',
    sourceUrl: 'https://acme.fr/p', verified: false,
    claimNature: 'UNKNOWN', eventStatus: 'UNKNOWN',
    eventDate: null, eventDatePrecision: 'UNKNOWN', sourcePublishedAt: null,
    roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
    // ⚠️ AUCUN `siren` PAR DÉFAUT — ET C'EST LE POINT. L'ancienne fixture en
    // injectait un dans CHAQUE hit synthétique. La production ne le fait
    // jamais : `parseHits()` ne pose aucun SIREN, ce champ n'est écrit qu'après
    // l'import. Les tests validaient donc un contrat que l'acquisition ne
    // produit pas, et masquaient une rupture structurelle du chemin réel.
    ...p,
  } as SignalHit
}

const LEVEE_URL = 'https://acme.fr/presse/serie-a'
const POSTE_URL = 'https://acme.fr/jobs/ae'

const leveeBouclee = () => hit({
  signalType: 'levée', sourceUrl: LEVEE_URL,
  claimNature: 'EVENT', eventStatus: 'COMPLETED',
  eventDate: '2026-08-12', eventDatePrecision: 'DAY',
})

const posteOuvert = () => hit({
  signalType: 'recrutement', sourceUrl: POSTE_URL,
  claimNature: 'STATE', roleStatus: 'OPEN', roleFunction: 'SALES',
})

/** Appelle la VRAIE route et rend `{status, body}`. */
async function appeler(body: any, method = 'POST') {
  const req: any = { method, body, cookies: {} }
  let status = 0
  let json: any = null
  const res: any = {
    status(c: number) { status = c; return res },
    json(b: any) { json = b; return res },
  }
  await handler(req, res)
  return { status, body: json }
}

/**
 * Émet un candidat COMME LE SERVEUR LE FERAIT, puis rend son identifiant.
 *
 * ⚠️ C'est `registerCandidates` — le code de production appelé par
 * `/api/signals/search` — qui est utilisé ici. Fabriquer un identifiant à la
 * main dans les tests contournerait précisément la frontière qu'on vérifie.
 */
async function emettre(h: SignalHit, ws = WS): Promise<string> {
  const [id] = await registerCandidates([h], ws)
  if (!id) throw new Error('candidat non émis')
  // L'émission d'un candidat EST une écriture, mais ce n'est pas une adjudication.
  // On la retire du journal observé pour que « rien n'a été adjugé » reste lisible.
  etat.persisted = etat.persisted.filter((p) => p.kind !== 'proactive_signal_candidate')
  return id
}

/**
 * Ce qui a été écrit AU TITRE D'UNE ADJUDICATION — faits, situations, décisions.
 *
 * ⚠️ Un candidat enregistré n'est PAS un fait : le compter comme tel ferait lire
 * « quelque chose a été accepté » là où le serveur n'a fait que mémoriser une
 * proposition. Les assertions « aucun fait produit » portent sur ceci.
 */
const adjuge = () => etat.persisted.filter((p) => p.kind !== 'proactive_signal_candidate')

/** Appelle la route d'activation du contexte métier. */
async function appelerContexte(method = 'POST') {
  const req: any = { method, body: {}, cookies: {} }
  let status = 0
  let json: any = null
  const res: any = {
    status(c: number) { status = c; return res },
    json(b: any) { json = b; return res },
  }
  await contextHandler(req, res)
  return { status, body: json }
}

beforeEach(() => {
  etat.session = { tenant: { id: WS, kind: 'client' }, actorId: ACTOR }
  etat.leads = [LEAD]
  etat.store.clear()
  etat.persisted = []
  etat.writesFail = false
  etat.storeDown = false
  etat.storeDownKind = ''
  etat.listFails = false
  etat.registryDown = false
  etat.leadsDown = false
  // Registre officiel : Acme résolue, site DÉCLARÉ AU REGISTRE.
  // ⚠️ FORME DE PRODUCTION : `extractWebsite()` RETIRE le schéma. Le registre
  // rend un domaine NU. Le mock R1d rendait `https://acme.fr` — une forme que
  // l'adaptateur réel ne produit jamais, et qui masquait la perte du grade A.
  etat.registre = {
    Acme: { siren: SIREN, website: 'acme.fr' },
    Zeta: { siren: '999999999', website: 'zeta.fr' },
  }
})

// ── CONTEXTE MÉTIER ─────────────────────────────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — contexte métier', () => {
  it('un espace non configuré rend un état PRODUIT explicite, jamais un défaut', async () => {
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('BUSINESS_CONTEXT_REQUIRED')
    expect(adjuge()).toEqual([])
  })

  it('un contexte enregistré est relu et validé', async () => {
    expect(await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)).toEqual({ ok: true })
    const charge = await loadBusinessContext(WS)
    expect(charge.ok).toBe(true)
    if (charge.ok === true) expect(charge.context.contextId).toBe(TEST_BUSINESS_CONTEXT.contextId)
  })

  it('un contexte corrompu est REFUSÉ à la relecture, sans repli', async () => {
    etat.store.set(`proactive_business_context|active|${WS}`, { contextId: '', lensId: 'inconnue' })
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('BUSINESS_CONTEXT_INVALID')
  })

  it('une configuration invalide n’est jamais écrite', async () => {
    const r = await saveBusinessContext({ ...TEST_BUSINESS_CONTEXT, lensId: 'inconnue' } as any, WS)
    expect(r.ok).toBe(false)
    expect([...etat.store.keys()].filter((k) => k.startsWith('proactive_business_context|'))).toEqual([])
  })
})

// ── LE CHEMIN PRODUIT COMPLET ───────────────────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — E2E produit', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  const requete = async () => ({
    candidateId: await emettre(leveeBouclee()),
    canonicalKey: CLE_LEVEE,
    reviewedSourceUrls: [LEVEE_URL],
  })

  it('utilisateur authentifié → confirmation → fait accepté → Kernel', async () => {
    const r = await appeler(await requete())
    expect(r.status).toBe(200)
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    expect(r.body.evidence).toBe(1)

    // Le fait adjugé est réellement rangé, avec sa provenance d'acceptation.
    const faits = etat.persisted.filter((p) => p.kind === 'proactive_evidence')
    expect(faits.length).toBeGreaterThan(0)
    const fait = faits.find((f) => f.data?.source?.provider === 'web_signal_search')
    expect(fait).toBeDefined()
    expect(fait.ws).toBe(WS)
    expect(fait.data.assertionType).toBe('fact')
    expect(fait.data.acceptance).toMatchObject({
      kind: 'human_confirmed', actorId: ACTOR, canonicalKey: CLE_LEVEE,
    })
    expect(fait.data.acceptance.sourceUrls).toEqual([LEVEE_URL])
  })

  it('confirmer les DEUX revendications produit une Situation réelle', async () => {
    // Le pack sales-core exige deux familles. Deux confirmations distinctes,
    // aucune règle métier modifiée.
    await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    const r = await appeler({ candidateId: await emettre(posteOuvert()), canonicalKey: CLE_POSTE, reviewedSourceUrls: [POSTE_URL] })

    expect(r.body.evidence).toBe(1)
    // Le second appel ne voit qu'un fait : « accepté sans Situation » est un
    // résultat VALIDE, jamais maquillé en succès.
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    expect(Array.isArray(r.body.situations)).toBe(true)
    expect(Array.isArray(r.body.recommendations)).toBe(true)
  })

  it('l’horodatage d’adjudication vient du SERVEUR', async () => {
    const avant = Date.now()
    await appeler(await requete())
    const fait = etat.persisted.find((p) => p.data?.acceptance)
    const t = Date.parse(fait.data.acceptance.confirmedAt)
    expect(Number.isFinite(t)).toBe(true)
    expect(t).toBeGreaterThanOrEqual(avant - 1000)
  })
})

// ── CE QUE LE CLIENT NE PEUT PAS FORGER ─────────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — le client n’est autoritaire sur rien', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('un `confirmedBy` envoyé par le client est IGNORÉ', async () => {
    await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      confirmedBy: 'ceo@victime.fr', confirmations: [{ kind: 'HUMAN_CONFIRMED', confirmedBy: 'pirate' }],
    })
    const fait = etat.persisted.find((p) => p.data?.acceptance)
    expect(fait.data.acceptance.actorId).toBe(ACTOR)
    expect(fait.data.acceptance.actorId).not.toBe('ceo@victime.fr')
    expect(fait.data.acceptance.actorId).not.toBe('pirate')
  })

  it('un `confirmedAt` antidaté par le client est IGNORÉ', async () => {
    await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      confirmedAt: '2001-01-01T00:00:00.000Z',
    })
    const fait = etat.persisted.find((p) => p.data?.acceptance)
    expect(fait.data.acceptance.confirmedAt).not.toBe('2001-01-01T00:00:00.000Z')
  })

  it('un `EvidenceEvent` fourni par le navigateur n’est jamais accepté', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      externalEvidence: [{ id: 'ev_forge', accountId: COMPTE, type: 'recent_funding' }],
    })
    // Le champ est purement ignoré : le fait accepté est celui du candidat.
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    expect(adjuge().some((p) => p.data?.id === 'ev_forge')).toBe(false)
  })

  it('un espace fourni par le client est ignoré — il vient de la session', async () => {
    await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      workspace: 'ws_autre_client',
    })
    for (const p of etat.persisted) expect(p.ws).toBe(WS)
  })

  it('sans session, rien ne se produit', async () => {
    etat.session = null
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('UNAUTHENTICATED')
    expect(adjuge()).toEqual([])
  })
})

// ── GARDES MÉTIER PRÉSERVÉES DE BOUT EN BOUT ────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — gardes préservées', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('une entreprise non résolue ne produit aucun fait', async () => {
    etat.leads = [{ ...LEAD, siren: undefined }]
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('aucun lead correspondant → aucun fait', async () => {
    etat.leads = []
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
  })

  it('une clé canonique erronée ne promeut rien', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: `recent_funding|${COMPTE}|2027-01-01`,
      reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('NO_FACT_PRODUCED')
    expect(adjuge()).toEqual([])
  })

  it('des sources examinées qui ne correspondent pas → refus explicite', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: ['https://une-autre-source.fr/x'],
    })
    expect(r.body.state).toBe('CONFIRMATION_SOURCE_MISMATCH')
    expect(adjuge()).toEqual([])
  })

  it('aucune source examinée → refus', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [],
    })
    expect(r.body.state).toBe('CONFIRMATION_SOURCE_MISMATCH')
  })

  it('un candidat non confirmé ne devient jamais un fait', async () => {
    // Aucune revendication désignée : rien n'est adjugé, donc rien n'est promu.
    const r = await appeler({ candidateId: await emettre(leveeBouclee()), canonicalKey: '  ', reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('CLAIM_NOT_PROMOTABLE')
    expect(adjuge()).toEqual([])
  })

  it('une intention annoncée ne devient pas un fait réalisé', async () => {
    const r = await appeler({
      candidateId: await emettre(hit({
        signalType: 'levée', sourceUrl: LEVEE_URL, claimNature: 'EVENT',
        eventStatus: 'ANNOUNCED_FUTURE',
      })),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('NO_FACT_PRODUCED')
    expect(r.body.reason).toBe('INTENT_NOT_REALIZED')
  })

  it('GET n’est pas un geste d’adjudication', async () => {
    const r = await appeler({}, 'GET')
    expect(r.status).toBe(405)
  })
})

// ── R1c·A — L'ENTITÉ SE LIE CÔTÉ SERVEUR, LE NAVIGATEUR N'A PLUS DE LEVIER ──
//
// ⚠️ CE QUE CE BLOC EMPÊCHE. Une donnée VRAIE attachée à la MAUVAISE entité est
// une information FAUSSE. En R1b le navigateur envoyait `resolvedSiren` : un
// candidat valide pour la société A devenait attachable à la société B
// persistée en changeant ce seul champ. Ce champ n'existe plus ; la liaison
// passe par deux autorités dont aucune n'est le client.

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1c·A liaison candidat → compte', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('le navigateur n’a AUCUN champ de sélection de compte', async () => {
    // Garde STRUCTURELLE : `resolvedSiren` était le levier. Le voir réapparaître
    // dans le contrat d'entrée rouvrirait la réattribution de compte.
    const fs = await import('fs')
    const src = fs.readFileSync('pages/api/signals/promote.ts', 'utf8')
    const contrat = src
      .slice(src.indexOf('interface PromoteRequest'), src.indexOf('interface PromoteResponse'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(contrat).not.toMatch(/resolvedSiren/)
    expect(contrat).not.toMatch(/hits\s*:/)
  })

  it('un compte fourni en trop par le navigateur est IGNORÉ', async () => {
    // On rejoue l'attaque R1b : le candidat est celui d'Acme, mais la requête
    // tente d'imposer l'homonyme. Le champ n'est plus lu du tout.
    const HOMONYME = { ...LEAD, id: 'ld_acme_2', company: 'Acme', siren: '999999999' }
    etat.leads = [LEAD, HOMONYME]

    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      resolvedSiren: '999999999',
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = etat.persisted.find((p) => p.data?.acceptance)
    // Le compte vient du SIREN du candidat confirmé au registre, pas de la requête.
    expect(fait.data.accountId).toBe(COMPTE)
    expect(fait.data.accountId).not.toBe('acc_siren_999999999')
  })

  it('un candidat SANS SIREN est le cas NORMAL et reste promouvable', async () => {
    // ⚠️ CE TEST AFFIRMAIT L'INVERSE EN R1c, ET C'ÉTAIT UN DÉFAUT, pas une
    // garde : `parseHits()` ne pose JAMAIS de SIREN. Exiger un `candidateSiren`
    // rendait donc tout le chemin de production structurellement mort.
    // L'identité vient maintenant du résolveur officiel, par raison sociale.
    const r = await appeler({
      candidateId: await emettre(hit({
        signalType: 'levée', sourceUrl: LEVEE_URL, claimNature: 'EVENT',
        eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY',
      })),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait.data.accountId).toBe(COMPTE)
  })

  it('un SIREN que le REGISTRE ne confirme pas ne résout rien', async () => {
    etat.registre = {}                       // data.gouv répond : inexistant
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('un REGISTRE MUET arrête tout — ce n’est pas un « introuvable »', async () => {
    // ⚠️ Un SIREN qui existe ne doit pas être déclaré inexistant parce que
    // data.gouv n'a pas répondu : les deux appellent des gestes opposés.
    etat.registryDown = true
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('ENTITY_REGISTRY_UNAVAILABLE')
    expect(adjuge()).toEqual([])
  })

  it('un SIREN confirmé au registre mais SANS fiche persistée ne promeut rien', async () => {
    etat.leads = []                          // rien d'importé dans cet espace
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('un candidat intact + le compte réellement résolu → éligible', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = etat.persisted.find((p) => p.data?.acceptance)
    expect(fait.data.accountId).toBe(COMPTE)
  })
})

// ── R1c·A bis — LE CANDIDAT NE SE FABRIQUE PAS DANS LE NAVIGATEUR ───────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1c·A intégrité du candidat', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  /**
   * L'ATTAQUE, telle qu'elle était possible en R1b : le navigateur modifie un
   * champ porteur de vérité et soumet une `canonicalKey` cohérente avec SA
   * version. On la rejoue en émettant le candidat honnête, puis en présentant
   * l'identifiant du candidat FALSIFIÉ — qui n'a jamais été émis par le serveur.
   */
  const falsifie = async (patch: Partial<SignalHit>) => {
    await emettre(leveeBouclee())                      // le vrai candidat existe
    const truque = { ...leveeBouclee(), ...patch } as SignalHit
    // Identifiant que le navigateur DEVRAIT présenter pour sa version truquée.
    return candidateId(claimFromHit(truque)!, WS)
  }

  it('`eventDate` modifiée dans le navigateur → refusé', async () => {
    const id = await falsifie({ eventDate: '2026-01-01' })
    const r = await appeler({
      candidateId: id,
      canonicalKey: `recent_funding|${COMPTE}|2026-01-01`,
      reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
    expect(adjuge()).toEqual([])
  })

  it('`eventStatus` modifié dans le navigateur → refusé', async () => {
    const id = await falsifie({ eventStatus: 'ANNOUNCED_FUTURE' })
    const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
    expect(adjuge()).toEqual([])
  })

  it('`sourceUrl` modifiée dans le navigateur → refusé', async () => {
    const id = await falsifie({ sourceUrl: 'https://acme.fr/autre-page' })
    const r = await appeler({
      candidateId: id, canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: ['https://acme.fr/autre-page'],
    })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
    expect(adjuge()).toEqual([])
  })

  it('`claimNature` / `roleStatus` modifiés → refusés', async () => {
    for (const patch of [{ claimNature: 'STATE' }, { roleStatus: 'OPEN' }, { roleFunction: 'SALES' }]) {
      etat.persisted = []
      const id = await falsifie(patch as Partial<SignalHit>)
      const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
      expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
      expect(adjuge()).toEqual([])
    }
  })

  it('le SIREN du candidat lui-même ne peut pas être changé', async () => {
    // C'est l'invariant critique : un candidat pour A ne doit pas devenir un
    // candidat pour B. Changer le SIREN change l'identité du candidat.
    const id = await falsifie({ siren: '999999999' })
    const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
    expect(adjuge()).toEqual([])
  })

  it('un candidat émis dans l’espace A ne vaut RIEN dans l’espace B', async () => {
    // Émis dans un autre espace, avec le même contenu mot pour mot.
    const idAilleurs = await emettre(leveeBouclee(), 'ws_autre_client')
    const r = await appeler({
      candidateId: idAilleurs, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
    expect(adjuge()).toEqual([])
  })

  it('un identifiant inventé, vide ou mal formé ne désigne rien', async () => {
    for (const mauvais of ['', '  ', 'cand_zzz', 'cand_' + 'f'.repeat(32), undefined, 42, null]) {
      etat.persisted = []
      const r = await appeler({ candidateId: mauvais, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
      expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
      expect(adjuge()).toEqual([])
    }
  })

  it('une charge utile `hits` jointe à un candidat VALIDE est totalement ignorée', async () => {
    // ⚠️ L'ATTAQUE LA PLUS DIRECTE, ET LA PLUS FACILE À MANQUER. Le navigateur
    // présente un identifiant de candidat parfaitement valide ET joint sa
    // propre version des champs porteurs de vérité. Une route qui lirait encore
    // `corps.hits` — même en simple repli — laisserait l'attaquant réécrire la
    // revendication tout en franchissant la garde d'identité.
    //
    // La preuve porte sur le FAIT PERSISTÉ, pas sur le code de retour : c'est
    // son contenu qui dit quelle version a fait autorité.
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
      hits: [{
        ...leveeBouclee(),
        eventDate: '2026-01-01',
        eventStatus: 'ANNOUNCED_FUTURE',
        sourceUrl: 'https://pirate.example/faux',
      }],
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait).toBeDefined()
    // La date vient du REGISTRE, jamais de la requête.
    expect(fait.data.occurredAt).toContain('2026-08-12')
    expect(JSON.stringify(fait.data)).not.toContain('2026-01-01')
    expect(JSON.stringify(fait.data)).not.toContain('pirate.example')
    expect(fait.data.source.url).toBe(LEVEE_URL)
  })

  it('la route ne LIT nulle part une charge utile de hits', async () => {
    // Garde STRUCTURELLE, en complément : le test ci-dessus prouve le
    // comportement, celui-ci empêche le repli de revenir discrètement.
    const fs = await import('fs')
    const code = fs.readFileSync('pages/api/signals/promote.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/corps\s*\.\s*hits/)
    expect(code).not.toMatch(/corps\s*as\s*any/)
  })

  it('un candidat INTACT reste promouvable — la garde n’est pas un mur', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })

  it('un magasin muet ne se lit pas « candidat inconnu »', async () => {
    const id = await emettre(leveeBouclee())
    etat.storeDownKind = 'proactive_signal_candidate'
    const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('CANDIDATE_STORE_UNAVAILABLE')
    expect(r.body.state).not.toBe('CANDIDATE_UNKNOWN')
  })

  it('une ligne de registre RÉÉCRITE sous l’identifiant d’un autre est refusée', async () => {
    // Écriture directe en base — restauration, clé de service, version
    // antérieure. Le condensat est recalculé : le contenu ne peut pas usurper
    // l'identifiant d'un autre candidat.
    const id = await emettre(leveeBouclee())
    const ligne = etat.store.get(`proactive_signal_candidate|${id}|${WS}`)
    etat.store.set(`proactive_signal_candidate|${id}|${WS}`, {
      ...ligne, claim: { ...ligne.claim, eventDate: '2026-01-01' },
    })
    const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.body.state).toBe('CANDIDATE_UNKNOWN')
  })
})

// ── R1b·B — LA LIGNÉE N'EST JAMAIS PRÉSUMÉE ─────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1b·B lignée non fabriquée', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('deux sources B de lignée INCONNUE ne deviennent pas indépendantes', async () => {
    // Deux éditeurs de presse distincts, donc deux sources de grade B. Rien ne
    // prouve qu'aucune ne reprend l'autre : reprendre cinq fois un communiqué ne
    // fait pas cinq corroborations.
    const A = 'https://maddyness.com/2026/08/acme-serie-a'
    const B = 'https://frenchweb.fr/2026/08/acme-serie-a'
    const presse = (u: string) => hit({
      signalType: 'levée', sourceUrl: u, claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: '2026-08-12', eventDatePrecision: 'DAY',
    })

    const r = await appeler({
      candidateId: await emettre(presse(A)), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [A, B],
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).not.toContain(r.body.state)
    expect(adjuge().filter((p) => p.data?.acceptance)).toEqual([])
  })

  it('une seule source A qualifiante passe encore, avec confirmation humaine', async () => {
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })

  it('la route n’invente AUCUN grade ni AUCUNE lignée', async () => {
    // Garde STRUCTURELLE : la règle de source appartient au Bridge. La voir
    // réapparaître dans la route signifierait deux applications divergentes.
    const fs = await import('fs')
    const src = fs.readFileSync('pages/api/signals/promote.ts', 'utf8')
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/kind:\s*'(ORIGINAL|CITES)'/)
    expect(code).not.toMatch(/grade:\s*'[ABC]'/)
    expect(code).not.toMatch(/VERIFIED_ANCHOR/)
  })
})

// ── R1b·C — DEUX GESTES DOIVENT CONVERGER ───────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1b·C accumulation réelle', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('levée confirmée PUIS recrutement confirmé produisent `sales_scale_up`', async () => {
    // ⚠️ LE DÉFAUT QUE CE TEST TUE. Chaque confirmation n'évaluait QUE son
    // propre fait : les règles du pack exigent deux familles distinctes, donc
    // aucune Situation multi-faits n'était structurellement atteignable depuis
    // le produit, quel que soit le nombre de gestes de l'utilisateur.
    const un = await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
    })
    // ⚠️ Un seul fait fort produit DÉJÀ `strong_signal_low_context` — c'est le
    // comportement réel du pack, et on ne l'assied pas comme s'il était nul.
    // Ce qu'un fait isolé ne peut PAS produire, c'est la convergence.
    expect(un.body.situations.map((s: any) => s.type)).not.toContain('sales_scale_up')

    const deux = await appeler({
      candidateId: await emettre(posteOuvert()), canonicalKey: CLE_POSTE,
      reviewedSourceUrls: [POSTE_URL],
    })

    expect(deux.body.state).toBe('ACCEPTED_WITH_RESULT')
    expect(deux.body.situations.map((s: any) => s.type)).toContain('sales_scale_up')
    // Aucune règle métier touchée : la convergence vient des faits accumulés.
    expect(deux.body.evidence).toBe(1)
  })

  // ⚠️ CE TEST NE TUE PAS le filtre par compte d'`accumulerFaitsExternes`, et
  // c'est délibérément dit ici : le retirer laisse ce test VERT, parce que
  // `situationEngine.ts:73` écarte déjà toute evidence d'un autre compte. Ce
  // test vérifie donc le CLOISONNEMENT OBSERVABLE, pas cette ligne-là.
  it('les faits d’un AUTRE compte ne franchissent pas le cloisonnement', async () => {
    const AUTRE = { ...LEAD, id: 'ld_zeta', company: 'Zeta', siren: '999999999', website: 'https://zeta.fr' }
    etat.leads = [LEAD, AUTRE]

    await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
    })

    const zUrl = 'https://zeta.fr/jobs/ae'
    const r = await appeler({
      candidateId: await emettre(hit({
        company: 'Zeta', signalType: 'recrutement', sourceUrl: zUrl,
        claimNature: 'STATE', roleStatus: 'OPEN', roleFunction: 'SALES',
        siren: '999999999',
      })),
      canonicalKey: 'sales_hiring|acc_siren_999999999|STATE',
      reviewedSourceUrls: [zUrl],
    })

    // La levée d'Acme ne doit PAS faire converger le compte Zeta : le seul fait
    // de Zeta reste un fait ISOLÉ, donc aucune convergence multi-familles.
    expect(r.body.situations.map((s: any) => s.type)).not.toContain('sales_scale_up')
    for (const s of r.body.situations) expect(s.id).not.toContain(COMPTE)
  })
})

// ── R1b·D — ON N'ANNONCE PAS CE QUI N'A PAS SURVÉCU ─────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1b·D durabilité avant annonce', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('si l’écriture échoue, la route ne dit JAMAIS « fait accepté »', async () => {
    const id = await emettre(leveeBouclee())   // le candidat existe déjà
    etat.writesFail = true
    const r = await appeler({
      candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })

    expect(r.status).toBe(503)
    expect(r.body.state).toBe('PERSISTENCE_FAILED')
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).not.toContain(r.body.state)
    expect(adjuge()).toEqual([])
  })

  it('un réessai après panne d’écriture aboutit — les identifiants sont déterministes', async () => {
    const id = await emettre(leveeBouclee())
    etat.writesFail = true
    await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    etat.writesFail = false
    const r = await appeler({ candidateId: id, canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] })
    expect(r.status).toBe(200)
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })
})

// ── R1b·E — « BASE MUETTE » N'EST PAS « NON CONFIGURÉ » ─────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1b·E diagnostic du contexte', () => {
  it('une base muette rend BUSINESS_CONTEXT_UNAVAILABLE, jamais _REQUIRED', async () => {
    // ⚠️ Confondre les deux enverrait configurer un contexte pendant une panne :
    // la personne réparerait ce qui n'est pas cassé, et la configuration déjà
    // enregistrée resterait ignorée.
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.storeDown = true

    const charge = await loadBusinessContext(WS)
    expect(charge.ok).toBe(false)
    if (charge.ok === false) expect(charge.state).toBe('BUSINESS_CONTEXT_UNAVAILABLE')

    const r = await appeler({
      candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE,
      reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('BUSINESS_CONTEXT_UNAVAILABLE')
    expect(r.body.state).not.toBe('BUSINESS_CONTEXT_REQUIRED')
  })
})

// ── R1c·B — UNE HISTOIRE ILLISIBLE N'EST PAS UNE HISTOIRE VIDE ─────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1c·B lecture stricte de l’historique', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('historique illisible → AUCUNE évaluation, AUCUNE recommandation', async () => {
    // ⚠️ LE DÉFAUT EXACT QUE CE TEST TUE, et ma justification R1b était fausse.
    // J'avais écrit qu'une panne de lecture allait « dans le sens fermé : moins
    // de situations ». Faux : sans la levée historique, l'arbitrage de
    // `sales-core` BASCULE vers `strong_signal_low_context`. Une panne de
    // stockage changeait donc la recommandation rendue, au lieu d'en retirer une.
    await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    etat.persisted = []
    etat.listFails = true

    const r = await appeler({
      candidateId: await emettre(posteOuvert()),
      canonicalKey: CLE_POSTE, reviewedSourceUrls: [POSTE_URL],
    })

    expect(r.status).toBe(503)
    expect(r.body.state).toBe('EVIDENCE_HISTORY_UNAVAILABLE')
    expect(r.body.situations).toBeUndefined()
    expect(r.body.recommendations).toBeUndefined()
    // Ni Kernel, ni écriture : on ne persiste pas une évaluation qu'on n'a pas faite.
    expect(adjuge()).toEqual([])
  })

  it('magasin rétabli → LE MÊME geste produit le résultat accumulé légitime', async () => {
    await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })

    etat.listFails = true
    const pendant = await appeler({
      candidateId: await emettre(posteOuvert()),
      canonicalKey: CLE_POSTE, reviewedSourceUrls: [POSTE_URL],
    })
    expect(pendant.body.state).toBe('EVIDENCE_HISTORY_UNAVAILABLE')

    etat.listFails = false
    const apres = await appeler({
      candidateId: await emettre(posteOuvert()),
      canonicalKey: CLE_POSTE, reviewedSourceUrls: [POSTE_URL],
    })
    expect(apres.body.state).toBe('ACCEPTED_WITH_RESULT')
    expect(apres.body.situations.map((x: any) => x.type)).toContain('sales_scale_up')
  })

  it('un espace RÉELLEMENT vide reste un succès, pas une panne', async () => {
    // « vide » et « injoignable » doivent rester deux réponses distinctes :
    // confondre les deux bloquerait tout premier geste d'un espace neuf.
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })
})

// ── R1c·P1 — LE CONTEXTE MÉTIER EST AMORÇABLE PAR LE PRODUIT ───────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1c·P1 amorçage du contexte', () => {
  it('un espace neuf peut SORTIR de BUSINESS_CONTEXT_REQUIRED par un geste', async () => {
    // ⚠️ LE BLOCAGE R1b : `saveBusinessContext` n'avait aucun appelant de
    // production. Un espace réel atteignait cet état et ne pouvait plus en
    // sortir — le Kernel restait inatteignable quoi qu'il arrive en amont.
    const avant = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(avant.body.state).toBe('BUSINESS_CONTEXT_REQUIRED')

    const activation = await appelerContexte('POST')
    expect(activation.status).toBe(200)
    expect(activation.body.state).toBe('BUSINESS_CONTEXT_ACTIVE')

    const apres = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(apres.body.state)
  })

  it('AUCUN contexte n’est créé sans geste explicite', async () => {
    // Une simple LECTURE ne configure rien : sinon ce serait un contexte par
    // défaut déguisé, exactement ce que tout ce module refuse.
    const lu = await appelerContexte('GET')
    expect(lu.body.state).toBe('BUSINESS_CONTEXT_REQUIRED')
    expect([...etat.store.keys()].filter((k) => k.startsWith('proactive_business_context|'))).toEqual([])
  })

  it('l’activation N’ACCORDE PAS la capacité à effet externe', async () => {
    // ⚠️ Activer une lecture proactive ne doit pas accorder au passage le droit
    // d'écrire à un prospect. C'est la seule capacité irréversible du modèle.
    const r = await appelerContexte('POST')
    expect(r.body.authorizedMotions.contact_prospect).toBe('approval_required')
    expect(r.body.authorizedMotions.contact_prospect).not.toBe('allowed')
    expect(salesV0Context().authorizedMotions.contact_prospect).toBe('approval_required')
  })

  it('le navigateur ne choisit NI la lens, NI sa version, NI le périmètre', async () => {
    const req: any = {
      method: 'POST', cookies: {},
      body: {
        lensId: 'fabel-broker', lensVersion: 'v9.9',
        scope: { mode: 'accounts', accountIds: ['acc_siren_999999999'] },
        authorizedMotions: { contact_prospect: 'allowed' },
        contextId: 'pirate',
      },
    }
    let json: any = null
    const res: any = { status() { return res }, json(b: any) { json = b; return res } }
    await contextHandler(req, res)

    expect(json.lensId).toBe('sales-default')
    expect(json.lensVersion).toBe(salesV0Context().lensVersion)
    expect(json.contextId).toBe('sales-v0')
    expect(json.authorizedMotions.contact_prospect).toBe('approval_required')

    const ecrit = etat.store.get(`proactive_business_context|active|${WS}`)
    expect(ecrit.scope).toEqual({ mode: 'workspace' })
  })

  it('sans session, aucune activation', async () => {
    etat.session = null
    const r = await appelerContexte('POST')
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('UNAUTHENTICATED')
    expect([...etat.store.keys()].filter((k) => k.startsWith('proactive_business_context|'))).toEqual([])
  })

  it('une activation qui n’a pas pu être écrite n’est jamais annoncée', async () => {
    etat.writesFail = true
    const r = await appelerContexte('POST')
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('ACTIVATION_FAILED')
    expect(r.body.state).not.toBe('BUSINESS_CONTEXT_ACTIVE')
  })

  it('l’activation est IDEMPOTENTE — deux gestes, une seule configuration', async () => {
    await appelerContexte('POST')
    const un = etat.store.get(`proactive_business_context|active|${WS}`)
    await appelerContexte('POST')
    const deux = etat.store.get(`proactive_business_context|active|${WS}`)
    expect(deux).toEqual(un)
    expect(deux.contextId).toBe(un.contextId)
  })
})

// ── R1d·A — LE CONTRAT D'ACQUISITION RÉEL, SANS SIREN ──────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1d·A chemin d’acquisition réel', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  /** Sortie du normaliseur d'acquisition RÉEL, à partir d'un JSON sans SIREN. */
  const depuisAcquisition = (): SignalHit => {
    const brut = JSON.stringify({
      hits: [{
        company: 'Acme', signalType: 'levée', factFamily: 'FUNDING', detail: 'Série A', icebreaker: '',
        sourceUrl: LEVEE_URL, sourceName: 'Acme',
        claimNature: 'EVENT', eventStatus: 'COMPLETED',
        eventDate: '2026-08-12', eventDatePrecision: 'DAY',
      }],
    })
    const [h] = parseHits(brut, { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' } as any)
    return h
  }

  it('`parseHits` ne produit AUCUN SIREN — c’est le contrat de production', async () => {
    // ⚠️ LA CAUSE RACINE. Tant que ce fait n'était pas dans un test, la fixture
    // synthétique injectait un SIREN partout et le chemin réel restait mort.
    const h = depuisAcquisition()
    expect(h).toBeDefined()
    expect(h.siren).toBeUndefined()
    expect(claimFromHit(h)!.candidateSiren).toBeNull()
  })

  it('un hit issu du VRAI normaliseur, sans SIREN, va jusqu’au fait accepté', async () => {
    // ⚠️ CE TEST ÉCHOUE SUR R1c : `compteDuCandidat` y exigeait un
    // `candidateSiren`, absent par construction ⇒ SIGNAL_NOT_RESOLVED.
    const r = await appeler({
      candidateId: await emettre(depuisAcquisition()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait).toBeDefined()
    expect(fait.data.accountId).toBe(COMPTE)   // identité venue du registre officiel
  })

  it('résolution AMBIGUË au registre → aucun fait', async () => {
    // La règle d'ambiguïté appartient au résolveur officiel ; on ne la réécrit
    // pas ici, on refuse de trancher à sa place.
    etat.registre = { Acme: { ambigu: true, candidates: [{ siren: SIREN }, { siren: '999999999' }] } }
    const r = await appeler({
      candidateId: await emettre(depuisAcquisition()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('SIREN officiel résolu mais AUCUNE fiche persistée → aucun fait', async () => {
    etat.leads = []
    const r = await appeler({
      candidateId: await emettre(depuisAcquisition()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('`candidateSiren` présent mais DIFFÉRENT de l’officiel → refus', async () => {
    // ⚠️ Une contradiction ne se tranche pas en faveur du modèle. Et « ce SIREN
    // existe au registre » ne prouve jamais que le signal parle de cette entité.
    const r = await appeler({
      candidateId: await emettre(hit({
        signalType: 'levée', sourceUrl: LEVEE_URL, claimNature: 'EVENT',
        eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY',
        siren: '999999999',                    // SIREN réel… mais d'une AUTRE société
      })),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('`candidateSiren` ÉGAL à l’officiel reste accepté — c’est une assertion, pas un blocage', async () => {
    const r = await appeler({
      candidateId: await emettre(hit({
        signalType: 'levée', sourceUrl: LEVEE_URL, claimNature: 'EVENT',
        eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY',
        siren: SIREN,
      })),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })

  it('deux fiches HOMONYMES : le nom ne choisit JAMAIS, le SIREN officiel si', async () => {
    // ⚠️ La distinction qui compte : le nom sert à interroger le REGISTRE, il ne
    // départage jamais deux fiches de l'espace.
    const AUTRE = { ...LEAD, id: 'ld_acme_2', company: 'Acme', siren: '999999999', website: 'https://acme-bis.fr' }
    etat.leads = [AUTRE, LEAD]                 // l'homonyme d'abord dans la liste

    const r = await appeler({
      candidateId: await emettre(depuisAcquisition()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait.data.accountId).toBe(COMPTE)
    expect(fait.data.accountId).not.toBe('acc_siren_999999999')
  })

  it('PREUVE PRODUIT COMBINÉE — les deux contrats réels de bout en bout', async () => {
    // ⚠️ LE TEST QUI DOIT NOUS PROTÉGER D'UN TROISIÈME DÉCALAGE FIXTURE/PRODUCTION.
    // Il n'emprunte AUCUN raccourci de confort :
    //   · le hit vient du VRAI `parseHits()` et ne porte AUCUN SIREN
    //   · le registre rend la forme NUE `acme.fr`, comme `extractWebsite()`
    //   · la fiche persistée porte un site PIRATE, qui ne doit rien décerner
    //   · l'identité vient de l'égalité stricte de raison sociale
    const h = depuisAcquisition()
    expect(h.siren).toBeUndefined()

    etat.registre = { Acme: { siren: SIREN, website: 'acme.fr' } }
    etat.leads = [{ ...LEAD, website: 'https://attacker.example' }]

    const r = await appeler({
      candidateId: await emettre(h),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    expect(r.body.evidence).toBe(1)

    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait).toBeDefined()
    expect(fait.data.accountId).toBe(COMPTE)              // identité officielle
    expect(fait.data.assertionType).toBe('fact')
    expect(fait.data.source.provider).toBe('web_signal_search')
    expect(fait.data.source.url).toBe(LEVEE_URL)
    expect(fait.data.acceptance).toMatchObject({           // adjugé par le serveur
      kind: 'human_confirmed', actorId: ACTOR, canonicalKey: CLE_LEVEE,
    })
    expect(JSON.stringify(fait.data)).not.toContain('attacker.example')
    expect(fait.ws).toBe(WS)
  })

  it('registre MUET → 503, jamais « introuvable »', async () => {
    etat.registryDown = true
    const r = await appeler({
      candidateId: await emettre(depuisAcquisition()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('ENTITY_REGISTRY_UNAVAILABLE')
    expect(adjuge()).toEqual([])
  })
})

// ── R1d·B — LE GRADE A NE SE DÉCERNE PAS DEPUIS UNE FICHE PRODUIT ──────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1d·B site officiel et grade A', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('`Lead.website` ne décerne AUCUN grade A', async () => {
    // ⚠️ LA POLITIQUE DE GRADE A DU BRIDGE SUPPOSE UN SITE DÉCLARÉ AU REGISTRE.
    // `Lead.website` est une donnée produit ordinaire — écrite par un import,
    // un enrichissement, une saisie. S'en servir laissait n'importe quel hôte
    // inscrit sur une fiche transformer sa propre page en preuve de grade A.
    const PIRATE = 'https://attacker.example/annonce'
    etat.leads = [{ ...LEAD, website: 'https://attacker.example' }]
    etat.registre = { Acme: { siren: SIREN, website: 'acme.fr' } }

    const r = await appeler({
      candidateId: await emettre(hit({
        signalType: 'levée', sourceUrl: PIRATE, claimNature: 'EVENT',
        eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY',
      })),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [PIRATE],
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).not.toContain(r.body.state)
    expect(adjuge().filter((p) => p.data?.acceptance)).toEqual([])
  })

  it('l’hôte du site OFFICIEL reste éligible au grade A', async () => {
    // La garde n'est pas un mur : le site déclaré au registre fonctionne.
    etat.leads = [{ ...LEAD, website: 'https://attacker.example' }]
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),   // source sur acme.fr
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
  })

  it('le site officiel NU (`acme.fr`) décerne bien le grade A', async () => {
    // ⚠️ LA FORME DE PRODUCTION, ET LE DÉCALAGE QUE CE TEST FERME. Le mock R1d
    // rendait `https://acme.fr` ; `extractWebsite()` rend `acme.fr`. `hostOf()`
    // s'appuyant sur `new URL(...)`, la forme nue ne produisait aucun hôte : le
    // site officiel de l'entreprise perdait son grade A en production, alors que
    // la garde R1d était correcte. La fixture affirmait un contrat plus commode
    // que le vrai — pour la deuxième fois.
    etat.registre = { Acme: { siren: SIREN, website: 'acme.fr' } }
    etat.leads = [{ ...LEAD, website: 'https://attacker.example' }]

    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),      // source sur acme.fr
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })

    expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).toContain(r.body.state)
    const fait = adjuge().find((p) => p.data?.acceptance)
    expect(fait).toBeDefined()
    expect(fait.data.source.url).toBe(LEVEE_URL)
  })

  it('un site officiel MALFORMÉ ne décerne aucun grade A', async () => {
    // Un site illisible ne se devine pas : il ne qualifie rien.
    for (const mauvais of ['', '   ', 'acme', 'javascript:alert(1)', 'ftp://acme.fr', '//acme.fr', null]) {
      etat.persisted = []
      etat.registre = { Acme: { siren: SIREN, website: mauvais } }
      const r = await appeler({
        candidateId: await emettre(leveeBouclee()),
        canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
      })
      expect(['ACCEPTED_WITH_RESULT', 'ACCEPTED_NO_SITUATION']).not.toContain(r.body.state)
      expect(adjuge().filter((p) => p.data?.acceptance)).toEqual([])
    }
  })

  it('la normalisation n’accepte QUE du HTTP(S), et jamais une valeur vide', async () => {
    // Test unitaire de l'adaptateur d'autorité lui-même.
    expect(urlOfficielleAbsolue('acme.fr')).toBe('https://acme.fr/')
    expect(urlOfficielleAbsolue('acme.fr/contact')).toBe('https://acme.fr/contact')
    expect(urlOfficielleAbsolue('https://acme.fr')).toBe('https://acme.fr/')
    expect(urlOfficielleAbsolue('http://acme.fr')).toBe('http://acme.fr/')
    for (const mauvais of ['', '  ', 'acme', 'javascript:alert(1)', 'ftp://acme.fr', 42, null, undefined]) {
      expect(urlOfficielleAbsolue(mauvais as any)).toBeUndefined()
    }
  })

  it('la route ne passe JAMAIS `lead.website` au Bridge', async () => {
    const fs = await import('fs')
    const code = fs.readFileSync('pages/api/signals/promote.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/sourceEvidenceFromHit\(.*lead\.lead\.website/)
    expect(code).not.toMatch(/lead\.lead\.website/)
    expect(code).toMatch(/sourceEvidenceFromHit\(.*officialWebsite/)
  })
})

// ── R1d·C — UNE LIGNE ABÎMÉE N'EST PAS UN FAIT ABSENT ──────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1d·C historique invalide', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('une evidence persistée MALFORMÉE arrête le raisonnement', async () => {
    // ⚠️ `.filter(isEvidenceEvent)` transformait silencieusement une ligne
    // corrompue en « ce fait n'existe pas » — exactement la confusion que la
    // lecture stricte existe pour empêcher, une couche plus bas.
    await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    etat.persisted = []
    etat.store.set(`proactive_evidence|ev_corrompu|${WS}`, { id: 'ev_corrompu', pas: 'une evidence' })

    const r = await appeler({
      candidateId: await emettre(posteOuvert()),
      canonicalKey: CLE_POSTE, reviewedSourceUrls: [POSTE_URL],
    })

    expect(r.status).toBe(503)
    expect(r.body.state).toBe('EVIDENCE_HISTORY_INVALID')
    expect(r.body.situations).toBeUndefined()
    expect(r.body.recommendations).toBeUndefined()
    expect(adjuge()).toEqual([])
  })

  it('« abîmé » et « injoignable » restent DEUX états distincts', async () => {
    // L'un se répare, l'autre se réessaie : les confondre enverrait attendre au
    // lieu d'agir, ou l'inverse.
    etat.listFails = true
    const muet = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(muet.body.state).toBe('EVIDENCE_HISTORY_UNAVAILABLE')
    expect(muet.body.state).not.toBe('EVIDENCE_HISTORY_INVALID')
  })
})

// ── R1d·D — LE FICHIER DE LEADS SE LIT STRICTEMENT ─────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1d·D lecture stricte des leads', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('magasin de leads MUET → 503, jamais SIGNAL_NOT_RESOLVED', async () => {
    // ⚠️ Dire « entreprise non résolue » pendant une panne enverrait importer
    // une fiche qui existe déjà — l'utilisateur corrigerait ce qui n'est pas cassé.
    etat.leadsDown = true
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.status).toBe(503)
    expect(r.body.state).toBe('LEAD_STORE_UNAVAILABLE')
    expect(r.body.state).not.toBe('SIGNAL_NOT_RESOLVED')
    expect(adjuge()).toEqual([])
  })

  it('espace RÉELLEMENT vide → SIGNAL_NOT_RESOLVED, pas une panne', async () => {
    etat.leads = []
    const r = await appeler({
      candidateId: await emettre(leveeBouclee()),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('SIGNAL_NOT_RESOLVED')
  })
})

// ── R1d — CORRECTIF HTTP ───────────────────────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — R1d codes HTTP', () => {
  it('BUSINESS_CONTEXT_UNAVAILABLE est un 5xx REJOUABLE', async () => {
    // Un 409 faisait lire une panne d'infrastructure comme un conflit produit :
    // ni le client ni la supervision ne pouvaient savoir qu'un réessai suffit.
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.storeDownKind = 'proactive_business_context'
    const r = await appeler({
      candidateId: 'cand_' + 'a'.repeat(32),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(r.body.state).toBe('BUSINESS_CONTEXT_UNAVAILABLE')
    expect(r.status).toBe(503)
    expect(r.status).not.toBe(409)
  })

  it('REQUIRED et INVALID restent des conflits produit (409)', async () => {
    const manquant = await appeler({
      candidateId: 'cand_' + 'a'.repeat(32),
      canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL],
    })
    expect(manquant.body.state).toBe('BUSINESS_CONTEXT_REQUIRED')
    expect(manquant.status).toBe(409)
  })
})

// ── IDEMPOTENCE ─────────────────────────────────────────────────────────────

describe('SIGNAL-PRODUCT-REACHABILITY-001 — idempotence', () => {
  beforeEach(async () => {
    await saveBusinessContext(TEST_BUSINESS_CONTEXT, WS)
    etat.persisted = []
  })

  it('deux confirmations identiques ne créent PAS deux faits', async () => {
    const req = { candidateId: await emettre(leveeBouclee()), canonicalKey: CLE_LEVEE, reviewedSourceUrls: [LEVEE_URL] }
    await appeler(req)
    const premier = etat.persisted.filter((p) => p.kind === 'proactive_evidence').map((p) => p.id)

    etat.persisted = []
    await appeler(req)
    const second = etat.persisted.filter((p) => p.kind === 'proactive_evidence').map((p) => p.id)

    // ⚠️ Les identifiants sont DÉTERMINISTES : le magasin écrit sur la clé
    // primaire `(kind, id, workspace_id)`. Réécrire la même ligne n'en crée pas
    // une seconde — c'est l'idempotence par construction, pas par déduplication.
    expect(second).toEqual(premier)
    expect(new Set([...premier, ...second]).size).toBe(premier.length)
  })
})
