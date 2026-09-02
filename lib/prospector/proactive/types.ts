import type { AuthorizedMotion, HumanControl } from './motions'
import type { AcquisitionFactV2 } from '../../../types/prospector'

// JARVIS-PROACTIVE V0
// Contrats métier du Decision Model.
// Chaîne cible : EvidenceEvent -> Situation -> Eligibility -> Recommendation -> Outcome.
//
// Règle : ces objets décrivent des faits, interprétations et décisions.
// Ils ne contiennent volontairement aucune logique d'exécution.

/**
 * Provenance d'ingestion des signaux externes.
 *
 * ⚠️ DÉCLARÉE ICI, ET NON DANS LE BRIDGE. `validators.ts` doit reconnaître cette
 * provenance pour exiger une adjudication, et importer le Bridge depuis les
 * validateurs créerait un cycle de propriété. Ce module ne dépend de personne :
 * c'est le seul endroit acyclique où les deux peuvent se rencontrer.
 */
export const EXTERNAL_SIGNAL_PROVIDER = 'web_signal_search'

const INSTANT_STRICT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/

/**
 * INSTANT RFC 3339 STRICT — L'UNIQUE définition du dépôt.
 *
 * ⚠️ POURQUOI PAS `validDate()`. Ce dernier s'appuie sur `Date.parse`, qui est
 * permissif ET NORMALISE : `2026-08-20T24:00:00Z` y devient le 21 août, et
 * `2026-08-20` — une date sans heure — y passe pour un instant. Un horodatage
 * d'adjudication validé strictement à l'écriture mais relu avec une règle plus
 * lâche romprait l'aller-retour : une confirmation refusée à l'entrée
 * deviendrait acceptable à la relecture.
 *
 * Les composantes ÉCRITES sont comparées à celles que le calendrier rend, pour
 * que la normalisation silencieuse soit impossible.
 */
export function isStrictInstant(valeur: unknown): boolean {
  if (typeof valeur !== 'string') return false
  const m = INSTANT_STRICT.exec(valeur)
  if (!m) return false

  const [, a, mo, j, h, mi, sec, oh, om] = m
  const [an, mois, jour] = [Number(a), Number(mo), Number(j)]
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return false
  const d = new Date(Date.UTC(an, mois - 1, jour))
  if (d.getUTCFullYear() !== an || d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) {
    return false
  }
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false
  return true
}

const JOUR_LEXICAL = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Le jour existe-t-il RÉELLEMENT au calendrier ? — L'UNIQUE définition du dépôt.
 *
 * ⚠️ DÉPLACÉE ICI DEPUIS `signalBridge.ts`, À L'IDENTIQUE (E2E_BRIDGE_001) :
 * `acquisitionV2.ts` et le Bridge la lisent tous deux, et le Bridge lit
 * `acquisitionV2` — ce module est le seul point acyclique où les trois se
 * rencontrent. Le Bridge la ré-exporte, la surface historique est inchangée.
 *
 * ⚠️ REVALIDÉE AUX FRONTIÈRES, et non déléguée au type. `eventDatePrecision`
 * vient d'une extraction : rien n'empêche `DAY` d'accompagner `'garbage'` ou
 * `'2026-02-30'`. Le typage TypeScript ne contrôle aucune donnée d'exécution.
 */
export function jourReel(valeur: unknown): valeur is string {
  if (typeof valeur !== 'string') return false
  const m = JOUR_LEXICAL.exec(valeur)
  if (!m) return false
  const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || j < 1 || j > 31) return false
  const d = new Date(Date.UTC(a, mo - 1, j))
  return d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j
}

/**
 * IDENTITÉ CANONIQUE d'une revendication — L'UNIQUE définition du dépôt.
 *
 * ⚠️ DÉCLARÉE ICI, ET NON DANS LE BRIDGE. Le Bridge l'écrit dans
 * `acceptance.canonicalKey` ; les validateurs doivent la RECALCULER à la
 * relecture pour vérifier qu'une evidence n'a pas été mutée d'une revendication
 * vers une autre en conservant l'adjudication humaine de la première. Deux
 * implémentations de la même règle finiraient par diverger — et la divergence
 * ferait passer une mutation pour une cohérence.
 *
 *   dated_event    → `<type>|<accountId>|<occurredAt>`
 *   undated_state  → `<type>|<accountId>|STATE`
 */
export function canonicalClaimKey(claim: {
  type: string
  accountId: string
  temporality: 'dated_event' | 'undated_state'
  occurredAt?: string
}): string {
  const quand = claim.temporality === 'dated_event' ? claim.occurredAt : 'STATE'
  return `${claim.type}|${claim.accountId}|${quand}`
}

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

