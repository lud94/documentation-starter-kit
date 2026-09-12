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

/**
 * ─── ANCRAGE LIÉ À L'ENTITÉ (JARVIS-CONTEXT-01b.2) ──────────────────────────
 *
 * ⚠️ DEUX SURCAPTURES SUCCESSIVES ONT ÉTÉ FERMÉES ICI. Elles avaient la même
 * cause : le pré-routeur cherchait un NOM d'entité quelque part, et un ANCRAGE
 * quelque part ailleurs, sans exiger qu'ils se rapportent l'un à l'autre.
 *
 *   01b   — `entreprises|societes|boites` valaient inventaire à eux seuls.
 *           « liste-moi des entreprises de cybersécurité à Lyon » partait en
 *           inventaire ; `source_companies` devenait inatteignable.
 *
 *   01b.1 — l'ancrage restait GLOBAL : la seule présence du mot « mes »
 *           suffisait, où qu'il soit. « Liste les entreprises de MES
 *           concurrents » et « montre les sociétés dans MES secteurs
 *           prioritaires » étaient donc capturées — le « mes » ne portait pas
 *           sur l'entité. Et `leads|personnes|interlocuteurs` n'exigeaient
 *           toujours aucun ancrage : « montre-moi des personnes chez
 *           Microsoft » partait en inventaire.
 *
 * LA RÈGLE EST DÉSORMAIS SYNTAXIQUE, PAS LEXICALE : l'ancrage doit être
 * ADJACENT au nom d'entité. « mes contacts » ancre ; « mes concurrents » dans
 * une phrase parlant de contacts n'ancre rien.
 *
 * ── CONSERVATEUR PAR CONSTRUCTION ───────────────────────────────────────────
 * Aucun nom nu ne déclenche plus l'inventaire — pas même `contacts` ou
 * `comptes`. « Affiche les comptes cibles SaaS en France » et « liste les
 * contacts commerciaux chez Acme » retournent `null`.
 *
 * C'est un choix ASYMÉTRIQUE et délibéré : laisser une formulation ambiguë au
 * classifieur ne coûte qu'un appel au modèle — qui, lui, dispose du contrat
 * complet et peut choisir `list_inventory`. Voler une intention de sourcing,
 * en revanche, rend une capacité DÉFINITIVEMENT inatteignable, sans recours et
 * sans trace. Les deux erreurs n'ont pas le même prix.
 */
const NOMS_CONTACT = 'contacts?|personnes?|interlocuteurs?'
const NOMS_COMPTE = 'comptes?|entreprises?|societes?|boites?'
const NOMS_LEAD = 'leads?'

/** L'espace du client, jamais le monde extérieur. */
const LIEU = '(?:mon|ma|le|la) (?:espace|pipe|pipeline|base|portefeuille)'

/** État qui n'a de sens que pour une donnée déjà entrée dans Prospector. */
const DEJA_LA = '(?:deja (?:presentes?|present|la|ici|importees?|importe|enregistrees?)|importees?|enregistrees?)'

/**
 * Construit le motif d'un nom d'entité RÉELLEMENT ancré.
 *
 * Trois formes, toutes adjacentes au nom :
 *   « (tous) mes <nom> »            possessif direct
 *   « <nom> de|dans <lieu> »        rattachement à l'espace
 *   « <nom> déjà présentes »        état d'appartenance
 */
function ancre(noms: string): RegExp {
  return new RegExp(
    '\\b(?:' +
      [
        `(?:tous |toutes )?mes (?:${noms})`,
        `(?:${noms}) (?:de|dans) ${LIEU}`,
        `(?:${noms}) du (?:pipe|pipeline)`,
        `(?:${noms}) ${DEJA_LA}`,
      ].join('|') +
      ')\\b',
  )
}

const CONTACT_ANCRE = ancre(NOMS_CONTACT)
const COMPTE_ANCRE = ancre(NOMS_COMPTE)
const LEAD_ANCRE = ancre(NOMS_LEAD)

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

  // Chaque entité doit porter SON PROPRE ancrage, adjacent à son nom. Un
  // « mes » qui se rapporte à autre chose — « les entreprises de mes
  // concurrents » — n'ancre rien.
  const contact = CONTACT_ANCRE.test(m)
  const compte = COMPTE_ANCRE.test(m)
  // « mes leads » ne distingue pas comptes et contacts : c'est l'espace entier.
  if (LEAD_ANCRE.test(m)) return 'all'

  if (contact && compte) return 'all'
  if (contact) return 'contacts'
  if (compte) return 'accounts'

  // Aucun nom d'entité ANCRÉ : « liste les séquences », « affiche les comptes
  // cibles SaaS en France », « montre-moi des personnes chez Microsoft ». On
  // laisse le classifieur trancher — il a le contrat complet sous les yeux.
  return null
}

/** Le périmètre annoncé par le LLM, ramené à une valeur connue. */
export function normalizeScope(valeur: unknown): InventoryScope {
  return valeur === 'contacts' || valeur === 'accounts' || valeur === 'all' ? valeur : 'all'
}
