// JARVIS-CONTEXT-01a — UNE SEULE DÉFINITION DE « COMPTE ».
//
// ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
// Prospector affichait « 1 compte · 1 contact » là où Jarvis répondait
// « 0 compte(s) · 1 contact(s) », sur les MÊMES lignes de la MÊME table, dans le
// MÊME espace. Aucune donnée n'était perdue : les deux ne comptaient pas la
// même chose.
//
//   • l'UI dénombrait `new Set(leads.map(l => l.company)).size` — le nombre de
//     NOMS D'ENTREPRISE distincts, comptes et contacts confondus ;
//   • Jarvis dénombrait des ENTITÉS `kind === 'account'`.
//
// Un contact chez « Acme » suffisait donc à faire apparaître « 1 compte ».
//
// S'y ajoutait une seconde divergence, dans l'autre sens : `jarvisAgent.ts`
// omettait le court-circuit `kind === 'contact'`, si bien qu'un contact DÉCLARÉ
// mais sans prénom ni nom était compté COMPTE côté serveur et CONTACT côté UI.
//
// Ce fichier prouve que les deux chemins ne peuvent plus diverger, et que le
// dénombrement porte sur des entités.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isAccountLead,
  isContactLead,
  projectAccounts,
  summarizeAccounts,
} from '../lib/prospector/leadKind'
import { isAccount } from '../lib/prospector/jarvisAgent'
import { isAccountLead as isAccountLeadDepuisCapabilities } from '../lib/prospector/leadKind'

type L = { id: string; kind?: string; firstName?: string; lastName?: string; company?: string }

const compte = (p: Partial<L> = {}): L =>
  ({ id: 'ac_1', kind: 'account', firstName: '', lastName: '', company: 'Acme', ...p })
const contact = (p: Partial<L> = {}): L =>
  ({ id: 'ld_1', kind: 'contact', firstName: 'Alice', lastName: 'Martin', company: 'Acme', ...p })

describe('A. 1 contact chez Acme, AUCUNE fiche compte — le cas rapporté', () => {
  const projection = projectAccounts([contact()])

  it('le nombre de comptes est 0 — pas 1', () => {
    expect(projection.accounts).toHaveLength(0)
  })

  it('le nombre de contacts est 1', () => {
    expect(projection.contacts).toHaveLength(1)
  })

  it('l\'entreprise apparaît comme groupe SANS fiche compte', () => {
    expect(projection.companiesWithoutAccount).toHaveLength(1)
    expect(projection.companiesWithoutAccount[0].company).toBe('Acme')
    expect(projection.companiesWithoutAccount[0].account).toBeUndefined()
    // Le groupe reste visible : il est commercialement utile.
    expect(projection.groups).toHaveLength(1)
  })

  // ⚠️ LE MUTANT HISTORIQUE. C'est cette assertion qui rougit si quelqu'un
  // rebranche un dénombrement de noms d'entreprise sous l'étiquette « compte ».
  it('le libellé n\'appelle JAMAIS ce groupe un compte', () => {
    const texte = summarizeAccounts(projection)
    expect(texte).toBe('0 compte · 1 entreprise liée sans fiche compte · 1 contact')
    expect(texte).not.toMatch(/(^|[^0-9])1 compte\b/)
  })
})

describe('B. 1 compte Acme + 1 contact Acme', () => {
  const projection = projectAccounts([compte(), contact()])

  it('un compte, un contact, un seul groupe', () => {
    expect(projection.accounts).toHaveLength(1)
    expect(projection.contacts).toHaveLength(1)
    expect(projection.groups).toHaveLength(1)
  })

  it('le groupe Acme porte une VRAIE fiche compte', () => {
    expect(projection.groups[0].account?.id).toBe('ac_1')
    expect(projection.groups[0].contacts.map((c) => c.id)).toEqual(['ld_1'])
    expect(projection.companiesWithoutAccount).toEqual([])
  })

  it('le libellé ne mentionne aucune entreprise sans fiche', () => {
    expect(summarizeAccounts(projection)).toBe('1 compte · 1 contact')
  })
})

describe('C. Un contact DÉCLARÉ sans prénom ni nom reste un contact', () => {
  // Forme réellement productible : `addLeadsFromCsv` accepte une ligne dont la
  // colonne prénom est vide dès que l'entreprise est renseignée.
  const anonyme = { id: 'ld_2', kind: 'contact', firstName: '', lastName: '', company: 'Beta' }

  it('le `kind` explicite prime sur l\'heuristique de nom', () => {
    expect(isAccountLead(anonyme)).toBe(false)
    expect(isContactLead(anonyme)).toBe(true)
  })

  it('Jarvis rend le MÊME verdict — c\'est la divergence qui est fermée', () => {
    expect(isAccount(anonyme as any)).toBe(false)
  })

  it('il est dénombré comme contact, et son entreprise n\'est pas un compte', () => {
    const p = projectAccounts([anonyme])
    expect(p.accounts).toHaveLength(0)
    expect(p.contacts).toHaveLength(1)
    expect(p.companiesWithoutAccount).toHaveLength(1)
  })
})

