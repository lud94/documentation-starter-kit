// EVAL-RUNNER-001a — GARDES DE FORME DU DECISION MODEL.
//
// ── POURQUOI CES FONCTIONS ONT QUITTÉ `persistence.ts` ──────────────────────
// Elles n'ont jamais rien eu à voir avec la persistance : ce sont des
// prédicats PURS sur la forme d'un objet. Elles y vivaient simplement parce que
// la base était, jusqu'ici, la seule frontière par laquelle des données non
// fiables entraient dans le moteur.
//
// Ce n'est plus vrai. Le runner d'évaluation lit du JSON de fichier, et doit
// appliquer EXACTEMENT les mêmes gardes. Les laisser dans `persistence.ts`
// l'aurait obligé soit à importer la couche Supabase pour valider un fichier —
// alors qu'il ne doit toucher aucune base — soit à recopier les prédicats, et
// deux définitions de « une evidence valide » divergent toujours.
//
// ⚠️ DÉPLACEMENT, PAS RÉÉCRITURE. Aucun prédicat n'est modifié ici.
//
// Ce module n'importe AUCUNE I/O : ni Supabase, ni réseau, ni système de
// fichiers. C'est ce qui le rend utilisable des deux côtés.
import { rulePackById } from './packs/registry'
import { isLensId } from './lens/registry'
import { AUTHORIZED_MOTIONS } from './motions'
import type {
  EvidenceEvent,
  Outcome,
  Recommendation,
  Situation,
} from './types'

export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function optionalDate(value: unknown): boolean {
  return value === undefined || validDate(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmpty(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmpty(item))
}

/**
 * ── POURQUOI REVALIDER À LA LECTURE ─────────────────────────────────────────
 * Une ligne relue est une ENTRÉE, pas une valeur de confiance. Elle vient d'un
 * processus distant, elle a pu être écrite par une version antérieure du code,
 * et `data` est un `jsonb` que rien ne contraint côté base. Faire confiance à sa
 * forme reviendrait à laisser un objet arbitraire entrer dans le moteur de
 * décision — lequel calcule ensuite des scores et des dates à partir de ces
 * champs. Un objet invalide est donc IGNORÉ, jamais réparé ni complété.
 */
export function isEvidenceEvent(value: any): value is EvidenceEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.scope) &&
    nonEmpty(value.type) &&
    !!value.source &&
    typeof value.source === 'object' &&
    nonEmpty(value.source.provider) &&
    nonEmpty(value.assertionType) &&
    validScore(value.confidence) &&
    validDate(value.observedAt) &&
    optionalDate(value.lastVerifiedAt) &&
    optionalDate(value.expiresAt) &&
    temporaliteCoherente(value)
  )
}

/**
 * INVARIANTS TEMPORELS — vérifiés à l'écriture ET à la lecture.
 *
 * ⚠️ AUCUNE VALEUR PAR DÉFAUT. Une temporalité absente est INVALIDE, elle n'est
 * jamais promue en `dated_event`. C'était le fail-open de la première version :
 * une ingestion qui oublie le champ verrait ses evidences devenir des événements
 * datés, donc porteuses d'urgence, sans que personne ne l'ait décidé.
 *
 *   `dated_event`   ⇒ `occurredAt` présent ET valide.
 *   `undated_state` ⇒ `occurredAt` ABSENT. Une date de survenue sur un état non
 *                     daté est une contradiction : on la refuse plutôt que de
 *                     l'ignorer, sans quoi elle finirait par être lue quelque
 *                     part.
 */
/**
 * ARCH-RULEPACK-001 — VALIDATION DES IDENTIFIANTS DE REGISTRE À L'EXÉCUTION.
 *
 * ⚠️ LE TYPAGE NE PROTÈGE PAS CETTE FRONTIÈRE. `RulePackId` et `LensId` sont
 * fermés à la COMPILATION, mais ce qui remonte de `prospector_store` est du
 * JSON : une ligne ancienne, corrompue ou écrite par une version future porte
 * un `rulePackId` que le compilateur n'a jamais vu. Prétendre le contraire
 * serait confondre une garantie de type avec une garantie de donnée.
 *
 * `rulePackById` et `isLensId` s'appuient sur `hasOwnProperty` : `__proto__`,
 * `constructor` et `toString` sont donc refusés comme n'importe quelle autre
 * chaîne inconnue, et non résolus via la chaîne de prototypes.
 */
