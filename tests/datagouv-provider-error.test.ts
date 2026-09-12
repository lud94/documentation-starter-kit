// OBS-DATAGOUV-001 — UNE PANNE N'EST PAS UNE ABSENCE.
//
// ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
// Toutes les fonctions de `datagouv.ts` convertissaient un 429, un 500, une
// coupure réseau ou un JSON illisible en `[]`, `null` ou `{found:false}` —
// exactement la même valeur qu'une réponse valide sans résultat.
//
// L'utilisateur lisait « entreprise introuvable » alors que Prospector n'avait
// pas pu interroger data.gouv. Les deux situations appellent des gestes
// opposés : sur « introuvable » on corrige la saisie, sur « indisponible » on
// réessaie. Les confondre fait corriger ce qui n'est pas faux, et abandonner ce
// qui aurait abouti.
//
// ── LE DERNIER `results[0]` ─────────────────────────────────────────────────
// `reconcileByName()` interrogeait encore avec `per_page=1` et retenait
// `results[0]` — le défaut qu'ENTITY-RESOLUTION-001 avait fermé dans
// `lookupByName`, resté ouvert ici. Il élevait la confiance d'une
// identification sur la foi d'un homonyme arbitraire.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import {
  fetchCompanies,
  fetchCompanyDetail,
  lookupByName,
  lookupBySiren,
  reconcileByName,
  searchCandidates,
} from '../lib/prospector/datagouv'
import { ProviderError, PUBLIC_ERROR } from '../lib/observability/safeError'

const societe = (siren: string, nom: string, ville = 'Paris') => ({
  siren,
  nom_complet: nom,
  etat_administratif: 'A',
  siege: { libelle_commune: ville },
  activite_principale: '62.01Z',
  dirigeants: [{ prenoms: 'Jean', nom: 'Dupont' }],
})

/** Réponse HTTP valide. */
function repond(results: any[]) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results }) } as any)
}
/** Le fournisseur répond, avec un statut d'échec. */
function statut(code: number) {
  fetchMock.mockResolvedValue({ ok: false, status: code, json: async () => ({}) } as any)
}
/** La requête n'aboutit pas. */
function reseauKo(message = 'ECONNRESET chemin/interne/secret') {
  fetchMock.mockRejectedValue(new Error(message))
}
/** Réponse 200 dont le corps est inexploitable. */
function corpsIllisible() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0') },
  } as any)
}

beforeEach(() => vi.clearAllMocks())

describe('A. Les pannes fournisseur LÈVENT, et ne se déguisent jamais en not_found', () => {
  it('1. HTTP 500 ⇒ provider_http, pas not_found', async () => {
    statut(500)
    const e: any = await lookupByName('OVHcloud').catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.safe.code).toBe('provider_http')
    expect(e.safe.status).toBe(500)
    expect(e.safe.provider).toBe('datagouv')
  })

  it('2. HTTP 429 ⇒ provider_http, marqué réessayable', async () => {
    statut(429)
    const e: any = await lookupByName('OVHcloud').catch((x) => x)
    expect(e.safe.code).toBe('provider_http')
    expect(e.safe.status).toBe(429)
    // Une limitation de débit se réessaie ; c'est justement l'information que
    // « introuvable » détruisait.
    expect(e.safe.retryable).toBe(true)
  })

  it('3. rejet réseau ⇒ provider_network', async () => {
    reseauKo()
    const e: any = await lookupByName('OVHcloud').catch((x) => x)
    expect(e.safe.code).toBe('provider_network')
  })

  it('4. JSON invalide ⇒ provider_response', async () => {
    corpsIllisible()
    const e: any = await lookupByName('OVHcloud').catch((x) => x)
    expect(e.safe.code).toBe('provider_response')
  })

  it('un corps non-objet (200 « null ») est aussi une réponse inexploitable', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => null } as any)
    const e: any = await lookupByName('OVHcloud').catch((x) => x)
    expect(e.safe.code).toBe('provider_response')
  })

  // ⚠️ SEC-LOG-01. La panne porte une CLASSE, jamais un contenu.
  it('aucune panne ne transporte de corps, d\'URL ni de pile', async () => {
    reseauKo('ECONNRESET https://recherche-entreprises.api.gouv.fr/search?q=SECRET')
    const e: any = await lookupByName('OVHcloud').catch((x) => x)

    const expose = JSON.stringify(e.safe) + e.message
    expect(expose).not.toContain('ECONNRESET')
    expect(expose).not.toContain('recherche-entreprises')
    expect(expose).not.toContain('SECRET')
    expect(expose).not.toContain('http')
    // Seuls des champs autorisés existent.
    expect(Object.keys(e.safe).sort()).toEqual(
      ['code', 'errorName', 'operation', 'provider', 'requestId', 'retryable', 'status'].sort(),
    )
  })

  it('les quatre pannes valent pour searchCandidates, lookupBySiren et fetchCompanyDetail', async () => {
    for (const panne of [() => statut(500), () => statut(429), () => reseauKo(), () => corpsIllisible()]) {
      panne(); await expect(searchCandidates('Acme')).rejects.toBeInstanceOf(ProviderError)
      panne(); await expect(lookupBySiren('552100554')).rejects.toBeInstanceOf(ProviderError)
      panne(); await expect(fetchCompanyDetail('552100554')).rejects.toBeInstanceOf(ProviderError)
    }
  })
})

