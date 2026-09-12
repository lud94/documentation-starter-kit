// JS-012_BUSINESS_CONTEXT_V0_002 — PROFIL D'ENTREPRISE V0.
//
// ── CE QU'EST CE CONTRAT, ET CE QU'IL N'EST PAS ─────────────────────────────
//
// Le profil d'entreprise décrit la RÉALITÉ COMMERCIALE d'un espace : ce que
// l'entreprise vend, à qui, où, face à qui. C'est un contexte DESCRIPTIF,
// cloisonné à l'espace — jamais une autorité.
//
// Il est DISTINCT de la configuration runtime proactive existante (le contexte
// d'évaluation du kernel, qui porte identité de configuration, périmètre,
// capacités d'exécution et politique d'interprétation). Ces deux objets ne
// fusionnent pas : l'un décrit l'entreprise, l'autre gouverne l'évaluation.
//
// LE PROFIL N'ACCORDE RIEN. Aucun champ d'ici ne porte de rôle, de périmètre,
// de capacité, de contrôle, de politique d'interprétation versionnée ni
// d'identité de configuration d'évaluation. C'est vrai PAR CONSTRUCTION : ces
// champs n'existent pas dans le contrat, et les tests le verrouillent.
//
// ⚠️ PAS DE NOM D'ENTREPRISE ICI. L'espace possède déjà son nom canonique
// (prospector_workspaces.name) ; le profil est cloisonné à l'espace. Un second
// champ de nom créerait une deuxième source de vérité.
//
// MODULE PUR : types, constantes et validation locale déterministe. Aucun
// stockage, aucune auth, aucun réseau, aucun LLM, aucune mutation.

/** Version du SCHÉMA du profil persisté. */
export const COMPANY_PROFILE_SCHEMA_VERSION = 'company-profile-v0.1'

/**
 * Champ de connaissance — INCONNU ≠ VIDE CONNU, structurellement.
 *
 *   { state: 'UNKNOWN' }            → jamais renseigné : on ne sait pas.
 *   { state: 'KNOWN', value: [] }   → renseigné VIDE : on sait qu'il n'y en
 *                                     a pas (listes uniquement).
 *   { state: 'KNOWN', value: T }    → renseigné.
 *
 * Un texte KNOWN blanc est INVALIDE : le vide d'un texte ne se déclare pas en
 * envoyant du blanc, il se déclare en restant UNKNOWN. Une liste KNOWN vide
 * est VALIDE : c'est l'affirmation explicite « aucun ».
 */
export type ProfileField<T> =
  | { readonly state: 'UNKNOWN' }
  | { readonly state: 'KNOWN'; readonly value: T }

/** Une offre nommée. La description est optionnelle mais jamais blanche. */
export interface CompanyOfferV0 {
  readonly name: string
  readonly description?: string
}

/**
 * Contenu ÉCRIVIBLE PAR LE CLIENT — les 8 champs descriptifs, tous REQUIS au
 * niveau du contrat. « Je ne sais pas » s'envoie EXPLICITEMENT :
 * `{ state: 'UNKNOWN' }`. Un champ omis n'est jamais converti en UNKNOWN —
 * l'oubli ne vaut pas déclaration d'ignorance.
 */
export interface CompanyBusinessProfileInputV0 {
  readonly whatWeSell: ProfileField<string>
  readonly offers: ProfileField<readonly CompanyOfferV0[]>
  readonly icp: ProfileField<string>
  readonly targetPersonas: ProfileField<readonly string[]>
  readonly sectors: ProfileField<readonly string[]>
  readonly geographies: ProfileField<readonly string[]>
  readonly competitors: ProfileField<readonly string[]>
  readonly commercialObjectives: ProfileField<string>
}

