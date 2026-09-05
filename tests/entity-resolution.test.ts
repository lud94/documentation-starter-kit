// ENTITY-RESOLUTION-001 (P0) — NE JAMAIS PRENDRE `results[0]` POUR LA VÉRITÉ.
//
// ── LE DÉFAUT ───────────────────────────────────────────────────────────────
// `lookupByName()` interrogeait data.gouv avec `per_page=1` et retenait le
// premier résultat. Or l'API rend un CLASSEMENT DE PERTINENCE, pas une réponse
// unique : « OVHcloud » remonte plusieurs sociétés, et la première était
// `OVHCLOUD OCT1`. Le SIREN, le NAF, le dirigeant et l'effectif d'une entité
// sans rapport étaient alors écrits sur le lead — silencieusement, et avec
// l'autorité d'une « vérification data.gouv ».
//
// Une donnée fausse portant un tampon officiel est pire qu'une donnée absente :
// elle contamine l'ingestion, les fiches, les listes, et tout ce qui s'appuiera
// plus tard sur ce SIREN.
//
// ── CE QUI EST VÉRIFIÉ ──────────────────────────────────────────────────────
// Que plus AUCUN chemin d'écriture ne retient une candidate arbitraire, et que
// l'ambiguïté remonte jusqu'à l'utilisateur au lieu d'être tranchée sans lui.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

vi.mock('../lib/supabase/client', () => ({ supabase: () => null, supabaseConfigured: () => false }))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

const upsertLeadChecked = vi.fn(async () => ({ ok: true }))
const listLeads = vi.fn(async () => [] as any[])
vi.mock('../lib/supabase/leads', () => ({
  upsertLeadChecked: (...a: any[]) => upsertLeadChecked(...(a as [])),
  listLeads: (...a: any[]) => listLeads(...(a as [])),
  listLeadsStrict: async () => ({ ok: true, leads: [] }),
  deleteLead: async () => true,
}))

const upsertItem = vi.fn(async () => true)
const listItems = vi.fn(async () => [] as any[])
vi.mock('../lib/supabase/store', () => ({
  upsertItem: (...a: any[]) => upsertItem(...(a as [])),
  listItems: (...a: any[]) => listItems(...(a as [])),
}))

const enrichCompanyWeb = vi.fn(async () => ({ summary: 'NE DOIT PAS ÊTRE APPELÉ' }))
vi.mock('../lib/prospector/identify', () => ({
  enrichCompanyWeb: (...a: any[]) => enrichCompanyWeb(...(a as [])),
  identifyLead: async () => ({ kind: 'account', company: 'X' }),
}))

import { lookupByName } from '../lib/prospector/datagouv'
import { ProviderError } from '../lib/observability/safeError'
import { executeJarvis } from '../lib/prospector/jarvisAgent'

const TENANT = { id: 'ws_alpha', kind: 'client' as const }
const WS = 'ws_alpha'

/** Réponse data.gouv brute, avec le classement de pertinence tel quel. */
function repond(results: any[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ results }),
  } as any)
}

const societe = (siren: string, nom: string, ville = 'Roubaix') => ({
  siren,
  nom_complet: nom,
  etat_administratif: 'A',
  siege: { libelle_commune: ville },
  activite_principale: '62.01Z',
  dirigeants: [{ prenoms: 'Jean', nom: 'Dupont' }],
})

// Le cas réel rapporté : `OVHCLOUD OCT1` arrive EN PREMIER.
const OVH = [
  societe('111111111', 'OVHCLOUD OCT1'),
  societe('222222222', 'OVHCLOUD'),
  societe('333333333', 'OVHCLOUD SUPPORT'),
]

beforeEach(() => {
  vi.clearAllMocks()
  upsertLeadChecked.mockResolvedValue({ ok: true } as any)
  listLeads.mockResolvedValue([])
  listItems.mockResolvedValue([])
  enrichCompanyWeb.mockResolvedValue({ summary: 'NE DOIT PAS ÊTRE APPELÉ' } as any)
})

