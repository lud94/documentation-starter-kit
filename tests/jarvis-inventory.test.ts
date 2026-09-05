// JARVIS-CONTEXT-01b — INVENTAIRE D'ESPACE.
//
// ── CE QUI MANQUAIT ─────────────────────────────────────────────────────────
// Jarvis n'avait aucune action d'inventaire. Face à « Liste-moi mes contacts »,
// le seul candidat plausible du contrat SYSTEM était `stats` — « chiffres du
// pipe ». L'utilisateur demandait QUI, Prospector répondait COMBIEN.
//
// ── LES DEUX PIÈGES ─────────────────────────────────────────────────────────
// 1. ESPACE VIDE ≠ PANNE. `listLeads()` rend `[]` dans les deux cas. Répondre
//    « aucun contact » pendant une panne serait une affirmation FAUSSE sur les
//    données du client. D'où `listLeadsStrict`, et deux réponses distinctes.
//
// 2. UNE ENTREPRISE CITÉE PAR UN CONTACT N'EST PAS UN COMPTE. C'est la faute
//    même que JARVIS-CONTEXT-01a a corrigée dans l'UI ; elle ne doit pas
//    réapparaître ici sous une autre forme.
import { describe, it, expect } from 'vitest'
import type { Lead } from '../types/prospector'
import type { StrictLeadsRead } from '../lib/supabase/leads'
import {
  INVENTORY_LIMIT,
  detectInventoryIntent,
  normalizeScope,
  renderInventory,
} from '../lib/prospector/inventory'
import { isWrite, WRITE_ACTIONS } from '../lib/prospector/jarvisAgent'

const contact = (p: Partial<Lead> = {}): Lead =>
  ({
    id: 'ld_1', kind: 'contact', firstName: 'Alice', lastName: 'Martin',
    title: 'VP Sales', company: 'Acme SAS', score: 0, temperature: 'warm',
    status: 'chaud', stage: 'to_invite', email: 'alice@acme.test', phone: '+33100000000',
    ...p,
  }) as Lead

const compte = (p: Partial<Lead> = {}): Lead =>
  ({
    id: 'ac_1', kind: 'account', firstName: '', lastName: '', title: '',
    company: 'Acme SAS', score: 0, temperature: 'warm', status: 'froid',
    stage: 'to_invite', email: null, phone: null, siren: '552100554',
    city: 'Paris', effectif: '50 à 99',
    ...p,
  }) as Lead

const ok = (leads: Lead[]): StrictLeadsRead => ({ ok: true, leads })
const panne: StrictLeadsRead = { ok: false }

describe('1. Contacts seuls', () => {
  const out = renderInventory(ok([contact()]), 'all')

  it('liste le contact avec identité, poste et entreprise', () => {
    expect(out).toContain('👤 Alice Martin — VP Sales · Acme SAS [chaud]')
    expect(out).toContain('Contacts (1) :')
  })

  it('annonce explicitement zéro compte', () => {
    expect(out).toContain('Comptes : aucun.')
  })

  // ⚠️ UN INVENTAIRE N'EST PAS UNE EXTRACTION. Il répond « qui est là », pas
  // « comment les joindre ».
  it('n\'expose NI courriel NI téléphone', () => {
    expect(out).not.toContain('alice@acme.test')
    expect(out).not.toContain('+33100000000')
  })
})

describe('2. Comptes seuls', () => {
  const out = renderInventory(ok([compte()]), 'all')

  it('liste la fiche compte sous son vrai nom, avec ses métadonnées présentes', () => {
    expect(out).toContain('🏢 Acme SAS (SIREN 552100554 · Paris · 50 à 99 sal.)')
    expect(out).toContain('Comptes (1) :')
    expect(out).toContain('Contacts : aucun.')
  })

  it('n\'invente aucune métadonnée absente', () => {
    const nu = renderInventory(ok([compte({ siren: undefined, city: undefined, effectif: undefined })]), 'accounts')
    const ligne = nu.split('\n').find((l) => l.startsWith('🏢'))
    // Aucune parenthèse de métadonnées : le nom seul, sans « (…) » vide.
    expect(ligne).toBe('🏢 Acme SAS')
  })
})

