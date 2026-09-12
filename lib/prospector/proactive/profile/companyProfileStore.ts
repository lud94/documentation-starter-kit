// JS-012_BUSINESS_CONTEXT_V0_002 — PERSISTANCE DU PROFIL D'ENTREPRISE.
//
// ── UN `kind` PROPRE, JAMAIS PARTAGÉ ────────────────────────────────────────
// Le profil descriptif a SON `kind` dans le magasin générique. Écrire dans le
// `kind` de la configuration runtime proactive mêlerait un document édité par
// l'utilisateur à l'objet qui gouverne l'évaluation — la frontière que ce
// ticket existe précisément pour préserver. Ce module n'importe RIEN de la
// configuration runtime et ne peut pas l'atteindre.
//
// ── AUCUN DÉFAUT SILENCIEUX ─────────────────────────────────────────────────
// Un espace sans profil reçoit PROFILE_NOT_CONFIGURED, jamais un profil
// fabriqué. Décider à la place de l'utilisateur ce que vend son entreprise
// serait pire qu'inutile : ce serait faux.
//
// ── VERSION : IDENTIFIANT OPAQUE, PAS DE SÉQUENCE ───────────────────────────
// ⚠️ Chaque enregistrement accepté reçoit un `revisionId` UUID neuf, généré
// ICI, côté serveur. PAS de « lire N puis écrire N+1 » : le magasin générique
// est un dernier-écrit-gagnant aveugle, et un compteur lu-puis-incrémenté
// mentirait sous écrivains concurrents (deux lecteurs de N écriraient tous
// deux N+1). L'unicité de l'identifiant est garantie ; l'ordre ne l'est pas,
// et on ne le prétend pas. Aucune primitive CAS n'est ajoutée ici.
import { randomUUID } from 'node:crypto'

import { getItemStrict, upsertItem } from '../../../supabase/store'
import {
  COMPANY_PROFILE_SCHEMA_VERSION,
  validateCompanyProfileInput,
  validateStoredCompanyProfile,
  type CompanyBusinessProfileInputV0,
  type CompanyBusinessProfileV0,
} from './companyProfile'

/** `kind` du magasin — distinct de toute configuration runtime existante. */
export const COMPANY_PROFILE_KIND = 'company_business_profile'

/** Un seul profil actif par espace en V0. */
export const ACTIVE_PROFILE_ID = 'active'

export type ProfileLoad =
  | { ok: true; profile: CompanyBusinessProfileV0 }
  | { ok: false; state: 'PROFILE_NOT_CONFIGURED' }
  | { ok: false; state: 'PROFILE_INVALID'; reason: string }
  | { ok: false; state: 'PROFILE_UNAVAILABLE' }

/**
 * Charge le profil d'entreprise D'UN ESPACE.
 *
 * LECTURE STRICTE, puis validation de contrat LOCALE et déterministe — jamais
 * de réseau au-delà du magasin, jamais d'écriture, jamais de réparation. Une
 * ligne malformée est rendue PROFILE_INVALID avec sa raison ; elle n'est ni
 * corrigée ni remplacée. Absent ≠ base muette : `getItemStrict` distingue les
 * deux, et l'utilisateur ne sera jamais invité à configurer pendant une panne.
 */
export async function loadCompanyProfile(ws: string): Promise<ProfileLoad> {
  if (typeof ws !== 'string' || ws.trim() === '') {
    return { ok: false, state: 'PROFILE_NOT_CONFIGURED' }
  }

  const lu = await getItemStrict<unknown>(COMPANY_PROFILE_KIND, ACTIVE_PROFILE_ID, ws)
  if (lu.ok === false) return { ok: false, state: 'PROFILE_UNAVAILABLE' }
  // ⚠️ ABSENT ≠ MALFORMÉ (R1). `getItemStrict` rend `value:null` pour « aucune
  // ligne », et UNIQUEMENT pour cela. Toute valeur non-null — y compris un
  // jsonb falsy corrompu (`false`, `0`, `''`) — est une LIGNE EXISTANTE et doit
  // passer par la validation de contrat : la rendre NOT_CONFIGURED inviterait
  // à reconfigurer par-dessus une ligne présente, en masquant la corruption.
  if (lu.value === null) return { ok: false, state: 'PROFILE_NOT_CONFIGURED' }

  const validation = validateStoredCompanyProfile(lu.value)
  if (validation.ok === false) {
    const champ = validation.field ? `${validation.reason}:${validation.field}` : validation.reason
    return { ok: false, state: 'PROFILE_INVALID', reason: champ }
  }
  return { ok: true, profile: validation.profile }
}

/**
 * Enregistre le profil d'un espace à partir du CONTENU client validé.
 *
 * Les métadonnées sont CONSTRUITES ICI : schemaVersion (littéral du contrat),
 * revisionId (UUID serveur neuf à chaque enregistrement accepté), updatedAt
 * (horloge serveur). Rien de ce que le client envoie ne peut les fournir —
 * la validation d'entrée refuse déjà ces clés comme étrangères.
 *
 * Remplacement ENTIER du document actif : pas de fusion partielle en V0.
 */
export async function saveCompanyProfile(
  input: unknown,
  ws: string,
): Promise<{ ok: true; revisionId: string } | { ok: false; reason: string }> {
  if (typeof ws !== 'string' || ws.trim() === '') {
    return { ok: false, reason: 'workspace_missing' }
  }

  const validation = validateCompanyProfileInput(input)
  if (validation.ok === false) {
    const champ = validation.field ? `${validation.reason}:${validation.field}` : validation.reason
    return { ok: false, reason: champ }
  }

  const stocke: CompanyBusinessProfileV0 = {
    ...(validation.profile as CompanyBusinessProfileInputV0),
    schemaVersion: COMPANY_PROFILE_SCHEMA_VERSION,
    revisionId: randomUUID(),
    updatedAt: new Date().toISOString(),
  }

  const ecrit = await upsertItem(COMPANY_PROFILE_KIND, ACTIVE_PROFILE_ID, stocke, ws)
  if (!ecrit) return { ok: false, reason: 'store_write_failed' }
  return { ok: true, revisionId: stocke.revisionId }
}
