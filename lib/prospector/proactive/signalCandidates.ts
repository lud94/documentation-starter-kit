// SIGNAL-PRODUCT-REACHABILITY-001-R1c — REGISTRE SERVEUR DES CANDIDATS.
//
// ── LA FRONTIÈRE QUE CE MODULE RÉTABLIT ─────────────────────────────────────
//
//     le navigateur DÉSIGNE un candidat
//     !=
//     le navigateur CONSTRUIT un candidat
//
// En R1b, `/api/signals/promote` recevait `hits: SignalHit[]` et fabriquait ses
// `SourceEvidence` à partir de cet objet. Un navigateur modifié pouvait donc
// choisir lui-même `eventStatus`, `eventDate`, `claimNature`, `roleStatus`,
// `sourceUrl`… puis soumettre une `canonicalKey` cohérente avec ses propres
// valeurs. Toutes les gardes du Bridge s'appliquaient alors à une revendication
// écrite par l'attaquant : elles restaient vraies, et parfaitement inutiles.
//
// ── POURQUOI UN REGISTRE, ET PAS UN REÇU SIGNÉ ──────────────────────────────
// Les deux familles étaient recevables. Le registre a été retenu parce que le
// dépôt possède DÉJÀ un magasin générique cloisonné par espace
// (`prospector_store (kind, id, workspace_id, data)`, RLS incluse) : le
// cloisonnement, la durabilité et la révocation existent sans rien ajouter.
//
// Surtout, il supprime le problème plutôt que de le contrôler : avec un reçu
// signé, le navigateur RENVOIE la charge utile et le serveur vérifie qu'elle n'a
// pas bougé ; avec un registre, le navigateur ne renvoie RIEN de porteur de
// vérité — il n'y a plus de charge utile à falsifier, donc plus de vérification
// à réussir ou à rater. Aucun secret de plus, aucune séparation de domaine à
// maintenir, aucune expiration à arbitrer.
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// ⚠️ CE N'EST PAS UNE ONTOLOGIE MÉTIER `Signal`. Aucune table, aucune migration,
// aucun cycle de vie, aucun statut produit. C'est un TAMPON D'INTÉGRITÉ : le
// serveur y dépose ce qu'il a lui-même produit, pour pouvoir le reconstituer à
// l'identique au moment de l'adjudication. Rien d'autre ne doit s'y greffer.
import { createHash } from 'crypto'

import { getItemStrict, upsertItem } from '../../supabase/store'
import type { AcquisitionFactV2, SignalHit } from '../../../types/prospector'
import { canonicalJson, isAcquisitionFactV2 } from './acquisitionV2'

/**
 * `kind` du magasin.
 *
 * ⚠️ DISTINCT des `PROACTIVE_KINDS` et de `BUSINESS_CONTEXT_KIND`. Un candidat
 * n'est ni un fait, ni une interprétation, ni une configuration : c'est une
 * proposition non adjugée. Les ranger ensemble ferait relire une proposition
 * comme une evidence.
 */
export const SIGNAL_CANDIDATE_KIND = 'proactive_signal_candidate'

/**
 * Les champs PORTEURS DE VÉRITÉ d'un candidat — ceux dont dépend la
 * revendication reconstruite, donc ceux que le navigateur ne doit jamais
 * pouvoir choisir.
 *
 * ⚠️ CETTE LISTE EST LA FRONTIÈRE. Tout champ qui entre un jour dans la
 * construction d'une `SourceEvidence` ou d'une `canonicalKey` doit être ici, ET
 * dans `CHAMPS_SIGNES` : un champ oublié redevient contrôlable par le client.
 */
