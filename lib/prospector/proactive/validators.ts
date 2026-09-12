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
import { EXTERNAL_SIGNAL_PROVIDER, canonicalClaimKey, isStrictInstant } from './types'
import { isAcquisitionFactV2 } from './acquisitionV2'
import type {
  EvidenceEvent,
  GroundingKind,
  Outcome,
  Recommendation,
  Situation,
  SourceGrade,
  SourceLineageKind,
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
    acceptationCoherente(value) &&
    provenanceCoherente(value?.source?.provenance) &&
    corroborationCoherente(value?.corroboration) &&
    faitStructureCoherent(value?.structuredFact) &&
    temporaliteCoherente(value)
  )
}

/**
 * FAIT STRUCTURÉ V2 — absent OU entier et valide, jamais à moitié.
 *
 * ⚠️ ABSENT EST VALIDE : toutes les evidences déjà persistées en sont
 * dépourvues, et l'exiger les invaliderait toutes à la relecture. PRÉSENT MAIS
 * ABÎMÉ ⇒ INVALIDE : un payload discriminé tronqué relu comme acceptable
 * ferait entrer dans le moteur un fait que l'acquisition n'a jamais validé.
 */
function faitStructureCoherent(v: unknown): boolean {
  return v === undefined || isAcquisitionFactV2(v)
}

/** Vocabulaires REVALIDÉS à la relecture — un `jsonb` ne contraint rien. */
const GRADES: readonly SourceGrade[] = ['A', 'B', 'C', 'UNKNOWN']
const LIGNEES: readonly SourceLineageKind[] = ['ORIGINAL', 'CITES', 'UNKNOWN']
const ANCRAGES: readonly GroundingKind[] = ['VERIFIED_ANCHOR', 'UNVERIFIABLE']

function dansCatalogue<T extends string>(v: unknown, catalogue: readonly T[]): boolean {
  return v === undefined || (typeof v === 'string' && (catalogue as readonly string[]).includes(v))
}

/**
 * INSTANTANÉ DE QUALIFICATION — absent OU bien formé, jamais approximatif.
 *
 * ⚠️ ABSENT EST VALIDE, ET C'EST LA COMPATIBILITÉ ASCENDANTE ELLE-MÊME. Toutes
 * les evidences déjà persistées dans `prospector_store` sont dépourvues de ce
 * bloc ; exiger sa présence les invaliderait TOUTES à la relecture, ce qui
 * ferait échouer l'accumulation d'historique (`EVIDENCE_HISTORY_INVALID`) et
 * arrêterait le produit. L'absence signifie « non enregistrée », jamais
 * « aucune ».
 *
 * ⚠️ PRÉSENT MAIS ABÎMÉ ⇒ INVALIDE. Un grade `'Z'` ou une lignée inventée
 * relue comme acceptable ferait croire à un audit que la promotion s'est
 * appuyée sur une qualification que le Bridge n'a jamais produite. Une
 * provenance à moitié fausse est pire qu'une provenance absente : la première
 * ment, la seconde se tait.
 */
function provenanceCoherente(p: unknown): boolean {
  if (p === undefined) return true
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false
  const v = p as any

  if (!optionalString(v.publisher)) return false
  if (!dansCatalogue<SourceGrade>(v.grade, GRADES)) return false
  if (!dansCatalogue<SourceLineageKind>(v.lineage, LIGNEES)) return false
  if (!dansCatalogue<GroundingKind>(v.grounding, ANCRAGES)) return false

  // Date de PUBLICATION : au jour (`AAAA-MM-JJ`) telle que l'acquisition la
  // normalise. Tolérance de `validDate`, comme partout ailleurs pour une date
  // qui vient d'un tiers et non de notre horloge.
  if (v.sourcePublishedAt !== undefined && !validDate(v.sourcePublishedAt)) return false

  // ⚠️ `retrievedAt` EST NOTRE HORODATAGE, donc STRICT. Il est produit par le
  // serveur (`SignalCandidate.issuedAt`) : le relire avec une règle plus lâche
  // que celle de l'écriture rouvrirait la normalisation silencieuse que
  // `isStrictInstant` existe pour interdire.
  if (v.retrievedAt !== undefined && !isStrictInstant(v.retrievedAt)) return false

  return true
}

/**
 * CORROBORATION — absente OU bien formée.
 *
 * ⚠️ `independentPublisherCount` DOIT S'ACCORDER AVEC `publishers` QUAND LES
 * DEUX SONT LÀ. Un compte de 3 en face d'une liste vide affirmerait une
 * corroboration que rien ne porte — et c'est exactement le champ qu'un lecteur
 * pressé regarderait en premier.
 */
