// SIGNAL_ARCHITECTURE_V1_WAVE2 — L'ANCRAGE NE PEUT PAS CASSER L'ADJUDICATION.
//
// ⚠️ FICHIER SÉPARÉ, ET C'EST NÉCESSAIRE. Il DOUBLE la couche de persistance
// pour la faire ÉCHOUER — `tests/canonical-fact-anchors.test.ts` emploie au
// contraire le magasin réel pour prouver la sémantique d'insertion. Les deux
// exigences sont incompatibles dans un même module.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  /**
   * Nombre d'écritures à faire échouer EN TÊTE de lot.
   *
   * ⚠️ ON COMPTE LES APPELS, ON NE DÉSIGNE PAS UN IDENTIFIANT. Les instantanés
   * sont triés par condensat : viser un identifiant rendrait le test dépendant
   * d'un hachage, et un mutant y survivrait sans qu'on sache pourquoi.
   */
  echecsEnTete: 0,
  appels: 0,
  ecrits: [] as string[],
}))

vi.mock('../lib/supabase/store', () => ({
  // La panne la plus dure : une EXCEPTION, pas un `false`. Sans `try/catch`,
  // elle devient un rejet — donc une adjudication humaine perdue.
  insertItemIfAbsent: async (_k: string, id: string) => {
    etat.appels++
    if (etat.appels <= etat.echecsEnTete) throw new Error('base injoignable')
    etat.ecrits.push(id)
    return true
  },
  getItemStrict: async () => { throw new Error('base injoignable') },
}))

import { recordCanonicalAnchors } from '../lib/prospector/proactive/canonicalFact'
import type { AssertionBuildInput } from '../lib/prospector/proactive/sourceAssertion'
import type { KnownEvidenceEvent } from '../lib/prospector/proactive/catalog'

const WS = 'ws_alpha'
const COMPTE = 'acc_siren_552100554'
const CLE_ETAT = `sales_hiring|${COMPTE}|STATE`

const SOURCE = (url: string, retrievedAt: string): any => ({
  url, publisher: new URL(url).hostname, grade: 'A',
  lineage: { kind: 'ORIGINAL' }, grounding: { kind: 'UNVERIFIABLE' },
  sourcePublishedAt: null, retrievedAt, hit: {},
})

/** Un lot d'ÉTAT observé sur deux jours ⇒ deux instantanés à écrire. */
function lotDeuxInstantanes(): AssertionBuildInput[] {
  const evidence = {
    id: 'ev_ext_etat', accountId: COMPTE, scope: 'account', type: 'sales_hiring',
    source: { provider: 'web_signal_search', url: 'https://careers.acme.fr/a' },
    assertionType: 'fact', confidence: 0.75, observedAt: '2026-09-05T14:00:00.000Z',
    temporality: 'undated_state',
  } as unknown as KnownEvidenceEvent

  return [{
    workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_ETAT, evidence,
    qualifyingSources: [
      SOURCE('https://careers.acme.fr/a', '2026-09-01T06:00:00.000Z'),
      SOURCE('https://careers.acme.fr/b', '2026-09-15T06:00:00.000Z'),
    ],
  }]
}

beforeEach(() => { etat.echecsEnTete = 99; etat.appels = 0; etat.ecrits = [] })

describe('I3 — isolation des pannes d’ancrage', () => {
  it('une panne d’écriture ne JETTE JAMAIS — l’adjudication survit', async () => {
    // ⚠️ LA PROPRIÉTÉ QUI COMPTE. Une personne a confirmé un fait ; une couche
    // d'ancrage indisponible ne rend pas ce fait faux. Sans cette promesse,
    // une panne d'infrastructure annulerait des adjudications humaines.
    const bilan = await recordCanonicalAnchors(lotDeuxInstantanes(), WS)
    expect(bilan.failed).toBe(2)
    expect(bilan.created).toBe(0)
  })

  it('une ancre en échec n’emporte PAS les suivantes du même lot', async () => {
    // ⚠️ CE CAS SEUL DISTINGUE une protection GLOBALE d'une protection PAR
    // ANCRE. Avec une seule écriture, les deux sont indiscernables.
    etat.echecsEnTete = 1
    const bilan = await recordCanonicalAnchors(lotDeuxInstantanes(), WS)
    expect(bilan.failed).toBe(1)
    expect(bilan.created).toBe(1)
    expect(etat.ecrits).toHaveLength(1)
  })

  it('une entrée MALFORMÉE ne fait pas rejeter non plus', async () => {
    // Ici c'est la CONSTRUCTION qui échoue — hors de la boucle protégée. Sans
    // garde englobante, la route rejetterait et l'adjudication serait perdue
    // pour une raison sans rapport avec elle.
    etat.echecsEnTete = 0
    const bilan = await recordCanonicalAnchors([{
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_ETAT,
      evidence: { id: 'e', accountId: COMPTE, type: 'sales_hiring',
        temporality: 'undated_state', observedAt: 'x' } as any,
      // ⚠️ `retrievedAt` PRÉSENT mais `lineage` ABSENT : la dérivation du jour
      // aboutit, puis la construction de la provenance déréférence
      // `s.lineage.kind` et JETTE. On atteint donc bien le code hors boucle.
      qualifyingSources: [
        { url: 'https://careers.acme.fr/a', retrievedAt: '2026-09-01T06:00:00.000Z' } as any,
      ],
    }], WS)
    expect(bilan.created).toBe(0)
    expect(bilan.failed).toBeGreaterThan(0)
  })

  it('le bilan ne contient aucun détail interne exploitable', async () => {
    const bilan = await recordCanonicalAnchors([], WS)
    expect(Object.keys(bilan).sort()).toEqual(['created', 'existing', 'failed'])
  })
})
