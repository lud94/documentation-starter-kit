// ENTITY-RESOLUTION-001 (complément) — L'AMBIGUÏTÉ NE CRÉE RIEN, ET NE MENT PAS.
//
// ── LES TROIS FAUTES FERMÉES ────────────────────────────────────────────────
// Une résolution ambiguë ne doit jamais :
//   1. créer silencieusement un compte ;
//   2. entrer silencieusement dans le pipeline ;
//   3. être présentée comme « entreprise introuvable ».
//
// La troisième est la plus insidieuse : elle dit le CONTRAIRE de la vérité. Il
// n'y a pas zéro société, il y en a trop — et le remède n'est pas le même. Un
// utilisateur à qui l'on annonce « introuvable » va corriger l'orthographe ;
// celui à qui l'on annonce « plusieurs » va donner un SIREN.
//
// ⚠️ `importSignalToPipeline` écrit dans un magasin mémoire de module. Les
// assertions portent donc autant sur ce qui N'A PAS été écrit que sur la
// valeur rendue.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import {
  addLead,
  ambiguityLabel,
  getLead,
  getLeads,
  importSignalToPipeline,
  getImportedSirens,
  invalidateLeads,
  verifyLeadCompany,
} from '../lib/prospector/capabilities'
import type { SignalHit } from '../types/prospector'

const hit = (p: Partial<SignalHit> = {}): SignalHit =>
  ({
    company: 'OVHcloud',
    signalType: 'levee',
    detail: 'levée de 12M€',
    icebreaker: 'Félicitations pour la levée',
    city: 'Roubaix',
    ...p,
  }) as SignalHit

const CANDIDATES = [
  { siren: '111111111', name: 'OVHCLOUD OCT1', city: 'Roubaix' },
  { siren: '222222222', name: 'OVHCLOUD', city: 'Roubaix' },
  { siren: '333333333', name: 'OVHCLOUD SUPPORT', city: 'Lille' },
]

/** Programme la réponse de `/api/company/verify`, et mémorise les URL vues. */
const urls: string[] = []
const appels: Array<{ url: string; method: string }> = []
function repond(par: (url: string) => any) {
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    urls.push(String(url))
    appels.push({ url: String(url), method: String(init?.method || 'GET').toUpperCase() })
    return { ok: true, json: async () => par(String(url)) } as any
  })
}
/** Les appels qui ÉCRIVENT (persistLead / persistLeads). */
const ecritures = () => appels.filter((a) => a.method === 'POST' && a.url.includes('/api/leads'))

beforeEach(() => {
  vi.clearAllMocks()
  urls.length = 0
  appels.length = 0
  invalidateLeads()
})

describe('A. Import unitaire — résolution AMBIGUË ⇒ rien n\'est écrit', () => {
  it('rend added:0 et ambiguous:true, avec les candidates', async () => {
    repond(() => ({ found: false, ambiguous: true, candidates: CANDIDATES }))

    const r = await importSignalToPipeline(hit({ company: 'OVHcloud SAS' }))

    expect(r.added).toBe(0)
    expect(r.ambiguous).toBe(true)
    expect(r.company).toBe('OVHcloud SAS')
    expect(r.candidates).toHaveLength(3)
    // Aucun identifiant de lead n'a été tiré : le retour avant `newLeadId()`.
    expect(r.id).toBeUndefined()
  })

  it('AUCUN lead n\'est créé — ni en mémoire, ni persisté', async () => {
    repond(() => ({ found: false, ambiguous: true, candidates: CANDIDATES }))

    await importSignalToPipeline(hit({ company: 'OVHcloud SAS' }))

    // ⚠️ AUCUNE ÉCRITURE : `persistLead` émettrait un POST vers /api/leads.
    // On vise la MÉTHODE, pas l'URL — `getLeads()` lit la même route en GET.
    expect(ecritures()).toEqual([])

    // Et rien n'est apparu dans le magasin mémoire.
    const leads = await getLeads()
    expect(leads.filter((l) => (l.company || '').includes('OVH'))).toEqual([])
  })

  it('AUCUN placeholder n\'est enregistré — un second essai reste possible', async () => {
    repond(() => ({ found: false, ambiguous: true, candidates: CANDIDATES }))

    await importSignalToPipeline(hit({ company: 'OVHcloud SAS' }))
    expect(await getImportedSirens()).not.toContain('sig-OVHcloud SAS')

    // ⚠️ Le second appel doit RE-RÉSOUDRE, et non rendre un placeholder mémorisé.
    // Un placeholder posé sur une ambiguïté figerait l'erreur définitivement.
    const r2 = await importSignalToPipeline(hit({ company: 'OVHcloud SAS' }))
    expect(r2.ambiguous).toBe(true)
    expect(r2.id).toBeUndefined()
  })

  it('AMBIGUOUS n\'est pas NOT_FOUND : un non-trouvé importe toujours', async () => {
    repond(() => ({ found: false }))

    const r = await importSignalToPipeline(hit({ company: 'Societe Inconnue XYZ' }))

    // Comportement actuel conservé : import sans métadonnées data.gouv.
    expect(r.added).toBe(1)
    expect(r.ambiguous).toBeUndefined()
    expect(r.verified).toBe(false)
  })
})

