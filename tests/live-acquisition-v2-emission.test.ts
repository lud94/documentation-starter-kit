// LIVE_ACQUISITION_V2_EMISSION_001 — la frontière acquisition → V2.
//
// ⚠️ AUCUN APPEL FOURNISSEUR : des fixtures JSON déterministes alimentent
// directement `parseHits`/`assembleLiveFactV2` — le code de PRODUCTION exact
// qui traitera une vraie réponse. Aucun réseau, aucun coût.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseHits, PROMPT_VERSION } from '../lib/prospector/signals'
import { assembleLiveFactV2, assertedFactHash, isAcquisitionFactV2 } from '../lib/prospector/proactive/acquisitionV2'
import { mapClaim } from '../lib/prospector/proactive/signalBridge'
import type { SignalExtraction } from '../types/prospector'

const EXTRACTION: SignalExtraction = { mode: 'claude-web', promptVersion: PROMPT_VERSION }

const base = {
  company: 'ACME TEST', detail: 'fait précis et daté', icebreaker: 'accroche',
  sourceUrl: 'https://presse.example.test/article', sourceName: 'La Presse',
  date: '2026-08', claimNature: 'EVENT', eventStatus: 'COMPLETED',
  eventDate: '2026-08-12', eventDatePrecision: 'DAY', sourcePublishedAt: '2026-08-13',
  roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
}

const reponse = (hits: any[]) => `Voici le résultat.\n${JSON.stringify({ hits })}`

const funding = (extra: Record<string, unknown> = {}) => ({
  ...base, signalType: 'levée', factFamily: 'FUNDING',
  amount: '€8.2M', roundStage: 'SERIES_A',
  investors: [{ nameRaw: 'Index Ventures', role: 'LEAD' }, { nameRaw: 'Accel', role: 'PARTICIPANT' }],
  ...extra,
})
const executive = (extra: Record<string, unknown> = {}) => ({
  ...base, signalType: 'actu', factFamily: 'EXECUTIVE_CHANGE',
  direction: 'APPOINTMENT', personFullName: 'Mme Marie DUPONT',
  roleFunction: 'SALES', roleSeniority: 'C_LEVEL', role: 'Chief Revenue Officer',
  roleStatus: 'FILLED',
  ...extra,
})
const hiring = (extra: Record<string, unknown> = {}) => ({
  ...base, signalType: 'recrutement', factFamily: 'HIRING_SNAPSHOT',
  claimNature: 'STATE', eventStatus: 'UNKNOWN', eventDate: null, eventDatePrecision: 'UNKNOWN',
  roleStatus: 'OPEN', roleFunction: 'SALES',
  openingsCount: 4, openingsCountMethod: 'SOURCE_DECLARED',
  ...extra,
})

describe('A/B/C — FUNDING', () => {
  it('A — montant exact publié : v2 valide, amountMinor DÉTERMINISTE, investisseurs conservés', () => {
    const [h] = parseHits(reponse([funding()]), EXTRACTION)
    expect(h.v2).toBeDefined()
    expect(isAcquisitionFactV2(h.v2)).toBe(true)
    const p: any = h.v2!.payload
    expect(p.amount).toEqual({ amountMinor: 820_000_000, currency: 'EUR', asPublished: '€8.2M' })
    expect(p.amountApprox).toBeUndefined()
    expect(p.roundStage).toBe('SERIES_A')
    expect(p.investors).toEqual([
      { nameRaw: 'Index Ventures', role: 'LEAD' },
      { nameRaw: 'Accel', role: 'PARTICIPANT' },
    ])
    expect(h.v2!.occurredAt).toBe('2026-08-12')
    expect(h.v2!.sourcePublishedAt).toBe('2026-08-13')
    expect(mapClaim(h)).toEqual({ type: 'recent_funding', temporality: 'dated_event', occurredAt: '2026-08-12' })
  })

  it('B — « environ 12 M€ » : amountApprox, jamais amount', () => {
    const [h] = parseHits(reponse([funding({ amount: 'environ 12 M€' })]), EXTRACTION)
    const p: any = h.v2!.payload
    expect(p.amount).toBeUndefined()
    expect(p.amountApprox).toEqual({ magnitudeMinor: 1_200_000_000, currency: 'EUR', asPublished: 'environ 12 M€' })
  })

  it('C — montant inanalysable : AUCUN nombre inventé, v2 reste valide sans montant', () => {
    for (const brut of ['between €8m and €12m', 'seven-figure round', '10 millions', '']) {
      const [h] = parseHits(reponse([funding({ amount: brut })]), EXTRACTION)
      expect(h.v2, brut).toBeDefined()
      const p: any = h.v2!.payload
      expect(p.amount, brut).toBeUndefined()
      expect(p.amountApprox, brut).toBeUndefined()
      expect(p.roundStage, brut).toBe('SERIES_A')
    }
  })

  it('EVENT sans date métier : occurredAt reste null — JAMAIS la date de publication ni le champ hérité date', () => {
    const [h] = parseHits(reponse([funding({ eventDate: null, eventDatePrecision: 'UNKNOWN' })]), EXTRACTION)
    expect(h.v2).toBeDefined()
    expect(h.v2!.occurredAt).toBeNull()
    expect(h.v2!.occurredAtPrecision).toBe('UNKNOWN')
    expect(h.v2!.sourcePublishedAt).toBe('2026-08-13') // la publication reste à SA place
  })

  it('un MOIS reste un MOIS : v2 valide, promotion refusée en aval — attendu et correct', () => {
    const [h] = parseHits(reponse([funding({ eventDate: '2026-08', eventDatePrecision: 'MONTH' })]), EXTRACTION)
    expect(h.v2!.occurredAt).toBe('2026-08')
    expect(h.v2!.occurredAtPrecision).toBe('MONTH')
    expect(mapClaim(h)).toBe('NO_EXACT_EVENT_DATE')
  })
})

