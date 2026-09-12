// PROSPECTOR-DOMAIN-ADAPTERS-001 — FRONTIÈRE DE VÉRITÉ DU DOMAINE LEGACY.
//
// Deux invariants, et le second est celui qui protège l'utilisateur :
//
//   A. `Lead.score` ne fabrique plus AUCUN fait métier.
//   B. la classification compte/contact a UNE seule définition dans le dépôt.
//
// ⚠️ LE TEST A NE PEUT PAS SE CONTENTER D'INTERDIRE DES CHAÎNES. « Paris » est
// une fabrication quand il sort d'un `location: 'Paris, France'` codé en dur ;
// c'est une donnée légitime quand il vient de `lead.city`. Le test distingue
// donc les deux en comparant DEUX leads identiques à un champ près — celui de
// l'entrée réelle. Interdire le littéral sans cette distinction rendrait le test
// vert pour une mauvaise raison, et interdirait d'afficher une vraie ville.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveLeadEntity } from '../lib/prospector/entityResolver'
import { isAccountLead, isContactLead } from '../lib/prospector/leadKind'
import { accountIdForLead, personIdForLead } from '../lib/prospector/proactive/dataBridge'
import type { Lead } from '../types/prospector'

function lead(p: Partial<Lead> = {}): Lead {
  return {
    id: 'ld_test01',
    firstName: '',
    lastName: '',
    title: '',
    company: 'Acme',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: null,
    phone: null,
    ...p,
  } as Lead
}

/** Toutes les chaînes du détail, quelle que soit leur profondeur. */
function chaines(valeur: unknown, sortie: string[] = []): string[] {
  if (typeof valeur === 'string') sortie.push(valeur)
  else if (Array.isArray(valeur)) valeur.forEach((v) => chaines(v, sortie))
  else if (valeur && typeof valeur === 'object') {
    Object.values(valeur as Record<string, unknown>).forEach((v) => chaines(v, sortie))
  }
  return sortie
}

// ── A — `Lead.score` NE FABRIQUE PLUS RIEN ─────────────────────────────────

