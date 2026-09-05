import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  assembleLiveFactV2,
  isAcquisitionFactV2,
  isHiringCount,
  normalizePersonName,
  parseMoney,
  parseMoneyResearchCompilerV0Legacy,
  personKeyV2,
} from '../lib/prospector/proactive/acquisitionV2'
import type { AcquisitionFactV2, PersonRef, SignalHit } from '../types/prospector'

// SIGNAL_ACQUISITION_CONTRACT_002_IMPLEMENTATION_CORE_001
// Contrat V2 : trois scénarios cibles représentables, fail closed partout.

function enveloppe(fait: Record<string, unknown>): any {
  return {
    contractVersion: 'v2',
    claimNature: 'EVENT',
    eventStatus: 'COMPLETED',
    occurredAt: '2026-08-12',
    occurredAtPrecision: 'DAY',
    sourcePublishedAt: '2026-08-13',
    rawDetail: { detail: 'détail publié', icebreaker: 'accroche' },
    extraction: { mode: 'claude-web', promptVersion: 'v2-test' },
    ...fait,
  }
}

const G1_FUNDING = enveloppe({
  family: 'FUNDING',
  payload: {
    family: 'FUNDING',
    amount: { amountMinor: 1_200_000_000, currency: 'EUR', asPublished: '€12M' },
    roundStage: 'SERIES_A',
    investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }],
  },
})

const PERSONNE_G2: PersonRef = {
  fullNameRaw: 'Marie Dupont',
  normalizedName: 'marie dupont',
  verification: 'NAME_ONLY',
}

const G2_EXECUTIVE = enveloppe({
  family: 'EXECUTIVE_CHANGE',
  payload: {
    family: 'EXECUTIVE_CHANGE',
    direction: 'APPOINTMENT',
    roleFunction: 'SALES',
    roleSeniority: 'C_LEVEL',
    person: PERSONNE_G2,
    roleTitleRaw: 'Chief Revenue Officer',
  },
})

function g3Hiring(valeur: number): any {
  return enveloppe({
    family: 'HIRING_SNAPSHOT',
    claimNature: 'STATE',
    eventStatus: 'UNKNOWN',
    occurredAt: null,
    occurredAtPrecision: 'UNKNOWN',
    payload: {
      family: 'HIRING_SNAPSHOT',
      roleFunction: 'SALES',
      roleStatus: 'OPEN',
      openingsObserved: { value: valeur, method: 'ENUMERATED_POSTINGS' },
    },
  })
}