describe('D/E/F — EXECUTIVE_CHANGE', () => {
  it('D — nomination : normalizedName calculé par le helper de PRODUCTION, NAME_ONLY, champs corrects', () => {
    const [h] = parseHits(reponse([executive()]), EXTRACTION)
    const p: any = h.v2!.payload
    expect(p.direction).toBe('APPOINTMENT')
    expect(p.person).toEqual({
      fullNameRaw: 'Mme Marie DUPONT',
      normalizedName: 'marie dupont', // civilité et casse — normalizePersonName de production
      verification: 'NAME_ONLY',
    })
    expect(p.person.externalRef).toBeUndefined()
    expect(p.roleFunction).toBe('SALES')
    expect(p.roleSeniority).toBe('C_LEVEL')
    expect(p.roleTitleRaw).toBe('Chief Revenue Officer')
    expect(mapClaim(h)).toEqual({ type: 'executive_appointment', temporality: 'dated_event', occurredAt: '2026-08-12' })
  })

  it('E — départ : direction DEPARTURE, mapping executive_departure', () => {
    const [h] = parseHits(reponse([executive({ direction: 'DEPARTURE' })]), EXTRACTION)
    expect((h.v2!.payload as any).direction).toBe('DEPARTURE')
    expect(mapClaim(h)).toEqual({ type: 'executive_departure', temporality: 'dated_event', occurredAt: '2026-08-12' })
  })

  it('F — personne manquante ou blanche : hit ÉCARTÉ, jamais un repli V1', () => {
    for (const nom of [undefined, '', '   ']) {
      const hits = parseHits(reponse([executive({ personFullName: nom })]), EXTRACTION)
      expect(hits, String(nom)).toEqual([]) // AUCUN hit — ni V2, ni V1
    }
  })
})

describe('G/H/I — HIRING_SNAPSHOT', () => {
  it('G — décompte énoncé par la source : openingsObserved porté', () => {
    const [h] = parseHits(reponse([hiring({ openingsCount: 7, openingsCountMethod: 'ENUMERATED_POSTINGS' })]), EXTRACTION)
    expect((h.v2!.payload as any).openingsObserved).toEqual({ value: 7, method: 'ENUMERATED_POSTINGS' })
    expect(h.v2!.occurredAt).toBeNull()
    expect(h.v2!.occurredAtPrecision).toBe('UNKNOWN')
    expect(mapClaim(h)).toEqual({ type: 'sales_hiring', temporality: 'undated_state' })
  })

  it('H — ZÉRO poste ouvert survit : 0 est une valeur pleine', () => {
    const [h] = parseHits(reponse([hiring({ openingsCount: 0 })]), EXTRACTION)
    expect((h.v2!.payload as any).openingsObserved).toEqual({ value: 0, method: 'SOURCE_DECLARED' })
  })

  it('I — sans décompte énoncé : v2 valide, openingsObserved ABSENT — jamais estimé', () => {
    for (const casse of [
      { openingsCount: null, openingsCountMethod: null },
      { openingsCount: 3.5, openingsCountMethod: 'SOURCE_DECLARED' }, // fractionnaire
      { openingsCount: 5, openingsCountMethod: 'ESTIMATED' },         // méthode hors vocabulaire
      { openingsCount: -1, openingsCountMethod: 'SOURCE_DECLARED' },
    ]) {
      const [h] = parseHits(reponse([hiring(casse)]), EXTRACTION)
      expect(h.v2, JSON.stringify(casse)).toBeDefined()
      expect((h.v2!.payload as any).openingsObserved, JSON.stringify(casse)).toBeUndefined()
    }
  })
})

