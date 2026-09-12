// SIGNAL_ARCHITECTURE_V1 — LE REGISTRE NE PEUT PAS CASSER L'ADJUDICATION.
//
// ⚠️ FICHIER SÉPARÉ, ET C'EST NÉCESSAIRE. Il DOUBLE la couche de persistance
// pour la faire ÉCHOUER — `tests/source-assertion-ledger.test.ts` emploie au
// contraire le magasin réel pour prouver la sémantique d'insertion. Les deux
// exigences sont incompatibles dans un même module, et les mêler produirait un
// test qui ne prouve ni l'une ni l'autre.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  /**
   * Nombre d'écritures à faire échouer EN TÊTE de lot.
   *
   * ⚠️ ON COMPTE LES APPELS, ON NE DÉSIGNE PAS UNE URL. `buildSourceAssertions`
   * trie par identifiant — donc par condensat — et l'ordre de traitement ne
   * suit pas celui des sources. Viser une URL rendrait le test dépendant d'un
   * hachage : il passerait ou non selon la source qui sort première, et un
   * mutant survivrait sans qu'on sache pourquoi.
   */
  echecsEnTete: 0,
  appels: 0,
  ecrites: [] as string[],
  /** `insertItemIfAbsent` rend `false` sans jeter — « existe » OU base muette. */
  faux: false,
  /** La relecture d'arbitrage échoue : l'issue est donc INDÉTERMINÉE. */
  relectureMuette: false,
}))

vi.mock('../lib/supabase/store', () => ({
  // La panne la plus dure : une EXCEPTION, pas un `false`. Un `try/catch`
  // absent se traduit alors par un rejet, donc par une adjudication perdue.
  insertItemIfAbsent: async (_k: string, _id: string, data: any) => {
    etat.appels++
    // `false` SANS exception : la forme exacte d'un « existe déjà » — ou d'une
    // base muette. C'est `getItemStrict` qui doit trancher.
    if (etat.faux) return false
    if (etat.appels <= etat.echecsEnTete) throw new Error('base injoignable')
    etat.ecrites.push(data.sourceUrl)
    return true
  },
  getItemStrict: async () => (etat.relectureMuette
    ? { ok: false as const }
    : Promise.reject(new Error('base injoignable'))),
}))

import { recordSourceAssertions } from '../lib/prospector/proactive/sourceAssertion'
import type { KnownEvidenceEvent } from '../lib/prospector/proactive/catalog'

const COMPTE = 'acc_siren_552100554'
const CLE = `recent_funding|${COMPTE}|2026-08-12`

const EVIDENCE = {
  id: 'ev_ext_test', accountId: COMPTE, scope: 'account', type: 'recent_funding',
  source: { provider: 'web_signal_search', url: 'https://acme.fr/p' },
  assertionType: 'fact', confidence: 0.75, observedAt: '2026-08-20T09:00:00.000Z',
  temporality: 'dated_event', occurredAt: '2026-08-12',
} as unknown as KnownEvidenceEvent

const SOURCE: any = {
  url: 'https://acme.fr/p', publisher: 'acme.fr', grade: 'A',
  lineage: { kind: 'ORIGINAL' }, grounding: { kind: 'UNVERIFIABLE' },
  sourcePublishedAt: null, hit: {},
}

function promotion(urls: string[]) {
  return [{
    workspaceId: 'ws_alpha', accountId: COMPTE, canonicalClaimKey: CLE,
    evidence: EVIDENCE,
    qualifyingSources: urls.map((u) => ({ ...SOURCE, url: u, publisher: new URL(u).hostname })),
  }]
}

beforeEach(() => {
  etat.echecsEnTete = 99; etat.appels = 0; etat.ecrites = []
  etat.faux = false; etat.relectureMuette = false
})

