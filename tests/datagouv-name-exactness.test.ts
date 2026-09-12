// SIGNAL-PRODUCT-REACHABILITY-001-R1e — EXACTITUDE DE `lookupByName()`.
//
// ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
// `lookupByName` documentait une doctrine d'exactitude — « ne jamais prendre
// `results[0]` pour la vérité » — que son implémentation ne tenait pas
// entièrement. Elle contenait :
//
//     if (candidates.length === 1) return { found: true, resolution: 'resolved', … }
//
// avant toute comparaison de raison sociale. Or l'API data.gouv rend un
// CLASSEMENT DE PERTINENCE : elle peut parfaitement ne renvoyer QU'UNE société,
// et que celle-ci ne porte pas le nom demandé. Interroger « Acme » et recevoir
// la seule « Acme Services » suffisait donc à décerner l'autorité.
//
// C'est ENTITY-RESOLUTION-001 rouvert par le bas : `results[0]` refusé quand il
// y en a plusieurs, accepté quand il est seul. Le cardinal d'un classement ne
// prouve rien.
//
// ── POURQUOI C'EST DEVENU P0 ────────────────────────────────────────────────
// Ce SIREN devient l'identité de COMPTE d'un fait du Decision Kernel. Une
// donnée vraie attachée à la mauvaise entité est une information fausse — et
// elle porterait ici le tampon « vérifié data.gouv ».
//
// ⚠️ ON TESTE L'IMPLÉMENTATION RÉELLE. Seule la frontière HTTP est doublée,
// comme dans `entity-resolution.test.ts`. Aucun réseau.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { lookupByName } from '../lib/prospector/datagouv'

/** Une société telle que l'API data.gouv la rend. */
function societe(nom: string, siren: string, siteWeb?: string) {
  return {
    siren,
    nom_complet: nom,
    nom_raison_sociale: nom,
    siege: { libelle_commune: 'Paris', activite_principale: '62.01Z' },
    complements: siteWeb ? { site_web: siteWeb } : undefined,
    etat_administratif: 'A',
  }
}

function repond(resultats: any[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ results: resultats }),
  })
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('lookupByName — exactitude de la raison sociale', () => {
  it('UN SEUL résultat APPROCHANT n’est PAS une résolution', async () => {
    // ⚠️ LE CŒUR DU LOT. Le classement ne contient qu'une société, mais elle ne
    // porte pas le nom demandé. Un cardinal de 1 n'est pas une preuve d'identité.
    repond([societe('Acme Services', '111111111')])

    const r = await lookupByName('Acme')

    expect(r.resolution).not.toBe('resolved')
    expect(r.found).toBe(false)
    // Et surtout : aucun SIREN ne remonte comme autorité.
    expect(r.siren).toBeUndefined()
  })

  it('UN SEUL résultat EXACT est une résolution', async () => {
    // La garde n'est pas un mur : le cas légitime passe toujours.
    repond([societe('Acme', '552100554', 'acme.fr')])

    const r = await lookupByName('Acme')

    expect(r.found).toBe(true)
    expect(r.resolution).toBe('resolved')
    expect(r.siren).toBe('552100554')
  })

  it('plusieurs candidates, UNE SEULE exacte → résolue sur celle-là', async () => {
    // ⚠️ La bonne n'est PAS la première du classement : c'est précisément ce que
    // l'exactitude doit trancher, et non l'ordre de pertinence.
    repond([
      societe('Acme Services', '111111111'),
      societe('Acme', '552100554'),
      societe('Acme Group', '222222222'),
    ])

    const r = await lookupByName('Acme')

    expect(r.resolution).toBe('resolved')
    expect(r.siren).toBe('552100554')
  })

  it('plusieurs HOMONYMES exacts → ambigu, jamais résolu', async () => {
    // Choisir serait deviner. L'ambiguïté remonte à l'utilisateur.
    repond([societe('Acme', '552100554'), societe('Acme', '999999999')])

    const r = await lookupByName('Acme')

    expect(r.resolution).toBe('ambiguous')
    expect(r.found).toBe(false)
    expect(r.siren).toBeUndefined()
  })

  it('QUE des approchants → ambigu, jamais le premier du classement', async () => {
    repond([societe('Acme Services', '111111111'), societe('Acme Group', '222222222')])

    const r = await lookupByName('Acme')

    expect(r.resolution).toBe('ambiguous')
    expect(r.siren).toBeUndefined()
  })

  it('aucun résultat → introuvable, et ce n’est pas une ambiguïté', async () => {
    repond([])

    const r = await lookupByName('Acme')

    expect(r.resolution).toBe('not_found')
    expect(r.found).toBe(false)
  })

  it('l’exactitude ignore casse, accents et ponctuation — pas le mot lui-même', async () => {
    // La normalisation existante compare des lettres et des chiffres. Elle
    // absorbe la typographie, jamais un mot supplémentaire.
    repond([societe('ACMÉ-FRANCE', '552100554')])
    const accents = await lookupByName('acme france')
    expect(accents.resolution).toBe('resolved')

    repond([societe('Acme France', '552100554')])
    const motEnPlus = await lookupByName('Acme')
    expect(motEnPlus.resolution).not.toBe('resolved')
  })

  it('le site officiel remonte sous la forme NUE de production', async () => {
    // ⚠️ CONTRAT DE FORME. `extractWebsite()` retire le schéma : tout appelant
    // qui traite cette valeur comme une URL absolue se trompe.
    repond([societe('Acme', '552100554', 'https://acme.fr/')])

    const r = await lookupByName('Acme')

    expect(r.website).toBe('acme.fr')
    expect(r.website).not.toMatch(/^https?:\/\//)
  })
})
