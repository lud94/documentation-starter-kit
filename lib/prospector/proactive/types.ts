import type { AuthorizedMotion, HumanControl } from './motions'

// JARVIS-PROACTIVE V0
// Contrats métier du Decision Model.
// Chaîne cible : EvidenceEvent -> Situation -> Eligibility -> Recommendation -> Outcome.
//
// Règle : ces objets décrivent des faits, interprétations et décisions.
// Ils ne contiennent volontairement aucune logique d'exécution.

export type EvidenceScope =
  | 'account'
  | 'person'
  | 'relationship'

export type AssertionType =
  | 'fact'
  | 'inference'
  | 'assumption'

/**
 * ⚠️ LE CATALOGUE DES TYPES NE VIT PLUS ICI (ARCH-RULEPACK-001).
 *
 * `EvidenceType` et `SituationType` sont DÉRIVÉS des rule packs enregistrés,
 * dans `./catalog`. Ce module reste volontairement générique pour une seule
 * raison, mais elle est décisive : `catalog` importe `packs/registry`, qui
 * importe les packs, qui importent ce fichier. Fermer les types ICI créerait
 * un cycle d'imports à l'exécution.
 *
 * La fermeture réelle est appliquée aux frontières de production via
 * `KnownEvidenceEvent` / `SituationType` de `./catalog`. Le paramètre générique
 * n'est pas une échappatoire : c'est ce qui permet au catalogue d'exister.
 */

export interface EvidenceSource {
  provider: string
  reference?: string
  url?: string
}

/**
 * NATURE TEMPORELLE d'une evidence — « quand » est-il connu ?
 *
 * ── LE DÉFAUT QUE CE CHAMP FERME (JARVIS-PROACTIVE-01D, red-team) ───────────
 * `occurredAt` est obligatoire, donc toute evidence doit porter une date. Une
 * donnée d'ÉTAT non horodatée — « la fiche dit que ce lead est chaud » — n'en a
 * pourtant aucune : on sait qu'on l'observe maintenant, on ignore depuis quand
 * elle est vraie. La dater de `now` la rendait indiscernable d'un événement
 * survenu à l'instant, et le Situation Engine, qui lit la fraîcheur de
 * `occurredAt`, en tirait une urgence maximale.
 *
 * ── LE CHAMP EST OBLIGATOIRE, ET SANS VALEUR PAR DÉFAUT ────────────────────
 * Une première version le rendait optionnel, « absent ⇒ dated_event ». C'était
 * un fail-open sémantique : une future ingestion qui oublierait le champ verrait
 * ses evidences promues au rang d'événements datés, donc porteuses d'urgence,
 * sans que personne ne l'ait décidé. Oublier de dire ce qu'on sait ne doit pas
 * valoir affirmation.
 *
 *   `dated_event`   — `occurredAt` est OBLIGATOIRE et porte la date métier
 *                     réelle du fait. `observedAt` reste la date de découverte.
 *   `undated_state` — `occurredAt` est ABSENT, et le type l'interdit. Seul
 *                     `observedAt` existe : on constate un état, on ignore
 *                     depuis quand il est vrai. Aucune urgence n'en découle.
 *
 * « Observé maintenant » ne signifie jamais « survenu maintenant ».
 */
export type EvidenceTemporality = 'dated_event' | 'undated_state'

/** Champs communs aux deux natures temporelles. */
interface EvidenceBase<T extends string = string> {
  id: string

  // ACCOUNT reste la racine métier.
  accountId: string
  personId?: string

  scope: EvidenceScope
  type: T

  // Valeur observable associée à l'événement.
  value?: string | number | boolean

  // Provenance : d'où vient l'information ?
  source: EvidenceSource

  // Nature épistémique : fait, inférence ou hypothèse.
  assertionType: AssertionType

  // 0..1 — confiance dans l'information elle-même.
  confidence: number

  // Quand Prospector/Jarvis a constaté l'information. TOUJOURS présent : même
  // sans date métier, on sait quand on a regardé.
  observedAt: string

  // Dernière vérification éventuelle.
  lastVerifiedAt?: string

  // Après cette date, l'evidence ne doit plus être considérée fraîche.
  expiresAt?: string
}

/** Un fait daté : la date de survenue est connue, et elle est exigée. */
export interface DatedEventEvidence<T extends string = string> extends EvidenceBase<T> {
  temporality: 'dated_event'