describe('fixtures dorées', () => {
  it('G1 — FUNDING €12M Series A, Index Ventures LEAD, valide', () => {
    expect(isAcquisitionFactV2(G1_FUNDING)).toBe(true)
    // Le rôle LEAD est CONSERVÉ tel quel — un effondrement vers UNKNOWN
    // détruirait la seule information structurée « qui a mené le tour ».
    expect(G1_FUNDING.payload.investors[0].role).toBe('LEAD')
  })

  it('G1bis — chaque rôle investisseur du vocabulaire clos est accepté, un rôle hors vocabulaire refusé', () => {
    for (const role of ['LEAD', 'PARTICIPANT', 'UNKNOWN']) {
      const f = JSON.parse(JSON.stringify(G1_FUNDING))
      f.payload.investors[0].role = role
      expect(isAcquisitionFactV2(f), role).toBe(true)
    }
    const mauvais = JSON.parse(JSON.stringify(G1_FUNDING))
    mauvais.payload.investors[0].role = 'CHEF'
    expect(isAcquisitionFactV2(mauvais)).toBe(false)
  })

  it('G2 — EXECUTIVE Marie Dupont CRO, C_LEVEL, APPOINTMENT, NAME_ONLY, valide', () => {
    expect(isAcquisitionFactV2(G2_EXECUTIVE)).toBe(true)
  })

  it('G3 — HIRING 15 / 22 / 8 ENUMERATED_POSTINGS, chaque observation valide', () => {
    for (const n of [15, 22, 8]) expect(isAcquisitionFactV2(g3Hiring(n)), String(n)).toBe(true)
  })

  it('G4 — HIRING zéro : 0 est une valeur PLEINE, jamais rejetée parce que falsy', () => {
    expect(isAcquisitionFactV2(g3Hiring(0))).toBe(true)
    expect(isHiringCount({ value: 0, method: 'ENUMERATED_POSTINGS' })).toBe(true)
  })

  it('G5 — famille de l’enveloppe ≠ famille du payload : rejet', () => {
    const f = JSON.parse(JSON.stringify(G1_FUNDING))
    f.family = 'EXECUTIVE_CHANGE'
    expect(isAcquisitionFactV2(f)).toBe(false)
    // Cas retors : le payload MENT sur sa propre famille en gardant une forme
    // FUNDING par ailleurs valide. Seul le double discriminant le rejette —
    // les ensembles de clés clos, eux, ne lisent pas la VALEUR de `family`.
    const menteur = JSON.parse(JSON.stringify(G1_FUNDING))
    menteur.payload.family = 'HIRING_SNAPSHOT'
    expect(isAcquisitionFactV2(menteur)).toBe(false)
  })

  it('G6 — prose libre à la place d’un MoneyExact : rejet', () => {
    const f = JSON.parse(JSON.stringify(G1_FUNDING))
    f.payload.amount = 'about €12m'
    expect(isAcquisitionFactV2(f)).toBe(false)
    const f2 = JSON.parse(JSON.stringify(G1_FUNDING))
    f2.payload.amount = { amountMinor: 'douze millions', currency: 'EUR', asPublished: '€12M' }
    expect(isAcquisitionFactV2(f2)).toBe(false)
  })

  it('G7 — direction UNKNOWN représentable (audit) ; l’ancrage canonique futur devra fail closed', () => {
    const f = JSON.parse(JSON.stringify(G2_EXECUTIVE))
    f.payload.direction = 'UNKNOWN'
    expect(isAcquisitionFactV2(f)).toBe(true)
  })
})

describe('argent — fail closed', () => {
  it('€12M exact → 1 200 000 000 centimes EUR', () => {
    expect(parseMoney('€12M')).toEqual({
      amount: { amountMinor: 1_200_000_000, currency: 'EUR', asPublished: '€12M' },
    })
  })

  it('formes exactes : £3.5m, CHF 2m, 1,5 M€, $450k', () => {
    expect(parseMoney('£3.5m')).toEqual({
      amount: { amountMinor: 350_000_000, currency: 'GBP', asPublished: '£3.5m' },
    })
    expect(parseMoney('CHF 2m')).toEqual({
      amount: { amountMinor: 200_000_000, currency: 'CHF', asPublished: 'CHF 2m' },
    })
    expect(parseMoney('1,5 M€')).toEqual({
      amount: { amountMinor: 150_000_000, currency: 'EUR', asPublished: '1,5 M€' },
    })
    expect(parseMoney('$450k')).toEqual({
      amount: { amountMinor: 45_000_000, currency: 'USD', asPublished: '$450k' },
    })
  })

  it('approximatif JAMAIS converti en exact : « environ », « about », « ~ » → amountApprox', () => {
    for (const brut of ['environ 12 M€', 'about €12m', '~$5m', 'près de 3 millions €']) {
      const r = parseMoney(brut) as any
      expect(r, brut).not.toBeNull()
      expect(r.amount, brut).toBeUndefined()
      expect(r.amountApprox, brut).toBeDefined()
    }
  })

  it('MoneyApprox ne porte AUCUNE borne inventée — clés exactement {magnitudeMinor, currency, asPublished}', () => {
    const r = parseMoney('about €12m') as any
    expect(Object.keys(r.amountApprox).sort()).toEqual(['asPublished', 'currency', 'magnitudeMinor'])
    expect(r.amountApprox.magnitudeMinor).toBe(1_200_000_000)
  })

  it('refus : intervalles, devise absente/ambiguë, plusieurs nombres, vague, zéro', () => {
    for (const brut of [
      'between €8m and €12m',
      'entre 8 et 12 M€',
      '€8m - €12m',
      '10 millions', // pas de devise
      '€10m ou $12m', // deux devises
      'seven-figure round',
      '0 €',
      '',
    ]) {
      expect(parseMoney(brut), brut).toBeNull()
    }
  })

  it('montant exact ET approximatif simultanés dans un payload : rejet', () => {
    const f = JSON.parse(JSON.stringify(G1_FUNDING))
    f.payload.amountApprox = { magnitudeMinor: 1_000_000_000, currency: 'EUR', asPublished: '~€10m' }
    expect(isAcquisitionFactV2(f)).toBe(false)
  })
})