describe('3. Mixte comptes et contacts', () => {
  const out = renderInventory(ok([contact(), compte()]), 'all')

  it('sépare les deux catégories et les dénombre séparément', () => {
    expect(out).toContain('Comptes (1) :')
    expect(out).toContain('Contacts (1) :')
  })

  it('le périmètre restreint ne rend QUE sa catégorie', () => {
    const c = renderInventory(ok([contact(), compte()]), 'contacts')
    expect(c).toContain('Contacts (1) :')
    expect(c).not.toContain('Comptes')

    const a = renderInventory(ok([contact(), compte()]), 'accounts')
    expect(a).toContain('Comptes (1) :')
    expect(a).not.toContain('👤')
  })

  it('l\'ordre est déterministe, quel que soit l\'ordre d\'arrivée', () => {
    const leads = [
      contact({ id: 'ld_3', firstName: 'Zoé', lastName: 'Zamora' }),
      contact({ id: 'ld_1', firstName: 'Alice', lastName: 'Martin' }),
      contact({ id: 'ld_2', firstName: 'Bruno', lastName: 'Bernard' }),
    ]
    const a = renderInventory(ok(leads), 'contacts')
    const b = renderInventory(ok([...leads].reverse()), 'contacts')
    expect(a).toBe(b)
    expect(a.indexOf('Bernard')).toBeLessThan(a.indexOf('Martin'))
    expect(a.indexOf('Martin')).toBeLessThan(a.indexOf('Zamora'))
  })

  it('les homonymes stricts sont départagés par identifiant, sans instabilité', () => {
    const jumeaux = [
      contact({ id: 'ld_b', firstName: 'Alice', lastName: 'Martin' }),
      contact({ id: 'ld_a', firstName: 'Alice', lastName: 'Martin' }),
    ]
    expect(renderInventory(ok(jumeaux), 'contacts')).toBe(
      renderInventory(ok([...jumeaux].reverse()), 'contacts'),
    )
  })
})

describe('4. Contact avec `company` mais SANS fiche compte ⇒ 0 compte', () => {
  // La faute corrigée dans l'UI par JARVIS-CONTEXT-01a ne doit pas réapparaître
  // ici : une entreprise citée par un contact n'est pas une entité compte.
  const out = renderInventory(ok([contact({ company: 'Beta SARL' })]), 'all')

  it('aucun compte n\'est inventé depuis le champ `company`', () => {
    expect(out).toContain('Comptes : aucun.')
    expect(out).not.toContain('🏢')
  })

  it('l\'entreprise est néanmoins mentionnée, et NOMMÉE pour ce qu\'elle est', () => {
    expect(out).toContain("n'ont pas de fiche compte : Beta SARL")
  })

  it('une entreprise qui a DÉJÀ une fiche compte n\'est pas re-signalée', () => {
    const avec = renderInventory(ok([contact(), compte()]), 'all')
    expect(avec).not.toContain('pas de fiche compte')
  })
})

describe('5. Espace vide', () => {
  it('dit qu\'il est vide, sans ambiguïté', () => {
    const out = renderInventory(ok([]), 'all')
    expect(out).toContain('aucun lead')
    expect(out).not.toContain('ne peux pas lire')
  })
})

describe('6. Erreur de stockage — JAMAIS confondue avec un espace vide', () => {
  const out = renderInventory(panne, 'all')

  it('annonce une indisponibilité, pas une absence de données', () => {
    expect(out).toContain('Je ne peux pas lire le pipeline')
    expect(out).not.toContain('aucun lead')
    expect(out).not.toContain('aucun.')
  })

  it('les deux réponses sont RÉELLEMENT différentes', () => {
    expect(renderInventory(panne, 'all')).not.toBe(renderInventory(ok([]), 'all'))
  })

  it('aucun périmètre ne contourne la panne', () => {
    for (const scope of ['contacts', 'accounts', 'all'] as const) {
      expect(renderInventory(panne, scope)).toContain('Je ne peux pas lire')
    }
  })
})

describe('7. Données legacy sans `kind`', () => {
  it('un legacy nommé est un contact ; un legacy sans nom est un compte', () => {
    const out = renderInventory(
      ok([
        { id: 'lg_1', firstName: 'Alice', lastName: 'Martin', company: 'Acme SAS' } as Lead,
        { id: 'lg_2', firstName: '', lastName: '', company: 'Gamma SA' } as Lead,
      ]),
      'all',
    )
    expect(out).toContain('Comptes (1) :')
    expect(out).toContain('🏢 Gamma SA')
    expect(out).toContain('Contacts (1) :')
    expect(out).toContain('👤 Alice Martin')
  })

  it('un contact DÉCLARÉ sans nom reste un contact — la déclaration prime', () => {
    const out = renderInventory(
      ok([{ id: 'ld_x', kind: 'contact', firstName: '', lastName: '', company: 'Delta' } as Lead]),
      'all',
    )
    expect(out).toContain('Comptes : aucun.')
    expect(out).toContain('Contacts (1) :')
    // Sans nom de personne, l'entreprise sert d'étiquette — jamais une chaîne vide.
    expect(out).toContain('👤 Delta')
  })
})