// ── VOCABULAIRES DE QUALIFICATION DE SOURCE — DÉCLARÉS ICI, ET NULLE PART AILLEURS
//
// ⚠️ POURQUOI DANS `types.ts` ET NON DANS LE BRIDGE. Ces valeurs sont PERSISTÉES
// sur l'evidence, donc `validators.ts` doit les revalider à la relecture. Or
// importer le Bridge depuis les validateurs créerait le cycle que ce module
// existe pour éviter — exactement le raisonnement déjà tenu pour
// `canonicalClaimKey` et `EXTERNAL_SIGNAL_PROVIDER`.
//
// ⚠️ AUCUN SECOND VOCABULAIRE N'EST CRÉÉ. `signalBridge.ts` importe ces types-ci
// et vérifie À LA COMPILATION que ses unions de travail — `SourceLineage`,
// `Grounding`, qui portent des charges utiles en plus du `kind` — ont exactement
// ces `kind`-là. Deux listes de grades qui divergeraient feraient valider à la
// relecture une valeur que le Bridge n'émet plus, ou l'inverse.

/** Autorité de la source. `UNKNOWN` ne vaut jamais « faible » : il vaut « non établi ». */
export type SourceGrade = 'A' | 'B' | 'C' | 'UNKNOWN'

/** Lignée. `UNKNOWN` NE VAUT JAMAIS INDÉPENDANCE — voir `signalBridge`. */
export type SourceLineageKind = 'ORIGINAL' | 'CITES' | 'UNKNOWN'

/** Ce que l'application a pu vérifier elle-même. Jamais ce que le modèle affirme. */
export type GroundingKind = 'VERIFIED_ANCHOR' | 'UNVERIFIABLE'

/**
 * INSTANTANÉ DE QUALIFICATION, PRIS AU MOMENT DE LA PROMOTION.
 *
 * ── LA PERTE QUE CE CHAMP ARRÊTE ───────────────────────────────────────────
 * Le Bridge CALCULE le grade, l'éditeur, la lignée et l'ancrage, s'en sert pour
 * décider si la revendication peut devenir un fait… puis les jette. Une
 * evidence relue six mois plus tard pouvait dire QUI l'avait adjugée et sur
 * QUELLES URL, mais plus POURQUOI ces sources étaient qualifiantes. La
 * politique de source n'était donc pas rejouable après coup : impossible de
 * distinguer « promue sur une source A ancrée » de « promue sur deux sources B
 * indépendantes » sans re-télécharger les pages — c'est-à-dire sans refaire
 * l'histoire.
 *
 * ⚠️ INSTANTANÉ, PAS VUE CALCULÉE. Si la politique de classement change demain,
 * une evidence ancienne doit continuer d'afficher les valeurs qui ont RÉELLEMENT
 * fondé sa promotion. Rien ne recalcule ce bloc à la lecture — le recalculer
 * réécrirait le passé pour le rendre conforme au présent.
 *
 * ⚠️ TOUS LES CHAMPS SONT FACULTATIFS, ET C'EST STRUCTUREL. Les evidences déjà
 * persistées n'en portent aucun, et elles restent valides : l'absence de
 * provenance signifie « non enregistrée », jamais « aucune ».
 */
export interface EvidenceProvenance {
  /** Éditeur — l'hôte fait foi, jamais le nom déclaré par la source. */
  publisher?: string
  grade?: SourceGrade
  lineage?: SourceLineageKind
  grounding?: GroundingKind

  /**
   * Date de PUBLICATION de la source, quand elle est connue.
   *
   * ⚠️ N'EST NI `observedAt` NI `occurredAt`, ET NE S'EN DÉDUIT JAMAIS. Quand la
   * source ne la donne pas, ce champ est ABSENT. Y recopier l'instant de
   * consultation fabriquerait une date de publication que personne n'a lue —
   * c'est le même faux zéro que `occurredAt = now` sur un état non daté.
   */
  sourcePublishedAt?: string

  /**
   * Quand PROSPECTOR a récupéré la matière — instant SERVEUR.
   *
   * Distinct de `observedAt`, qui est l'instant d'ADJUDICATION du fait : une
   * recherche du lundi confirmée le jeudi a deux dates différentes, et les
   * confondre effacerait le délai de revue.
   */
  retrievedAt?: string

  /**
   * POURQUOI le grade A « site de l'entreprise » a été décerné
   * (ENTITY_OFFICIAL_DOMAIN_GROUNDING_001) — ADDITIF, clos :
   *   `REGISTRY_DECLARED`               — site déclaré au registre officiel ;
   *   `HUMAN_ADJUDICATED_LEGAL_NOTICE` — domaine première-partie adjugé par un
   *     humain sur matière légale capturée par Prospector (PAS une preuve de
   *     propriété DNS/du domaine, PAS une déclaration de registre).
   * Absent sur toute evidence antérieure (qui reste valide) et sur tout grade
   * non issu du chemin site-officiel. Hors de toute identité.
   */
  domainAuthority?: 'REGISTRY_DECLARED' | 'HUMAN_ADJUDICATED_LEGAL_NOTICE'

