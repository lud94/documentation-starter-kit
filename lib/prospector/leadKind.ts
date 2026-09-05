// DÉFINITION CANONIQUE DE « COMPTE » ET « CONTACT » (lot JARVIS-CONTEXT-01a).
//
// ── LE DÉFAUT QUE CE MODULE FERME ────────────────────────────────────────────
// Il existait DEUX prédicats concurrents, et l'écran n'en utilisait aucun pour
// compter :
//
//   • `capabilities.ts` — complet : `kind:'contact'` court-circuitait ;
//   • `jarvisAgent.ts`  — INCOMPLET : pas de court-circuit `contact`, donc un
//     lead explicitement `kind:'contact'` mais sans prénom ni nom (forme que
//     `addLeadsFromCsv` sait produire) était compté COMPTE par Jarvis et
//     CONTACT par l'UI, sur la MÊME ligne de la MÊME table ;
//   • `pipeline.tsx`    — ne classait pas du tout : il dénombrait
//     `new Set(leads.map(l => l.company)).size`, c'est-à-dire des CHAÎNES DE
//     CARACTÈRES. Un unique contact chez « Acme » affichait « 1 compte ».
//
// Deux définitions divergentes d'un même mot ne se réconcilient pas par
// discipline de revue : elles se réconcilient en n'en laissant qu'UNE.
//
// ── POURQUOI UN MODULE À PART, ET NON UN IMPORT DEPUIS `capabilities.ts` ─────
// `capabilities.ts` est le module CLIENT : magasin mémoire du navigateur,
// `fetch()` vers les routes API, état de session. `jarvisAgent.ts` s'exécute
// côté SERVEUR. Les faire dépendre l'un de l'autre pour un prédicat de trois
// lignes attacherait tout le graphe client au cerveau serveur.
//
// Ce module est donc volontairement STÉRILE : aucun état, aucun réseau, aucune
// dépendance UI, aucun effet de bord, aucun import applicatif. C'est ce qui lui
// permet d'être la seule définition des deux côtés de la frontière.
//
// ── LA RÈGLE ─────────────────────────────────────────────────────────────────
//   kind === 'account'  ⇒ compte              (explicite, prioritaire)
//   kind === 'contact'  ⇒ contact             (explicite, prioritaire)
//   kind absent (legacy) ⇒ compte si AUCUN nom de personne, contact sinon
//
// ⚠️ L'HEURISTIQUE NE S'APPLIQUE QU'AU LEGACY. Un `kind` renseigné est une
// DÉCLARATION : la deviner à nouveau reviendrait à contredire l'utilisateur qui
// l'a posée. C'est exactement le court-circuit qui manquait à `jarvisAgent.ts`.

/** Forme minimale requise pour classer — volontairement structurelle. */
export interface LeadKindShape {
  kind?: string
  firstName?: string
  lastName?: string
}

/** Un nom de personne est-il réellement renseigné ? (espaces seuls = absent) */
function porteUnNomDePersonne(l: LeadKindShape): boolean {
  return Boolean((l.firstName || '').trim() || (l.lastName || '').trim())
}

/**
 * Le lead est-il un COMPTE (une entreprise, sans personne) ?
 *
 * Unique définition du dépôt. Toute autre implémentation est un défaut.
 */
export function isAccountLead(l: LeadKindShape): boolean {
  if (l.kind === 'account') return true
  if (l.kind === 'contact') return false
  return !porteUnNomDePersonne(l)
}

/**
 * Le lead est-il un CONTACT (une personne) ?
 *
 * Strictement le complément d'`isAccountLead` : la partition est TOTALE, il
 * n'existe pas de troisième classe. Défini par négation plutôt que réécrit,
 * pour qu'aucune dérive ne puisse s'installer entre les deux.
 */
export function isContactLead(l: LeadKindShape): boolean {
  return !isAccountLead(l)
}

// ─── PROJECTION « COMPTES » ──────────────────────────────────────────────────
//
// L'écran regroupe les leads par entreprise. Ce regroupement est UTILE — voir
// tous les contacts d'une même société — mais il ne crée pas de compte : un
// groupe peut parfaitement n'être porté que par des contacts.
//
// ⚠️ LE DÉFAUT HISTORIQUE ÉTAIT ICI, ET IL ÉTAIT DE DÉNOMBREMENT. L'en-tête
// affichait `new Set(leads.map(l => l.company)).size` sous l'étiquette
// « comptes ». C'est le nombre de NOMS D'ENTREPRISE DISTINCTS, comptes et
// contacts confondus — jamais le nombre de fiches compte. Un workspace ne
// contenant qu'un contact chez « Acme » annonçait « 1 compte » alors que Jarvis,
// qui dénombre de vraies entités, annonçait « 0 compte(s) ». Les deux lisaient
// les mêmes lignes ; un seul comptait des entités.
//
// Cette fonction rend les trois grandeurs SÉPARÉMENT et nommément, pour qu'on
// ne puisse plus présenter l'une à la place de l'autre.