  // Quand l'événement a RÉELLEMENT eu lieu. Obligatoire : un événement daté
  // sans date n'est pas un événement daté.
  occurredAt: string
}

/**
 * Un état constaté dont la date de survenue est inconnue.
 *
 * ⚠️ `occurredAt?: never` n'est pas une coquetterie de typage : il rend
 * IMPOSSIBLE, à la compilation, de glisser une date de survenue inventée sur un
 * état non daté. L'ancienne version y recopiait `now`, et c'est exactement ce
 * qui faisait passer une fiche vieille de dix-huit mois pour un fait du jour.
 */
export interface UndatedStateEvidence<T extends string = string> extends EvidenceBase<T> {
  temporality: 'undated_state'
  occurredAt?: never
}

export type EvidenceEvent<T extends string = string> =
  | DatedEventEvidence<T>
  | UndatedStateEvidence<T>

/**
 * ARCH-HORIZON-001 — ÉCHÉANCE MÉTIER ANTICIPÉE.
 *
 * ── LE MANQUE QUE CETTE PRIMITIVE COMBLE ────────────────────────────────────
 * Le moteur savait mesurer la FRAÎCHEUR d'un événement passé — une urgence qui
 * DÉCROÎT avec le temps. Il ne savait pas représenter une échéance FUTURE dont
 * l'urgence CROÎT à mesure qu'on s'en approche. Aucune composition des
 * primitives existantes ne produit cette forme.
 *
 * ── UNIVERSELLE, ET DÉLIBÉRÉMENT SANS VOCABULAIRE DE DOMAINE ────────────────
 * Renouvellement de contrat, reconduction SaaS, date limite d'appel d'offres,
 * expiration de certification, fin de garantie : cinq domaines indépendants,
 * une seule forme — « une date future connue à laquelle il devient opportun
 * d'agir ». Aucun terme de bail, de bureau ni d'immobilier n'entre ici.
 */
export interface AnticipatedHorizon {
  /**
   * Date métier ANTICIPÉE — observée ou dérivée.
   *
   * ⚠️ N'EST JAMAIS `Situation.expiresAt`. Celui-ci borne la validité de
   * l'INTERPRÉTATION ; celle-ci décrit un fait métier attendu. Les confondre
   * ferait passer une échéance commerciale pour une durée de cache.
   */
  at: string

  /**
   * Début de la fenêtre d'action. OBLIGATOIRE, sans valeur par défaut.
   *
   * ⚠️ LE CŒUR NE CONNAÎT AUCUN DÉLAI RAISONNABLE UNIVERSEL. Six mois avant une
   * fin de bail, trente jours avant une certification, deux ans avant un
   * renouvellement d'infrastructure : c'est une politique métier, elle
   * appartient au Rule Pack. Un défaut du core en ferait une vérité qu'il n'a
   * aucun moyen de connaître. Absent ⇒ horizon INVALIDE, jamais « toujours
   * ouvert ».
   */
  actionWindowOpensAt: string

  /**
   * Statut épistémique de CETTE DATE — vocabulaire existant du moteur.
   *
   * `fact` UNIQUEMENT si la date elle-même a été observée. Une date calculée
   * (début + durée) est une `inference`, et le rester est ce qui empêche la
   * promotion silencieuse d'une estimation en vérité.
   *
   * ⚠️ Le cœur vérifie la STRUCTURE, pas la SINCÉRITÉ de cette étiquette : un
   * pack qui écrirait `fact` sur une date calculée produirait une donnée
   * structurellement valide et épistémiquement fausse. Cette responsabilité
   * appartient au pack et à ses tests.
   */
  assertionType: AssertionType

  /**
   * EvidenceIds ayant servi au calcul. NON VIDE.
   *
   * Doit être un SOUS-ENSEMBLE de `Situation.evidenceIds` : la dérivation ne
   * peut s'appuyer que sur des preuves déjà retenues, donc déjà passées par le
   * filtre temporel du moteur. C'est ce qui rend la date recomputable par un
   * auditeur — et ce qui garantit qu'un rejeu à `now = T` n'utilise que ce qui
   * était connaissable à T.
   */
  derivedFrom: readonly string[]
}

export interface Situation {
  id: string
  accountId: string
  personId?: string