describe('personne — identité minimale, scopée au compte', () => {
  it('normalisation conservatrice : civilité, casse, espaces — et RIEN de plus', () => {
    expect(normalizePersonName('  Mme  Marie   DUPONT ')).toBe('marie dupont')
    expect(normalizePersonName('Dr. Jean Martin')).toBe('jean martin')
    // Les diacritiques sont CONSERVÉS : la fausse scission est acceptée,
    // la fusion « josé » = « jose » serait du fuzzy déguisé.
    expect(normalizePersonName('José García')).toBe('josé garcía')
    expect(normalizePersonName('José García')).not.toBe('jose garcia')
    // Les initiales ne sont pas développées : fausse scission assumée.
    expect(normalizePersonName('Jean P. Dupont')).not.toBe(normalizePersonName('Jean Dupont'))
  })

  it('NAME_ONLY est ADMIS et sa clé est scopée au compte — verrou littéral', () => {
    expect(personKeyV2(PERSONNE_G2, 'acc_1')).toBe('name:marie dupont@acc_1')
    expect(personKeyV2(PERSONNE_G2, 'acc_2')).toBe('name:marie dupont@acc_2')
    expect(personKeyV2(PERSONNE_G2, 'acc_1')).not.toBe(personKeyV2(PERSONNE_G2, 'acc_2'))
    expect(personKeyV2(PERSONNE_G2, '')).toBeNull()
  })

  it('référence externe : la clé ne dépend plus du compte (identité vérifiée)', () => {
    const verifiee: PersonRef = {
      fullNameRaw: 'Marie Dupont',
      normalizedName: 'marie dupont',
      externalRef: { kind: 'LINKEDIN_URL', value: 'https://linkedin.com/in/mdupont' },
      verification: 'VERIFIED_EXTERNAL_REF',
    }
    expect(personKeyV2(verifiee, 'acc_1')).toBe('LINKEDIN_URL:https://linkedin.com/in/mdupont')
    expect(personKeyV2(verifiee, 'acc_2')).toBe(personKeyV2(verifiee, 'acc_1'))
  })

  it('cohérence verification ⇔ externalRef, et normalizedName recalculée', () => {
    const f = JSON.parse(JSON.stringify(G2_EXECUTIVE))
    f.payload.person.verification = 'VERIFIED_EXTERNAL_REF' // sans ref
    expect(isAcquisitionFactV2(f)).toBe(false)

    const g = JSON.parse(JSON.stringify(G2_EXECUTIVE))
    g.payload.person.externalRef = { kind: 'LINKEDIN_URL', value: 'x' } // NAME_ONLY avec ref
    expect(isAcquisitionFactV2(g)).toBe(false)

    const h = JSON.parse(JSON.stringify(G2_EXECUTIVE))
    h.payload.person.normalizedName = 'marie  dupont' // mutée
    expect(isAcquisitionFactV2(h)).toBe(false)
  })
})

describe('décompte — entier ≥ 0, méthode close, jamais estimé', () => {
  it('valeurs refusées : négatif, fractionnaire, méthode hors vocabulaire, prose', () => {
    expect(isHiringCount({ value: -1, method: 'ENUMERATED_POSTINGS' })).toBe(false)
    expect(isHiringCount({ value: 3.5, method: 'ENUMERATED_POSTINGS' })).toBe(false)
    expect(isHiringCount({ value: 5, method: 'ESTIMATED' })).toBe(false)
    expect(isHiringCount({ value: 'quinze', method: 'SOURCE_DECLARED' })).toBe(false)
  })
})