/** Une entreprise et ce qui s'y rattache. `account` absent = aucune fiche compte. */
export interface AccountGroup<T extends LeadKindShape> {
  /** Nom affichable. Vaut `'—'` quand aucune entreprise n'est renseignée. */
  company: string
  /**
   * Une entreprise est-elle RÉELLEMENT renseignée ?
   *
   * ⚠️ NE PAS DÉDUIRE CETTE RÉPONSE DE `company`. Le groupe des leads sans
   * entreprise porte le libellé `'—'`, qui est un placeholder d'affichage, pas
   * un nom. Le tester par comparaison de chaîne confondrait « pas d'entreprise »
   * avec « une entreprise nommée “—” » — c'est exactement le défaut corrigé
   * ici : un contact sans entreprise était annoncé « 1 entreprise liée sans
   * fiche compte », alors qu'aucune entreprise n'est liée.
   */
  hasCompany: boolean
  /** La fiche compte, si elle existe RÉELLEMENT comme entité. */
  account?: T
  contacts: T[]
}

export interface AccountProjection<T extends LeadKindShape> {
  /** Entités compte réelles. C'est CE nombre qui peut s'appeler « comptes ». */
  accounts: T[]
  /** Entités contact réelles. */
  contacts: T[]
  /** Groupes par entreprise, triés par nom — comptes et sans-fiche mêlés. */
  groups: AccountGroup<T>[]
  /**
   * Groupes portés uniquement par des contacts : l'entreprise est connue (elle
   * est persistée DANS le contact), mais aucune fiche compte n'a été créée.
   * Grandeur distincte, jamais à additionner avec `accounts`.
   *
   * ⚠️ Les contacts SANS entreprise en sont exclus (`hasCompany`). Leur groupe
   * d'affichage `'—'` reste dans `groups` — la vue en a besoin — mais il ne
   * désigne aucune entreprise, donc il ne s'y compte pas.
   */
  companiesWithoutAccount: AccountGroup<T>[]
}

const SANS_ENTREPRISE = '—'

/** Regroupe et dénombre. Pure : aucune entrée n'est modifiée. */
export function projectAccounts<T extends LeadKindShape & { company?: string }>(
  leads: T[],
): AccountProjection<T> {
  const groups = new Map<string, AccountGroup<T>>()
  const accounts: T[] = []
  const contacts: T[] = []

  for (const l of leads) {
    const renseignee = (l.company || '').trim()
    const company = renseignee || SANS_ENTREPRISE
    let g = groups.get(company)
    if (!g) {
      g = { company, hasCompany: Boolean(renseignee), contacts: [] }
      groups.set(company, g)
    }
    if (isAccountLead(l)) {
      accounts.push(l)
      // Deux fiches compte pour une même entreprise : on garde la première
      // rencontrée, sans en inventer la fusion — ce lot ne touche pas au
      // modèle de données.
      if (!g.account) g.account = l
    } else {
      contacts.push(l)
      g.contacts.push(l)
    }
  }

  const ordonnes = Array.from(groups.values()).sort((a, b) => a.company.localeCompare(b.company))

  return {
    accounts,
    contacts,
    groups: ordonnes,
    // `hasCompany` d'abord : un contact sans entreprise n'est PAS une
    // « entreprise liée sans fiche compte ». Il n'y a rien à lier.
    companiesWithoutAccount: ordonnes.filter(
      (g) => g.hasCompany && !g.account && g.contacts.length > 0,
    ),
  }
}

/** Accord en nombre, sans dépendance externe. */
function pluriel(n: number, singulier: string, plur = `${singulier}s`): string {
  return `${n} ${n > 1 ? plur : singulier}`
}

/**
 * Libellé de l'en-tête de la vue Comptes.
 *
 * Les trois grandeurs restent NOMMÉES SÉPARÉMENT. L'entreprise connue par un
 * contact seul est mentionnée — elle est commercialement utile — mais elle
 * n'est jamais appelée « compte », et elle ne s'additionne jamais aux comptes.
 *
 * ⚠️ Elle n'est pas « non persistée » : le nom de l'entreprise EST bien
 * enregistré, dans le contact. C'est la FICHE COMPTE qui n'existe pas.
 */
export function summarizeAccounts<T extends LeadKindShape & { company?: string }>(
  projection: AccountProjection<T>,
): string {
  const parts = [pluriel(projection.accounts.length, 'compte')]
  if (projection.companiesWithoutAccount.length > 0) {
    parts.push(
      `${pluriel(projection.companiesWithoutAccount.length, 'entreprise')} liée${
        projection.companiesWithoutAccount.length > 1 ? 's' : ''
      } sans fiche compte`,
    )
  }
  parts.push(pluriel(projection.contacts.length, 'contact'))
  return parts.join(' · ')
}