export interface CandidateClaim {
  company: string
  signalType: SignalHit['signalType']
  sourceUrl: string
  claimNature: SignalHit['claimNature']
  eventStatus: SignalHit['eventStatus']
  eventDate: string | null
  eventDatePrecision: SignalHit['eventDatePrecision']
  sourcePublishedAt: string | null
  roleStatus: SignalHit['roleStatus']
  roleFunction: SignalHit['roleFunction']
  /**
   * SIREN tel que le modèle l'a proposé — CANDIDAT, jamais identité.
   *
   * ⚠️ Il ne sert QU'À INTERROGER data.gouv au moment de l'adjudication. Le
   * registre officiel est l'autorité ; ce champ n'est qu'une clé de recherche,
   * exactement comme dans `importSignalToPipeline`.
   */
  candidateSiren: string | null

  /**
   * Fait structuré V2 VALIDÉ, porté verbatim (SIGNAL_ACQUISITION_CONTRACT_002).
   *
   * ⚠️ PORTEUR DE VÉRITÉ : il entre dans la construction des `SourceEvidence`
   * et du mapping V2, donc dans le condensat d'identité — mais par un SEGMENT
   * SÉPARÉ, absent quand il vaut `null`, pour que l'identité de tout candidat
   * V1 déjà émis reste octet pour octet inchangée.
   *
   * ⚠️ `null`, JAMAIS ABSENT : `readCandidate` vérifie la présence de chaque
   * champ signé ; un champ optionnel ne serait pas vérifiable. Les lignes
   * héritées sans ce champ restent lisibles (voir `readCandidate`).
   */
  v2: AcquisitionFactV2 | null
}

export interface SignalCandidate {
  id: string
  claim: CandidateClaim
  /** Instant SERVEUR d'émission. Jamais fourni par le navigateur. */
  issuedAt: string
}

/**
 * Ordre FIGÉ des champs signés : l'identité d'un candidat est un condensat de
 * ces valeurs, et l'ordre en fait partie. Le changer change toutes les
 * identités — ce qui est correct, mais doit être un geste conscient.
 */
const CHAMPS_SIGNES: readonly (keyof CandidateClaim)[] = [
  'company', 'signalType', 'sourceUrl', 'claimNature', 'eventStatus',
  'eventDate', 'eventDatePrecision', 'sourcePublishedAt',
  'roleStatus', 'roleFunction', 'candidateSiren',
]

/**
 * Identité DÉTERMINISTE d'un candidat, dans un espace donné.
 *
 * ⚠️ L'ESPACE ENTRE DANS LE CONDENSAT — MAIS CE N'EST PAS LÀ QUE LE
 * CLOISONNEMENT SE JOUE, et il faut le dire exactement. Ce qui ferme réellement
 * la réutilisation inter-espaces, c'est la LECTURE : `readCandidate` interroge
 * le magasin avec le `ws` de la session, et un identifiant émis ailleurs n'y
 * désigne aucune ligne. Vérifié par mutation : retirer `ws` du condensat ne fait
 * échouer aucun test, parce que la lecture cloisonnée suffit déjà.
 *
 * On le conserve en défense en profondeur — deux espaces qui découvriraient le
 * même signal obtiennent des identifiants distincts, donc un identifiant ne
 * voyage pas — mais il ne faut pas le présenter comme la garde. La garde est le
 * cloisonnement du magasin.
 *
 * Déterministe pour que relancer la même recherche ne multiplie pas les lignes.
 *
 */
export function candidateId(claim: CandidateClaim, ws: string): string {
  const charge = CHAMPS_SIGNES.map((c) => `${c}=${String(claim[c] ?? '')}`).join(' ')
  // ⚠️ SEGMENT V2 SÉPARÉ, ABSENT QUAND `v2` EST NUL. Tout candidat V1 déjà émis
  // garde ainsi une identité octet pour octet inchangée. Le bloc V2 est
  // porteur de vérité (il construit `SourceEvidence` et le mapping V2) : le
  // laisser hors du condensat permettrait de substituer son contenu sous un
  // identifiant existant. Sérialisation canonique — l'ordre des clés d'un
  // `jsonb` relu n'est pas garanti, et `String(objet)` ne condense rien.
  const v2 = claim.v2 ? `\nv2=${canonicalJson(claim.v2)}` : ''
  // Séparation de domaine : ce condensat ne doit jamais entrer en collision
  // avec un autre usage du même magasin.
  const h = createHash('sha256').update(`signal-candidate:v1:${ws} ${charge}${v2}`).digest('hex')
  return `cand_${h.slice(0, 32)}`
}