describe('cohérence temporelle par famille', () => {
  it('HIRING_SNAPSHOT est un STATE : occurredAt/précision/nature EVENT refusés', () => {
    const avecDate = g3Hiring(5)
    avecDate.occurredAt = '2026-08-12'
    avecDate.occurredAtPrecision = 'DAY'
    expect(isAcquisitionFactV2(avecDate)).toBe(false)

    const nature = g3Hiring(5)
    nature.claimNature = 'EVENT'
    expect(isAcquisitionFactV2(nature)).toBe(false)
  })

  it('FUNDING/EXECUTIVE sont des EVENT ; précision DAY exige un jour réel, UNKNOWN exige null', () => {
    const etat = JSON.parse(JSON.stringify(G1_FUNDING))
    etat.claimNature = 'STATE'
    expect(isAcquisitionFactV2(etat)).toBe(false)

    const faux = JSON.parse(JSON.stringify(G1_FUNDING))
    faux.occurredAt = '2026-02-30'
    expect(isAcquisitionFactV2(faux)).toBe(false)

    const mois = JSON.parse(JSON.stringify(G2_EXECUTIVE))
    mois.occurredAt = '2026-08'
    mois.occurredAtPrecision = 'MONTH'
    expect(isAcquisitionFactV2(mois)).toBe(true)

    const fausse = JSON.parse(JSON.stringify(G1_FUNDING))
    fausse.occurredAtPrecision = 'UNKNOWN' // date présente + précision inconnue = fausse précision
    expect(isAcquisitionFactV2(fausse)).toBe(false)
  })
})

describe('verrous structurels', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('aucune confiance numérique universelle : `confidence` absent du contrat et refusé à la validation', () => {
    expect(lire('lib/prospector/proactive/acquisitionV2.ts')).not.toMatch(/confidence\s*[?:]\s*number/)
    expect(lire('types/prospector.ts')).not.toMatch(/confidence\s*[?:]\s*number/)

    const env = JSON.parse(JSON.stringify(G1_FUNDING))
    env.confidence = 0.9
    expect(isAcquisitionFactV2(env)).toBe(false)
    const pay = JSON.parse(JSON.stringify(G1_FUNDING))
    pay.payload.confidence = 0.9
    expect(isAcquisitionFactV2(pay)).toBe(false)
  })

  it('rawDetail jamais lu par mapping/identité : absent de signalBridge, sourceAssertion, canonicalFact', () => {
    for (const module of [
      'lib/prospector/proactive/signalBridge.ts',
      'lib/prospector/proactive/sourceAssertion.ts',
      'lib/prospector/proactive/canonicalFact.ts',
    ]) {
      expect(lire(module), module).not.toMatch(/rawDetail/)
    }
  })

  it('les investisseurs n’entrent dans AUCUNE identité : absent des modules d’identité', () => {
    for (const module of [
      'lib/prospector/proactive/sourceAssertion.ts',
      'lib/prospector/proactive/canonicalFact.ts',
    ]) {
      expect(lire(module), module).not.toMatch(/investor/i)
    }
  })

  it('compatibilité héritée : v2 est OPTIONNEL sur SignalHit (compilation) et absent ≠ invalide', () => {
    const hitV1: SignalHit = {
      company: 'Acme',
      signalType: 'levée',
      detail: 'lève 12 M€',
      icebreaker: 'bravo',
      verified: false,
      claimNature: 'EVENT',
      eventStatus: 'COMPLETED',
      eventDate: '2026-08-12',
      eventDatePrecision: 'DAY',
      sourcePublishedAt: null,
      roleStatus: 'UNKNOWN',
      roleFunction: 'UNKNOWN',
      extraction: { mode: 'claude-web', promptVersion: 'v1' },
    }
    expect(hitV1.v2).toBeUndefined()
    const hitV2: SignalHit = { ...hitV1, v2: G1_FUNDING as AcquisitionFactV2 }
    expect(isAcquisitionFactV2(hitV2.v2)).toBe(true)
  })

  it('bloc v2 à moitié rempli : rejet (clé requise manquante, clé hors contrat)', () => {
    const sans = JSON.parse(JSON.stringify(G1_FUNDING))
    delete sans.extraction
    expect(isAcquisitionFactV2(sans)).toBe(false)
    const extra = JSON.parse(JSON.stringify(G1_FUNDING))
    extra.score = 87
    expect(isAcquisitionFactV2(extra)).toBe(false)
    expect(isAcquisitionFactV2(undefined)).toBe(false)
    expect(isAcquisitionFactV2(null)).toBe(false)
  })
})