function packEtTypeConnus(rulePackId: unknown, type: unknown): boolean {
  if (typeof rulePackId !== 'string' || typeof type !== 'string') return false
  const pack = rulePackById(rulePackId)
  if (!pack) return false
  // Le type doit être DÉCLARÉ PAR CE PACK. Un type valide chez un autre pack
  // ne l'est pas ici : c'est la résolution du play qui en dépend.
  return pack.declaredSituationTypes.includes(type)
}

/**
 * ARCH-HORIZON-001 — VALIDATION D'UN HORIZON ANTICIPÉ.
 *
 * ⚠️ N'EST APPELÉE QUE SI LE CHAMP EST PRÉSENT. Une Situation sans
 * `anticipated` — c'est-à-dire l'immense majorité, et TOUTES les situations
 * antérieures à ce lot — reste valide exactement comme avant. La
 * rétrocompatibilité n'est pas une tolérance : le champ est optionnel par
 * conception.
 *
 * ⚠️ `derivedFrom ⊆ evidenceIds` est l'invariant qui compte vraiment. Il
 * garantit que la date dérivée ne s'appuie que sur des preuves déjà retenues,
 * donc déjà passées par le filtre temporel du moteur. Sans lui, un horizon
 * pourrait citer une evidence écartée — ou inexistante — et le rejeu d'un cas
 * historique à `now = T` cesserait d'être fidèle.
 */
const ASSERTION_TYPES: readonly string[] = ['fact', 'inference', 'assumption']

function horizonValide(
  value: any,
  evidenceIds: unknown,
  expiresAt: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  if (!validDate(value.at)) return false
  if (!validDate(value.actionWindowOpensAt)) return false

  // Fenêtre dégénérée ou inversée : refusée. Une fenêtre vide n'a aucun sens
  // métier, et diviser par sa durée n'en aurait pas davantage.
  if (Date.parse(value.actionWindowOpensAt) >= Date.parse(value.at)) return false

  if (typeof value.assertionType !== 'string') return false
  if (!ASSERTION_TYPES.includes(value.assertionType)) return false

  if (!Array.isArray(value.derivedFrom) || value.derivedFrom.length === 0) {
    return false
  }
  if (!value.derivedFrom.every((id: any) => nonEmpty(id))) return false

  // Sous-ensemble strict des evidences retenues par la situation.
  if (!Array.isArray(evidenceIds)) return false
  const retenues = new Set(evidenceIds as string[])
  if (!value.derivedFrom.every((id: string) => retenues.has(id))) return false

  // ── COHÉRENCE ENTRE LES DEUX BORNES (ARCH-HORIZON-001a) ──────────────────
  //
  //     anticipated.at  = borne MÉTIER maximale
  //     expiresAt       = borne de VALIDITÉ de l'interprétation
  //
  // Une interprétation anticipée ne peut pas être déclarée valide au-delà de
  // son propre horizon : `expiresAt > anticipated.at` décrit un objet qui
  // affirme rester pertinent après la disparition de la raison qui le
  // justifiait. C'est cette incohérence qui, relue depuis la base, produisait
  // une recommandation active sur une échéance périmée.
  //
  // `expiresAt` devient donc OBLIGATOIRE dès qu'un horizon existe : absent, il
  // vaudrait « valide sans limite », soit le fail-open exact qu'on ferme ici.
  if (!validDate(expiresAt)) return false
  if (Date.parse(expiresAt as string) > Date.parse(value.at)) return false

  return true
}

function motionsConnues(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((m) => typeof m === 'string' && (AUTHORIZED_MOTIONS as readonly string[]).includes(m))
  )
}