describe('F2/F3 — isolation des pannes du registre', () => {
  it('une panne d’écriture ne JETTE JAMAIS — l’adjudication survit', async () => {
    // ⚠️ C'EST LA PROPRIÉTÉ QUI COMPTE. Une personne a confirmé un fait ; un
    // journal d'audit indisponible ne rend pas ce fait faux. Si cette promesse
    // ne tenait pas, une panne du registre annulerait des adjudications
    // humaines — le registre coûterait plus qu'il ne rapporte.
    const bilan = await recordSourceAssertions(promotion(['https://acme.fr/p']), 'ws_alpha')
    expect(bilan.failed).toBe(1)
    expect(bilan.created).toBe(0)
  })

  it('une assertion en échec n’emporte PAS les suivantes du même lot', async () => {
    // ⚠️ CE QUE CE CAS SEUL PEUT VOIR. Avec une seule source, une protection
    // globale et une protection PAR ASSERTION sont indiscernables. Ici la
    // première écriture échoue et la seconde doit tout de même aboutir :
    // perdre le reste du lot parce qu'une ligne a échoué aggraverait
    // précisément la perte que ce registre existe pour éviter.
    etat.echecsEnTete = 1   // la PREMIÈRE écriture échoue, quel que soit l'ordre
    const bilan = await recordSourceAssertions(
      promotion(['https://acme.fr/a', 'https://acme.fr/b']), 'ws_alpha',
    )
    expect(bilan.failed).toBe(1)
    expect(bilan.created).toBe(1)   // ⚠️ 0 si la protection est GLOBALE au lieu d'être PAR ASSERTION
    expect(etat.ecrites).toHaveLength(1)
  })

  it('une source MALFORMÉE ne fait pas rejeter non plus', async () => {
    // ⚠️ CE CAS N'EST PAS COUVERT PAR LA PROTECTION PAR ASSERTION. Ici c'est la
    // CONSTRUCTION qui échoue — `s.lineage.kind` sur une source sans lignée —
    // donc avant toute écriture, hors de la boucle protégée. Sans garde
    // englobante, la route rejetterait et l'adjudication humaine serait perdue
    // pour une raison qui n'a rien à voir avec elle.
    etat.echecsEnTete = 0
    const bilan = await recordSourceAssertions(
      [{ workspaceId: 'ws_alpha', accountId: COMPTE, canonicalClaimKey: CLE,
         evidence: EVIDENCE, qualifyingSources: [{ url: 'https://acme.fr/p' } as any] }],
      'ws_alpha',
    )
    expect(bilan.created).toBe(0)
    expect(bilan.failed).toBeGreaterThan(0)
  })

  it('le bilan ne porte que des compteurs et des identifiants durables', async () => {
    // ⚠️ NI MESSAGE, NI URL, NI CAUSE. `durableIds` a rejoint le contrat parce
    // que la couche d'ancrage doit savoir QUELLES assertions ont réellement
    // survécu — sans quoi elle produirait des ancres orphelines. Ce sont des
    // condensats opaques, et le bilan reste STRICTEMENT interne : `promote.ts`
    // ne journalise qu'une erreur générique et n'en met rien dans la réponse.
    const bilan = await recordSourceAssertions([], 'ws_alpha')
    expect(Object.keys(bilan).sort()).toEqual(['created', 'durableIds', 'existing', 'failed'])
    expect(bilan.durableIds).toEqual([])
  })

  it('un `false` AMBIGU non arbitré n’est PAS un succès durable', async () => {
    // ⚠️ LE CAS LE PLUS SOURNOIS. `insertItemIfAbsent` rend `false` aussi bien
    // pour « la ligne existe » que pour « la base n'a pas répondu ». La
    // relecture d'arbitrage échoue ici : l'issue est INDÉTERMINÉE, donc
    // `write_failed` — et un indéterminé ne soutient aucune ancre.
    etat.faux = true
    etat.relectureMuette = true
    const bilan = await recordSourceAssertions(promotion(['https://acme.fr/p']), 'ws_alpha')
    expect(bilan.failed).toBe(1)
    expect(bilan.created).toBe(0)
    expect(bilan.durableIds).toEqual([])
  })

  it('une écriture EN ÉCHEC n’entre JAMAIS dans les identifiants durables', async () => {
    // ⚠️ LE CŒUR DE L'INTÉGRITÉ D'ÉCRITURE. `insertItemIfAbsent` rend `false`
    // pour « existe déjà » ET pour « base muette » ; un faux ambigu traité
    // comme un succès ferait naître une ancre sans appui persistant.
    const bilan = await recordSourceAssertions(promotion(['https://acme.fr/p']), 'ws_alpha')
    expect(bilan.failed).toBe(1)
    expect(bilan.durableIds).toEqual([])
  })
})
