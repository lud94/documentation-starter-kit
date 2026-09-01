// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — domaine première-partie ADJUGÉ.
//
// ⚠️ HORS LIGNE : magasin réel (repli mémoire), capture INJECTÉE, horloges
// injectées. La primitive réseau est testée dans legal-proof-ssrf.test.ts ;
// ici on la double au niveau du module et des routes.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etatCapture = vi.hoisted(() => ({
  resultat: null as any,
  appels: [] as Array<{ domainHost: string; proofUrl: string }>,
}))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveActorFromRequest: async () => etatSession.session,
}))
vi.mock('../lib/prospector/datagouv', () => ({
  lookupByName: async (name: string) => {
    if (etatSession.registreMuet) throw new Error('registry unavailable')
    return etatSession.registre[String(name).trim()] ?? { found: false, resolution: 'not_found' }
  },
}))
vi.mock('../lib/prospector/proactive/legalProofFetch', async (orig) => {
  const reel = await orig<typeof import('../lib/prospector/proactive/legalProofFetch')>()
  return {
    ...reel,
    captureLegalProof: async (domainHost: string, proofUrl: string) => {
      etatCapture.appels.push({ domainHost, proofUrl })
      return etatCapture.resultat ?? { ok: false, reason: 'FETCH_FAILED' }
    },
  }
})

const etatSession = vi.hoisted(() => ({
  session: null as any,
  registre: {} as Record<string, any>,
  registreMuet: false,
}))

import {
  buildProofAnchor, DOMAIN_ADJUDICATION_KIND, DOMAIN_PROOF_OBSERVATION_KIND,
  domainAdjudicationId, domainProofObservationId, eligibleAdjudicatedDomain,
  extractSirens, isDomainProofObservation, readDomainProofObservation,
  recordDomainAdjudication, recordDomainProofObservation,
} from '../lib/prospector/proactive/domainBinding'
import { sourceEvidenceFromHit } from '../lib/prospector/proactive/signalBridge'
import proofHandler from '../pages/api/internal/domain-proof'
import adjHandler from '../pages/api/internal/domain-adjudication'
import { registerCandidates } from '../lib/prospector/proactive/signalCandidates'
import type { SignalHit } from '../types/prospector'

const g: any = globalThis as any
beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etatCapture.resultat = null
  etatCapture.appels = []
  etatSession.session = { tenant: { id: WS, kind: 'user' }, actorId: 'user_adjudicateur' }
  etatSession.registre = {}
  etatSession.registreMuet = false
})

const WS = 'ws_domain_a'
const AUTRE_WS = 'ws_domain_b'
const SIREN = '989284955'
const HOTE = 'gradium.ai'
const PAGE = `Mentions légales — GRADIUM SAS, SIREN 989 284 955, 10 rue de Paris. Hébergeur : OVH SAS, SIREN 424761419.`
const T0 = () => new Date('2026-09-01T10:00:00.000Z')
const T1 = () => new Date('2026-09-01T11:00:00.000Z')

const obsInput = (extra: Record<string, unknown> = {}) => ({
  siren: SIREN, domainHost: HOTE,
  proofUrl: `https://${HOTE}/mentions-legales`,
  finalUrl: `https://${HOTE}/mentions-legales`,
  body: PAGE, registryLegalName: 'GRADIUM',
  ...extra,
})

async function observation(extra: Record<string, unknown> = {}, now = T0) {
  const r = await recordDomainProofObservation(obsInput(extra) as any, WS, now)
  if (r.ok === false) throw new Error(r.reason)
  return r.observation
}