describe('B. hit.siren présent ⇒ résolution par IDENTIFIANT, pas par nom', () => {
  it('interroge ?siren= et JAMAIS ?name=', async () => {
    repond(() => ({ found: true, siren: '555555555', name: 'ACME SA', city: 'Paris', naf: '62.01Z' }))

    await importSignalToPipeline(hit({ company: 'Acme', siren: '555555555' }))

    const verif = urls.filter((u) => u.includes('/api/company/verify'))
    expect(verif).toHaveLength(1)
    expect(verif[0]).toContain('siren=555555555')
    expect(verif[0]).not.toContain('name=')
  })

  // ⚠️ Un SIREN désigne UNE entité. Résoudre par nom alors qu'on tient déjà un
  // identifiant remplacerait une certitude par un classement de pertinence.
  it('l\'identité vérifiée est déterministe', async () => {
    // ⚠️ SIREN distinct du cas précédent : `importedPlaceholders` est un état
    // de MODULE, et la déduplication par SIREN — qui est le comportement
    // ATTENDU — rendrait `added: 0` sur un identifiant déjà importé.
    repond(() => ({ found: true, siren: '556666666', name: 'ACME BIS SA', city: 'Paris' }))

    const r = await importSignalToPipeline(hit({ company: 'AcmeBis', siren: '556666666' }))

    expect(r.added).toBe(1)
    expect(r.verified).toBe(true)
    expect(r.siren).toBe('556666666')
  })

  it('un SIREN non vérifiable n\'invente aucune résolution par nom', async () => {
    repond(() => ({ found: false }))

    const r = await importSignalToPipeline(hit({ company: 'AcmeNonVerif', siren: '999999999' }))

    const verif = urls.filter((u) => u.includes('/api/company/verify'))
    expect(verif.every((u) => !u.includes('name='))).toBe(true)
    // NOT_FOUND : le compte s'importe, mais SANS identité canonique.
    expect(r.added).toBe(1)
    expect(r.verified).toBe(false)
    expect(r.siren).toBeUndefined()
  })
})

describe('C. Import en lot — l\'ambiguïté est SAUTÉE, pas importée', () => {
  it('les entreprises non ambiguës du lot passent quand même', async () => {
    // Chaque entreprise claire résout vers un SIREN DISTINCT : deux sociétés
    // partageant un SIREN seraient légitimement dédoublonnées, ce qui masquerait
    // ce que ce test veut prouver.
    repond((url) =>
      url.includes('Ambigue')
        ? { found: false, ambiguous: true, candidates: CANDIDATES }
        : url.includes('Claire2')
          ? { found: true, siren: '444444442', name: 'CLAIRE DEUX SA', city: 'Nantes' }
          : { found: true, siren: '444444441', name: 'CLAIRE SA', city: 'Nantes' },
    )

    const lot = [hit({ company: 'Claire' }), hit({ company: 'Ambigue' }), hit({ company: 'Claire2' })]
    const resultats = []
    for (const h of lot) resultats.push(await importSignalToPipeline(h))

    // L'ambiguë ne compte pas comme succès et n'a pas d'identifiant à lister.
    const ambigues = resultats.filter((r) => r.ambiguous)
    const importees = resultats.filter((r) => !r.ambiguous && r.id)

    expect(ambigues).toHaveLength(1)
    expect(importees).toHaveLength(2)
    expect(ambigues[0].id).toBeUndefined()
    // Une ambiguïté au milieu du lot n'interrompt rien.
    expect(resultats[2].added).toBe(1)
  })
})