describe('8. Troncature — bornée ET annoncée', () => {
  const beaucoup = Array.from({ length: INVENTORY_LIMIT + 7 }, (_, i) =>
    contact({ id: `ld_${String(i).padStart(3, '0')}`, lastName: `Nom${String(i).padStart(3, '0')}` }),
  )
  const out = renderInventory(ok(beaucoup), 'contacts')

  it('n\'affiche jamais plus que la limite', () => {
    expect(out.split('\n').filter((l) => l.startsWith('👤'))).toHaveLength(INVENTORY_LIMIT)
  })

  it('annonce le total RÉEL, pas le nombre affiché', () => {
    expect(out).toContain(`Contacts (${INVENTORY_LIMIT + 7}) :`)
  })

  // ⚠️ Une troncature silencieuse ferait croire à un espace plus petit qu'il
  // n'est — la demi-vérité que tout ce chantier corrige.
  it('annonce explicitement le reste', () => {
    expect(out).toContain(`… et 7 de plus (${INVENTORY_LIMIT} affichés sur ${INVENTORY_LIMIT + 7}).`)
  })

  it('exactement la limite ⇒ aucune mention de reste', () => {
    const pile = renderInventory(ok(beaucoup.slice(0, INVENTORY_LIMIT)), 'contacts')
    expect(pile).not.toContain('de plus')
  })
})

describe('9. Intention d\'inventaire — déterministe', () => {
  it.each([
    ['liste-moi mes contacts', 'contacts'],
    ['Liste-moi mes contacts !', 'contacts'],
    ['quels sont mes contacts ?', 'contacts'],
    ['affiche les contacts de mon espace', 'contacts'],
    ['montre-moi les personnes de mon espace', 'contacts'],
    ['liste mes comptes', 'accounts'],
    ['montre-moi les comptes de mon espace', 'accounts'],
    // ⚠️ `affiche les entreprises` figurait ici comme `accounts`. C'était le
    // défaut : un terme générique, sans ancrage, capturait du sourcing. Voir
    // le bloc 12.
    ['liste mes entreprises', 'accounts'],
    ['affiche les entreprises de mon espace', 'accounts'],
    ['quelles sont les entreprises dans mon pipeline ?', 'accounts'],
    ['liste mes comptes et mes contacts', 'all'],
    ['liste tous mes leads', 'all'],
  ])('« %s » ⇒ inventaire %s', (message, attendu) => {
    expect(detectInventoryIntent(message)).toBe(attendu)
  })

  it('la détection ignore accents, casse et ponctuation', () => {
    expect(detectInventoryIntent('LISTE-MOI MES CONTACTS')).toBe('contacts')
    expect(detectInventoryIntent('énumère mes contacts')).toBe('contacts')
  })

  it('un verbe de liste sans objet d\'inventaire laisse décider le classifieur', () => {
    expect(detectInventoryIntent('liste mes séquences')).toBeNull()
    expect(detectInventoryIntent('montre-moi la page')).toBeNull()
    expect(detectInventoryIntent('liste les contacts commerciaux chez Acme')).toBeNull()
    expect(detectInventoryIntent('')).toBeNull()
  })
})