  /**
   * Type métier de la situation.
   *
   * ⚠️ Volontairement `string` ICI, fermé dans `./catalog` — ce module ne peut
   * pas importer les packs sans créer un cycle. La fermeture s'applique aux
   * frontières de production, où `SituationType` du catalogue est employé.
   */
  type: string

  // Les EvidenceEvent qui justifient cette interprétation.
  evidenceIds: string[]

  // 0..1 — crédibilité de l'interprétation.
  confidence: number

  // 0..1 — pertinence pour ICP / offre / objectif commercial.
  relevance: number

  // 0..1 — nécessité d'agir maintenant.
  urgency: number

  // Explication déterministe / auditable.
  rationale: string

  // ── PROVENANCE COMPLÈTE (ARCH-RULEPACK-001) ───────────────────────────────
  // Une Situation n'est plus produite par « le moteur » : elle l'est par UNE
  // règle, d'UN pack, lu à travers UNE lens. Sans ces quatre-là, une situation
  // persistée est irreproductible — `relevance` dépend de la lens, et on ne
  // saurait plus quelle politique l'a calculée.
  //
  // ⚠️ Les VERSIONS sont de la provenance, jamais de l'identité. Une montée de
  // version REMPLACE la ligne courante, elle n'en crée pas une seconde.
  rulePackId: string
  rulePackVersion: string
  ruleId: string
  ruleVersion: string
  lensId: string
  lensVersion: string

  /**
   * Échéance métier anticipée — ABSENTE pour l'immense majorité des situations.
   *
   * ⚠️ N'ENTRE PAS DANS L'IDENTITÉ. Une échéance recalculée REMPLACE la ligne
   * courante, elle n'en crée pas une seconde — même doctrine que les versions.
   */
  anticipated?: AnticipatedHorizon

  createdAt: string
  lastEvaluatedAt: string
  expiresAt?: string
}

export type RecommendationDecision =
  | 'recommend'
  | 'no_action'

export type RecommendationPriority =
  | 'low'
  | 'medium'
  | 'high'

/**
 * PLAY — ce que Jarvis RECOMMANDE de faire, sur le fond commercial.
 *
 * ⚠️ À ne pas confondre avec `AuthorizedMotion`, qui dit ce qu'on a le DROIT
 * de faire. Un play pertinent peut rester interdit ; une capacité accordée ne
 * rend aucun play pertinent. Voir `./motions`.
 */
export type PlayType =
  | 'engage_or_reengage'
  | 'follow_up'
  | 'investigate'

export interface Recommendation {
  id: string
  situationId: string
  accountId: string
  personId?: string

  // Une situation valide peut volontairement produire NO_ACTION.
  decision: RecommendationDecision

  // Pourquoi Jarvis recommande — ou ne recommande pas — d'agir.
  reason: string
  whyNow: string

  priority: RecommendationPriority
  confidence: number

  // Absent lorsque decision = no_action.
  play?: PlayType
  recommendedAction?: string

  ruleId: string
  ruleVersion: string

  // ── CONTRÔLE HUMAIN — ORTHOGONAL À `decision` (ARCH-RULEPACK-001) ─────────
  //
  // ⚠️ `decision` et `control` répondent à DEUX questions différentes :
  //   decision : « faut-il agir ? »        → recommend | no_action
  //   control  : « qui a le droit d'agir ? » → autonomous | approval_required | blocked
  //
  // Les fondre interdirait le cas le plus utile du vertical immobilier :
  // `decision: 'recommend'` + `control: 'approval_required'` — la situation
  // justifie d'agir, mais un humain valide d'abord.
  control: HumanControl
  /** Pourquoi ce niveau de contrôle. Jamais un score, toujours une raison. */
  controlReason: string
  /** Capacités que le play exige. Vide lorsque `decision = no_action`. */
  requiredMotions: readonly AuthorizedMotion[]

  // Provenance du Business Context. `contextId` entre dans l'identité,
  // `contextVersion` non — même doctrine que les versions de règle.
  contextId: string
  contextVersion: string

  createdAt: string
  expiresAt?: string
}

export type OutcomeType =
  | 'recommendation_accepted'
  | 'recommendation_dismissed'
  | 'action_completed'
  | 'reply_received'
  | 'meeting_booked'
  | 'no_response'

export interface Outcome {
  id: string
  recommendationId: string
  accountId: string
  personId?: string

  type: OutcomeType

  // Résultat observé, jamais présenté comme une causalité prouvée.
  note?: string

  occurredAt: string
}