/**
 * Profil PERSISTÉ : le contenu client + les métadonnées CONSTRUITES PAR LE
 * SERVEUR. Le client ne fournit JAMAIS schemaVersion, revisionId ni updatedAt.
 *
 * ── GARANTIE DE VERSION V0, ET RIEN DE PLUS ─────────────────────────────────
 * Chaque enregistrement accepté reçoit un `revisionId` OPAQUE unique et un
 * `updatedAt` serveur ; une lecture restitue ces valeurs telles quelles.
 * AUCUNE garantie de séquence monotone ni de concurrence optimiste : la
 * persistance sous-jacente est un dernier-écrit-gagnant, et prétendre plus
 * serait mentir. Pas d'historique, pas d'event sourcing.
 */
export interface CompanyBusinessProfileV0 extends CompanyBusinessProfileInputV0 {
  readonly schemaVersion: typeof COMPANY_PROFILE_SCHEMA_VERSION
  readonly revisionId: string
  readonly updatedAt: string
}

export type ProfileRejection =
  | 'profile_missing'
  | 'schema_version_invalid'
  | 'field_missing'
  | 'unknown_key'
  | 'field_state_invalid'
  | 'unknown_carries_value'
  | 'known_missing_value'
  | 'text_blank'
  | 'list_invalid'
  | 'list_entry_invalid'
  | 'offer_invalid'
  | 'metadata_invalid'

export type ProfileValidation<T> =
  | { ok: true; profile: T }
  | { ok: false; reason: ProfileRejection; field?: string }

// ── ENSEMBLES FERMÉS — gelés : constantes de module, jamais mutables. ───────

const TEXT_FIELDS = Object.freeze(['whatWeSell', 'icp', 'commercialObjectives'] as const)
const LIST_FIELDS = Object.freeze([
  'targetPersonas', 'sectors', 'geographies', 'competitors',
] as const)
export const PROFILE_CONTENT_FIELDS = Object.freeze([
  'whatWeSell', 'offers', 'icp', 'targetPersonas',
  'sectors', 'geographies', 'competitors', 'commercialObjectives',
] as const)
const STORED_METADATA_FIELDS = Object.freeze(['schemaVersion', 'revisionId', 'updatedAt'] as const)

function texteNonBlanc(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Valide UN champ de connaissance. FAIL CLOSED :
 * - state hors {UNKNOWN, KNOWN} → refus ;
 * - UNKNOWN portant une valeur → refus (une ignorance ne transporte rien) ;
 * - KNOWN sans valeur → refus ;
 * - clés parasites dans le wrapper → refus.
 * La validation INSPECTE le blanc (trim) mais ne réécrit JAMAIS l'entrée.
 */
function champValide(
  brut: unknown,
  field: string,
  valeurValide: (v: unknown, field: string) => ProfileRejection | null,
): { ok: true } | { ok: false; reason: ProfileRejection; field: string } {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) {
    return { ok: false, reason: 'field_state_invalid', field }
  }
  const f = brut as Record<string, unknown>
  const cles = Object.keys(f)

  if (f.state === 'UNKNOWN') {
    if (cles.length !== 1) return { ok: false, reason: 'unknown_carries_value', field }
    return { ok: true }
  }
  if (f.state === 'KNOWN') {
    if (!('value' in f)) return { ok: false, reason: 'known_missing_value', field }
    if (cles.length !== 2) return { ok: false, reason: 'field_state_invalid', field }
    const refus = valeurValide(f.value, field)
    if (refus) return { ok: false, reason: refus, field }
    return { ok: true }
  }
  return { ok: false, reason: 'field_state_invalid', field }
}

function valeurTexte(v: unknown): ProfileRejection | null {
  // KNOWN blanc = invalide : le vide d'un texte se déclare en UNKNOWN.
  return texteNonBlanc(v) ? null : 'text_blank'
}

function valeurListe(v: unknown): ProfileRejection | null {
  if (!Array.isArray(v)) return 'list_invalid'
  // [] est VALIDE : « aucun » affirmé explicitement.
  for (const entree of v) {
    if (!texteNonBlanc(entree)) return 'list_entry_invalid'
  }
  return null
}