// ── RESEARCH_FUNDING_SEMANTIC_GUARDS_001 — BORNES INFÉRIEURES ───────────────
// Un plancher (« over €2M », « plus de 3 M€ ») n'affirme AUCUN montant : ni
// exact, ni approximatif. La formulation publiée reste dans asPublished.
describe('parseMoney — bornes inférieures (politique courante)', () => {
  it('exact et approximatif restent inchangés', () => {
    expect(parseMoney('€2M')).toEqual({ amount: { amountMinor: 200000000, currency: 'EUR', asPublished: '€2M' } })
    expect(parseMoney('about €2M')).toEqual({ amountApprox: { magnitudeMinor: 200000000, currency: 'EUR', asPublished: 'about €2M' } })
    expect(parseMoney('~€2M')).toEqual({ amountApprox: { magnitudeMinor: 200000000, currency: 'EUR', asPublished: '~€2M' } })
    expect(parseMoney('around $30 million')).toEqual({ amountApprox: { magnitudeMinor: 3000000000, currency: 'USD', asPublished: 'around $30 million' } })
    expect(parseMoney('environ 2 M€')).toEqual({ amountApprox: { magnitudeMinor: 200000000, currency: 'EUR', asPublished: 'environ 2 M€' } })
  })

  it('borne inférieure ⇒ null — JAMAIS MoneyExact, JAMAIS MoneyApprox', () => {
    for (const brut of [
      'over €2 million', 'over €807.6k', 'more than $10M', 'at least £5M',
      'above €2M', 'upwards of $4M', 'exceeding €3 million',
      'plus de 3 M€', 'au moins 3 M€', 'au-delà de 3 M€', 'supérieur à 3 M€', '€2M+',
    ]) {
      expect(parseMoney(brut), brut).toBeNull()
    }
  })

  it('mots contenant les marqueurs par accident ne déclenchent PAS la borne', () => {
    // « takeover » contient « over » sans frontière de mot : montant intact.
    expect(parseMoney('takeover €2M')).not.toBeNull()
  })

  it('l’assembleur VIVANT produit un fait FUNDING SANS argent structuré pour une borne', () => {
    const fait = assembleLiveFactV2({
      factFamily: 'FUNDING', claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: '2026-08-12', eventDatePrecision: 'DAY', sourcePublishedAt: '2026-08-13',
      detail: '', icebreaker: '',
      extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
      amountText: 'over €2 million', roundStage: 'SEED',
      roleFunction: 'UNKNOWN', roleStatus: 'UNKNOWN',
    })
    expect(fait).not.toBeNull()
    expect((fait as any).payload.amount).toBeUndefined()
    expect((fait as any).payload.amountApprox).toBeUndefined()
  })

  it('la politique HÉRITÉE V0 (rejeu historique SEUL) reproduit l’ancien comportement', () => {
    expect(parseMoneyResearchCompilerV0Legacy('over €2 million'))
      .toEqual({ amount: { amountMinor: 200000000, currency: 'EUR', asPublished: 'over €2 million' } })
    // et reste identique à la politique courante hors bornes :
    expect(parseMoneyResearchCompilerV0Legacy('about €2M')).toEqual(parseMoney('about €2M'))
    expect(parseMoneyResearchCompilerV0Legacy('between €8m and €12m')).toBeNull()
  })
})