describe('J/K — UNSUPPORTED et fail closed', () => {
  it('J/E — signal RÉELLEMENT hors familles V2 (actu M&A, bureau, produit…) : hit hérité VALIDE, v2 absent', () => {
    for (const type of ['actu', 'autre']) {
      const [h] = parseHits(reponse([{ ...base, signalType: type, factFamily: 'UNSUPPORTED' }]), EXTRACTION)
      expect(h, type).toBeDefined()
      expect(h.company).toBe('ACME TEST')
      expect(h.v2, type).toBeUndefined()
    }
  })

  it('R1-A/B — discriminateur ABSENT ou INVALIDE : extraction malformée, hit ÉCARTÉ — jamais UNSUPPORTED, jamais V1', () => {
    for (const famille of [undefined, null, '', 'M_AND_A', 'funding', 'FUNDING ']) {
      const fixture: any = { ...base, signalType: 'actu' }
      if (famille !== undefined) fixture.factFamily = famille
      expect(parseHits(reponse([fixture]), EXTRACTION), String(famille)).toEqual([])
    }
  })

  it('R1-C — UNSUPPORTED + forme de levée héritée : ÉCARTÉ — pas de contournement du contrat V2', () => {
    const hits = parseHits(reponse([{ ...base, signalType: 'levée', factFamily: 'UNSUPPORTED', amount: '€8.2M' }]), EXTRACTION)
    expect(hits).toEqual([]) // l'ancien mapClaim V1 aurait promu recent_funding
  })

  it('R1-D — UNSUPPORTED + recrutement (surtout STATE/OPEN/SALES) : ÉCARTÉ — aucun candidat hiring v3 par le chemin V1', () => {
    const etatOuvert = {
      ...base, signalType: 'recrutement', factFamily: 'UNSUPPORTED',
      claimNature: 'STATE', eventStatus: 'UNKNOWN', eventDate: null, eventDatePrecision: 'UNKNOWN',
      roleStatus: 'OPEN', roleFunction: 'SALES',
    }
    expect(parseHits(reponse([etatOuvert]), EXTRACTION)).toEqual([]) // V1 aurait promu sales_hiring
    // Et même un état ouvert SALES déguisé sous « actu » ne passe pas.
    expect(parseHits(reponse([{ ...etatOuvert, signalType: 'actu' }]), EXTRACTION)).toEqual([])
    // Un recrutement structurellement couvert par V2 ne se déclare pas UNSUPPORTED.
    expect(parseHits(reponse([{ ...base, signalType: 'recrutement', factFamily: 'UNSUPPORTED' }]), EXTRACTION)).toEqual([])
  })

  it('R2-A/B — UNSUPPORTED alors que les champs clos CONSTRUISENT un EXECUTIVE_CHANGE : ÉCARTÉ', () => {
    for (const direction of ['APPOINTMENT', 'DEPARTURE']) {
      const hits = parseHits(reponse([{
        ...base, signalType: 'actu', factFamily: 'UNSUPPORTED',
        claimNature: 'EVENT', eventStatus: 'COMPLETED',
        eventDate: '2026-08-20', eventDatePrecision: 'DAY',
        direction, personFullName: 'Alice Martin',
        roleFunction: 'EXEC_OTHER', roleSeniority: 'C_LEVEL', role: 'CEO',
      }]), EXTRACTION)
      expect(hits, direction).toEqual([]) // pas d'échappatoire au contrat V2
    }
  })

  it('R2-C/D — exécutif-like mais RÉELLEMENT inconstructible (direction UNKNOWN, ou personne absente) : hérité admis', () => {
    const gabarit = {
      ...base, signalType: 'actu', factFamily: 'UNSUPPORTED',
      claimNature: 'EVENT', eventStatus: 'COMPLETED',
      eventDate: '2026-08-20', eventDatePrecision: 'DAY',
      roleFunction: 'EXEC_OTHER', roleSeniority: 'C_LEVEL', role: 'CEO',
    }
    for (const casse of [
      { direction: 'UNKNOWN', personFullName: 'Alice Martin' }, // C
      { direction: 'APPOINTMENT', personFullName: '' },          // D
      { direction: 'APPOINTMENT' },                              // D — personne absente
    ]) {
      const [h] = parseHits(reponse([{ ...gabarit, ...casse }]), EXTRACTION)
      expect(h, JSON.stringify(casse)).toBeDefined()
      expect(h.v2, JSON.stringify(casse)).toBeUndefined() // hérité, sans v2 — rien réparé
    }
  })

  it('R1-6 — un exécutif volontairement UNSUPPORTED (actu, non promotable V1) reste un hit hérité — rien n’est réparé depuis la prose', () => {
    const [h] = parseHits(reponse([{
      ...base, signalType: 'actu', factFamily: 'UNSUPPORTED',
      roleStatus: 'FILLED', roleFunction: 'EXEC_OTHER',
      detail: 'nomination d’un nouveau CEO', // la prose ne répare RIEN
    }]), EXTRACTION)
    expect(h).toBeDefined()
    expect(h.v2).toBeUndefined()
    expect(mapClaim(h)).toBe('NO_HONEST_EVIDENCE_TYPE') // non promotable par V1 : trou fermé
  })

  it('K — famille V2 déclarée mais contradictoire : hit ÉCARTÉ, aucun candidat possible', () => {
    for (const casse of [
      funding({ claimNature: 'STATE' }),                       // FUNDING + STATE
      hiring({ claimNature: 'EVENT', eventDate: '2026-08-12', eventDatePrecision: 'DAY' }), // HIRING + EVENT
      executive({ personFullName: '' }),                        // exécutif sans personne
      funding({ claimNature: 'UNKNOWN' }),                      // nature indéterminée sur une famille EVENT
    ]) {
      expect(parseHits(reponse([casse]), EXTRACTION), JSON.stringify(casse.factFamily)).toEqual([])
    }
    // Et un lot mixte : le hit malformé tombe, les valides restent.
    const hits = parseHits(reponse([funding({ claimNature: 'STATE' }), funding(), { ...base, signalType: 'actu', factFamily: 'UNSUPPORTED' }]), EXTRACTION)
    expect(hits.length).toBe(2)
    expect(hits[0].v2).toBeDefined()
    expect(hits[1].v2).toBeUndefined()
  })

  it('K-bis — enums descriptifs hors vocabulaire : UNKNOWN, jamais une invention ni un rejet inutile', () => {
    const [h] = parseHits(reponse([funding({ roundStage: 'MEGA_ROUND', investors: [{ nameRaw: 'X Capital', role: 'CHEF' }] })]), EXTRACTION)
    const p: any = h.v2!.payload
    expect(p.roundStage).toBe('UNKNOWN')
    expect(p.investors).toEqual([{ nameRaw: 'X Capital', role: 'UNKNOWN' }])
  })
})