describe('D. ambiguityLabel — ne dit jamais « introuvable »', () => {
  const texte = ambiguityLabel('OVHcloud', CANDIDATES)

  it('nomme le vrai problème : il y en a plusieurs', () => {
    expect(texte).toContain('correspond à plusieurs entreprises')
    expect(texte).not.toContain('introuvable')
    expect(texte).not.toContain('Introuvable')
  })

  it('dit explicitement ce qui n\'a PAS été écrit', () => {
    expect(texte).toContain("Aucun compte n'a été créé")
    expect(ambiguityLabel('X', CANDIDATES, "Aucun champ n'a été modifié.")).toContain(
      "Aucun champ n'a été modifié",
    )
  })

  it('présente nom, SIREN et ville', () => {
    expect(texte).toContain('OVHCLOUD OCT1')
    expect(texte).toContain('SIREN 111111111')
    expect(texte).toContain('Roubaix')
  })

  it('borne à cinq candidates et annonce le reste', () => {
    const beaucoup = Array.from({ length: 9 }, (_, i) => ({
      siren: `10000000${i}`, name: `ACME ${i}`, city: 'Paris',
    }))
    const t = ambiguityLabel('ACME', beaucoup)
    expect(t).toContain('et 4 autre(s)')
    expect(t).toContain('ACME 4')
    expect(t).not.toContain('ACME 5')
  })

  it('propose la sortie : préciser la société ou donner le SIREN', () => {
    expect(texte).toContain('SIREN')
    expect(texte.toLowerCase()).toContain('sélectionne')
  })

  it('sans candidates, le message reste correct et non trompeur', () => {
    const t = ambiguityLabel('X', [])
    expect(t).toContain('plusieurs entreprises')
    expect(t).not.toContain('introuvable')
  })
})