/** Extrait du `SignalHit` produit par le SERVEUR sa part porteuse de vérité. */
export function claimFromHit(hit: SignalHit): CandidateClaim | null {
  const company = String(hit?.company || '').trim()
  const sourceUrl = String(hit?.sourceUrl || '').trim()
  // Sans entreprise ni source, il n'y a rien à adjuger plus tard : on n'émet pas
  // un candidat qui ne pourra jamais devenir un fait.
  if (!company || !sourceUrl) return null

  // ⚠️ V2 PRÉSENT MAIS MALFORMÉ ⇒ AUCUN CANDIDAT — le même refus qu'une ligne
  // inécrivable : pas d'identifiant émis. On ne DÉPOUILLE jamais un bloc V2
  // abîmé pour continuer en V1 : un hit qui prétendait porter un fait structuré
  // et ne le porte pas n'est pas un hit V1, c'est un hit invalide.
  if (hit?.v2 !== undefined && !isAcquisitionFactV2(hit.v2)) return null

  const siren = String(hit?.siren || '').trim()
  return {
    v2: hit?.v2 ?? null,
    company,
    signalType: hit.signalType,
    sourceUrl,
    claimNature: hit.claimNature,
    eventStatus: hit.eventStatus,
    eventDate: hit.eventDate ?? null,
    eventDatePrecision: hit.eventDatePrecision,
    sourcePublishedAt: hit.sourcePublishedAt ?? null,
    roleStatus: hit.roleStatus,
    roleFunction: hit.roleFunction,
    candidateSiren: /^\d{9}$/.test(siren) ? siren : null,
  }
}

/**
 * Reconstitue le `SignalHit` que le Bridge consommera, À PARTIR DU REGISTRE.
 *
 * ⚠️ AUCUN CHAMP NE VIENT DE LA REQUÊTE. `detail` et `icebreaker` sont vides à
 * dessein : ce sont des textes d'affichage, ils ne portent aucune vérité et
 * n'entrent dans aucune revendication. Les faire transiter n'ajouterait qu'une
 * surface d'injection.
 *
 * `verified: false` est LITTÉRAL : la vérification d'identité se fait en aval,
 * sur le registre officiel, et ce champ ne doit jamais la préempter.
 */
export function hitFromCandidate(candidate: SignalCandidate): SignalHit {
  const c = candidate.claim
  return {
    company: c.company,
    signalType: c.signalType,
    detail: '',
    icebreaker: '',
    sourceUrl: c.sourceUrl,
    verified: false,
    claimNature: c.claimNature,
    eventStatus: c.eventStatus,
    eventDate: c.eventDate,
    eventDatePrecision: c.eventDatePrecision,
    sourcePublishedAt: c.sourcePublishedAt,
    roleStatus: c.roleStatus,
    roleFunction: c.roleFunction,
    // ⚠️ LE BLOC V2 VIENT DU REGISTRE, PAS DE LA REQUÊTE — comme tout le reste.
    ...(c.v2 ? { v2: c.v2 } : {}),
  } as SignalHit
}

/**
 * Enregistre les candidats d'une recherche et rend leurs identifiants.
 *
 * ⚠️ APPELÉ DEPUIS LE SERVEUR UNIQUEMENT (`/api/signals/search`), avec des
 * `SignalHit` que le serveur vient de produire. Passer ici un objet reçu d'un
 * navigateur ferait exactement rentrer par la fenêtre ce que ce module ferme.
 *
 * Une ligne qui n'a pas pu être écrite ne reçoit PAS d'identifiant : mieux vaut
 * un candidat non promouvable qu'un identifiant qui ne désignera rien.
 */