describe('A. lookupByName ne choisit plus arbitrairement', () => {
  it('plusieurs candidates, aucun nom strict ⇒ AUCUNE n\'est retenue', async () => {
    // « OVHcloud SAS » ne correspond exactement à aucune des trois.
    repond(OVH)
    const v = await lookupByName('OVHcloud SAS')

    expect(v.found).toBe(false)
    expect(v.ambiguous).toBe(true)
    expect(v.candidates).toHaveLength(3)

    // ⚠️ L'ASSERTION CENTRALE : rien de `candidates[0]` n'a fuité dans le
    // résultat. C'est exactement ce que faisait l'ancienne implémentation.
    expect(v.siren).toBeUndefined()
    expect(v.name).toBeUndefined()
    expect(v.naf).toBeUndefined()
    expect(v.dirigeant).toBeUndefined()
    expect(v.effectif).toBeUndefined()
    expect(v.siren).not.toBe('111111111')
  })

  it('UN SEUL nom strict après normalisation ⇒ c\'est LUI, pas le premier', async () => {
    repond(OVH)
    const v = await lookupByName('OVHcloud')

    expect(v.found).toBe(true)
    expect(v.ambiguous).toBeUndefined()
    // 222222222 = « OVHCLOUD ». 111111111 = « OVHCLOUD OCT1 », arrivé premier.
    expect(v.siren).toBe('222222222')
    expect(v.siren).not.toBe('111111111')
  })

  it('la normalisation couvre accents, casse et ponctuation — rien de plus', async () => {
    repond([societe('900000001', 'Éditions Léa & Fils'), societe('900000002', 'EDITIONS LEA FILS 2')])
    const v = await lookupByName('editions lea fils')
    expect(v.found).toBe(true)
    expect(v.siren).toBe('900000001')
  })

  it('AUCUN rapprochement approximatif : un préfixe ne résout pas', async () => {
    repond([societe('800000001', 'ACME FRANCE'), societe('800000002', 'ACME EUROPE')])
    const v = await lookupByName('ACME')
    expect(v.found).toBe(false)
    expect(v.ambiguous).toBe(true)
  })

  it('plusieurs entités portant EXACTEMENT le même nom restent ambiguës', async () => {
    repond([societe('700000001', 'DUPONT', 'Lyon'), societe('700000002', 'DUPONT', 'Lille')])
    const v = await lookupByName('Dupont')
    expect(v.found).toBe(false)
    expect(v.ambiguous).toBe(true)
    expect(v.candidates).toHaveLength(2)
  })

  it('0 candidat ⇒ found:false, sans ambiguïté', async () => {
    repond([])
    const v = await lookupByName('SocieteInexistanteXYZ')
    expect(v.found).toBe(false)
    expect(v.ambiguous).toBeUndefined()
  })

  // ⚠️ CONTRAT CORRIGÉ PAR R1e·P0-1 — CE TEST CANONISAIT LE DÉFAUT.
  //
  // Il s'intitulait « 1 candidat ⇒ found:true, MÊME SI LE NOM DIFFÈRE » et
  // exigeait donc exactement ce que ce fichier existe pour interdire : retenir
  // une candidate sans égalité de raison sociale. La garde s'appliquait quand
  // le classement contenait plusieurs sociétés, et sautait quand il n'en
  // contenait qu'une — alors que le cardinal d'un classement de PERTINENCE ne
  // prouve rien du tout.
  //
  // Le défaut devient P0 depuis que ce SIREN sert d'identité de COMPTE à un
  // fait du Decision Kernel : une donnée vraie sur la mauvaise entité est une
  // information fausse, et elle porterait le tampon « vérifié data.gouv ».
  it('1 candidat APPROCHANT ⇒ jamais résolu, l’ambiguïté remonte', async () => {
    repond([societe('600000001', 'MA BOITE SARL')])
    const v = await lookupByName('Ma Boite')
    expect(v.found).toBe(false)
    expect(v.resolution).not.toBe('resolved')
    expect(v.siren).toBeUndefined()
  })

  it('1 candidat EXACT ⇒ résolu — la garde n’est pas un mur', async () => {
    repond([societe('600000001', 'MA BOITE SARL')])
    const v = await lookupByName('Ma Boite SARL')
    expect(v.found).toBe(true)
    expect(v.siren).toBe('600000001')
  })

  // ⚠️ CONTRAT MODIFIÉ PAR OBS-DATAGOUV-001. Ce test exigeait `{found:false}`
  // sur panne réseau — c'était précisément le défaut : une indisponibilité
  // rendue indiscernable d'un « aucune entreprise de ce nom ». La panne LÈVE
  // désormais une `ProviderError`, que l'appelant classe en `provider_error`.
  it('une panne réseau LÈVE, et ne se déguise plus en « introuvable »', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET secret interne'))

    await expect(lookupByName('OVHcloud')).rejects.toThrow(ProviderError)

    // SEC-LOG-01 : rien du fournisseur ne transite vers l'appelant.
    const capture = await lookupByName('OVHcloud').catch((e: any) => e)
    expect(JSON.stringify(capture.safe)).not.toContain('ECONNRESET')
    expect(capture.message).not.toContain('ECONNRESET')
    expect(capture.safe.code).toBe('provider_network')
    expect(capture.safe.provider).toBe('datagouv')
  })
})