describe('PROSPECTOR-DOMAIN-ADAPTERS-001 — Lead.score n’est plus une source de fait', () => {
  /**
   * Marqueurs de l'ancienne branche fabricante. Aucun ne peut provenir d'un
   * champ réel du lead employé ici — c'est ce qui les rend décisifs.
   */
  const FABRICATIONS = [
    'Série A',
    '12 M€',
    'Pappers',
    'Unipile',
    'LinkedIn',
    "offre d'emploi",
    'Offre d’emploi',
    '51-200',
    '11-50',
    'croissance',
    'Croissance',
    'FRAIS',
    'Paris, France',
    'décideur',
    'FAIT —',
    '2e degré',
    '1er degré',
  ]

  /**
   * Crée une fiche réelle puis y applique le patch du test.
   *
   * ⚠️ `getLeads()` rend des COPIES (`{ ...l }`) : muter son résultat ne touche
   * pas le magasin. On passe donc par `updateLead`, le chemin d'écriture réel.
   */
  async function detail(l: Lead) {
    const caps = await import('../lib/prospector/capabilities')
    const cree = await caps.addLead({ company: l.company })
    const { id, ...patch } = l
    await caps.updateLead(cree.id, patch)
    return caps.getLeadDetail(cree.id)
  }

  it('score = 95 sans aucune donnée sourcée → AUCUN fait fabriqué', async () => {
    const d = await detail(lead({ score: 95, temperature: 'hot', status: 'chaud', title: 'CTO' }))
    expect(d).toBeDefined()
    const texte = chaines(d).join(' | ')
    for (const marqueur of FABRICATIONS) {
      expect(texte, `fabrication survivante : « ${marqueur} »`).not.toContain(marqueur)
    }
  })

  it('score = 95 → aucune « preuve », et un dossier explicitement à enrichir', async () => {
    const d = await detail(lead({ score: 95, temperature: 'hot' }))
    expect(d!.dossier.preuves).toEqual([])
    expect(d!.dossier.pourquoiMaintenant).toContain('Aucun signal vérifié')
    expect(d!.dossier.mecanisme).toBe('À enrichir')
    expect(d!.scoring).toMatchObject({ fit: 0, intent: 0, timing: 0 })
  })

  it('score = 95 et score = 0 produisent EXACTEMENT le même niveau de vérité', async () => {
    // Le cœur du lot : le score ne doit plus rien changer à ce qui est affirmé.
    const chaud = await detail(lead({ id: 'ld_a', score: 95, temperature: 'hot' }))
    const froid = await detail(lead({ id: 'ld_b', score: 0, temperature: 'hot' }))
    expect(chaines(chaud!.dossier)).toEqual(chaines(froid!.dossier))
    expect(chaud!.company.funding).toBe(froid!.company.funding)
    expect(chaud!.company.size).toBe(froid!.company.size)
    expect(chaud!.scoring.fit).toBe(froid!.scoring.fit)
  })

  it('un site web n’est JAMAIS déduit du nom de l’entreprise', async () => {
    const d = await detail(lead({ score: 95, company: 'Acme Corp' }))
    expect(d!.company.website).not.toContain('acmecorp.com')
    expect(d!.company.website).toBe('')
  })

  // ── LA DISTINCTION QUI COMPTE ────────────────────────────────────────────
  it('une valeur RÉELLE du lead reste affichée, même si son littéral fut fabriqué', async () => {
    // « Paris, France » était codé en dur. Une vraie ville « Paris » venant de
    // `lead.city`, elle, DOIT s'afficher : interdire le mot serait aussi faux
    // que l'inventer.
    const d = await detail(lead({
      score: 95, city: 'Paris', effectif: '51-200', website: 'https://acme.fr',
      siren: '552100554',
    }))
    expect(d!.company.location).toBe('Paris')
    expect(d!.company.location).not.toBe('Paris, France')
    expect(d!.company.size).toBe('51-200')      // réel : vient de `lead.effectif`
    expect(d!.company.website).toBe('https://acme.fr')
    expect(d!.company.description).toContain('552100554')
  })

  it('sans donnée réelle, les champs entreprise restent vides', async () => {
    const d = await detail(lead({ score: 95 }))
    expect(d!.company.location).toBe('—')
    expect(d!.company.size).toBe('—')
    expect(d!.company.funding).toBe('—')
    expect(d!.company.description).toContain('à enrichir')
  })
})

// ── B — UNE DONNÉE VRAIE DANS LE MAUVAIS EMPLACEMENT EST UNE INFORMATION FAUSSE

describe('PROSPECTOR-DOMAIN-ADAPTERS-001a — chiffre d’affaires ≠ financement', () => {
  async function detail(l: Lead) {
    const caps = await import('../lib/prospector/capabilities')
    const cree = await caps.addLead({ company: l.company })
    const { id, ...patch } = l
    await caps.updateLead(cree.id, patch)
    return { detail: await caps.getLeadDetail(cree.id), id: cree.id, caps }
  }

  it('lead.ca N’EST PAS projeté dans company.funding', async () => {
    // ⚠️ CE TEST CORRIGE UN TEST DE R1 QUI CANONISAIT LE DÉFAUT. La version
    // précédente affirmait `funding === '12 M€'` comme un comportement correct,
    // au motif que la donnée était réelle. Elle l'est — c'est exactement ce qui
    // rendait l'erreur invisible : un chiffre d'affaires présenté comme une
    // levée décrit une entreprise que personne n'a observée.
    const { detail: d } = await detail(lead({ score: 95, ca: '12 M€' }))
    expect(d!.company.funding).not.toBe('12 M€')
    expect(d!.company.funding).toBe('—')
  })

  it('lead.ca reste intact et persisté — il n’est pas supprimé, il n’est plus projeté', async () => {
    const { id, caps } = await detail(lead({ score: 95, ca: '12 M€' }))
    const leads = await caps.getLeads()
    expect(leads.find((x) => x.id === id)!.ca).toBe('12 M€')
  })

  it('AUCUN champ du Lead ne peut atteindre company.funding aujourd’hui', async () => {
    // Le modèle `Lead` ne porte aucun financement faisant autorité : tout
    // emprunt au voisin le plus proche serait un nouveau défaut de la même
    // famille.
    const { detail: d } = await detail(lead({
      score: 95, ca: '12 M€', effectif: '51-200', summary: 'Levée de 8 M€ en 2026',
      city: 'Paris', website: 'https://acme.fr',
    }))
    expect(d!.company.funding).toBe('—')
  })

  it('les correspondances sémantiques VALIDES sont préservées', async () => {
    const { detail: d } = await detail(lead({
      score: 95, city: 'Paris', effectif: '51-200', website: 'https://acme.fr',
    }))
    expect(d!.company.location).toBe('Paris')     // city    → location  ✓
    expect(d!.company.size).toBe('51-200')        // effectif → size     ✓
    expect(d!.company.website).toBe('https://acme.fr') // website → website ✓
  })
})