export async function registerCandidates(
  hits: readonly SignalHit[], ws: string, now: () => Date = () => new Date(),
): Promise<(string | null)[]> {
  if (typeof ws !== 'string' || ws.trim() === '') return hits.map(() => null)

  const sorties: (string | null)[] = []
  for (const hit of hits) {
    const claim = claimFromHit(hit)
    if (!claim) { sorties.push(null); continue }

    const id = candidateId(claim, ws)
    const candidate: SignalCandidate = { id, claim, issuedAt: now().toISOString() }
    const ecrit = await upsertItem(SIGNAL_CANDIDATE_KIND, id, candidate, ws)
    sorties.push(ecrit ? id : null)
  }
  return sorties
}

export type CandidateRead =
  | { ok: true; candidate: SignalCandidate }
  | { ok: false; state: 'CANDIDATE_UNKNOWN' }
  | { ok: false; state: 'CANDIDATE_STORE_UNAVAILABLE' }

/**
 * Relit un candidat DANS SON ESPACE.
 *
 * ⚠️ TROIS ÉTATS, jamais deux. « ce candidat n'existe pas ici » et « je n'ai pas
 * pu regarder » appellent des gestes opposés : le premier est un refus
 * définitif, le second un réessai. Les confondre ferait dire « candidat
 * inconnu » pendant une panne, et l'utilisateur relancerait une recherche
 * entière pour rien.
 *
 * ⚠️ REVALIDÉ À LA RELECTURE. Ce qui remonte est du `jsonb` que rien ne
 * contraint côté base. Une ligne écrite par une version antérieure du contrat,
 * ou tronquée, ne doit pas devenir la revendication d'un fait.
 *
 * ⚠️ L'IDENTITÉ EST RECALCULÉE. Le condensat est reconstruit à partir du contenu
 * relu et comparé à l'identifiant demandé : une ligne dont le contenu aurait été
 * modifié sous l'identifiant d'un autre candidat — par une écriture directe en
 * base, une restauration, ou une clé de service — ne peut pas se faire passer
 * pour lui.
 */
export async function readCandidate(id: unknown, ws: string): Promise<CandidateRead> {
  if (typeof id !== 'string' || !/^cand_[0-9a-f]{32}$/.test(id.trim())) {
    return { ok: false, state: 'CANDIDATE_UNKNOWN' }
  }
  const cle = id.trim()

  const lu = await getItemStrict<SignalCandidate>(SIGNAL_CANDIDATE_KIND, cle, ws)
  if (lu.ok === false) return { ok: false, state: 'CANDIDATE_STORE_UNAVAILABLE' }
  if (!lu.value) return { ok: false, state: 'CANDIDATE_UNKNOWN' }

  const brut = lu.value
  const claim = brut.claim
  if (!claim || typeof claim !== 'object') return { ok: false, state: 'CANDIDATE_UNKNOWN' }
  for (const champ of CHAMPS_SIGNES) {
    if (!(champ in claim)) return { ok: false, state: 'CANDIDATE_UNKNOWN' }
  }
  // ⚠️ V2 : ABSENT (ligne héritée) ⇒ `null` ; PRÉSENT ⇒ bloc ENTIER et valide,
  // revalidé à la relecture comme tout le reste — un `jsonb` ne contraint rien.
  // L'identité est ensuite recalculée AVEC ce bloc : une substitution du fait
  // structuré sous un identifiant existant ne peut pas passer pour lui.
  const v2 = (claim as any).v2 ?? null
  if (v2 !== null && !isAcquisitionFactV2(v2)) return { ok: false, state: 'CANDIDATE_UNKNOWN' }
  const normalise: CandidateClaim = { ...claim, v2 }
  if (candidateId(normalise, ws) !== cle) return { ok: false, state: 'CANDIDATE_UNKNOWN' }

  return { ok: true, candidate: { id: cle, claim: normalise, issuedAt: String(brut.issuedAt || '') } }
}