describe('L — la prose ne porte AUCUNE sémantique', () => {
  it('muter detail/icebreaker ne change que rawDetail — projection et version sémantiques intactes', () => {
    const [a] = parseHits(reponse([funding()]), EXTRACTION)
    const [b] = parseHits(reponse([funding({ detail: 'article entièrement réécrit', icebreaker: 'autre accroche' })]), EXTRACTION)
    expect(a.v2!.rawDetail).not.toEqual(b.v2!.rawDetail)
    expect(assertedFactHash(a.v2!, 'acc_siren_999000001')).toBe(assertedFactHash(b.v2!, 'acc_siren_999000001'))
    expect(a.v2!.payload).toEqual(b.v2!.payload)
  })

  it('l’assembleur ne lit la prose QUE pour rawDetail (verrou structurel)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/prospector/proactive/acquisitionV2.ts'), 'utf8')
    const corps = src.split('export function assembleLiveFactV2')[1].split('\nexport ')[0]
    // `detail`/`icebreaker` n'apparaissent que dans la construction de rawDetail.
    const usages = corps.match(/e\.detail|e\.icebreaker/g) ?? []
    expect(usages.length).toBe(2)
    expect(corps).toContain('rawDetail: { detail: e.detail, icebreaker: e.icebreaker }')
    // Et jamais d'analyse de prose : aucun match/regex sur ces champs.
    expect(corps).not.toMatch(/detail\.(match|includes|search|split)/)
  })
})

describe('M — version de contrat et cache', () => {
  it('PROMPT_VERSION vaut signal-acquisition-v3 et entre EXACTEMENT UNE FOIS dans l’identité de cache', () => {
    expect(PROMPT_VERSION).toBe('signal-acquisition-v3')
    const src = readFileSync(join(process.cwd(), 'lib/prospector/signals.ts'), 'utf8')
    const cache = src.split('cacheParts: [')[1].split(']')[0]
    expect((cache.match(/PROMPT_VERSION/g) ?? []).length).toBe(1)
    // Aucun second jeton de version indépendant — sur les lignes DIRECTIVES
    // (la doc historique a le droit de raconter l'ancien jeton 'v3').
    for (const l of src.split('\n')) {
      if (l.trim().startsWith('//') || l.trim().startsWith('*')) continue
      expect(l, l).not.toMatch(/'v3'|"v3"/)
    }
  })
})
