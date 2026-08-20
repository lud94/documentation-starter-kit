// JARVIS-CONTEXT-01b — INVENTAIRE D'ESPACE : LIRE CE QUI EXISTE, PAS LE COMPTER.
//
// ── POURQUOI CETTE CAPACITÉ EXISTE ───────────────────────────────────────────
// Jarvis n'avait aucune action d'inventaire. Le contrat SYSTEM offrait `stats`
// — décrite comme « chiffres du pipe (comptes, contacts, étapes) » — et
// `find_lead`, qui exige une requête. Face à « Liste-moi mes contacts », le
// classifieur n'avait donc qu'un candidat plausible : `stats`. L'utilisateur
// demandait QUI, Prospector répondait COMBIEN.
//
// Ce n'était pas un défaut de routage : la capacité manquait. On l'ajoute, on ne
// rebranche rien.
//
// ── CE MODULE EST PUR ────────────────────────────────────────────────────────
// Aucun réseau, aucun LLM, aucun accès au stockage : il reçoit une lecture déjà
// faite et rend du texte. C'est ce qui permet de tester le rendu, l'ordre, la
// troncature et la distinction « vide / panne » sans base ni clé d'API.
import type { Lead } from '../../types/prospector'
import type { StrictLeadsRead } from '../supabase/leads'
import { isAccountLead, isContactLead } from './leadKind'

export type InventoryScope = 'contacts' | 'accounts' | 'all'

/**
 * Nombre maximum d'entités listées par catégorie.
 *
 * Une réponse de canal texte (extension, Telegram) doit rester lisible. Au-delà,
 * on annonce explicitement le reste : une troncature silencieuse ferait croire
 * à un espace plus petit qu'il n'est — exactement le genre de demi-vérité que
 * ce chantier corrige.
 */
export const INVENTORY_LIMIT = 25

/** Ordre total et déterministe : deux exécutions rendent la même liste. */
function parNom(a: Lead, b: Lead): number {
  const cle = (l: Lead) =>
    `${(l.lastName || '').trim()} ${(l.firstName || '').trim()} ${(l.company || '').trim()}`
      .trim()
      .toLowerCase()
  const c = cle(a).localeCompare(cle(b), 'fr')
  // L'identifiant tranche les homonymes : sans lui, l'ordre dépendrait de
  // l'ordre d'arrivée des lignes, donc du plan de requête.
  return c !== 0 ? c : (a.id || '').localeCompare(b.id || '')
}

function parEntreprise(a: Lead, b: Lead): number {
  const c = (a.company || '').trim().toLowerCase().localeCompare((b.company || '').trim().toLowerCase(), 'fr')
  return c !== 0 ? c : (a.id || '').localeCompare(b.id || '')
}

/** Identité affichable d'une personne, sans jamais rendre une chaîne vide. */
function identite(l: Lead): string {
  const nom = `${(l.firstName || '').trim()} ${(l.lastName || '').trim()}`.trim()
  return nom || l.company?.trim() || 'Sans nom'
}

/**
 * ⚠️ AUCUNE DONNÉE DE CONTACT N'EST RENDUE ICI. Ni courriel, ni téléphone, ni
 * URL : un inventaire répond « qui est là », pas « comment les joindre ».
 * Les exposer par défaut ferait de chaque « liste mes contacts » une extraction.
 */
function ligneContact(l: Lead): string {
  const complements = [
    (l.title || '').trim(),
    (l.company || '').trim(),
  ].filter(Boolean)
  const statut = (l.status || '').trim()
  return `👤 ${identite(l)}${complements.length ? ` — ${complements.join(' · ')}` : ''}${statut ? ` [${statut}]` : ''}`
}

/**
 * Fiche compte. Le nom rendu est celui de l'ENTITÉ compte, et les métadonnées
 * sont uniquement celles déjà présentes sur la ligne — rien n'est enrichi, rien
 * n'est déduit.
 */