  /**
   * COMMENT l'ENTITÉ du fait a été résolue (ENTITY_RESOLUTION_ADJUDICATION_001)
   * — ADDITIF, clos, hors identité :
   *   `AUTO_EXACT_REGISTRY`               — correspondance stricte unique ;
   *   `HUMAN_SELECTED_REGISTRY_CANDIDATE` — sélection humaine parmi des
   *     candidats officiels OBSERVÉS. Dans ce cas
   *     `entityResolutionAdjudicationId` (era_…) est OBLIGATOIRE et permet de
   *     remonter : Evidence → adjudication → observation → cliché exact vu.
   *   Chemin auto ⇒ id ABSENT. Anciennes evidences sans les deux : valides.
   */
  entityAuthority?: 'AUTO_EXACT_REGISTRY' | 'HUMAN_SELECTED_REGISTRY_CANDIDATE'
  entityResolutionAdjudicationId?: string
}

/**
 * CORROBORATION TELLE QU'ELLE EXISTAIT AU MOMENT DE LA PROMOTION.
 *
 * ⚠️ `independentPublisherCount` COMPTE DES ÉDITEURS INDÉPENDANTS PROUVÉS, pas
 * des URL. Cinq reprises d'un même communiqué ne sont pas cinq confirmations —
 * la règle vit dans `signalBridge.independentPublishers`, ce champ n'en est que
 * la trace figée.
 *
 * ⚠️ `0` EST UNE VALEUR SIGNIFICATIVE, ET NON UN MANQUE : « promue sans aucun
 * éditeur indépendant établi » est précisément ce qu'un audit doit pouvoir lire.
 * C'est le cas NOMINAL de la V0, où la lignée n'est pas transportée depuis
 * l'acquisition et vaut donc `UNKNOWN`.
 */
export interface EvidenceCorroboration {
  /** Éditeurs indépendants établis. Trié, sans doublon. */
  publishers?: readonly string[]
  /** URL des sources QUALIFIANTES — celles qui ont réellement porté la décision. */
  sourceUrls?: readonly string[]
  independentPublisherCount?: number
}

export interface EvidenceSource {
  provider: string
  reference?: string
  url?: string

  /**
   * Qualification de la source PRINCIPALE — celle que `url` désigne.
   *
   * Facultatif : absent sur les evidences internes (CRM) et sur toutes celles
   * déjà persistées avant ce lot.
   */
  provenance?: EvidenceProvenance
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

/**
 * POURQUOI CE FAIT A ÉTÉ ACCEPTÉ — provenance d'ADJUDICATION, pas de source.
 *
 * ⚠️ À NE PAS CONFONDRE AVEC `EvidenceSource`. `source` dit d'où vient
 * l'information ; `acceptance` dit qui a décidé qu'elle pouvait être affirmée
 * comme un fait. Une evidence externe issue du web n'est un fait que parce
 * qu'une personne l'a adjugée : effacer ce motif la rendrait, dès la relecture,
 * indiscernable d'un fait fabriqué.
 *
 * Facultatif : les evidences dérivées du CRM (`dataBridge`) n'en portent pas —
 * elles constatent l'état de notre propre base et n'ont personne à citer.
 */
export interface EvidenceAcceptance {
  kind: 'human_confirmed'
  /** Identifiant opaque de l'acteur. Jamais une adresse déduite d'un client. */
  actorId: string
  confirmedAt: string
  /** La revendication EXACTE adjugée. */
  canonicalKey: string
  /** Les sources réellement examinées lors de l'adjudication. */
  sourceUrls: readonly string[]
}

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

  /**
   * Motif d'ACCEPTATION, quand ce fait a dû être adjugé pour être affirmé.
   *
   * Absent sur les evidences internes. PRÉSENT et validé fail-closed sur toute
   * evidence issue d'une source externe.
   */
  acceptance?: EvidenceAcceptance

  /**
   * Corroboration constatée AU MOMENT DE LA PROMOTION.
   *
   * ⚠️ PORTÉE PAR L'EVIDENCE, PAS PAR `source`. `source` décrit UNE source ; la
   * corroboration est une propriété du GROUPE de preuves qui a fondé le fait.
   * La ranger sous `source` laisserait croire qu'une seule source se corrobore
   * elle-même.
   */
  corroboration?: EvidenceCorroboration

  /**
   * Fait structuré V2 de la SOURCE PRINCIPALE — PROJECTION COURANTE, pas
   * l'histoire (SIGNAL_ACQUISITION_CONTRACT_002_E2E_BRIDGE_001).
   *
   * ⚠️ L'HISTOIRE PAR SOURCE VIT DANS LE REGISTRE `SourceAssertion`, où chaque
   * source conserve SON instantané sémantique versionné. Ce champ-ci peut être
   * réécrit par une adjudication ultérieure (même limite que la provenance,
   * EVIDENCE_PROVENANCE_OVERWRITE_001) : il sert à l'inspection aval, jamais de
   * source primaire. Absent = evidence héritée valide ; présent = bloc entier
   * et validé.
   *
   * ⚠️ N'ENTRE DANS AUCUNE IDENTITÉ : ni montant, ni investisseur, ni stade, ni
   * décompte, ni intitulé de poste ne modifient `Evidence.id`.
   */
  structuredFact?: AcquisitionFactV2
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