function temporaliteCoherente(value: any): boolean {
  if (value.temporality === 'dated_event') return validDate(value.occurredAt)
  if (value.temporality === 'undated_state') return value.occurredAt === undefined
  return false
}

export function isSituation(value: any): value is Situation {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.type) &&
    stringArray(value.evidenceIds) &&
    validScore(value.confidence) &&
    validScore(value.relevance) &&
    validScore(value.urgency) &&
    typeof value.rationale === 'string' &&
    nonEmpty(value.ruleId) &&
    nonEmpty(value.ruleVersion) &&
    // ARCH-RULEPACK-001 — PROVENANCE EXIGÉE, PAS SEULEMENT TOLÉRÉE.
    //
    // Une situation dont on ignore quel pack et quelle lens l'ont produite
    // n'est pas attribuable, donc pas auditable. L'accepter « parce qu'elle
    // ressemble à une situation » rouvrirait le fail-open que tout ce lot
    // ferme : le play, le controlFloor et la reproductibilité se résolvent
    // TOUS depuis `rulePackId`. Sans lui, le moteur de recommandation ne peut
    // rien conclure — mieux vaut le refuser à la frontière.
    nonEmpty(value.rulePackId) &&
    nonEmpty(value.rulePackVersion) &&
    nonEmpty(value.lensId) &&
    nonEmpty(value.lensVersion) &&
    // Le pack doit exister ICI, et déclarer CE type. Sans quoi la situation
    // n'est pas résoluble : `plays[type]` serait vide et la recommandation
    // retomberait en `no_action` sans que rien n'explique pourquoi.
    packEtTypeConnus(value.rulePackId, value.type) &&
    isLensId(value.lensId) &&
    // ARCH-HORIZON-001 — l'horizon est optionnel, mais s'il existe il est
    // validé intégralement. Un horizon à moitié correct serait pire qu'absent :
    // il produirait une urgence et une expiration calculées sur du sable.
    (value.anticipated === undefined ||
      horizonValide(value.anticipated, value.evidenceIds, value.expiresAt)) &&
    validDate(value.createdAt) &&
    validDate(value.lastEvaluatedAt) &&
    optionalDate(value.expiresAt)
  )
}

export function isRecommendation(value: any): value is Recommendation {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.situationId) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    (value.decision === 'recommend' || value.decision === 'no_action') &&
    typeof value.reason === 'string' &&
    typeof value.whyNow === 'string' &&
    (value.priority === 'low' || value.priority === 'medium' || value.priority === 'high') &&
    validScore(value.confidence) &&
    optionalString(value.play) &&
    optionalString(value.recommendedAction) &&
    nonEmpty(value.ruleId) &&
    nonEmpty(value.ruleVersion) &&
    // ARCH-RULEPACK-001 — LE CONTRÔLE HUMAIN N'EST PAS OPTIONNEL.
    //
    // `control` absent serait lu comme « rien à signaler », c'est-à-dire
    // autonome : exactement l'inverse du fail-closed. Une recommandation dont
    // le niveau de contrôle est inconnu ne doit pas exister en base.
    (value.control === 'autonomous' ||
      value.control === 'approval_required' ||
      value.control === 'blocked') &&
    typeof value.controlReason === 'string' &&
    motionsConnues(value.requiredMotions) &&
    // `contextId` entre dans l'identité de la ligne : sans lui, l'idempotence
    // n'a plus de sens (deux contextes différents écraseraient la même ligne).
    nonEmpty(value.contextId) &&
    nonEmpty(value.contextVersion) &&
    validDate(value.createdAt) &&
    optionalDate(value.expiresAt) &&
    // Un `no_action` qui porte un play serait contradictoire : il annoncerait
    // une action tout en déclarant n'en recommander aucune.
    (value.decision === 'recommend' || (value.play === undefined && value.recommendedAction === undefined))
  )
}

export function isOutcome(value: any): value is Outcome {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.recommendationId) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.type) &&
    (value.note === undefined || typeof value.note === 'string') &&
    validDate(value.occurredAt)
  )
}