function corroborationCoherente(c: unknown): boolean {
  if (c === undefined) return true
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false
  const v = c as any

  // Un tableau VIDE est licite — « aucun éditeur indépendant établi » est le cas
  // nominal de la V0. `stringArray` l'accepte ; il refuse les entrées vides.
  if (v.publishers !== undefined && !stringArray(v.publishers)) return false
  if (v.sourceUrls !== undefined && !stringArray(v.sourceUrls)) return false

  if (v.independentPublisherCount !== undefined) {
    const n = v.independentPublisherCount
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return false
    if (Array.isArray(v.publishers) && n !== v.publishers.length) return false
  }
  return true
}

/**
 * PROVENANCE D'ADJUDICATION — absente OU complète, jamais à moitié.
 *
 * ⚠️ REVALIDÉE À LA LECTURE, comme tout le reste. Une ligne relue vient d'un
 * `jsonb` que rien ne contraint côté base : une acceptation tronquée y
 * affirmerait qu'un fait a été adjugé sans dire par qui ni sur quoi. Un motif
 * d'acceptation invalide invalide donc l'evidence entière — l'ignorer
 * laisserait passer un fait externe dont la justification a disparu.
 */
function acceptationCoherente(value: any): boolean {
  const a = value.acceptance

  // ⚠️ UN FAIT EXTERNE SANS ADJUDICATION EST INVALIDE — À L'ÉCRITURE COMME À LA
  // RELECTURE. Rendre `acceptance` seulement optionnel laissait une ligne
  // `web_signal_search` + `fact` valider sans que personne ne l'ait confirmée :
  // le contrôle du Bridge devenait contournable par toute écriture directe dans
  // le magasin. Les evidences internes (CRM) restent dispensées : elles
  // constatent l'état de notre propre base et n'ont personne à citer.
  const externe = value?.source?.provider === EXTERNAL_SIGNAL_PROVIDER

  // ⚠️ CONTRAT V0 FERMÉ POUR LA PROVENANCE WEB. Exiger l'adjudication seulement
  // sur `assertionType === 'fact'` laissait une porte : la même provenance avec
  // `inference`, `assumption` — ou toute autre valeur — passait sans confirmation.
  // Or le Bridge V0 ne produit QU'UN fait adjugé par un humain ; toute autre
  // forme portant cette provenance n'a été produite par aucun chemin légitime.
  //
  // Ce durcissement vaut pour `web_signal_search` UNIQUEMENT. Le trou général
  // sur `assertionType` reste `EVIDENCE-ASSERTION-RUNTIME-GUARD-001`, non traité ici.
  if (externe && value.assertionType !== 'fact') return false
  if (a === undefined) return !externe

  if (!a || typeof a !== 'object') return false
  if (a.kind !== 'human_confirmed') return false
  if (!nonEmpty(a.actorId)) return false
  // ⚠️ MÊME RÈGLE STRICTE QU'À L'ÉCRITURE. `validDate` s'appuie sur `Date.parse`
  // et accepterait `2026-08-20T24:00:00Z` en le normalisant au 21 : un
  // horodatage refusé par le Bridge redeviendrait acceptable à la relecture.
  if (!isStrictInstant(a.confirmedAt)) return false
  if (!nonEmpty(a.canonicalKey)) return false
  if (!stringArray(a.sourceUrls) || a.sourceUrls.length === 0) return false

  // ⚠️ LA SOURCE CITÉE DOIT FIGURER PARMI LES PREUVES RÉELLEMENT EXAMINÉES.
  // Sans quoi une evidence désignerait une source que personne n'a revue, tout
  // en portant une adjudication qui semble la couvrir.
  const url = value?.source?.url
  if (typeof url !== 'string' || url.trim() === '') return false
  if (!a.sourceUrls.map((u: string) => u.trim()).includes(url.trim())) return false

  // ⚠️ L'ADJUDICATION DOIT DÉSIGNER CETTE EVIDENCE-CI, ET AUCUNE AUTRE.
  // Sans ce contrôle, une evidence adjugée pouvait être MUTÉE d'une
  // revendication vers une autre — changer son `type`, son `accountId` ou son
  // `occurredAt` — tout en conservant la confirmation humaine de la première.
  // La signature humaine se serait alors appliquée à un fait que personne n'a vu.
  //
  // La clé est RECALCULÉE depuis l'evidence, par la définition canonique unique
  // de `types.ts` — jamais réécrite ici.
  return a.canonicalKey === canonicalClaimKey({
    type: value.type,
    accountId: value.accountId,
    temporality: value.temporality,
    occurredAt: value.occurredAt,
  })
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