describe('observation de preuve (append-only)', () => {
  it('SIREN compact, espacé, pointé : détectés ; mauvais SIREN absent ; multiples CONSERVÉS triés', () => {
    expect(extractSirens('SIREN 989284955')).toEqual(['989284955'])
    expect(extractSirens('SIREN 989 284 955 et RCS 424.761.419')).toEqual(['424761419', '989284955'])
    expect(extractSirens('numéro 12345678901234 long')).toEqual([]) // jamais découpé dans une suite plus longue
    const o = extractSirens(PAGE)
    expect(o).toEqual(['424761419', '989284955'])
  })

  it('observation nominale : dérivée SERVEUR, ancre littérale bornée contenant le SIREN cible', async () => {
    const o = await observation()
    expect(o.id).toMatch(/^dpo_[0-9a-f]{32}$/)
    expect(o.targetSirenFound).toBe(true)
    expect(o.sirensFound).toEqual(['424761419', '989284955'])
    expect(o.proofAnchor).toContain('989 284 955')
    expect(o.proofAnchor.length).toBeLessThanOrEqual(400)
    expect(o.legalNameObserved).toBe(true)
    expect(o.proofObservedAt).toBe('2026-09-01T10:00:00.000Z') // horloge serveur injectée
    expect(buildProofAnchor(PAGE, SIREN)).toBe(o.proofAnchor) // déterministe
  })

  it('même corps, instants DIFFÉRENTS : DEUX observations historiques distinctes', async () => {
    const a = await observation({}, T0)
    const b = await observation({}, T1)
    expect(a.id).not.toBe(b.id)
    expect(a.proofContentHash).toBe(b.proofContentHash)
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${DOMAIN_PROOF_OBSERVATION_KIND}|`))
    expect(lignes.length).toBe(2)
  })

  it('corps différent : observation distincte ; SIREN cible absent ⇒ targetSirenFound=false, persistée quand même', async () => {
    const a = await observation({}, T0)
    const b = await observation({ body: 'Mentions légales — OVH SAS, SIREN 424 761 419 uniquement.' }, T1)
    expect(b.id).not.toBe(a.id)
    expect(b.targetSirenFound).toBe(false)
    expect(b.sirensFound).toEqual(['424761419'])
  })

  it('relecture stricte ; altération (recordHash, drapeau cible, ancre) ⇒ TAMPERED ; autre espace ⇒ inconnu ; clé inconnue rejetée', async () => {
    const o = await observation()
    const cle = `${DOMAIN_PROOF_OBSERVATION_KIND}|${WS}|${o.id}`
    const relu = await readDomainProofObservation(o.id, WS)
    expect(relu.ok).toBe(true)
    expect((await readDomainProofObservation(o.id, AUTRE_WS)).ok).toBe(false)
    const original = JSON.parse(JSON.stringify(g.__prospectorStore.get(cle)))
    for (const mutation of [
      (r: any) => { r.recordHash = 'e'.repeat(64) },
      (r: any) => { r.targetSirenFound = false }, // drapeau incohérent avec la liste
      (r: any) => { r.sirensFound = ['424761419'] }, // liste réduite au commode
      (r: any) => { r.proofAnchor = 'ancre substituée sans le SIREN' },
      (r: any) => { r.score = 0.9 }, // clé hors contrat
    ]) {
      const row = JSON.parse(JSON.stringify(original)); mutation(row)
      g.__prospectorStore.set(cle, row)
      expect(await readDomainProofObservation(o.id, WS)).toEqual({ ok: false, reason: 'OBSERVATION_TAMPERED' })
    }
    g.__prospectorStore.set(cle, original)
  })

  it('hôte final hors du domaine lié, ou URLs non-https : REJET d’entrée', async () => {
    expect((await recordDomainProofObservation(obsInput({ finalUrl: 'https://autre.fr/x' }) as any, WS, T0)))
      .toEqual({ ok: false, reason: 'INVALID_INPUT' })
    expect((await recordDomainProofObservation(obsInput({ proofUrl: 'http://gradium.ai/x' }) as any, WS, T0)))
      .toEqual({ ok: false, reason: 'INVALID_INPUT' })
  })
})

describe('adjudication (append-only)', () => {
  it('ACCEPTED puis REJECTED puis ACCEPTED : TROIS enregistrements, dernier déterministe', async () => {
    const o = await observation()
    const t = (h: string) => () => new Date(`2026-09-01T${h}:00.000Z`)
    const a1 = await recordDomainAdjudication({ observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY' }, 'alice', WS, t('12:00'))
    const a2 = await recordDomainAdjudication({ observationId: o.id, verdict: 'REJECTED' }, 'alice', WS, t('12:05'))
    const a3 = await recordDomainAdjudication({ observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY' }, 'alice', WS, t('12:10'))
    if (a1.ok === false || a2.ok === false || a3.ok === false) throw new Error('adjudication échouée')
    expect(new Set([a1.adjudication.id, a2.adjudication.id, a3.adjudication.id]).size).toBe(3)
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${DOMAIN_ADJUDICATION_KIND}|`))
    expect(lignes.length).toBe(3)
  })

  it('observation sans SIREN cible : ACCEPT refusé, REJECT permis', async () => {
    const o = await observation({ body: 'SIREN 424 761 419 seulement' })
    expect(o.targetSirenFound).toBe(false)
    expect(await recordDomainAdjudication({ observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY' }, 'alice', WS, T0))
      .toEqual({ ok: false, reason: 'OBSERVATION_NOT_ELIGIBLE' })
    expect((await recordDomainAdjudication({ observationId: o.id, verdict: 'REJECTED' }, 'alice', WS, T0)).ok).toBe(true)
  })

  it('inter-espaces refusé ; verdict hors vocabulaire refusé ; l’identité inclut acteur ET instant', async () => {
    const o = await observation()
    expect(await recordDomainAdjudication({ observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY' }, 'x', AUTRE_WS, T0))
      .toEqual({ ok: false, reason: 'OBSERVATION_UNKNOWN' })
    expect(await recordDomainAdjudication({ observationId: o.id, verdict: 'MAYBE' }, 'x', WS, T0))
      .toEqual({ ok: false, reason: 'INVALID_INPUT' })
    expect(domainAdjudicationId(WS, o.id, 'ACCEPTED_FIRST_PARTY', 'alice', '2026-09-01T12:00:00.000Z'))
      .not.toBe(domainAdjudicationId(WS, o.id, 'ACCEPTED_FIRST_PARTY', 'bob', '2026-09-01T12:00:00.000Z'))
    expect(domainAdjudicationId(WS, o.id, 'ACCEPTED_FIRST_PARTY', 'alice', '2026-09-01T12:00:00.000Z'))
      .not.toBe(domainAdjudicationId(WS, o.id, 'ACCEPTED_FIRST_PARTY', 'alice', '2026-09-01T12:01:00.000Z'))
  })
})

describe('éligibilité courante (dérivée, revalidée à l’usage)', () => {
  async function liaisonAdjugee() {
    const o = await observation()
    const a = await recordDomainAdjudication({ observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY' }, 'alice', WS, T0)
    if (a.ok === false) throw new Error(a.reason)
    return o
  }
  const captureIdentique = () => {
    etatCapture.resultat = { ok: true, finalUrl: `https://${HOTE}/mentions-legales`, body: PAGE }
  }

  it('acceptée + re-capture au contenu IDENTIQUE ⇒ éligible ; la revalidation est réellement exécutée et PERSISTÉE', async () => {
    await liaisonAdjugee()
    captureIdentique()
    const r = await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, T1)
    expect(r).toEqual({ eligible: true, domainHost: HOTE, authority: 'HUMAN_ADJUDICATED_LEGAL_NOTICE' })
    expect(etatCapture.appels).toEqual([{ domainHost: HOTE, proofUrl: `https://${HOTE}/mentions-legales` }])
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${DOMAIN_PROOF_OBSERVATION_KIND}|`))
    expect(lignes.length).toBe(2) // l'observation de revalidation est un fait historique
  })

  it('dernier verdict REJECTED ⇒ inéligible SANS re-capture ; aucune adjudication ⇒ inéligible', async () => {
    const o = await liaisonAdjugee()
    await recordDomainAdjudication({ observationId: o.id, verdict: 'REJECTED' }, 'alice', WS, T1)
    captureIdentique()
    expect(await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, T1))
      .toEqual({ eligible: false, reason: 'LATEST_REJECTED' })
    expect(etatCapture.appels).toEqual([])
    if (g.__prospectorStore) g.__prospectorStore.clear()
    expect(await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, T1))
      .toEqual({ eligible: false, reason: 'NO_ACCEPTED_ADJUDICATION' })
  })

  it('contenu CHANGÉ ⇒ inéligible, nouvelle observation persistée en attente d’une NOUVELLE adjudication — jamais l’ancienne réutilisée', async () => {
    await liaisonAdjugee()
    etatCapture.resultat = {
      ok: true, finalUrl: `https://${HOTE}/mentions-legales`,
      body: PAGE + '\n(mise à jour du site)', // même SIREN, même hôte — mais contenu ≠
    }
    const r = await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, T1)
    expect(r).toEqual({ eligible: false, reason: 'PROOF_CHANGED' })
    const obs = [...g.__prospectorStore.entries()]
      .filter(([k]: any) => k.startsWith(`${DOMAIN_PROOF_OBSERVATION_KIND}|`)).map(([, v]: any) => v)
    expect(obs.length).toBe(2)
    // Le SIREN cible a DISPARU de la page ⇒ inéligible aussi (jamais un A sans preuve courante).
    etatCapture.resultat = { ok: true, finalUrl: `https://${HOTE}/mentions-legales`, body: 'plus de siren ici' }
    expect((await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, () => new Date('2026-09-01T12:00:00.000Z'))).eligible).toBe(false)
  })

  it('revalidation en échec (SSRF/réseau/contenu) ⇒ inéligible ; hôte différent ⇒ hors périmètre', async () => {
    await liaisonAdjugee()
    etatCapture.resultat = { ok: false, reason: 'PROHIBITED_TARGET' }
    expect(await eligibleAdjudicatedDomain(SIREN, HOTE, WS, undefined, T1))
      .toEqual({ eligible: false, reason: 'REVALIDATION_FAILED' })
    captureIdentique()
    expect(await eligibleAdjudicatedDomain(SIREN, 'app.gradium.ai', WS, undefined, T1))
      .toEqual({ eligible: false, reason: 'NO_ACCEPTED_ADJUDICATION' }) // sous-domaine ≠ hôte lié
    expect(await eligibleAdjudicatedDomain('899270979', HOTE, WS, undefined, T1))
      .toEqual({ eligible: false, reason: 'NO_ACCEPTED_ADJUDICATION' }) // autre SIREN
  })
})

describe('routes — frontières de confiance', () => {
  async function appeler(handler: any, body: any) {
    const req: any = { method: 'POST', body, cookies: {} }
    let status = 0; let json: any = null
    const res: any = { status(c: number) { status = c; return res }, json(b: any) { json = b; return res } }
    await handler(req, res)
    return { status, body: json }
  }
  const hit = (sourceUrl: string): SignalHit => ({
    company: 'Gradium', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl, verified: false, claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: '2026-07-08', eventDatePrecision: 'DAY', sourcePublishedAt: null,
    roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
  } as SignalHit)

  it('capture : candidat + entité résolue + hôte de preuve == hôte SOURCE ⇒ observation dérivée SERVEUR', async () => {
    etatSession.registre['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, name: 'GRADIUM' }
    const [cid] = await registerCandidates([hit(`https://${HOTE}/blog/levee`)], WS, T0)
    etatCapture.resultat = { ok: true, finalUrl: `https://${HOTE}/mentions-legales`, body: PAGE }
    const r = await appeler(proofHandler, {
      candidateId: cid, proofUrl: `https://${HOTE}/mentions-legales`,
      // ⚠️ Tentatives d'injection : TOUTES ignorées, le serveur dérive.
      siren: '000000000', domainHost: 'attaquant.fr', body: 'FAUX', targetSirenFound: true,
    })
    expect(r.status).toBe(200)
    expect(r.body.observation.siren).toBe(SIREN)         // du registre, pas du corps
    expect(r.body.observation.domainHost).toBe(HOTE)      // de la source du candidat
    expect(r.body.observation.targetSirenFound).toBe(true) // du contenu capturé par le serveur
  })

  it('capture : hôte de preuve ≠ hôte source (EU-Startups → syntetica.com) ⇒ PROOF_HOST_MISMATCH', async () => {
    etatSession.registre['Gradium'] = { found: true, resolution: 'resolved', siren: SIREN, name: 'GRADIUM' }
    const [cid] = await registerCandidates([hit('https://www.eu-startups.com/2026/07/gradium')], WS, T0)
    const r = await appeler(proofHandler, { candidateId: cid, proofUrl: `https://${HOTE}/mentions-legales` })
    expect(r.status).toBe(409)
    expect(r.body.state).toBe('PROOF_HOST_MISMATCH')
    expect(etatCapture.appels).toEqual([]) // aucune capture tentée
  })

  it('capture : entité NON RÉSOLUE (Shiplog/Mio) ⇒ bloquée — la liaison ne contourne jamais la résolution', async () => {
    const [cid] = await registerCandidates([hit('https://useshiplog.com/post')], WS, T0)
    // ⚠️ AMBIGU **AVEC** un SIREN candidat : seule la garde `resolution ===
    // 'resolved'` bloque — un simple contrôle de format ne suffirait pas.
    etatSession.registre['Gradium'] = { found: true, resolution: 'ambiguous', siren: SIREN, name: 'GRADIUM' }
    const r = await appeler(proofHandler, { candidateId: cid, proofUrl: 'https://useshiplog.com/legal' })
    expect(r.status).toBe(409)
    expect(r.body.state).toBe('ENTITY_NOT_RESOLVED')
    expect(etatCapture.appels).toEqual([])
  })

  it('adjudication : le navigateur ne fixe NI l’acteur NI l’instant ; espace de session seul', async () => {
    const o = await observation()
    const r = await appeler(adjHandler, {
      observationId: o.id, verdict: 'ACCEPTED_FIRST_PARTY',
      adjudicatedBy: 'attaquant', adjudicatedAt: '1999-01-01T00:00:00.000Z',
    })
    expect(r.status).toBe(200)
    expect(r.body.adjudication.adjudicatedBy).toBe('user_adjudicateur') // acteur de SESSION
    expect(r.body.adjudication.adjudicatedAt).not.toBe('1999-01-01T00:00:00.000Z')
  })
})

describe('grade et promotion — frontières', () => {
  const hitSur = (url: string): SignalHit => ({
    company: 'Gradium', signalType: 'levée', detail: '', icebreaker: '', sourceUrl: url,
    verified: false, claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-08',
    eventDatePrecision: 'DAY', sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
  } as SignalHit)

  it('domainAuthority ne s’attache QUE sur le chemin A site-officiel — jamais B/C/UNKNOWN ni sans correspondance', () => {
    const officiel = sourceEvidenceFromHit(hitSur(`https://${HOTE}/blog/levee`), `https://${HOTE}`, undefined, undefined, undefined, 'HUMAN_ADJUDICATED_LEGAL_NOTICE')!
    expect(officiel.grade).toBe('A')
    expect(officiel.domainAuthority).toBe('HUMAN_ADJUDICATED_LEGAL_NOTICE')
    const presse = sourceEvidenceFromHit(hitSur('https://www.eu-startups.com/a'), `https://${HOTE}`, undefined, undefined, undefined, 'REGISTRY_DECLARED')!
    expect(presse.grade).toBe('B')
    expect(presse.domainAuthority).toBeUndefined()
    const sans = sourceEvidenceFromHit(hitSur(`https://${HOTE}/x`), undefined, undefined, undefined, undefined, 'REGISTRY_DECLARED')!
    expect(sans.domainAuthority).toBeUndefined() // pas de site fourni ⇒ pas d'autorité recopiée
    const ancienne = sourceEvidenceFromHit(hitSur(`https://${HOTE}/x`), `https://${HOTE}`)!
    expect(ancienne.domainAuthority).toBeUndefined() // appels historiques inchangés
  })

  it('verrous structurels : registre d’abord, repli adjugé SEULEMENT en son absence, jamais Lead.website', async () => {
    const { readFileSync } = await import('node:fs')
    const code = readFileSync('pages/api/signals/promote.ts', 'utf8')
    expect(code).toMatch(/let officialWebsiteAutorite = lead\.officialWebsite/)
    expect(code).toMatch(/if \(!officialWebsiteAutorite\) \{[\s\S]{0,600}eligibleAdjudicatedDomain\(/)
    expect(code).not.toMatch(/officialWebsiteAutorite[^\n]*lead\.lead\.website/)
    expect(code).not.toMatch(/eligibleAdjudicatedDomain\([^)]*website/i)
    expect(code).toMatch(/sourceEvidenceFromHit\(.*officialWebsiteAutorite.*dateRecuperation, autoriteDomaine\)/)
  })
})