describe('10. Les demandes QUANTITATIVES restent sur `stats`', () => {
  // Ce lot AJOUTE une capacité ; il ne doit en retirer aucune. Détourner
  // « combien ai-je de contacts ? » déverserait 25 lignes là où un chiffre
  // était attendu.
  it.each([
    'combien ai-je de contacts ?',
    'combien de comptes dans mon espace',
    'quel est le nombre de contacts',
    'donne-moi le nombre de comptes',
    'mes statistiques',
    'stats du pipe',
  ])('« %s » n\'est PAS détourné vers l\'inventaire', (message) => {
    expect(detectInventoryIntent(message)).toBeNull()
  })

  // ⚠️ LE CAS QUI ÉPROUVE RÉELLEMENT LE GARDE QUANTITATIF.
  //
  // Les formulations ci-dessus ne portent aucun verbe de liste : elles sont
  // écartées parce qu'il en manque un, pas parce qu'elles sont quantitatives.
  // Le garde n'y sert à rien — vérifié, le retirer ne cassait aucun de ces cas.
  //
  // Ces directives-ci portent LES DEUX : un verbe de liste ET une demande de
  // nombre. Elles demandent un chiffre, et seul le garde quantitatif les
  // empêche de déverser vingt-cinq lignes.
  it.each([
    'liste-moi le nombre de contacts',
    'montre-moi combien j\'ai de contacts',
    'affiche le total de mes comptes',
    'montre-moi les statistiques de mes contacts',
  ])('« %s » demande un NOMBRE malgré son verbe de liste', (message) => {
    expect(detectInventoryIntent(message)).toBeNull()
  })
})

describe('12. Le pré-routeur ne VOLE PAS les intentions de sourcing', () => {
  // ── LE DÉFAUT FERMÉ (JARVIS-CONTEXT-01b.1) ─────────────────────────────────
  //
  // La première version reconnaissait `entreprises|societes|boites` au même
  // titre que `comptes`. Toute directive de SOURCING commençant par un verbe de
  // liste était donc tranchée AVANT le classifieur, et `source_companies`
  // devenait inatteignable pour ces formulations. Une capacité perdue en
  // échange d'une capacité gagnée : ce lot n'a jamais eu le droit de faire ça.
  //
  // `compte` est un terme MÉTIER — on n'a de comptes que dans son propre
  // espace. `entreprise`, `société`, `boîte` désignent le monde entier : ils
  // n'ouvrent l'inventaire QUE si un ancrage explicite les rattache aux données
  // déjà présentes.
  it.each([
    'liste-moi des entreprises de cybersécurité à Lyon',
    'quelles sont les entreprises SaaS françaises ?',
    'affiche-moi des entreprises de 50 à 100 salariés',
    'liste les entreprises qui recrutent un Head of Sales',
  ])('« %s » reste au classifieur (sourcing)', (message) => {
    expect(detectInventoryIntent(message)).toBeNull()
  })

  // Formulations calquées sur le contrat SYSTEM de `source_companies`.
  it.each([
    'trouve des ESN à Paris de 50 à 100 salariés',
    'cherche des sociétés de conseil IT en Île-de-France',
    'liste des boîtes de fintech à Bordeaux',
    'montre-moi des entreprises du secteur Consulting',
    'affiche des sociétés de 11 à 20 salariés',
    'quelles sont les boîtes qui lèvent des fonds en ce moment ?',
  ])('« %s » n\'est pas capturé par le pré-routeur', (message) => {
    expect(detectInventoryIntent(message)).toBeNull()
  })

  it('un terme générique ANCRÉ ouvre bien l\'inventaire', () => {
    expect(detectInventoryIntent('liste mes entreprises')).toBe('accounts')
    expect(detectInventoryIntent('affiche les entreprises de mon espace')).toBe('accounts')
    expect(detectInventoryIntent('quelles sont les entreprises dans mon pipeline ?')).toBe('accounts')
    expect(detectInventoryIntent('montre les sociétés déjà présentes')).toBe('accounts')
    expect(detectInventoryIntent('liste les boîtes de ma base')).toBe('accounts')
  })

  // ⚠️ MÊME « comptes » EXIGE UN ANCRAGE (JARVIS-CONTEXT-01b.2). Un nom nu ne
  // suffit plus : « affiche les comptes cibles SaaS en France » parle du monde
  // extérieur. Laisser une formulation ambiguë au classifieur ne coûte qu'un
  // appel au modèle ; lui voler une intention de sourcing rend une capacité
  // définitivement inatteignable. Les deux erreurs n'ont pas le même prix.
  it('« comptes » NU ne suffit pas — il lui faut un ancrage', () => {
    expect(detectInventoryIntent('liste mes comptes')).toBe('accounts')
    expect(detectInventoryIntent('montre les comptes dans mon pipeline')).toBe('accounts')
    expect(detectInventoryIntent('affiche les comptes')).toBeNull()
    expect(detectInventoryIntent('quels sont les comptes ?')).toBeNull()
  })

  // ⚠️ `tout` / `tous` n'ancrent rien. Les garder dans le repli « all »
  // rouvrait la capture par la bande.
  it('« tous » ne suffit pas à ancrer une demande de sourcing', () => {
    expect(detectInventoryIntent('liste des entreprises tous secteurs')).toBeNull()
    expect(detectInventoryIntent('affiche toutes les sociétés de la tech')).toBeNull()
  })

  it('les demandes quantitatives restent exclues, ancrage ou non', () => {
    expect(detectInventoryIntent('combien ai-je d\'entreprises dans mon espace ?')).toBeNull()
    expect(detectInventoryIntent('liste-moi le nombre de mes comptes')).toBeNull()
  })
})