function valeurOffres(v: unknown): ProfileRejection | null {
  if (!Array.isArray(v)) return 'list_invalid'
  for (const offre of v) {
    if (!offre || typeof offre !== 'object' || Array.isArray(offre)) return 'offer_invalid'
    const o = offre as Record<string, unknown>
    const cles = Object.keys(o)
    if (!texteNonBlanc(o.name)) return 'offer_invalid'
    if ('description' in o) {
      if (!texteNonBlanc(o.description)) return 'offer_invalid'
      if (cles.length !== 2) return 'offer_invalid'
    } else if (cles.length !== 1) {
      return 'offer_invalid'
    }
  }
  return null
}

function validerContenu(
  brut: Record<string, unknown>,
  clesAutorisees: readonly string[],
): { ok: true } | { ok: false; reason: ProfileRejection; field?: string } {
  // Clés inconnues : REFUSÉES. Un champ non contractuel qui passerait en
  // silence deviendrait un canal de contenu non validé.
  for (const cle of Object.keys(brut)) {
    if (!clesAutorisees.includes(cle)) {
      return { ok: false, reason: 'unknown_key', field: cle }
    }
  }
  // Champs requis : ABSENT ≠ UNKNOWN. L'omission échoue, elle ne se répare pas.
  for (const field of PROFILE_CONTENT_FIELDS) {
    if (!(field in brut)) return { ok: false, reason: 'field_missing', field }
  }
  for (const field of TEXT_FIELDS) {
    const v = champValide(brut[field], field, valeurTexte)
    if (v.ok === false) return v
  }
  for (const field of LIST_FIELDS) {
    const v = champValide(brut[field], field, valeurListe)
    if (v.ok === false) return v
  }
  const offres = champValide(brut.offers, 'offers', valeurOffres)
  if (offres.ok === false) return offres
  return { ok: true }
}

/**
 * Valide le CONTENU fourni par un client. Refuse toute clé de métadonnée
 * (schemaVersion, revisionId, updatedAt) et toute clé étrangère : le client
 * n'écrit que les 8 champs descriptifs, rien d'autre.
 */
export function validateCompanyProfileInput(
  input: unknown,
): ProfileValidation<CompanyBusinessProfileInputV0> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'profile_missing' }
  }
  const brut = input as Record<string, unknown>
  const v = validerContenu(brut, PROFILE_CONTENT_FIELDS)
  if (v.ok === false) return v
  return { ok: true, profile: brut as unknown as CompanyBusinessProfileInputV0 }
}

/**
 * Valide un profil PERSISTÉ relu du magasin — « validation de contrat à la
 * lecture » : structurelle, locale, déterministe. Ce n'est JAMAIS une
 * « revalidation métier » (re-vérifier des faits contre des sources) — cette
 * dernière est interdite sur un chemin de lecture.
 */
export function validateStoredCompanyProfile(
  input: unknown,
): ProfileValidation<CompanyBusinessProfileV0> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'profile_missing' }
  }
  const brut = input as Record<string, unknown>
  if (brut.schemaVersion !== COMPANY_PROFILE_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_version_invalid' }
  }
  if (!texteNonBlanc(brut.revisionId)) {
    return { ok: false, reason: 'metadata_invalid', field: 'revisionId' }
  }
  if (!texteNonBlanc(brut.updatedAt) || !Number.isFinite(Date.parse(brut.updatedAt as string))) {
    return { ok: false, reason: 'metadata_invalid', field: 'updatedAt' }
  }
  const v = validerContenu(brut, [...STORED_METADATA_FIELDS, ...PROFILE_CONTENT_FIELDS])
  if (v.ok === false) return v
  return { ok: true, profile: brut as unknown as CompanyBusinessProfileV0 }
}