// ── B — CLASSIFICATION CANONIQUE ───────────────────────────────────────────

describe('PROSPECTOR-DOMAIN-ADAPTERS-001 — personIdForLead suit la définition canonique', () => {
  it('compte explicite AVEC noms → aucun personId', () => {
    const l = lead({ kind: 'account', firstName: 'Alice', lastName: 'Martin' })
    expect(isAccountLead(l)).toBe(true)
    expect(personIdForLead(l)).toBeUndefined()
  })

  it('contact explicite AVEC nom → personId', () => {
    const l = lead({ kind: 'contact', firstName: 'Alice', lastName: 'Martin' })
    expect(isContactLead(l)).toBe(true)
    expect(personIdForLead(l)).toBe(l.id)
  })

  it('LEGACY sans kind et sans nom → compte → aucun personId', () => {
    const l = lead({ kind: undefined })
    expect(isAccountLead(l)).toBe(true)
    expect(personIdForLead(l)).toBeUndefined()
  })

  it('LEGACY sans kind mais AVEC un nom → contact → personId', () => {
    const l = lead({ kind: undefined, firstName: 'Bruno' })
    expect(isAccountLead(l)).toBe(false)
    expect(personIdForLead(l)).toBe(l.id)
  })

  it('contact explicite SANS nom de personne → aucun personId', () => {
    // `isAccountLead` dit « ce n'est pas un compte » ; il n'y a pourtant
    // personne à désigner. Les deux critères sont bien distincts.
    const l = lead({ kind: 'contact' })
    expect(isAccountLead(l)).toBe(false)
    expect(personIdForLead(l)).toBeUndefined()
  })

  it('un nom réduit à des espaces ne vaut pas identité', () => {
    expect(personIdForLead(lead({ kind: 'contact', firstName: '   ' }))).toBeUndefined()
  })

  it('sans identifiant de fiche, aucun personId', () => {
    expect(personIdForLead(lead({ kind: 'contact', firstName: 'Bruno', id: '' }))).toBeUndefined()
  })
})

// ── A — entityResolver : plus aucun classificateur local ───────────────────
//
// ⚠️ ICI, CONTRAIREMENT À `dataBridge`, LA DIVERGENCE ÉTAIT RÉELLE ET
// OBSERVABLE. Le prédicat local valait `kind === 'account' || aucun nom` : il
// omettait le court-circuit `kind === 'contact'`, c'est-à-dire exactement le
// défaut que `leadKind.ts` a été écrit pour supprimer, et qui survivait dans ce
// troisième module. Un test de comportement suffit donc à le tuer.