describe('E. verifyLeadCompany — ambiguïté ⇒ AUCUN champ du lead touché', () => {
  it('propage ambiguous + candidates sans rien écrire', async () => {
    repond(() => ({ found: true }))
    const lead = await addLead({ firstName: 'Alice', lastName: 'Martin', company: 'OVHcloud SAS' })

    // Photographie de la fiche AVANT vérification.
    const avant = JSON.parse(JSON.stringify(getLead(lead.id)))

    repond(() => ({ found: false, ambiguous: true, candidates: CANDIDATES }))
    appels.length = 0
    const r = await verifyLeadCompany(lead.id)

    expect(r?.found).toBe(false)
    expect(r?.ambiguous).toBe(true)
    expect(r?.candidates).toHaveLength(3)

    // ⚠️ AUCUN champ modifié. Écrire le SIREN d'une société choisie au hasard
    // serait pire que ne rien écrire : la fiche paraîtrait vérifiée.
    expect(getLead(lead.id)).toEqual(avant)
    expect(getLead(lead.id)?.siren).toBeUndefined()
    expect(ecritures()).toEqual([])
  })

  it('sans ambiguïté, la vérification écrit bien — le garde n\'a pas tout bloqué', async () => {
    repond(() => ({ found: true }))
    const lead = await addLead({ firstName: 'Bruno', lastName: 'Bernard', company: 'Claire Unique SA' })

    repond(() => ({ found: true, siren: '777777777', name: 'CLAIRE UNIQUE SA', city: 'Nantes', active: true }))
    const r = await verifyLeadCompany(lead.id)

    expect(r?.found).toBe(true)
    expect(r?.ambiguous).toBeUndefined()
    expect(getLead(lead.id)?.siren).toBe('777777777')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. SIREN CANDIDAT ≠ SIREN CANONIQUE
//
// `hit.siren` provient d'un signal produit par un LLM. C'est une PROPOSITION,
// pas une identité. Deux fautes coexistaient :
//
//   1. `const siren = dg?.siren || hit.siren` recopiait le SIREN du signal
//      quand data.gouv ne le confirmait PAS. Un échec de vérification se muait
//      en validation implicite, et le lead portait un SIREN non vérifié
//      indiscernable d'un SIREN officiel — avec le tampon « vérifié ».
//
//   2. `const key = hit.siren || \`sig-${hit.company}\`` en faisait la clé
//      canonique de déduplication AVANT vérification. Un SIREN halluciné
//      devenait l'identité d'un compte, et bloquait ensuite l'import de la
//      VRAIE entreprise portant ce SIREN.
//
// Seul data.gouv fait autorité. Non confirmé ⇒ aucun SIREN, aucune clé.
// ─────────────────────────────────────────────────────────────────────────────
describe('F. Un SIREN de signal non vérifié n\'est jamais canonique', () => {
  it('A. data.gouv found:false ⇒ import sans SIREN, et aucune clé canonique', async () => {
    repond(() => ({ found: false }))
    const CANDIDAT = '911111111'

    const r = await importSignalToPipeline(hit({ company: 'FauxSirenA', siren: CANDIDAT }))

    // L'import reste autorisé (comportement NOT_FOUND inchangé pour ce lot)…
    expect(r.added).toBe(1)
    expect(r.verified).toBe(false)
    // …mais SANS identité canonique.
    expect(r.siren).toBeUndefined()
    expect(getLead(r.id!)?.siren).toBeUndefined()

    // ⚠️ Aucune clé `importedPlaceholders[hit.siren]`. Sans quoi la vraie
    // entreprise portant ce SIREN deviendrait impossible à importer.
    expect(await getImportedSirens()).not.toContain(CANDIDAT)
  })

  it('le SIREN candidat n\'est jamais recopié dans un champ du lead', async () => {
    repond(() => ({ found: false }))
    const CANDIDAT = '911111112'

    const r = await importSignalToPipeline(hit({ company: 'FauxSirenBis', siren: CANDIDAT }))

    // Balayage complet : la valeur ne doit apparaître NULLE PART sur la fiche.
    expect(JSON.stringify(getLead(r.id!))).not.toContain(CANDIDAT)
  })

  // ⚠️ CONTRAT RENFORCÉ PAR OBS-DATAGOUV-001. Ce test acceptait l'import du
  // compte lors d'une panne, à condition qu'aucun SIREN ne soit écrit. C'était
  // encore trop permissif : créer un compte inerte sur la foi d'une
  // indisponibilité pose un placeholder qui empêche ensuite tout réessai.
  // Une panne ne produit désormais AUCUNE écriture du tout.
  it('B. vérification en ÉCHEC ⇒ AUCUN import, aucun SIREN, aucune clé', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      appels.push({ url: String(url), method: String(init?.method || 'GET').toUpperCase() })
      if (String(url).includes('/api/company/verify')) throw new Error('ECONNRESET')
      return { ok: true, json: async () => ({}) } as any
    })
    const CANDIDAT = '922222222'

    const r = await importSignalToPipeline(hit({ company: 'PanneReseau', siren: CANDIDAT }))

    expect(r.added).toBe(0)
    expect(r.resolution).toBe('provider_error')
    expect(r.id).toBeUndefined()
    expect(r.siren).toBeUndefined()
    expect(ecritures()).toEqual([])
    expect(await getImportedSirens()).not.toContain(CANDIDAT)
  })

  it('une réponse illisible ne vaut pas davantage confirmation', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      appels.push({ url: String(url), method: String(init?.method || 'GET').toUpperCase() })
      return { ok: true, json: async () => { throw new Error('JSON invalide') } } as any
    })
    const CANDIDAT = '922222223'

    const r = await importSignalToPipeline(hit({ company: 'ReponseIllisible', siren: CANDIDAT }))

    expect(r.added).toBe(0)
    expect(r.resolution).toBe('provider_error')
    expect(r.siren).toBeUndefined()
    expect(await getImportedSirens()).not.toContain(CANDIDAT)
  })

  it('C. data.gouv found:true ⇒ le SIREN VÉRIFIÉ devient canonique', async () => {
    const VERIFIE = '933333333'
    repond(() => ({ found: true, siren: VERIFIE, name: 'VRAIE SA', city: 'Lyon', naf: '62.01Z' }))

    const r = await importSignalToPipeline(hit({ company: 'VraieBoite', siren: VERIFIE }))

    expect(r.added).toBe(1)
    expect(r.verified).toBe(true)
    expect(r.siren).toBe(VERIFIE)
    expect(getLead(r.id!)?.siren).toBe(VERIFIE)
    // La clé canonique est bien posée, sur le SIREN validé.
    expect(await getImportedSirens()).toContain(VERIFIE)
  })

  it('le SIREN canonique est celui de data.gouv, pas celui du signal', async () => {
    // data.gouv peut normaliser/corriger : c'est SA valeur qui fait foi.
    const PROPOSE = '944444440'
    const RENVOYE = '944444449'
    repond(() => ({ found: true, siren: RENVOYE, name: 'CORRIGEE SA', city: 'Lille' }))

    const r = await importSignalToPipeline(hit({ company: 'Corrigee', siren: PROPOSE }))

    expect(r.siren).toBe(RENVOYE)
    expect(getLead(r.id!)?.siren).toBe(RENVOYE)
    expect(await getImportedSirens()).toContain(RENVOYE)
    expect(await getImportedSirens()).not.toContain(PROPOSE)
  })

  it('D. un second import de la même entreprise est dédoublonné par le SIREN VALIDÉ', async () => {
    const VERIFIE = '955555555'
    repond(() => ({ found: true, siren: VERIFIE, name: 'DEDOUBLON SA', city: 'Nice' }))

    const premier = await importSignalToPipeline(hit({ company: 'Dedoublon', siren: VERIFIE }))
    expect(premier.added).toBe(1)

    // Même entreprise, libellé DIFFÉRENT : seul le SIREN validé peut les relier.
    const second = await importSignalToPipeline(hit({ company: 'Dedoublon SAS', siren: VERIFIE }))

    expect(second.added).toBe(0)
    expect(second.id).toBe(premier.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G. OBS-DATAGOUV-001 — AUCUN APPELANT NE PERSISTE SUR `provider_error`
//
// Une panne data.gouv ne doit déclencher AUCUNE écriture, AUCUN enrichissement,
// AUCUN repli identitaire et AUCUN message « introuvable ». Importer « sans
// métadonnées » créerait un compte inerte sur la foi d'une indisponibilité, et
// poserait un placeholder qui empêcherait ensuite tout réessai.
// ─────────────────────────────────────────────────────────────────────────────
describe('G. provider_error ⇒ aucune écriture, nulle part', () => {
  it('9a. import de signal : rien n\'est créé, rien n\'est réservé', async () => {
    repond(() => ({ found: false, resolution: 'provider_error', error: 'Opération indisponible pour le moment.' }))

    const r = await importSignalToPipeline(hit({ company: 'PanneDataGouv' }))

    expect(r.added).toBe(0)
    expect(r.resolution).toBe('provider_error')
    expect(r.id).toBeUndefined()
    expect(ecritures()).toEqual([])
    expect(await getImportedSirens()).not.toContain('sig-PanneDataGouv')
  })

  it('un second essai reste possible : aucun placeholder n\'a figé la panne', async () => {
    repond(() => ({ found: false, resolution: 'provider_error' }))
    await importSignalToPipeline(hit({ company: 'PanneRetentee' }))

    // La panne cesse : l'import doit désormais aboutir.
    repond(() => ({ found: true, siren: '966666666', name: 'RETENTEE SA', city: 'Lyon' }))
    const r2 = await importSignalToPipeline(hit({ company: 'PanneRetentee' }))

    expect(r2.added).toBe(1)
    expect(r2.siren).toBe('966666666')
  })

  it('9b. verifyLeadCompany : aucun champ du lead n\'est touché', async () => {
    repond(() => ({ found: true }))
    const lead = await addLead({ firstName: 'Carla', lastName: 'Dubois', company: 'PanneFiche SA' })
    const avant = JSON.parse(JSON.stringify(getLead(lead.id)))

    repond(() => ({ found: false, resolution: 'provider_error' }))
    appels.length = 0
    const r = await verifyLeadCompany(lead.id)

    expect(r?.found).toBe(false)
    expect(r?.resolution).toBe('provider_error')
    expect(r?.ambiguous).toBeUndefined()
    expect(getLead(lead.id)).toEqual(avant)
    expect(ecritures()).toEqual([])
  })

  it('la route injoignable est traitée comme une panne, pas comme une absence', async () => {
    repond(() => ({ found: true }))
    const lead = await addLead({ firstName: 'Denis', lastName: 'Roux', company: 'RouteKO SA' })
    const avant = JSON.parse(JSON.stringify(getLead(lead.id)))

    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const r = await verifyLeadCompany(lead.id)

    expect(r?.resolution).toBe('provider_error')
    expect(getLead(lead.id)).toEqual(avant)
  })

  it('9c. le libellé rendu à l\'utilisateur ne dit jamais « introuvable »', async () => {
    const { PROVIDER_UNAVAILABLE } = await import('../lib/prospector/capabilities')
    expect(PROVIDER_UNAVAILABLE).not.toMatch(/introuvable/i)
    expect(PROVIDER_UNAVAILABLE).toMatch(/indisponible/i)
  })
})