describe('13. L\'ancrage porte sur L\'ENTITÉ, pas sur la phrase', () => {
  // ── LE DÉFAUT FERMÉ (JARVIS-CONTEXT-01b.2) ─────────────────────────────────
  //
  // 01b.1 exigeait un ancrage pour les termes génériques, mais le cherchait
  // N'IMPORTE OÙ dans la phrase. La seule présence du mot « mes » suffisait :
  //
  //   « liste les entreprises de MES concurrents »        → capturé à tort
  //   « montre les sociétés dans MES secteurs prioritaires » → capturé à tort
  //
  // Le « mes » ne portait pas sur l'entité. Et `leads|personnes|interlocuteurs`
  // n'exigeaient aucun ancrage du tout.
  //
  // La règle est désormais SYNTAXIQUE : l'ancrage doit être ADJACENT au nom.
  it.each([
    'liste-moi des leads cybersécurité à Paris',
    'montre-moi des personnes chez Microsoft',
    'quels sont les interlocuteurs pertinents chez Acme ?',
    'liste les entreprises de mes concurrents',
    'montre les sociétés dans mes secteurs prioritaires',
    'liste les contacts commerciaux chez Acme',
    'affiche les comptes cibles SaaS en France',
  ])('« %s » reste au classifieur', (message) => {
    expect(detectInventoryIntent(message)).toBeNull()
  })

  it.each([
    ['liste mes contacts', 'contacts'],
    ['liste mes comptes', 'accounts'],
    ['liste tous mes leads', 'all'],
    ['affiche les contacts de mon espace', 'contacts'],
    ['montre les comptes dans mon pipeline', 'accounts'],
    ['liste les entreprises déjà présentes', 'accounts'],
  ])('« %s » ⇒ %s', (message, attendu) => {
    expect(detectInventoryIntent(message)).toBe(attendu)
  })

  // ⚠️ « mes concurrents » et « mes contacts » se distinguent UNIQUEMENT par le
  // mot qui suit « mes ». Un ancrage global ne peut pas les séparer ; un
  // ancrage adjacent, si.
  it('un possessif portant sur autre chose n\'ancre rien', () => {
    expect(detectInventoryIntent('liste les contacts de mes partenaires')).toBeNull()
    expect(detectInventoryIntent('affiche les comptes de mes clients')).toBeNull()
    expect(detectInventoryIntent('liste mes contacts')).toBe('contacts')
  })

  it('« leads » exige lui aussi son ancrage, et vaut alors l\'espace entier', () => {
    expect(detectInventoryIntent('liste les leads')).toBeNull()
    expect(detectInventoryIntent('liste-moi des leads à Paris')).toBeNull()
    expect(detectInventoryIntent('liste mes leads')).toBe('all')
    expect(detectInventoryIntent('affiche les leads de mon espace')).toBe('all')
  })
})

describe('11. Contrat d\'action : LECTURE PURE', () => {
  // ⚠️ Un inventaire qui demanderait confirmation serait une régression
  // d'ergonomie ; un inventaire classé en écriture serait une faute de sûreté.
  it('`list_inventory` n\'est pas une action d\'écriture', () => {
    expect(WRITE_ACTIONS).not.toContain('list_inventory')
    expect(isWrite({ type: 'list_inventory', scope: 'contacts' })).toBe(false)
    expect(isWrite({ type: 'list_inventory', scope: 'all' })).toBe(false)
  })

  it('un périmètre inconnu ou absent retombe sur « all », jamais sur une erreur', () => {
    expect(normalizeScope('contacts')).toBe('contacts')
    expect(normalizeScope('accounts')).toBe('accounts')
    expect(normalizeScope('all')).toBe('all')
    for (const bidon of [undefined, null, '', 'CONTACTS', 'leads', 42, {}]) {
      expect(normalizeScope(bidon)).toBe('all')
    }
  })
})