function ligneCompte(l: Lead): string {
  const nom = (l.company || '').trim() || 'Compte sans nom'
  const meta = [
    l.siren ? `SIREN ${l.siren}` : '',
    (l.city || '').trim(),
    (l.effectif || '').trim() ? `${(l.effectif || '').trim()} sal.` : '',
  ].filter(Boolean)
  return `🏢 ${nom}${meta.length ? ` (${meta.join(' · ')})` : ''}`
}

function bloc(titre: string, lignes: string[], total: number): string[] {
  if (total === 0) return [`${titre} : aucun.`]
  const out = [`${titre} (${total}) :`, ...lignes]
  if (total > lignes.length) {
    out.push(`… et ${total - lignes.length} de plus (${lignes.length} affichés sur ${total}).`)
  }
  return out
}

/**
 * Rend l'inventaire d'un espace.
 *
 * ⚠️ ESPACE VIDE ET PANNE DE STOCKAGE SONT DEUX RÉPONSES DISTINCTES. Répondre
 * « aucun contact » alors que la base est injoignable serait une affirmation
 * fausse sur les données du client — la faute exacte que la doctrine
 * fail-closed interdit. `listLeadsStrict` distingue les deux ; cette fonction
 * doit préserver la distinction jusqu'à l'écran.
 */
export function renderInventory(read: StrictLeadsRead, scope: InventoryScope): string {
  if (!read.ok) {
    return 'Je ne peux pas lire le pipeline pour le moment. Aucun inventaire ne peut être établi — réessaie dans un instant.'
  }

  const comptes = read.leads.filter(isAccountLead).sort(parEntreprise)
  const contacts = read.leads.filter(isContactLead).sort(parNom)

  if (read.leads.length === 0) {
    return 'Cet espace ne contient encore aucun lead. Importe des entreprises depuis Sourcing, ou ajoute un contact.'
  }

  const sections: string[] = []

  if (scope === 'accounts' || scope === 'all') {
    sections.push(
      ...bloc('Comptes', comptes.slice(0, INVENTORY_LIMIT).map(ligneCompte), comptes.length),
    )
  }
  if (scope === 'contacts' || scope === 'all') {
    if (sections.length) sections.push('')
    sections.push(
      ...bloc('Contacts', contacts.slice(0, INVENTORY_LIMIT).map(ligneContact), contacts.length),
    )
  }

  // ⚠️ UNE ENTREPRISE CITÉE PAR UN CONTACT N'EST PAS UN COMPTE. Elle n'apparaît
  // jamais dans la section Comptes — seules les entités `isAccountLead` y
  // figurent. La mentionner ici, séparément et nommément, évite que « 0 compte »
  // se lise comme « aucune entreprise connue ».
  if (scope === 'accounts' || scope === 'all') {
    const nomsDeComptes = new Set(comptes.map((l) => (l.company || '').trim().toLowerCase()))
    const sansFiche = new Set(
      contacts
        .map((l) => (l.company || '').trim())
        .filter((c) => c && !nomsDeComptes.has(c.toLowerCase())),
    )
    if (sansFiche.size > 0) {
      sections.push(
        '',
        `${sansFiche.size} entreprise(s) citée(s) par un contact n'ont pas de fiche compte : ${
          Array.from(sansFiche).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, INVENTORY_LIMIT).join(', ')
        }.`,
      )
    }
  }

  return sections.join('\n')
}

// ─── DÉTECTION D'INTENTION ───────────────────────────────────────────────────
//
// Déterministe et PRIORITAIRE sur le classifieur. Même contrat que
// `looksLikeReminderDirective` : le LLM reste maître du cas général, mais une
// poignée de formulations sans ambiguïté ne doivent plus pouvoir être
// réinterprétées d'une exécution à l'autre.