describe('PROSPECTOR-DOMAIN-ADAPTERS-001a — entityResolver suit la définition canonique', () => {
  /** Contact DÉCLARÉ mais sans nom — forme que `addLeadsFromCsv` sait produire. */
  const contactSansNom = lead({
    id: 'ld_csv1', kind: 'contact', firstName: '', lastName: '', company: 'Zephyr Industries',
  })

  it('contact explicite sans nom → NON éligible sous preference « account »', () => {
    // Ancien comportement : éligible, car « aucun nom » suffisait à en faire un
    // compte. La déclaration de l'utilisateur était contredite.
    const r = resolveLeadEntity([contactSansNom], 'Zephyr Industries', 'account')
    expect(r.kind).toBe('not_found')
  })

  it('contact explicite sans nom → RESTE candidat sous preference « contact »', () => {
    const r = resolveLeadEntity([contactSansNom], 'Zephyr Industries', 'contact')
    expect(r.kind).toBe('exact')
    expect((r as any).candidate.lead.id).toBe('ld_csv1')
  })

  it('la classification employée est bien la canonique', () => {
    expect(isAccountLead(contactSansNom)).toBe(false)
    expect(isContactLead(contactSansNom)).toBe(true)
  })

  it('un compte explicite reste éligible sous « account » et exclu sous « contact »', () => {
    const compte = lead({ id: 'ld_acc1', kind: 'account', company: 'Orion SAS' })
    expect(resolveLeadEntity([compte], 'Orion SAS', 'account').kind).toBe('exact')
    expect(resolveLeadEntity([compte], 'Orion SAS', 'contact').kind).toBe('not_found')
  })

  it('un lead LEGACY sans kind ni nom reste traité comme un compte', () => {
    const legacy = lead({ id: 'ld_leg1', kind: undefined, company: 'Vega Group' })
    expect(resolveLeadEntity([legacy], 'Vega Group', 'account').kind).toBe('exact')
  })
})

// ── GARDE STRUCTURELLE — la seule capable de tuer le mutant M4 ─────────────
//
// ⚠️ AUCUN TEST DE COMPORTEMENT NE PEUT PROTÉGER CETTE RÈGLE, ET IL FAUT LE
// DIRE. Remplacer `isAccountLead(lead)` par `lead.kind === 'account'` dans
// `personIdForLead` ne change AUCUN résultat aujourd'hui : vérifié sur les 72
// combinaisons de `(kind, firstName, lastName, id)`, zéro divergence — le
// second critère (« aucun nom de personne ») absorbe le seul cas où
// l'heuristique legacy se distingue.
//
// Un test comportemental qui prétendrait tuer ce mutant serait donc faux. La
// règle à protéger n'est pas un résultat, c'est une DÉPENDANCE : ce module ne
// doit pas reposséder la définition. On la vérifie donc là où elle vit — dans
// le texte du module.
describe('PROSPECTOR-DOMAIN-ADAPTERS-001 — dataBridge ne reclassifie pas localement', () => {
  it('aucune comparaison `kind === account|contact` dans le CODE de dataBridge', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/prospector/proactive/dataBridge.ts'),
      'utf8',
    )
    // Les lignes de commentaire sont exclues : la note qui EXPLIQUE l'ancien
    // test a le droit de le citer.
    const code = source
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

    expect(code).toMatch(/isAccountLead\(/)
    expect(code).not.toMatch(/kind\s*[=!]==\s*['"](account|contact)['"]/)
  })
})

// ── accountIdForLead reste l’unique producteur, inchangé par ce lot ────────

describe('PROSPECTOR-DOMAIN-ADAPTERS-001 — accountIdForLead inchangé', () => {
  it('SIREN d’abord', () => {
    expect(accountIdForLead(lead({ siren: '552100554' }))).toBe('acc_siren_552100554')
  })

  it('repli par nom CONSERVÉ dans ce lot (interdit au futur Bridge, pas ici)', () => {
    expect(accountIdForLead(lead({ company: 'Acme Corp' }))).toBe('acc_name_acme_corp')
  })

  it('ni SIREN ni nom → aucun identifiant fabriqué', () => {
    expect(accountIdForLead(lead({ company: '' }))).toBeNull()
  })
})