describe('B. Jarvis add_company — ambiguïté ⇒ AUCUNE écriture', () => {
  it('upsertLeadChecked n\'est JAMAIS appelé', async () => {
    repond(OVH)
    const out = await executeJarvis(TENANT, { type: 'add_company', company: 'OVHcloud SAS' }, WS)

    expect(upsertLeadChecked).not.toHaveBeenCalled()
    expect(out).toContain("Aucun compte n'a été créé")
  })

  it('les candidates sont présentées : nom, SIREN, ville', async () => {
    repond(OVH)
    const out = await executeJarvis(TENANT, { type: 'add_company', company: 'OVHcloud SAS' }, WS)

    expect(out).toContain('OVHCLOUD OCT1')
    expect(out).toContain('SIREN 111111111')
    expect(out).toContain('Roubaix')
    expect(out).toContain('SIREN 222222222')
  })

  it('au plus CINQ candidates, le reste est annoncé', async () => {
    repond(Array.from({ length: 8 }, (_, i) => societe(`10000000${i}`, `ACME ${i}`)))
    const out = await executeJarvis(TENANT, { type: 'add_company', company: 'ACME' }, WS)

    expect(out.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(5)
    expect(out).toContain('et 3 autre(s)')
    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })

  it('sans ambiguïté, la création a bien lieu — le garde n\'a pas tout bloqué', async () => {
    repond([societe('222222222', 'OVHCLOUD')])
    const out = await executeJarvis(TENANT, { type: 'add_company', company: 'OVHcloud' }, WS)

    expect(upsertLeadChecked).toHaveBeenCalledTimes(1)
    expect((upsertLeadChecked.mock.calls[0] as any[])[0].siren).toBe('222222222')
    expect(out).not.toContain("Aucun compte n'a été créé")
  })
})

describe('C. Jarvis add_to_list — ambiguïté ⇒ ni compte, ni liste', () => {
  it('aucun compte créé ET aucune liste modifiée', async () => {
    repond(OVH)
    const out = await executeJarvis(
      TENANT,
      { type: 'add_to_list', company: 'OVHcloud SAS', listName: 'Cibles' },
      WS,
    )

    expect(upsertLeadChecked).not.toHaveBeenCalled()
    expect(upsertItem).not.toHaveBeenCalled()
    expect(out).toContain("Aucun compte n'a été créé")
    expect(out).toContain("la liste n'a pas été modifiée")
  })

  it('un lead DÉJÀ présent n\'est pas concerné : aucune résolution n\'a lieu', async () => {
    listLeads.mockResolvedValue([
      { id: 'ac_1', kind: 'account', firstName: '', lastName: '', company: 'OVHcloud SAS' },
    ] as any)
    repond(OVH)

    await executeJarvis(TENANT, { type: 'add_to_list', company: 'OVHcloud SAS', listName: 'Cibles' }, WS)

    // La liste est bien mise à jour, sans création de compte.
    expect(upsertItem).toHaveBeenCalledTimes(1)
    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })
})

describe('D. Jarvis explain_company — ambiguïté ⇒ aucun enrichissement web', () => {
  it('enrichCompanyWeb n\'est JAMAIS appelé', async () => {
    repond(OVH)
    const out = await executeJarvis(TENANT, { type: 'explain_company', company: 'OVHcloud SAS' }, WS)

    expect(enrichCompanyWeb).not.toHaveBeenCalled()
    expect(out).not.toContain('NE DOIT PAS ÊTRE APPELÉ')
  })

  it('l\'utilisateur est invité à préciser la société ou le SIREN', async () => {
    repond(OVH)
    const out = await executeJarvis(TENANT, { type: 'explain_company', company: 'OVHcloud SAS' }, WS)

    expect(out).toContain('Précise la raison sociale exacte ou donne-moi le SIREN')
    expect(out).toContain("Aucune fiche n'a été affichée")
  })

  it('sans ambiguïté, l\'enrichissement a bien lieu', async () => {
    repond([societe('222222222', 'OVHCLOUD')])
    enrichCompanyWeb.mockResolvedValue({ summary: 'Résumé légitime' } as any)

    const out = await executeJarvis(TENANT, { type: 'explain_company', company: 'OVHcloud' }, WS)

    expect(enrichCompanyWeb).toHaveBeenCalledTimes(1)
    expect(out).toContain('Résumé légitime')
  })
})

describe('E. ingest/lead — la propriété est garantie par found:false', () => {
  // La route conditionne DÉJÀ toute écriture de métadonnées à `v.found`. Le
  // nouveau contrat rendant `found:false` sur ambiguïté, la propriété exigée
  // est acquise sans modifier la route. Ce test l'ancre pour qu'un futur lot
  // ne puisse pas la défaire en passant `ambiguous` pour un simple indicateur.
  it('une réponse ambiguë ne porte AUCUNE métadonnée à recopier', async () => {
    repond(OVH)
    const v = await lookupByName('OVHcloud SAS')

    expect(v.found).toBe(false)
    for (const champ of ['siren', 'naf', 'city', 'dirigeant', 'effectif', 'website', 'active'] as const) {
      expect(v[champ], champ).toBeUndefined()
    }
  })
})