function normaliser(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * ⚠️ LES DEMANDES QUANTITATIVES SONT EXCLUES, ET C'EST LE POINT DÉLICAT.
 *
 * « Combien ai-je de contacts ? » demande un NOMBRE : c'est `stats`, et le
 * détourner vers l'inventaire déverserait une liste de 25 lignes là où un
 * chiffre était attendu. Ce lot ajoute une capacité ; il ne doit en retirer
 * aucune.
 */
const QUANTITATIF = /\b(combien|nombre|total|compte(?:ur)? de|statistiques?|stats)\b/

/** Verbes et tournures qui demandent explicitement à VOIR les entités. */
const DEMANDE_LISTE =
  /\b(liste|listes|lister|listing|inventaire|montre|montrer|affiche|afficher|enumere|enumerer|donne moi (?:la liste|les)|quels sont|quelles sont|qui sont|qui est dans)\b/

const NOM_CONTACT = /\b(contacts?|personnes?|interlocuteurs?)\b/

/**
 * ⚠️ « ENTREPRISE » N'EST PAS UN TERME D'INVENTAIRE (JARVIS-CONTEXT-01b.1).
 *
 * La première version reconnaissait `entreprises|societes|boites` au même titre
 * que `comptes`. Le pré-routeur volait alors des intentions de SOURCING avant
 * même que le classifieur les voie :
 *
 *   « liste-moi des entreprises de cybersécurité à Lyon »
 *   « quelles sont les entreprises SaaS françaises ? »
 *
 * Ces directives demandent à CHERCHER sur data.gouv, pas à relire l'espace.
 * Les router déterministement vers `list_inventory` rendait `source_companies`
 * inatteignable pour toute formulation commençant par un verbe de liste — une
 * capacité perdue en échange d'une capacité gagnée.
 *
 * La distinction est lexicale et nette : `compte` est un terme MÉTIER de
 * Prospector — on n'a de « comptes » que dans son propre espace. `entreprise`,
 * `société`, `boîte` désignent le monde entier.
 */
const NOM_COMPTE_FORT = /\b(comptes?)\b/
const NOM_COMPTE_GENERIQUE = /\b(entreprises?|societes?|boites?)\b/

/**
 * Ancrage explicite aux données DÉJÀ PRÉSENTES dans Prospector.
 *
 * Seul un tel ancrage autorise un terme générique à déclencher l'inventaire.
 * Sans lui, l'intention est ambiguë — et l'ambiguïté se tranche en rendant
 * `null` : le classifieur décide, comme avant ce lot.
 */
const ANCRAGE_ESPACE = new RegExp(
  '\\b(?:' +
    [
      'mes',
      '(?:mon|le|du|de mon|dans mon|dans le) (?:espace|pipe|pipeline|portefeuille)',
      '(?:ma|la|de ma|dans ma) base',
      'deja (?:presentes?|present|importees?|importe|dans|ici)',
    ].join('|') +
    ')\\b',
)

/**
 * Termes propres à Prospector, qui valent à eux seuls ancrage.
 *
 * ⚠️ `tout` / `tous` ONT ÉTÉ RETIRÉS. Ils n'ancrent rien — « liste des
 * entreprises tous secteurs » est du sourcing — et les conserver rouvrait par
 * la bande la capture qu'on vient de fermer.
 */
const NOM_TOUT = /\b(leads?|pipe|pipeline|espace)\b/

/**
 * Rend le périmètre d'inventaire demandé, ou `null` si la directive n'est pas
 * une demande d'inventaire explicite — auquel cas le classifieur décide, comme
 * avant.
 */
export function detectInventoryIntent(message: string): InventoryScope | null {
  const m = normaliser(message)
  if (!m) return null
  if (QUANTITATIF.test(m)) return null
  if (!DEMANDE_LISTE.test(m)) return null

  const contact = NOM_CONTACT.test(m)
  // Un terme générique ne compte que s'il est ancré à l'espace du client.
  const compte =
    NOM_COMPTE_FORT.test(m) || (NOM_COMPTE_GENERIQUE.test(m) && ANCRAGE_ESPACE.test(m))

  if (contact && compte) return 'all'
  if (contact) return 'contacts'
  if (compte) return 'accounts'
  if (NOM_TOUT.test(m)) return 'all'

  // Un verbe de liste sans objet reconnaissable — « liste les séquences » —
  // n'est pas un inventaire d'entités. On laisse le classifieur trancher.
  return null
}

/** Le périmètre annoncé par le LLM, ramené à une valeur connue. */
export function normalizeScope(valeur: unknown): InventoryScope {
  return valeur === 'contacts' || valeur === 'accounts' || valeur === 'all' ? valeur : 'all'
}