describe('B. Une réponse VALIDE et vide reste un not_found', () => {
  it('5. results:[] ⇒ not_found, sans exception', async () => {
    repond([])
    const v = await lookupByName('SocieteInexistanteXYZ')
    expect(v.found).toBe(false)
    expect(v.resolution).toBe('not_found')
    expect(v.ambiguous).toBeUndefined()
  })

  it('searchCandidates rend [] sur réponse valide vide', async () => {
    repond([])
    expect(await searchCandidates('SocieteInexistanteXYZ')).toEqual([])
  })

  it('6. SIREN valide mais absent de la réponse ⇒ not_found', async () => {
    // La réponse contient une AUTRE société : l'ancien code retombait sur
    // `results[0]` et acceptait ce voisin.
    repond([societe('999999999', 'AUTRE SA')])
    const v = await lookupBySiren('552100554')
    expect(v.found).toBe(false)
    expect(v.resolution).toBe('not_found')
    expect(v.name).toBeUndefined()
  })

  it('fetchCompanyDetail : SIREN absent ⇒ not_found, dirigeants vides', async () => {
    repond([societe('999999999', 'AUTRE SA')])
    const d = await fetchCompanyDetail('552100554')
    expect(d.found).toBe(false)
    expect(d.resolution).toBe('not_found')
    expect(d.dirigeants).toEqual([])
  })

  it('un SIREN malformé est un not_found, sans appel réseau', async () => {
    const v = await lookupBySiren('12')
    expect(v.resolution).toBe('not_found')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('C. Les résolutions métier sont préservées à l\'identique', () => {
  const OVH = [
    societe('111111111', 'OVHCLOUD OCT1', 'Roubaix'),
    societe('222222222', 'OVHCLOUD', 'Roubaix'),
    societe('333333333', 'OVHCLOUD SUPPORT', 'Lille'),
  ]

  it('7. l\'ambiguïté reste ambiguous — ENTITY-RESOLUTION-001 intact', async () => {
    repond(OVH)
    const v = await lookupByName('OVHcloud SAS')
    expect(v.found).toBe(false)
    expect(v.ambiguous).toBe(true)
    expect(v.resolution).toBe('ambiguous')
    expect(v.candidates).toHaveLength(3)
    expect(v.siren).toBeUndefined()
  })

  it('8. le nom strict unique reste resolved', async () => {
    repond(OVH)
    const v = await lookupByName('OVHcloud')
    expect(v.found).toBe(true)
    expect(v.resolution).toBe('resolved')
    expect(v.siren).toBe('222222222')
  })

  it('found:true implique TOUJOURS resolution:resolved', async () => {
    repond([societe('552100554', 'ACME SA')])
    expect((await lookupByName('ACME SA')).resolution).toBe('resolved')
    expect((await lookupBySiren('552100554')).resolution).toBe('resolved')
    expect((await fetchCompanyDetail('552100554')).resolution).toBe('resolved')
  })
})

describe('D. reconcileByName — plus aucun results[0]', () => {
  const OVH = [
    societe('111111111', 'OVHCLOUD OCT1'),
    societe('222222222', 'OVHCLOUD'),
  ]

  it('10. le code source ne contient plus de sélection results[0]', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/prospector/datagouv.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    // Ni `results[0]`, ni la fenêtre `per_page=1` qui la rendait inévitable
    // dans une résolution PAR NOM.
    expect(src).not.toMatch(/results\s*\|\|\s*\[\]\s*\)\s*\[\s*0\s*\]/)
    expect(src).not.toMatch(/per_page=1&etat_administratif/)
  })

  it('une ambiguïté ne produit AUCUN SIREN', async () => {
    repond(OVH)
    expect(await reconcileByName('OVHcloud SAS')).toBeNull()
  })

  it('un not_found ne produit aucun SIREN', async () => {
    repond([])
    expect(await reconcileByName('SocieteInexistanteXYZ')).toBeNull()
  })

  it('une panne se PROPAGE — elle ne devient pas « pas de correspondance »', async () => {
    statut(503)
    await expect(reconcileByName('OVHcloud')).rejects.toBeInstanceOf(ProviderError)
  })

  it('seule une résolution exacte produit un SIREN', async () => {
    repond(OVH)
    const r = await reconcileByName('OVHcloud')
    expect(r).toEqual({ siren: '222222222', sector: '62.01Z', city: 'Paris' })
  })
})

describe('E. Contrat public des routes — aucune fuite fournisseur', () => {
  // Les routes sont exercées via leur handler, avec un faux `res` : c'est le
  // corps RÉELLEMENT renvoyé au navigateur qui est inspecté.
  function faussesReponses() {
    const envoye: any[] = []
    const res: any = {
      status(code: number) { res._code = code; return res },
      json(body: any) { envoye.push({ code: res._code, body }); return res },
    }
    return { res, envoye }
  }

  const FUITES = [
    'ECONNRESET', 'recherche-entreprises', 'api.gouv.fr', 'https://',
    'Unexpected token', 'SyntaxError', 'at Object.', 'stack',
  ]

  it('11. /api/company/verify ne fuit ni corps, ni URL, ni message fournisseur', async () => {
    reseauKo('ECONNRESET https://recherche-entreprises.api.gouv.fr/search?q=X')
    const { default: verify } = await import('../pages/api/company/verify')
    const { res, envoye } = faussesReponses()

    await verify({ query: { name: 'OVHcloud' } } as any, res)

    const { code, body } = envoye[0]
    expect(code).toBe(200)
    expect(body.found).toBe(false)
    expect(body.resolution).toBe('provider_error')
    expect(body.error).toBe(PUBLIC_ERROR)

    const brut = JSON.stringify(body)
    for (const f of FUITES) expect(brut, f).not.toContain(f)
    // Le contrat est CLOS : trois champs, pas un de plus.
    expect(Object.keys(body).sort()).toEqual(['error', 'found', 'resolution'])
  })

  it('12. /api/company/detail ne fuit rien non plus', async () => {
    corpsIllisible()
    const { default: detail } = await import('../pages/api/company/detail')
    const { res, envoye } = faussesReponses()

    await detail({ query: { siren: '552100554' } } as any, res)

    const { body } = envoye[0]
    expect(body.found).toBe(false)
    expect(body.resolution).toBe('provider_error')
    expect(body.dirigeants).toEqual([])
    expect(body.error).toBe(PUBLIC_ERROR)

    const brut = JSON.stringify(body)
    for (const f of FUITES) expect(brut, f).not.toContain(f)
  })

  it('une réponse valide et vide passe bien en not_found côté route', async () => {
    repond([])
    const { default: verify } = await import('../pages/api/company/verify')
    const { res, envoye } = faussesReponses()

    await verify({ query: { name: 'SocieteInexistanteXYZ' } } as any, res)
    expect(envoye[0].body.resolution).toBe('not_found')
    expect(envoye[0].body.error).toBeUndefined()
  })
})

describe('F. TEST NÉGATIF — un 500 ne produit JAMAIS le mot « introuvable »', () => {
  // ⚠️ C'est l'assertion qui résume tout le lot. Elle balaie les contrats
  // publics des deux routes ET les libellés d'interface.
  const INTERDITS = [/introuvable/i, /not.?found/i, /n'existe pas/i, /aucune entreprise/i]

  it('le contrat de /verify sur 500 ne contient aucun de ces mots', async () => {
    statut(500)
    const { default: verify } = await import('../pages/api/company/verify')
    const envoye: any[] = []
    const res: any = { status() { return res }, json(b: any) { envoye.push(b); return res } }

    await verify({ query: { name: 'OVHcloud' } } as any, res)

    const texte = JSON.stringify(envoye[0])
    for (const mot of INTERDITS) expect(texte, String(mot)).not.toMatch(mot)
  })

  it('le contrat de /detail sur 500 non plus', async () => {
    statut(500)
    const { default: detail } = await import('../pages/api/company/detail')
    const envoye: any[] = []
    const res: any = { status() { return res }, json(b: any) { envoye.push(b); return res } }

    await detail({ query: { siren: '552100554' } } as any, res)

    const texte = JSON.stringify(envoye[0])
    for (const mot of INTERDITS) expect(texte, String(mot)).not.toMatch(mot)
  })

  it('le libellé d\'interface dit « indisponible », et propose de réessayer', async () => {
    const { PROVIDER_UNAVAILABLE } = await import('../lib/prospector/capabilities')
    for (const mot of INTERDITS) expect(PROVIDER_UNAVAILABLE).not.toMatch(mot)
    expect(PROVIDER_UNAVAILABLE).toMatch(/indisponible/i)
    expect(PROVIDER_UNAVAILABLE).toMatch(/réessaie/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G. LES DEUX CHEMINS DE SOURCING — AUDIT DE CLÔTURE
//
// J'avais annoncé ces deux fonctions comme « avalant encore leurs pannes ».
// C'était FAUX, et la vérification au code l'a montré :
//
//   • `fetchCompanies()` lève déjà `ProviderError` sur `!res.ok` (antérieur à ce
//     lot), et n'enveloppe rien dans un try/catch : réseau et JSON invalide
//     REMONTENT au lieu d'être convertis en liste vide ;
//   • `debugSearch()` est purement diagnostique — la route ne renvoie que
//     `status`, jamais `body` ni `url`.
//
// Aucun code n'est modifié ici. Ces tests VERROUILLENT la propriété, qui
// n'était établie par aucun test : la couverture SEC-LOG-01 existante prouve
// l'absence de FUITE, pas l'absence de FAUX VIDE.
// ─────────────────────────────────────────────────────────────────────────────
describe('G. fetchCompanies — une panne ne devient jamais une liste vide', () => {
  const CRITERES = { sector: 'Technology', location: 'Paris', size: '11-20', page: 1, activeOnly: true }

  it('HTTP 500 ⇒ rejette, ne rend PAS results:[]', async () => {
    statut(500)
    const e: any = await fetchCompanies(CRITERES as any).catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.safe.code).toBe('provider_http')
    expect(e.safe.status).toBe(500)
  })

  it('HTTP 429 ⇒ rejette, marqué réessayable', async () => {
    statut(429)
    const e: any = await fetchCompanies(CRITERES as any).catch((x) => x)
    expect(e.safe.status).toBe(429)
    expect(e.safe.retryable).toBe(true)
  })

  it('rejet réseau ⇒ remonte, ne rend PAS results:[]', async () => {
    reseauKo()
    const r = await fetchCompanies(CRITERES as any).then(() => 'RENDU', () => 'LEVE')
    expect(r).toBe('LEVE')
  })

  it('JSON invalide ⇒ remonte, ne rend PAS results:[]', async () => {
    corpsIllisible()
    const r = await fetchCompanies(CRITERES as any).then(() => 'RENDU', () => 'LEVE')
    expect(r).toBe('LEVE')
  })

  it('réponse VALIDE et vide ⇒ results:[] légitime, sans exception', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [], total_results: 0, page: 1, total_pages: 0 }) } as any)
    const d = await fetchCompanies(CRITERES as any)
    expect(d.results).toEqual([])
    expect(d.total).toBe(0)
  })

  // ⚠️ LE POINT QUI COMPTE POUR L'UTILISATEUR. Jarvis répond « Aucune entreprise
  // trouvée pour ces critères » quand `r.results` est vide. Si une panne rendait
  // une liste vide, ce message s'afficherait sur une indisponibilité — le défaut
  // exact que ce lot ferme, transposé au sourcing.
  it('une panne n\'atteint JAMAIS la branche « aucune entreprise trouvée »', async () => {
    for (const panne of [() => statut(500), () => statut(429), () => reseauKo(), () => corpsIllisible()]) {
      panne()
      const atteint = await fetchCompanies(CRITERES as any).then(
        (d) => d.results.length === 0,   // aurait déclenché le message
        () => false,                      // la panne remonte : message jamais atteint
      )
      expect(atteint).toBe(false)
    }
  })
})

describe('G bis. debugSearch — exception diagnostique SÛRE, et prouvée telle', () => {
  it('la route ne renvoie que le statut : ni body fournisseur, ni URL', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => '<html>ERREUR INTERNE FOURNISSEUR</html>' } as any)
    const { default: search } = await import('../pages/api/sourcing/search')
    const envoye: any[] = []
    const res: any = { status(c: number) { res._c = c; return res }, json(b: any) { envoye.push(b); return res }, setHeader() { return res } }

    await search({ method: 'GET', query: { debug: '1', sector: 'Technology' } } as any, res)

    const body = envoye[0]
    expect(body).toEqual({ status: 503 })
    const brut = JSON.stringify(body)
    expect(brut).not.toContain('ERREUR INTERNE FOURNISSEUR')
    expect(brut).not.toContain('recherche-entreprises')
    expect(brut).not.toContain('http')
  })

  it('elle n\'alimente AUCUNE décision métier ni écriture — prouvé sur le code', async () => {
    const { readFileSync } = await import('node:fs')
    const nu = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // Un seul consommateur dans tout le dépôt : la branche `debug` de la route.
    const route = nu('pages/api/sourcing/search.ts')
    expect(route).toContain('debugSearch')
    // Ce que la branche debug renvoie est clos au seul statut.
    expect(route).toMatch(/json\(\{\s*status:\s*d\.status\s*\}\)/)
    // Aucune persistance, aucune résolution d'entité dans cette route.
    for (const interdit of ['upsertLead', 'persistLead', 'upsertItem', 'lookupByName', 'reconcileByName']) {
      expect(route, interdit).not.toContain(interdit)
    }
  })

  it('une panne du mode debug ne dit pas « introuvable »', async () => {
    reseauKo()
    const { default: search } = await import('../pages/api/sourcing/search')
    const envoye: any[] = []
    const res: any = { status() { return res }, json(b: any) { envoye.push(b); return res }, setHeader() { return res } }

    await search({ method: 'GET', query: { debug: '1' } } as any, res)

    const texte = JSON.stringify(envoye[0])
    for (const mot of [/introuvable/i, /aucune entreprise/i, /not.?found/i]) {
      expect(texte, String(mot)).not.toMatch(mot)
    }
  })

  it('le chemin NORMAL de /sourcing/search ne dit pas « introuvable » sur panne', async () => {
    statut(500)
    const { default: search } = await import('../pages/api/sourcing/search')
    const envoye: any[] = []
    const res: any = { status(c: number) { res._c = c; return res }, json(b: any) { envoye.push({ code: res._c, body: b }); return res }, setHeader() { return res } }

    await search({ method: 'GET', query: { sector: 'Technology' } } as any, res)

    // 502 : la dépendance a échoué. Ce n'est pas un 200 avec zéro résultat.
    expect(envoye[0].code).toBe(502)
    const texte = JSON.stringify(envoye[0].body)
    for (const mot of [/introuvable/i, /aucune entreprise/i]) {
      expect(texte, String(mot)).not.toMatch(mot)
    }
    expect(texte).toContain('indisponible')
  })
})