describe('D. Legacy sans `kind` — l\'heuristique s\'applique, et seulement là', () => {
  it('aucun nom de personne ⇒ compte', () => {
    expect(isAccountLead({ id: 'x', company: 'Gamma' } as L)).toBe(true)
    expect(isAccountLead({ id: 'x', firstName: '', lastName: '   ' } as L)).toBe(true)
  })

  it('un nom de personne ⇒ contact', () => {
    expect(isAccountLead({ id: 'x', firstName: 'Alice' } as L)).toBe(false)
    expect(isAccountLead({ id: 'x', lastName: 'Martin' } as L)).toBe(false)
  })

  it('`kind:\'account\'` avec un nom reste un compte — la déclaration prime', () => {
    expect(isAccountLead({ id: 'x', kind: 'account', firstName: 'Alice' } as L)).toBe(true)
  })
})

describe('E. Un seul classifieur pour l\'UI et pour Jarvis', () => {
  // Balayage exhaustif du produit cartésien des formes possibles : si les deux
  // chemins divergeaient sur UNE seule combinaison, ce test la trouverait.
  const KINDS = [undefined, 'account', 'contact', 'inconnu']
  const NOMS = ['', '  ', 'Alice']

  it('aucune combinaison ne fait diverger Jarvis de la projection UI', () => {
    for (const kind of KINDS) {
      for (const firstName of NOMS) {
        for (const lastName of NOMS) {
          const l = { id: 'x', kind, firstName, lastName, company: 'Acme' } as L
          const ui = isAccountLead(l)
          expect(isAccount(l as any), JSON.stringify(l)).toBe(ui)
          expect(isAccountLeadDepuisCapabilities(l), JSON.stringify(l)).toBe(ui)
          // La partition est totale : jamais les deux, jamais aucune.
          expect(isContactLead(l)).toBe(!ui)
          // La projection classe chaque lead dans exactement une colonne.
          const p = projectAccounts([l])
          expect(p.accounts.length + p.contacts.length).toBe(1)
          expect(p.accounts.length === 1).toBe(ui)
        }
      }
    }
  })

  // Un prédicat réintroduit ailleurs redeviendrait invisible en revue. On
  // vérifie donc qu'il n'existe plus qu'UNE implémentation dans le dépôt.
  it('aucune seconde implémentation ne subsiste dans le code des consommateurs', () => {
    for (const f of ['lib/prospector/capabilities.ts', 'lib/prospector/jarvisAgent.ts', 'pages/pipeline.tsx']) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      // La forme heuristique `kind === 'account' || ...` ne doit apparaître que
      // dans le module canonique.
      expect(src, f).not.toMatch(/kind\s*===\s*['"]account['"]/)
    }
  })

  // ⚠️ GARDE TEXTUELLE, ET C'EST ASSUMÉ. Le dépôt teste en environnement `node`
  // et n'embarque ni jsdom ni testing-library ; ce lot n'a pas le droit d'ajouter
  // un paquet. On ne peut donc pas RENDRE `pipeline.tsx` pour lire son en-tête.
  //
  // La logique dénombrable a été extraite dans `projectAccounts` /
  // `summarizeAccounts`, qui sont testées pour de vrai ci-dessus. Il reste à
  // prouver que l'écran consomme bien CE calcul, et qu'il n'en refabrique pas un
  // second. C'est ce que font les deux assertions suivantes.
  //
  // Elles ne sont pas cosmétiques : la première version de ce test utilisait
  // `new Set\([^)]*\.company\)`, incapable de traverser la parenthèse interne de
  // `map((l) => l.company)`. Le mutant historique passait donc au travers — le
  // seul mutant que ce fichier existe pour attraper.
  it('l\'en-tête de la vue Comptes est alimenté par la projection, pas par un calcul local', () => {
    const src = readFileSync('pages/pipeline.tsx', 'utf8')
    expect(src).toContain('summarizeAccounts(projectAccounts(')
  })

  it('aucun `new Set(...)` de `pages/pipeline.tsx` ne porte sur `.company`', () => {
    const src = readFileSync('pages/pipeline.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    // Lecture à parenthèses ÉQUILIBRÉES : `map((l) => l.company)` est traversé.
    const coupables: string[] = []
    const marqueur = 'new Set('
    for (let i = src.indexOf(marqueur); i >= 0; i = src.indexOf(marqueur, i + 1)) {
      let profondeur = 0
      let j = i + marqueur.length - 1
      for (; j < src.length; j++) {
        if (src[j] === '(') profondeur++
        else if (src[j] === ')' && --profondeur === 0) break
      }
      const corps = src.slice(i, j + 1)
      if (corps.includes('.company')) coupables.push(corps)
    }
    expect(coupables, coupables.join('\n')).toEqual([])
  })
})

describe('F. Regroupement — dénombrement d\'entités, jamais de chaînes', () => {
  it('deux contacts de la même entreprise ne font PAS deux comptes', () => {
    const p = projectAccounts([contact(), contact({ id: 'ld_2', firstName: 'Bruno' })])
    expect(p.accounts).toHaveLength(0)
    expect(p.contacts).toHaveLength(2)
    expect(p.groups).toHaveLength(1)
    expect(summarizeAccounts(p)).toBe('0 compte · 1 entreprise liée sans fiche compte · 2 contacts')
  })

  it('deux entreprises distinctes sans fiche compte s\'accordent au pluriel', () => {
    const p = projectAccounts([contact(), contact({ id: 'ld_2', company: 'Beta' })])
    expect(summarizeAccounts(p)).toBe('0 compte · 2 entreprises liées sans fiche compte · 2 contacts')
  })

  it('un compte SEUL, sans contact, n\'est pas une « entreprise liée »', () => {
    const p = projectAccounts([compte()])
    expect(p.companiesWithoutAccount).toEqual([])
    expect(summarizeAccounts(p)).toBe('1 compte · 0 contact')
  })

  it('une entreprise absente est regroupée sans inventer de nom', () => {
    const p = projectAccounts([contact({ company: '   ' })])
    expect(p.groups[0].company).toBe('—')
  })

  it('une entreprise nommée littéralement « — » reste une vraie entreprise', () => {
    // Garde-fou contre une correction paresseuse : distinguer par comparaison
    // de chaîne avec le placeholder confondrait les deux cas.
    const p = projectAccounts([contact({ company: '—' })])
    expect(p.groups[0].hasCompany).toBe(true)
    expect(p.companiesWithoutAccount).toHaveLength(1)
  })

  it('l\'entrée n\'est jamais modifiée', () => {
    const entree = [compte(), contact()]
    const copie = JSON.parse(JSON.stringify(entree))
    projectAccounts(entree)
    expect(entree).toEqual(copie)
  })

  it('une liste vide rend zéro partout, sans erreur', () => {
    const p = projectAccounts([])
    expect(p).toEqual({ accounts: [], contacts: [], groups: [], companiesWithoutAccount: [] })
    expect(summarizeAccounts(p)).toBe('0 compte · 0 contact')
  })
})

// JARVIS-CONTEXT-01a.1 — UN CONTACT SANS ENTREPRISE NE LIE AUCUNE ENTREPRISE.
//
// Le groupe des leads sans entreprise porte le libellé `'—'`, qui est un
// PLACEHOLDER D'AFFICHAGE, pas un nom. Il entrait néanmoins dans
// `companiesWithoutAccount`, si bien qu'un contact sans entreprise s'annonçait
// « 1 entreprise liée sans fiche compte ». Aucune entreprise n'est liée : le
// libellé affirmait un fait faux.
describe('G. Absence totale d\'entreprise ≠ entreprise sans fiche compte', () => {
  it('A. entreprise renseignée, aucune fiche compte ⇒ 1 entreprise liée', () => {
    const p = projectAccounts([contact({ company: 'Acme' })])
    expect(p.companiesWithoutAccount).toHaveLength(1)
    expect(p.groups[0].hasCompany).toBe(true)
  })

  it('B. entreprise vide ⇒ groupe « — » visible, mais AUCUNE entreprise liée', () => {
    const p = projectAccounts([contact({ company: '' })])
    expect(p.groups).toHaveLength(1)
    expect(p.groups[0].company).toBe('—')
    expect(p.groups[0].hasCompany).toBe(false)
    expect(p.companiesWithoutAccount).toHaveLength(0)
    expect(summarizeAccounts(p)).toBe('0 compte · 1 contact')
  })

  it('C. entreprise en espaces seuls ⇒ même résultat', () => {
    const p = projectAccounts([contact({ company: '   ' })])
    expect(p.groups[0].hasCompany).toBe(false)
    expect(p.companiesWithoutAccount).toHaveLength(0)
    expect(summarizeAccounts(p)).toBe('0 compte · 1 contact')
  })

  it('champ `company` absent du lead ⇒ même résultat', () => {
    const p = projectAccounts([{ id: 'ld_9', kind: 'contact', firstName: 'Alice' }])
    expect(p.companiesWithoutAccount).toHaveLength(0)
    expect(summarizeAccounts(p)).toBe('0 compte · 1 contact')
  })

  it('mélange : seules les vraies entreprises sont dénombrées', () => {
    const p = projectAccounts([
      contact({ id: 'ld_1', company: 'Acme' }),
      contact({ id: 'ld_2', company: '' }),
      contact({ id: 'ld_3', company: '  ' }),
    ])
    // Les deux contacts sans entreprise partagent le groupe « — ».
    expect(p.groups).toHaveLength(2)
    expect(p.contacts).toHaveLength(3)
    expect(p.companiesWithoutAccount.map((g) => g.company)).toEqual(['Acme'])
    expect(summarizeAccounts(p)).toBe('0 compte · 1 entreprise liée sans fiche compte · 3 contacts')
  })

  it('un compte sans entreprise ne devient pas une entreprise liée', () => {
    const p = projectAccounts([compte({ company: '' })])
    expect(p.accounts).toHaveLength(1)
    expect(p.companiesWithoutAccount).toEqual([])
    expect(summarizeAccounts(p)).toBe('1 compte · 0 contact')
  })
})
