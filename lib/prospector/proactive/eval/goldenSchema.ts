// GOLDEN-SCHEMA-001a — CONTRAT `proactive-golden-v0.1`, VALIDATION STRUCTURELLE PURE.
//
// ── CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS ─────────────────────────────
// Un Golden Case est une ADJUDICATION HUMAINE : ce qu'une source dit, ce que
// nous avons pu en typer, et ce que le moteur DOIT en conclure. Ce n'est pas un
// cas d'exécution. Le cas d'exécution en est DÉRIVÉ (`goldenToEvalCase`), il
// n'y est jamais recopié.
//
// ── LA DÉCISION DE CONCEPTION CENTRALE : DÉRIVER, NE PAS DUPLIQUER ──────────
// Une version antérieure persistait à la fois `adjudication` et un `input`
// complet contenant les mêmes `evidenceType`, `assertionType`, `occurredAt`,
// `evidenceId`, `runtimeSource`. Deux copies MODIFIABLES de la même sémantique,
// dans un corpus dont la raison d'être est d'être édité à la main : la dérive
// n'était pas un risque, c'était une échéance. Le contrat ne persiste donc QUE
// ce qui n'est pas dérivable (`executionContext`), et le projecteur reconstruit
// le reste.
//
// ── ORACLE PARTIEL, PAS ORACLE INCOMPLET ────────────────────────────────────
// Un cas signé peut n'affirmer qu'une PARTIE de l'espace des Situations. Un
// oracle INCOMPLET est celui dont l'auteur visait l'exhaustivité et a échoué :
// ses silences sont des accidents, indiscernables d'un oubli. Un oracle PARTIEL
// affirme un sous-ensemble ET LE DIT : chaque `UNSPECIFIED` porte sa raison, et
// l'abstention est elle-même signée.
//
// ⚠️ Une version antérieure exigeait qu'un cas signé affirme TOUTES les
// Situations actives. Elle produisait des `FORBIDDEN` que personne n'avait
// adjugés, déduits de la lecture des tables de familles — c'est-à-dire du code
// même que le corpus est censé juger. Un oracle recopié depuis l'implémentation
// ne mesure rien.
//
// ── AUCUNE I/O ──────────────────────────────────────────────────────────────
// Ce module valide une valeur DÉJÀ désérialisée, exactement comme
// `caseSchema.ts`. Il ne lit ni fichier, ni manifeste, ni dataset. L'ancrage sur
// le RAW appartient à `goldenRawIntegrity.ts`, par injection de dépendances.
//
// ── COUCHES, ET POURQUOI CE MODULE N'IMPORTE PAS LE PROJECTEUR ──────────────
//
//     caseSchema  ←  goldenSchema  ←  goldenToEvalCase
//
// Le graphe est STRICTEMENT à sens unique. Une version antérieure importait
// `projectGoldenCase` ici pendant que le projecteur importait `projectTemporality`
// de ce fichier : un CYCLE D'IMPORTS À L'EXÉCUTION, du même genre que celui que
// `catalog.ts` documente et évite. Il ne s'était pas encore manifesté parce que
// Vitest tolère l'ordre d'évaluation actuel — c'est exactement le type de panne
// qui apparaît le jour où un autre module entre par l'autre bout.
//
// La validation COMPLÈTE (structure + projection + `validateEvalCase`) vit donc
// dans `goldenToEvalCase.validateGoldenCase()`, la couche du dessus.
//
// ⚠️ Ce module valide malgré tout `executionContext` — pour TOUS les cas, y
// compris BLOQUÉS — au moyen d'une SONDE à evidence vide. Le contexte
// d'exécution est persisté même quand le cas ne s'exécute pas : le laisser
// invalide jusqu'à la levée du blocage reviendrait à découvrir un contexte
// cassé des mois plus tard, au pire moment.
//
// ── INFRASTRUCTURE GÉNÉRIQUE : AUCUNE POLITIQUE DE VERTICAL ─────────────────
// Ce module ne dépend d'AUCUN pack en particulier. Il lit `LENS_REGISTRY` et
// `PACK_REGISTRY` — des registres, pas des politiques — et `evidenceMatchesTarget`,
// un prédicat générique du Situation Engine.
//
// ⚠️ Une version antérieure importait `FIRST_PARTY_PROVIDERS` de
// `packs/real-estate-fabel/provenance`. C'était une inversion de couches : le
// schéma Golden, censé servir tous les verticaux, aurait fait dépendre sa
// validité d'une liste blanche appartenant à UN pack — et l'ajout d'un second
// vertical aurait rendu la règle soit fausse, soit arbitraire. Le cœur ne peut
// pas trancher universellement ce qu'est un provider « first-party » : cette
// notion n'existe même pas dans `EvidenceSource`.
//
// La règle générique conservée ici est purement RÉFÉRENTIELLE — « le provider
// est-il celui déclaré, ou justifié ? ». La compatibilité avec la politique
// Fabel du pilote est vérifiée par un test d'INTÉGRATION, qui a le droit
// d'importer le pack ; l'infrastructure, non.
import { LENS_REGISTRY } from '../lens/registry'
import { PACK_REGISTRY } from '../packs/registry'
import { evidenceMatchesTarget } from '../situationEngine'
import { EVAL_SCHEMA_VERSION, validateEvalCase } from './caseSchema'
import type { BusinessContextV0 } from '../lens/context'
import type { AssertionType } from '../types'

/** Version de contrat. Toute autre valeur est refusée — jamais « migrée à la lecture ». */
export const GOLDEN_SCHEMA_VERSION = 'proactive-golden-v0.1'

/**
 * Clés racine AUTORISÉES — liste FERMÉE, et toutes OBLIGATOIRES.
 *
 * Ni `_comment` ni aucune autre extension libre : `caseSchema.ts` en accepte un
 * parce qu'une fixture technique doit pouvoir crier qu'elle n'est pas de la
 * ground truth. Ici, tout EST de la ground truth, et chaque champ a une place
 * nommée où s'exprimer — `rationale`, `note`, `semanticClaim`.
 */
const CLES_RACINE = [
  'goldenSchemaVersion',
  'caseId',
  'evaluationProfile',
  'provenance',
  'rawSource',
  'assumptions',
  'adjudication',
  'executability',
  'executionContext',
  'expected',
  'legacyAssessment',
  'caseStatus',
] as const

// ── ÉNUMÉRATIONS FERMÉES ────────────────────────────────────────────────────
// Une valeur inconnue est une ERREUR, jamais un défaut. C'est la doctrine
// fail-closed du dépôt : oublier de dire ce qu'on sait ne vaut pas affirmation.

export const RAILS = ['SEMANTIC'] as const
export type Rail = (typeof RAILS)[number]

export const EXECUTABILITIES = ['EXECUTABLE', 'ADJUDICATED_NON_EXECUTABLE'] as const
export type Executability = (typeof EXECUTABILITIES)[number]

export const MAPPING_DECISIONS = [
  'MAPPED',
  'MISSING_TYPE',
  'SOURCE_UNVERIFIED',
  'NOT_MAPPABLE',
] as const
export type MappingDecision = (typeof MAPPING_DECISIONS)[number]

/**
 * Classes d'exclusion — LE GARDE-FOU CONTRE L'ÉCHAPPATOIRE.
 *
 * `NOT_MAPPABLE` est non bloquant, donc c'est la porte de sortie évidente :
 * requalifier un trou de taxonomie gênant et le cas redevient exécutable. Ces
 * quatre classes ferment la porte par construction — un FAIT MÉTIER réel
 * concernant le compte ne peut honnêtement porter aucune d'entre elles. Il
 * reste donc `MISSING_TYPE`, et il reste bloquant.
 */
export const EXCLUSION_CLASSES = [
  'NON_FACTUAL_NARRATIVE',
  'DATASET_METADATA',
  'RAIL_R_SEMANTICS',
  'DUPLICATE_OF_CLAIM',
] as const
export type ExclusionClass = (typeof EXCLUSION_CLASSES)[number]

/**
 * NATURE temporelle — ce que la chose EST.
 *
 * ⚠️ DISTINCTE DE LA PRÉCISION, et c'est le correctif le plus important de ce
 * contrat. Une version antérieure encodait « licenciements survenus, date
 * inconnue » en `undated_state`. Or `undated_state` affirme autre chose : un
 * ÉTAT constaté maintenant, dont on ignore depuis quand il est vrai. Un
 * ÉVÉNEMENT dont la date nous échappe n'est pas un état — et la confusion n'est
 * pas cosmétique : `contradictionBloquante` traite `undated_state` comme
 * bloquant en toutes circonstances, donc la fixture aurait emprunté un chemin
 * choisi par l'encodage, pas par les faits.
 */
export const TEMPORAL_NATURES = ['EVENT', 'STATE', 'UNKNOWN'] as const
export type TemporalNature = (typeof TEMPORAL_NATURES)[number]

/** PRÉCISION temporelle — ce que la SOURCE nous permet de dire de sa date. */
export const TEMPORAL_PRECISIONS = ['TIMESTAMP', 'DAY', 'MONTH', 'YEAR', 'UNKNOWN'] as const
export type TemporalPrecision = (typeof TEMPORAL_PRECISIONS)[number]

export const REVIEW_CLASSES = [
  'RAW_SOURCE_DIRECTLY_REVIEWED',
  'EXTERNAL_REVIEW_EVIDENCE',
  'INDEPENDENT_CORROBORATION',
  'NOT_REVIEWED',
] as const
export type ReviewClass = (typeof REVIEW_CLASSES)[number]

export const SITUATION_ASSERTIONS = ['REQUIRED', 'FORBIDDEN', 'UNSPECIFIED'] as const
export type SituationAssertion = (typeof SITUATION_ASSERTIONS)[number]

export const LEGACY_SCOPES = ['RAIL_S', 'RAIL_R', 'OUT_OF_SCOPE'] as const
export type LegacyScope = (typeof LEGACY_SCOPES)[number]

export const LEGACY_STATUSES = ['SUPPORTED', 'NOT_SUPPORTED', 'NOT_ADJUDICATED'] as const
export type LegacyStatus = (typeof LEGACY_STATUSES)[number]

/**
 * Causes de blocage. PLUSIEURS peuvent coexister.
 *
 * ⚠️ AUCUNE PRIORITÉ. Une version antérieure exposait un `primaryStatus` : il
 * aurait fallu ordonner « manque un type » et « date inexploitable », alors
 * qu'aucune autorité ne le fait. Pire, il en aurait CACHÉ un — et celui qui
 * aurait corrigé le blocage visible aurait retrouvé le cas non exécutable, sans
 * motif enregistré.
 */
export const BLOCKER_KINDS = [
  'EVIDENCE_TYPE_GAP',
  'SOURCE_REVIEW_REQUIRED',
  'EXPECTATION_AMBIGUOUS',
  'TEMPORAL_PRECISION_GAP',
] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

export const CASE_STATES = ['SIGNED_SEMANTIC_GOLDEN', 'BLOCKED'] as const
export type CaseState = (typeof CASE_STATES)[number]

const EVIDENCE_SCOPES = ['account', 'person', 'relationship'] as const

// ── TYPES DU CONTRAT ────────────────────────────────────────────────────────

export interface EvaluationProfile {
  rail: Rail
  lensId: string
  lensVersion: string
}

export interface GoldenProvenance {
  materializationTicket: string
  adjudicationProtocol: string
  /** JOUR uniquement. Pas d'horodatage exact fabriqué pour un fait connu au jour près. */
  adjudicatedOn: string
}

export interface RawSourceAnchor {
  datasetPath: string
  datasetSchemaVersion: string
  datasetVersion: string
  datasetSha256: string
  originalCaseId: string
}

export interface ReplayAssumptions {
  now: { value: string; source: string; precision: TemporalPrecision }
  observedAt: { value: string; source: string }
  targetRelevance: { value: number; rationale: string }
  evidenceConfidence: { value: number; rationale: string }
  syntheticRuntimeProvider: { value: string; rationale: string }
}

export interface SourceReview {
  reviewClass: ReviewClass
  sourceUrl?: string
  fetchedAt?: string
  supportingClaim?: string
  notes?: string
}

export interface ClaimRef {
  rawEvidenceId: string
  claimIndex: number
}

export interface RuntimeSource {
  provider: string
  reference?: string
  url?: string
}

export interface AdjudicatedClaim {
  claimIndex: number
  semanticClaim: string
  mappingDecision: MappingDecision

  // ── ADJUDICATION SÉMANTIQUE — légale à TOUTE décision de mapping ──────────
  // ⚠️ Ces champs ne sont PAS réservés à `MAPPED`. Nous savons qu'une intention
  // annoncée est un `fact` observé, daté du jour de l'annonce, même si aucun
  // `EvidenceType` ne la porte encore. Les jeter avec le mapping détruirait
  // l'analyse qui justifie précisément d'ouvrir un ticket de taxonomie.
  assertionType?: AssertionType
  temporalNature?: TemporalNature
  temporalPrecision?: TemporalPrecision
  occurredAt?: string
  sourceReview?: SourceReview[]
  rationale?: string
  exclusionClass?: ExclusionClass
  duplicateOf?: ClaimRef

  // ── MAPPING RUNTIME — légal UNIQUEMENT si `MAPPED` ────────────────────────
  // `evidenceScope` / `targetAccountId` / `targetPersonId` ne dupliquent rien :
  // ce sont les LIAISONS runtime, indérivables de la sémantique. Avec deux
  // cibles, « à quel compte se rattache ce fait » n'a pas de réponse déductible,
  // et `evidenceMatchesTarget()` rend la différence comportementale.
  evidenceType?: string
  evidenceId?: string
  evidenceScope?: (typeof EVIDENCE_SCOPES)[number]
  targetAccountId?: string
  targetPersonId?: string
  runtimeSource?: RuntimeSource
}

export interface RawEvidenceAdjudication {
  rawEvidenceId: string
  /** Assertion HUMAINE. Aucun parseur ne peut déduire d'une prose qu'elle est épuisée. */
  decompositionStatus: 'COMPLETE'
  claims: AdjudicatedClaim[]
}

export interface ExecutionContextTarget {
  accountId: string
  personId?: string
  eligibility?: Record<string, unknown>
}

export interface GoldenExecutionContext {
  businessContext: BusinessContextV0
  targets: ExecutionContextTarget[]
}

export interface SituationExpectation {
  assertion: SituationAssertion
  rationale: string
}

export interface LegacyAssessmentItem {
  /** JSON Pointer RFC 6901, résolu contre le cas RAW. */
  rawRef: string
  scope: LegacyScope
  status: LegacyStatus
  rationale: string
}

export interface Blocker {
  kind: BlockerKind
  rawEvidenceId?: string
  claimIndex?: number
  note: string
}

export interface GoldenCase {
  goldenSchemaVersion: typeof GOLDEN_SCHEMA_VERSION
  caseId: string
  evaluationProfile: EvaluationProfile
  provenance: GoldenProvenance
  rawSource: RawSourceAnchor
  assumptions: ReplayAssumptions
  adjudication: { rawEvidence: RawEvidenceAdjudication[] }
  executability: Executability
  executionContext: GoldenExecutionContext
  expected: { situations: Record<string, SituationExpectation> }
  legacyAssessment: { items: LegacyAssessmentItem[] }
  caseStatus: { state: CaseState; blockers: Blocker[] }
}

export interface GoldenError {
  code: string
  path: string
  message: string
}

export type GoldenValidation =
  | { ok: true; case: GoldenCase }
  | { ok: false; errors: GoldenError[] }

// ── OUTILS PARTAGÉS ─────────────────────────────────────────────────────────

/**
 * SituationTypes réellement ACTIFS pour une lens.
 *
 * ⚠️ `SITUATION_TYPES` du catalogue est l'union PLATE de tous les packs
 * enregistrés — `sales-core` compris. Exiger qu'un cas Fabel se prononce sur
 * `sales_scale_up` serait un contrat insatisfiable honnêtement : aucun pack de
 * cette lens ne peut produire ce type. Symétrique exact de
 * `typesActifsPourLens` côté evidences (`caseSchema.ts`).
 */
export function situationTypesActifsPourLens(lensId: string): Set<string> | null {
  const lens = (LENS_REGISTRY as any)[lensId]
  if (!lens) return null

  const actifs = new Set<string>()
  for (const packId of lens.rulePacks ?? []) {
    const pack = (PACK_REGISTRY as any)[packId]
    if (!pack) continue
    for (const type of pack.declaredSituationTypes) actifs.add(type)
  }

  return actifs
}

/** Tous les SituationTypes déclarés par un pack enregistré, toutes lenses confondues. */
function situationTypesConnus(): Set<string> {
  const connus = new Set<string>()
  for (const pack of Object.values(PACK_REGISTRY as any)) {
    for (const type of (pack as any).declaredSituationTypes) connus.add(type)
  }
  return connus
}

export type TemporalProjection =
  | { kind: 'dated_event' }
  | { kind: 'undated_state' }
  | { kind: 'gap'; reason: string }

/**
 * NATURE + PRÉCISION → temporalité runtime. Table unique, partagée par le
 * validateur et le projecteur : deux implémentations divergeraient.
 *
 * ⚠️ `EVENT` + MOIS/ANNÉE/INCONNU est un TROU, jamais une conversion. Choisir
 * un jour fabriquerait une précision, et comme `freshnessScore` lit
 * `occurredAt`, cela fabriquerait une URGENCE.
 */
export function projectTemporality(
  nature: TemporalNature,
  precision: TemporalPrecision,
): TemporalProjection {
  if (nature === 'STATE') return { kind: 'undated_state' }

  if (nature === 'EVENT') {
    if (precision === 'TIMESTAMP' || precision === 'DAY') return { kind: 'dated_event' }
    return {
      kind: 'gap',
      reason:
        `Événement de précision « ${precision} » : aucune projection honnête vers un ` +
        '`occurredAt` runtime. Choisir un jour fabriquerait une précision, donc une urgence.',
    }
  }

  return {
    kind: 'gap',
    reason:
      'Nature temporelle INCONNUE : ni événement daté, ni état constaté. Aucune ' +
      'temporalité runtime ne peut être affirmée.',
  }
}

/** La claim empêche-t-elle l'exécution du cas ? */
export function claimEstBloquante(claim: AdjudicatedClaim): BlockerKind | null {
  if (claim.mappingDecision === 'MISSING_TYPE') return 'EVIDENCE_TYPE_GAP'
  if (claim.mappingDecision === 'SOURCE_UNVERIFIED') return 'SOURCE_REVIEW_REQUIRED'

  if (claim.mappingDecision === 'MAPPED') {
    // `NOT_MAPPABLE` est explicitement dispensé : la claim n'entre pas dans
    // l'evidence runtime, donc sa temporalité n'a rien à projeter.
    const nature = claim.temporalNature
    const precision = claim.temporalPrecision
    if (!nature || !precision) return 'TEMPORAL_PRECISION_GAP'
    if (projectTemporality(nature, precision).kind === 'gap') return 'TEMPORAL_PRECISION_GAP'
  }

  return null
}

export function toutesLesClaims(golden: any): AdjudicatedClaim[] {
  const groupes = golden?.adjudication?.rawEvidence
  if (!Array.isArray(groupes)) return []
  return groupes.flatMap((g: any) => (Array.isArray(g?.claims) ? g.claims : []))
}

// ── VALIDATION ──────────────────────────────────────────────────────────────

const JOUR_ISO = /^\d{4}-\d{2}-\d{2}$/

function nonVide(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function dateValide(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function estObjet(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Valide un Golden Case. FAIL CLOSED, et EXHAUSTIF.
 *
 * Rend TOUTES les erreurs plutôt que la première : corriger un cas erreur par
 * erreur, en relançant à chaque fois, est le meilleur moyen d'abandonner avant
 * d'avoir tout corrigé. Même doctrine que `validateEvalCase`.
 */
export function validateGoldenCaseStructure(input: unknown): GoldenValidation {
  const errors: GoldenError[] = []
  const add = (code: string, path: string, message: string) =>
    errors.push({ code, path, message })

  if (!estObjet(input)) {
    return {
      ok: false,
      errors: [
        {
          code: 'golden_case_not_object',
          path: '',
          message: 'Un cas Golden doit être un objet.',
        },
      ],
    }
  }

  const g = input as any

  // ── Racine fermée, et intégralement obligatoire ──────────────────────────
  for (const cle of Object.keys(g)) {
    if (!(CLES_RACINE as readonly string[]).includes(cle)) {
      add(
        'golden_root_key_unknown',
        cle,
        `Clé racine inconnue « ${cle} ». Les clés inconnues sont refusées, jamais ignorées : ` +
          'une faute de frappe doit se voir, pas se taire.',
      )
    }
  }
  for (const cle of CLES_RACINE) {
    if (!(cle in g)) {
      add('golden_root_key_missing', cle, `Clé racine obligatoire « ${cle} » absente.`)
    }
  }

  if (g.goldenSchemaVersion !== GOLDEN_SCHEMA_VERSION) {
    add(
      'golden_schema_version_unknown',
      'goldenSchemaVersion',
      `Version de contrat attendue « ${GOLDEN_SCHEMA_VERSION} ». Une autre valeur est refusée, ` +
        'jamais migrée à la lecture.',
    )
  }

  if (!nonVide(g.caseId)) {
    add('golden_case_id_missing', 'caseId', '`caseId` est requis et non vide.')
  }

  // ── evaluationProfile ────────────────────────────────────────────────────
  let actifs: Set<string> | null = null

  if (!estObjet(g.evaluationProfile)) {
    add('profile_invalid', 'evaluationProfile', '`evaluationProfile` doit être un objet.')
  } else {
    const p = g.evaluationProfile

    if (!(RAILS as readonly string[]).includes(p.rail)) {
      add(
        'profile_rail_unknown',
        'evaluationProfile.rail',
        `Rail inconnu. Attendu : ${RAILS.join(' | ')}.`,
      )
    }

    const lens = (LENS_REGISTRY as any)[p.lensId]
    if (!lens) {
      add(
        'profile_lens_unknown',
        'evaluationProfile.lensId',
        `Lens « ${p.lensId} » non enregistrée. ⚠️ Un identifiant de RULE PACK ` +
          '(ex. « real-estate-fabel ») n’est pas un identifiant de LENS : les packs sont DÉRIVÉS ' +
          'de la lens, jamais recopiés dans le Golden.',
      )
    } else {
      actifs = situationTypesActifsPourLens(p.lensId)
      if (p.lensVersion !== lens.lensVersion) {
        add(
          'profile_lens_version_mismatch',
          'evaluationProfile.lensVersion',
          `Version de lens « ${p.lensVersion} » ≠ « ${lens.lensVersion} » enregistrée. Utiliser ` +
            'silencieusement une autre version attribuerait des situations à une politique qui ne ' +
            'les a pas produites.',
        )
      }
    }
  }

  // ── provenance ───────────────────────────────────────────────────────────
  if (!estObjet(g.provenance)) {
    add('provenance_incomplete', 'provenance', '`provenance` doit être un objet.')
  } else {
    const p = g.provenance
    if (!nonVide(p.materializationTicket)) {
      add(
        'provenance_incomplete',
        'provenance.materializationTicket',
        '`materializationTicket` est requis.',
      )
    }
    if (!nonVide(p.adjudicationProtocol)) {
      add(
        'provenance_incomplete',
        'provenance.adjudicationProtocol',
        '`adjudicationProtocol` est requis.',
      )
    }
    if (!nonVide(p.adjudicatedOn)) {
      add('provenance_incomplete', 'provenance.adjudicatedOn', '`adjudicatedOn` est requis.')
    } else if (!JOUR_ISO.test(p.adjudicatedOn)) {
      add(
        'provenance_timestamp_over_precise',
        'provenance.adjudicatedOn',
        '`adjudicatedOn` doit être de précision JOUR (`YYYY-MM-DD`). Fabriquer une heure — ' +
          'un minuit, l’horloge de la machine — pour un fait connu au jour près introduirait une ' +
          'précision inventée dans un corpus dont le sujet est précisément de ne pas en inventer, ' +
          'et rendrait les fixtures non déterministes.',
      )
    }
  }

  // ── rawSource ────────────────────────────────────────────────────────────
  if (!estObjet(g.rawSource)) {
    add('raw_source_incomplete', 'rawSource', '`rawSource` doit être un objet.')
  } else {
    for (const champ of [
      'datasetPath',
      'datasetSchemaVersion',
      'datasetVersion',
      'datasetSha256',
      'originalCaseId',
    ]) {
      if (!nonVide(g.rawSource[champ])) {
        add(
          'raw_source_incomplete',
          `rawSource.${champ}`,
          `\`${champ}\` est requis et non vide : un ancrage partiel n’ancre rien.`,
        )
      }
    }
  }

  // ── assumptions ──────────────────────────────────────────────────────────
  if (!estObjet(g.assumptions)) {
    add('assumptions_invalid', 'assumptions', '`assumptions` doit être un objet.')
  } else {
    const a = g.assumptions

    if (!estObjet(a.now) || !dateValide(a.now.value) || !nonVide(a.now.source)) {
      add(
        'assumptions_invalid',
        'assumptions.now',
        '`now` doit porter `value` (ISO-8601 valide) et `source`.',
      )
    } else if (!(TEMPORAL_PRECISIONS as readonly string[]).includes(a.now.precision)) {
      add(
        'assumptions_invalid',
        'assumptions.now.precision',
        `Précision inconnue. Attendu : ${TEMPORAL_PRECISIONS.join(' | ')}.`,
      )
    }

    if (!estObjet(a.observedAt) || !dateValide(a.observedAt.value) || !nonVide(a.observedAt.source)) {
      add(
        'assumptions_invalid',
        'assumptions.observedAt',
        '`observedAt` doit porter `value` (ISO-8601 valide) et `source`.',
      )
    }

    if (
      !estObjet(a.targetRelevance) ||
      typeof a.targetRelevance.value !== 'number' ||
      !Number.isFinite(a.targetRelevance.value) ||
      a.targetRelevance.value < 0 ||
      a.targetRelevance.value > 1 ||
      !nonVide(a.targetRelevance.rationale)
    ) {
      add(
        'assumptions_invalid',
        'assumptions.targetRelevance',
        '`targetRelevance` doit porter une `value` dans [0,1] et un `rationale`. Cette constante ' +
          'est un CONSTANT DE REJEU, jamais un lens fit historique : `account.lensFitExpected` ne ' +
          'doit jamais l’alimenter.',
      )
    }

    if (
      !estObjet(a.evidenceConfidence) ||
      typeof a.evidenceConfidence.value !== 'number' ||
      !Number.isFinite(a.evidenceConfidence.value) ||
      a.evidenceConfidence.value < 0 ||
      a.evidenceConfidence.value > 1 ||
      !nonVide(a.evidenceConfidence.rationale)
    ) {
      add(
        'assumptions_invalid',
        'assumptions.evidenceConfidence',
        '`evidenceConfidence` doit porter une `value` dans [0,1] et un `rationale`. Cette valeur ' +
          'exprime une CERTITUDE DE FIXTURE — « la claim est bien présente » — et non la confiance ' +
          'de la source.',
      )
    }

    // ── OPTIONNEL, ET CONDITIONNÉ À SON USAGE RÉEL ────────────────────────
    //
    // ⚠️ Un cas dont toutes les claims MAPPED portent une identité de provider
    // d'ingestion RÉELLE n'a aucun provider synthétique. L'exiger quand même
    // ferait écrire une hypothèse fausse — « voici le provider synthétique que
    // j'emploie », alors qu'on n'en emploie aucun — dans le bloc dont l'unique
    // raison d'être est de dire la vérité sur ce qui a été fabriqué. La
    // réciproque est vérifiée plus bas : déclaré mais inutilisé est également
    // refusé.
    if (a.syntheticRuntimeProvider === undefined) {
      // Absent : légal. Chaque claim MAPPED devra alors justifier son provider.
    } else if (!estObjet(a.syntheticRuntimeProvider) || !nonVide(a.syntheticRuntimeProvider.value)) {
      add(
        'assumptions_invalid',
        'assumptions.syntheticRuntimeProvider',
        '`syntheticRuntimeProvider`, s’il est présent, doit porter `value` et `rationale`.',
      )
    } else {
      if (!nonVide(a.syntheticRuntimeProvider.rationale)) {
        add(
          'assumptions_invalid',
          'assumptions.syntheticRuntimeProvider.rationale',
          'Un provider synthétique sans justification serait indiscernable d’une provenance ' +
            'historique réelle.',
        )
      }
      // ⚠️ AUCUN VERDICT « FIRST-PARTY » ICI. Savoir si un provider est traité
      // comme first-party appartient à chaque pack — `EvidenceSource` ne porte
      // même pas la notion. Une infrastructure générique qui trancherait à leur
      // place serait fausse dès le deuxième vertical. La compatibilité de la
      // valeur synthétique avec la politique du pack pilote est vérifiée par un
      // test d'intégration, jamais ici.
    }
  }

  // ── executability ────────────────────────────────────────────────────────
  if (!(EXECUTABILITIES as readonly string[]).includes(g.executability)) {
    add(
      'executability_unknown',
      'executability',
      `Valeur inconnue. Attendu : ${EXECUTABILITIES.join(' | ')}.`,
    )
  }

  // ── executionContext ─────────────────────────────────────────────────────
  const comptesConnus = new Set<string>()

  if (!estObjet(g.executionContext)) {
    add('execution_context_invalid', 'executionContext', '`executionContext` doit être un objet.')
  } else {
    const ec = g.executionContext

    if (!estObjet(ec.businessContext)) {
      add(
        'execution_context_invalid',
        'executionContext.businessContext',
        '`businessContext` doit être un objet.',
      )
    } else if (estObjet(g.evaluationProfile)) {
      // Le contexte est validé EN PROFONDEUR par la SONDE, plus bas, qui appelle
      // `validateEvalCase` : le refaire ici créerait un second validateur de
      // Business Context. Seule la cohérence avec le profil est vérifiée ici,
      // parce qu'elle n'existe que dans le Golden.
      if (ec.businessContext.lensId !== g.evaluationProfile.lensId) {
        add(
          'profile_lens_mismatch',
          'executionContext.businessContext.lensId',
          'La lens du Business Context diverge de `evaluationProfile.lensId`. Le cas serait adjugé ' +
            'sous une lens et exécuté sous une autre.',
        )
      }
      if (ec.businessContext.lensVersion !== g.evaluationProfile.lensVersion) {
        add(
          'profile_lens_version_mismatch',
          'executionContext.businessContext.lensVersion',
          'La version de lens du Business Context diverge de `evaluationProfile.lensVersion`.',
        )
      }
    }

    // ⚠️ Tableau vide, doublons, portée, éligibilité : POLITIQUE DU RUNNER,
    // appliquée par la sonde. On ne collecte ici que les comptes déclarés, dont
    // les claims ont besoin pour se lier.
    if (Array.isArray(ec.targets)) {
      for (const t of ec.targets) {
        if (estObjet(t) && nonVide(t.accountId)) comptesConnus.add(t.accountId)
      }
    }
  }

  // ── adjudication ─────────────────────────────────────────────────────────
  const idsEvidence = new Set<string>()
  const clesDeClaim = new Set<string>()
  const blocageAttendu: BlockerKind[] = []
  const ciblesConnues: any[] = Array.isArray(g.executionContext?.targets)
    ? g.executionContext.targets.filter((t: any) => estObjet(t) && nonVide(t.accountId))
    : []

  if (!estObjet(g.adjudication) || !Array.isArray(g.adjudication.rawEvidence)) {
    add(
      'adjudication_invalid',
      'adjudication.rawEvidence',
      '`adjudication.rawEvidence` doit être un tableau.',
    )
  } else if (g.adjudication.rawEvidence.length === 0) {
    add(
      'adjudication_invalid',
      'adjudication.rawEvidence',
      'Un cas Golden doit adjuger au moins une Evidence RAW.',
    )
  } else {
    const vus = new Set<string>()

    g.adjudication.rawEvidence.forEach((groupe: any, gi: number) => {
      const gp = `adjudication.rawEvidence[${gi}]`

      if (!estObjet(groupe) || !nonVide(groupe.rawEvidenceId)) {
        add('adjudication_invalid', `${gp}.rawEvidenceId`, '`rawEvidenceId` est requis et non vide.')
        return
      }

      if (vus.has(groupe.rawEvidenceId)) {
        add(
          'raw_evidence_adjudication_duplicate',
          `${gp}.rawEvidenceId`,
          `L’Evidence RAW « ${groupe.rawEvidenceId} » est adjugée deux fois. Une seule ` +
            'adjudication par Evidence RAW : deux décompositions concurrentes rendraient ' +
            '« complète » ambigu.',
        )
      }
      vus.add(groupe.rawEvidenceId)

      if (groupe.decompositionStatus !== 'COMPLETE') {
        add(
          'decomposition_status_invalid',
          `${gp}.decompositionStatus`,
          '`decompositionStatus` doit valoir « COMPLETE ». C’est une ASSERTION HUMAINE — aucun ' +
            'parseur ne peut déduire d’une prose qu’elle a été entièrement extraite. Une ' +
            'décomposition inachevée reste un état de workflow AVANT matérialisation ; elle n’a ' +
            'aucune représentation persistée.',
        )
      }

      if (!Array.isArray(groupe.claims) || groupe.claims.length === 0) {
        add(
          'raw_evidence_claims_empty',
          `${gp}.claims`,
          'Au moins une claim est requise : une Evidence RAW adjugée sans claim aurait disparu ' +
            'sans décision enregistrée.',
        )
        return
      }

      const indices = groupe.claims.map((c: any) => c?.claimIndex)
      const attendus = groupe.claims.map((_: unknown, i: number) => i)
      if (JSON.stringify([...indices].sort((a, b) => a - b)) !== JSON.stringify(attendus)) {
        add(
          'claim_index_non_contiguous',
          `${gp}.claims`,
          `\`claimIndex\` doit être unique et contigu depuis 0 ; reçu [${indices.join(', ')}]. ` +
            'Un trou d’indice signale une claim retirée en silence.',
        )
      }

      groupe.claims.forEach((claim: any, ci: number) => {
        const cp = `${gp}.claims[${ci}]`
        validerClaim(claim, cp, {
          add,
          rawEvidenceId: groupe.rawEvidenceId,
          assumptions: g.assumptions,
          comptesConnus,
          ciblesConnues,
          idsEvidence,
          clesDeClaim,
          blocageAttendu,
          etatSigne: g.caseStatus?.state === 'SIGNED_SEMANTIC_GOLDEN',
        })
      })
    })

    // ── RÉFÉRENCES DE DOUBLON : DIRECTES, ET VERS UN CANONIQUE ─────────────
    //
    // ⚠️ CE QUE « la cible existe » NE SUFFISAIT PAS À EMPÊCHER. Une claim
    // pouvait se désigner elle-même (A → A), ou deux claims se désigner
    // mutuellement (A → B, B → A). Dans les deux cas TOUTES les représentations
    // du fait sont écartées, aucune ne subsiste, et le fait disparaît — sans
    // qu'aucune règle ne soit violée en apparence. C'est exactement la
    // suppression silencieuse que `NOT_MAPPABLE` est censé rendre impossible.
    //
    // RÈGLE V0 : un doublon désigne UNE AUTRE claim, qui n'est elle-même PAS un
    // doublon. Pas de chaîne. Le fait conservé est donc toujours à un saut, et
    // toujours canonique.
    const parCle = new Map<string, any>()
    for (const groupe of g.adjudication.rawEvidence) {
      if (!estObjet(groupe) || !Array.isArray(groupe.claims)) continue
      for (const claim of groupe.claims) {
        if (estObjet(claim)) parCle.set(`${groupe.rawEvidenceId}#${claim.claimIndex}`, claim)
      }
    }

    for (const groupe of g.adjudication.rawEvidence) {
      if (!estObjet(groupe) || !Array.isArray(groupe.claims)) continue

      for (const claim of groupe.claims) {
        if (!estObjet(claim) || claim.exclusionClass !== 'DUPLICATE_OF_CLAIM') continue

        const ref = claim.duplicateOf
        if (!estObjet(ref)) continue

        const cleSource = `${groupe.rawEvidenceId}#${claim.claimIndex}`
        const cleCible = `${ref.rawEvidenceId}#${ref.claimIndex}`
        const chemin = `adjudication.rawEvidence[${groupe.rawEvidenceId}].claims[${claim.claimIndex}].duplicateOf`

        if (cleCible === cleSource) {
          add(
            'claim_duplicate_self_reference',
            chemin,
            `La claim « ${cleSource} » se désigne elle-même comme doublon. Elle serait écartée sans ` +
              'qu’aucune représentation du fait ne subsiste : le fait disparaîtrait purement et ' +
              'simplement.',
          )
          continue
        }

        if (!clesDeClaim.has(cleCible)) {
          add(
            'claim_duplicate_reference_unknown',
            chemin,
            `La claim écartée comme doublon renvoie à « ${cleCible} », qui n’existe pas. Un doublon ` +
              'qui ne désigne pas le fait conservé supprime ce fait au lieu de le dédoublonner.',
          )
          continue
        }

        if (parCle.get(cleCible)?.exclusionClass === 'DUPLICATE_OF_CLAIM') {
          add(
            'claim_duplicate_target_is_duplicate',
            chemin,
            `La claim « ${cleSource} » désigne « ${cleCible} », elle-même écartée comme doublon. ` +
              'Les chaînes et les cycles sont interdits en V0 : A → B → A écarterait les DEUX ' +
              'représentations, et une chaîne oblige à suivre un renvoi pour savoir quel fait a ' +
              'survécu. Un doublon désigne directement une claim CANONIQUE.',
          )
        }
      }
    }
  }

  // ── PROVIDER SYNTHÉTIQUE : DÉCLARÉ ⇒ RÉELLEMENT EMPLOYÉ ──────────────────
  // Une hypothèse qui ne s'applique à rien est une hypothèse fausse. Elle ferait
  // croire à un relecteur que des faits ont été fabriqués alors qu'ils portent
  // tous une provenance réelle.
  const synthetiqueDeclare = g.assumptions?.syntheticRuntimeProvider?.value
  if (nonVide(synthetiqueDeclare)) {
    const employe = toutesLesClaims(g).some(
      (c: any) =>
        c?.mappingDecision === 'MAPPED' && c?.runtimeSource?.provider === synthetiqueDeclare,
    )
    if (!employe) {
      add(
        'synthetic_provider_unused',
        'assumptions.syntheticRuntimeProvider',
        `Le provider synthétique « ${synthetiqueDeclare} » est déclaré mais aucune claim MAPPED ne ` +
          'l’emploie. Une hypothèse de rejeu qui ne s’applique à rien laisserait croire que des ' +
          'faits ont été fabriqués alors qu’ils portent tous une provenance réelle : soit on ' +
          'l’emploie, soit on ne le déclare pas.',
      )
    }
  }

  // ── expected ─────────────────────────────────────────────────────────────
  let assertionsFermes = 0

  if (!estObjet(g.expected) || !estObjet(g.expected.situations)) {
    add('expected_invalid', 'expected.situations', '`expected.situations` doit être un objet.')
  } else {
    for (const cle of Object.keys(g.expected)) {
      if (cle !== 'situations') {
        add(
          'expectation_forbidden_key',
          `expected.${cle}`,
          `Clé « ${cle} » interdite dans « expected ». RAIL S n’affirme QUE des Situations : ` +
            '`behavior`, `confidence`, `priority`, `lensFitExpected`, `control` et `ranking` ' +
            'appartiennent à RAIL R.',
        )
      }
    }

    const connus = situationTypesConnus()
    const vus = new Set<string>()

    for (const [type, valeur] of Object.entries<any>(g.expected.situations)) {
      vus.add(type)
      const path = `expected.situations.${type}`

      if (!connus.has(type)) {
        add(
          'expectation_situation_unknown',
          path,
          `SituationType « ${type} » déclaré par aucun Rule Pack enregistré.`,
        )
      } else if (actifs && !actifs.has(type)) {
        add(
          'expectation_situation_inactive_for_lens',
          path,
          `SituationType « ${type} » connu du catalogue, mais déclaré par aucun Rule Pack de la ` +
            `lens « ${g.evaluationProfile?.lensId} ». L’attente serait INERTE : trivialement ` +
            'satisfaite, elle ne testerait rien tout en gonflant la couverture apparente.',
        )
      }

      if (!estObjet(valeur)) {
        add('expected_invalid', path, 'Chaque attente doit être un objet `{assertion, rationale}`.')
        continue
      }
      if (!(SITUATION_ASSERTIONS as readonly string[]).includes(valeur.assertion)) {
        add(
          'expectation_assertion_unknown',
          `${path}.assertion`,
          `Assertion inconnue. Attendu : ${SITUATION_ASSERTIONS.join(' | ')}.`,
        )
      } else if (valeur.assertion !== 'UNSPECIFIED') {
        assertionsFermes += 1
      }

      if (!nonVide(valeur.rationale)) {
        add(
          'expectation_rationale_missing',
          `${path}.rationale`,
          'Un `rationale` est requis, y compris pour `UNSPECIFIED` : c’est ce qui distingue une ' +
            'ABSTENTION DÉLIBÉRÉE d’un oubli, et donc un oracle PARTIEL d’un oracle INCOMPLET.',
        )
      }
    }

    if (actifs) {
      for (const type of actifs) {
        if (!vus.has(type)) {
          add(
            'expectation_missing_active_situation',
            `expected.situations.${type}`,
            `SituationType actif « ${type} » absent. Le silence n’est pas une valeur : une clé ` +
              'absente serait indiscernable d’un `UNSPECIFIED` décidé.',
          )
        }
      }
    }
  }

  // ── legacyAssessment ─────────────────────────────────────────────────────
  if (!estObjet(g.legacyAssessment) || !Array.isArray(g.legacyAssessment.items)) {
    add('legacy_item_incomplete', 'legacyAssessment.items', '`items` doit être un tableau.')
  } else if (g.legacyAssessment.items.length === 0) {
    add(
      'legacy_item_incomplete',
      'legacyAssessment.items',
      'Au moins une référence historique est requise.',
    )
  } else {
    g.legacyAssessment.items.forEach((item: any, i: number) => {
      const path = `legacyAssessment.items[${i}]`

      if (!estObjet(item)) {
        add('legacy_item_incomplete', path, 'Chaque item doit être un objet.')
        return
      }
      // ⚠️ Aucune VALEUR du RAW n'est recopiée ici — uniquement un POINTEUR.
      // Dupliquer un libellé historique en ferait une seconde vérité, qui
      // dériverait de l'archive sans que rien ne le signale.
      if (!nonVide(item.rawRef) || !item.rawRef.startsWith('/')) {
        add(
          'legacy_raw_ref_invalid',
          `${path}.rawRef`,
          '`rawRef` doit être un JSON Pointer RFC 6901 (ex. « /expected/primaryHypothesis »).',
        )
      }
      if (!(LEGACY_SCOPES as readonly string[]).includes(item.scope)) {
        add(
          'legacy_scope_unknown',
          `${path}.scope`,
          `Portée inconnue. Attendu : ${LEGACY_SCOPES.join(' | ')}.`,
        )
      }
      if (!(LEGACY_STATUSES as readonly string[]).includes(item.status)) {
        add(
          'legacy_status_unknown',
          `${path}.status`,
          `Statut inconnu. Attendu : ${LEGACY_STATUSES.join(' | ')}.`,
        )
      }
      if (!nonVide(item.rationale)) {
        add('legacy_item_incomplete', `${path}.rationale`, '`rationale` est requis.')
      }
    })
  }

  // ── caseStatus, et sa cohérence avec l'adjudication ──────────────────────
  if (!estObjet(g.caseStatus)) {
    add('case_status_invalid', 'caseStatus', '`caseStatus` doit être un objet.')
  } else {
    const cs = g.caseStatus

    if (!(CASE_STATES as readonly string[]).includes(cs.state)) {
      add('case_status_unknown', 'caseStatus.state', `État inconnu. Attendu : ${CASE_STATES.join(' | ')}.`)
    }

    if (!Array.isArray(cs.blockers)) {
      add('case_status_invalid', 'caseStatus.blockers', '`blockers` doit être un tableau.')
    } else {
      cs.blockers.forEach((b: any, i: number) => {
        const path = `caseStatus.blockers[${i}]`
        if (!estObjet(b)) {
          add('case_status_invalid', path, 'Chaque blocage doit être un objet.')
          return
        }
        if (!(BLOCKER_KINDS as readonly string[]).includes(b.kind)) {
          add(
            'blocker_kind_unknown',
            `${path}.kind`,
            `Cause inconnue. Attendu : ${BLOCKER_KINDS.join(' | ')}. Aucune chaîne composite : ` +
              'plusieurs causes coexistent en plusieurs entrées, jamais en une seule.',
          )
        }
        if (!nonVide(b.note)) {
          add('case_status_invalid', `${path}.note`, '`note` est requis.')
        }
      })

      // Les blocages DÉCLARÉS doivent correspondre aux blocages RÉELS.
      const declares = cs.blockers
        .map((b: any) => b?.kind)
        .filter((k: any) => (BLOCKER_KINDS as readonly string[]).includes(k))

      const manquants = blocageAttendu.filter((k) => !declares.includes(k))
      const surnumeraires = declares.filter(
        (k: BlockerKind) => !blocageAttendu.includes(k) && k !== 'EXPECTATION_AMBIGUOUS',
      )

      for (const kind of new Set(manquants)) {
        add(
          'blocker_inconsistent_with_claims',
          'caseStatus.blockers',
          `Une claim impose le blocage « ${kind} », qui n’est pas déclaré. Un blocage tu rendrait ` +
            'le cas non exécutable sans motif enregistré.',
        )
      }
      for (const kind of new Set<BlockerKind>(surnumeraires)) {
        add(
          'blocker_inconsistent_with_claims',
          'caseStatus.blockers',
          `Le blocage « ${kind} » est déclaré alors qu’aucune claim ne l’impose. ` +
            '(`EXPECTATION_AMBIGUOUS` fait exception : il porte sur l’attente, pas sur une claim.)',
        )
      }

      // ── L'ÉQUIVALENCE, dans les DEUX sens ────────────────────────────────
      const sansBlocage = cs.blockers.length === 0
      const executable = g.executability === 'EXECUTABLE'

      if (cs.state === 'SIGNED_SEMANTIC_GOLDEN') {
        if (!sansBlocage || !executable) {
          add(
            'case_status_executability_mismatch',
            'caseStatus.state',
            'Un cas SIGNÉ exige `blockers: []` ET `executability: EXECUTABLE`.',
          )
        }
        if (assertionsFermes === 0) {
          add(
            'signed_case_without_assertion',
            'expected.situations',
            'Un cas SIGNÉ doit porter au moins une assertion REQUIRED ou FORBIDDEN. Un cas ' +
              'entièrement UNSPECIFIED n’affirme rien et ne peut rien signer. ' +
              '⚠️ L’inverse n’est PAS exigé : `UNSPECIFIED` reste légal dans un cas signé — un ' +
              'oracle partiel est légitime, fabriquer des attentes non adjugées ne l’est pas.',
          )
        }
      } else if (cs.state === 'BLOCKED') {
        if (sansBlocage || executable) {
          add(
            'case_status_executability_mismatch',
            'caseStatus.state',
            'Un cas BLOQUÉ exige au moins un blocage ET ' +
              '`executability: ADJUDICATED_NON_EXECUTABLE`.',
          )
        }
      }
    }
  }

  // ── SONDE DU CONTEXTE D'EXÉCUTION — POUR TOUS LES CAS, BLOQUÉS COMPRIS ───
  //
  // ⚠️ AUCUN SECOND VALIDATEUR DE CONTEXTE. On soumet au validateur du runner un
  // cas runtime à EVIDENCE VIDE : il applique alors sa politique réelle sur
  // `businessContext` et `targets` — champs obligatoires, version de lens,
  // périmètre, doublons, éligibilité — sans qu'on ait à projeter des claims
  // encore irrésolues.
  //
  // ⚠️ ET SURTOUT POUR LES CAS BLOQUÉS. `executionContext` est persisté même
  // quand le cas ne s'exécute pas, précisément pour que lever un blocage ne
  // demande pas d'inventer plus tard des données d'exécution. Le laisser
  // invalide jusque-là ferait découvrir un contexte cassé des mois après, au
  // moment où l'on croit avoir fini.
  for (const err of sonderContexteExecution(g)) add(err.code, err.path, err.message)

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, case: g as GoldenCase }
}

/** Pertinence de SONDE — sans effet métier : la sonde ne produit aucun verdict. */
const RELEVANCE_SONDE = 0.5

/**
 * Soumet le contexte d'exécution persisté au validateur du runner.
 *
 * ── REMAPPAGE DES CHEMINS ───────────────────────────────────────────────────
 * Les erreurs rendues désignent des champs de l'`EvalCase` sondé. Elles sont
 * réécrites vers le champ Golden RÉELLEMENT fautif : un chemin qui nomme une
 * structure inexistante n'aide personne à corriger un fichier.
 *
 * ⚠️ AUCUN CHEMIN NE COMMENCE PAR `input.`. Ce préfixe désignait une racine
 * `input` qui a été SUPPRIMÉE du contrat (R2, « dériver, ne pas dupliquer ») :
 * il envoyait le lecteur vers un champ qui n'existe plus.
 */
function sonderContexteExecution(g: any): GoldenError[] {
  const ec = g?.executionContext
  if (!estObjet(ec)) return []

  const relevance = g?.assumptions?.targetRelevance?.value
  const relevanceSonde =
    typeof relevance === 'number' && Number.isFinite(relevance) && relevance >= 0 && relevance <= 1
      ? relevance
      : RELEVANCE_SONDE

  const sonde = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    now: g?.assumptions?.now?.value,
    businessContext: ec.businessContext,
    targets: Array.isArray(ec.targets)
      ? ec.targets.map((t: any) =>
          estObjet(t) ? { ...t, relevance: relevanceSonde } : t,
        )
      : ec.targets,
    // VIDE, et c'est tout l'intérêt : le contexte est éprouvé sans qu'aucune
    // claim non résolue n'ait à être projetée.
    evidence: [],
  }

  const validation = validateEvalCase(sonde)
  if (validation.ok === true) return []

  return validation.errors.map((err) => ({
    code: err.code,
    path: remapperCheminSonde(err.path),
    message: err.message,
  }))
}

function remapperCheminSonde(path: string): string {
  if (path === 'now') return 'assumptions.now.value'
  // La pertinence est INJECTÉE par la sonde : une erreur dessus incrimine la
  // constante déclarée, jamais une cible qui ne la porte pas.
  if (/^targets\[\d+\]\.relevance$/.test(path)) return 'assumptions.targetRelevance.value'
  if (path === 'schemaVersion') return 'assumptions'
  return `executionContext.${path}`
}

// ── VALIDATION D'UNE CLAIM ──────────────────────────────────────────────────

interface ContexteClaim {
  add: (code: string, path: string, message: string) => void
  rawEvidenceId: string
  assumptions: any
  comptesConnus: Set<string>
  ciblesConnues: any[]
  idsEvidence: Set<string>
  clesDeClaim: Set<string>
  blocageAttendu: BlockerKind[]
  etatSigne: boolean
}

/** Champs réservés au mapping runtime — interdits hors `MAPPED`. */
const CHAMPS_RUNTIME = [
  'evidenceType',
  'evidenceId',
  'evidenceScope',
  'targetAccountId',
  'targetPersonId',
  'runtimeSource',
] as const

function validerClaim(claim: any, path: string, ctx: ContexteClaim): void {
  const { add } = ctx

  if (!estObjet(claim)) {
    add('claim_invalid', path, 'Chaque claim doit être un objet.')
    return
  }

  if (typeof claim.claimIndex === 'number') {
    ctx.clesDeClaim.add(`${ctx.rawEvidenceId}#${claim.claimIndex}`)
  }

  if (!nonVide(claim.semanticClaim)) {
    add(
      'claim_semantic_missing',
      `${path}.semanticClaim`,
      '`semanticClaim` est requis : c’est le FAIT ATOMIQUE, la seule chose qui survive à un ' +
        'changement de taxonomie.',
    )
  }

  if (!(MAPPING_DECISIONS as readonly string[]).includes(claim.mappingDecision)) {
    add(
      'claim_mapping_decision_unknown',
      `${path}.mappingDecision`,
      `Décision inconnue. Attendu : ${MAPPING_DECISIONS.join(' | ')}.`,
    )
    return
  }

  const mappee = claim.mappingDecision === 'MAPPED'

  // ── Sémantique : légale partout, mais VALIDE partout où elle est présente ─
  if (claim.assertionType !== undefined && !nonVide(claim.assertionType)) {
    add('claim_assertion_type_invalid', `${path}.assertionType`, '`assertionType` doit être une chaîne non vide.')
  }
  if (
    claim.temporalNature !== undefined &&
    !(TEMPORAL_NATURES as readonly string[]).includes(claim.temporalNature)
  ) {
    add(
      'claim_temporal_nature_unknown',
      `${path}.temporalNature`,
      `Nature inconnue. Attendu : ${TEMPORAL_NATURES.join(' | ')}. ⚠️ Un ÉVÉNEMENT dont la date ` +
        'nous échappe reste un `EVENT` de précision `UNKNOWN` — jamais un `STATE`, qui affirmerait ' +
        'un état constaté d’ancienneté inconnue.',
    )
  }
  if (
    claim.temporalPrecision !== undefined &&
    !(TEMPORAL_PRECISIONS as readonly string[]).includes(claim.temporalPrecision)
  ) {
    add(
      'claim_temporal_precision_unknown',
      `${path}.temporalPrecision`,
      `Précision inconnue. Attendu : ${TEMPORAL_PRECISIONS.join(' | ')}.`,
    )
  }

  if (claim.sourceReview !== undefined) {
    if (!Array.isArray(claim.sourceReview)) {
      add('claim_source_review_invalid', `${path}.sourceReview`, '`sourceReview` doit être un tableau.')
    } else {
      claim.sourceReview.forEach((rev: any, i: number) => {
        if (!estObjet(rev) || !(REVIEW_CLASSES as readonly string[]).includes(rev.reviewClass)) {
          add(
            'claim_source_review_invalid',
            `${path}.sourceReview[${i}].reviewClass`,
            `Classe de revue inconnue. Attendu : ${REVIEW_CLASSES.join(' | ')}.`,
          )
        }
      })
    }
  }

  const revues: any[] = Array.isArray(claim.sourceReview) ? claim.sourceReview : []
  const revueReelle = revues.some(
    (r) =>
      estObjet(r) &&
      (REVIEW_CLASSES as readonly string[]).includes(r.reviewClass) &&
      r.reviewClass !== 'NOT_REVIEWED',
  )

  // ── MAPPED : mapping runtime complet, et revue RÉELLE ────────────────────
  if (mappee) {
    for (const champ of ['evidenceType', 'evidenceId', 'evidenceScope', 'targetAccountId']) {
      if (!nonVide(claim[champ])) {
        add(
          'claim_missing_runtime_fields',
          `${path}.${champ}`,
          `\`${champ}\` est requis pour une claim MAPPED : sans lui, aucune EvidenceEvent runtime ` +
            'ne peut être construite honnêtement.',
        )
      }
    }
    if (
      claim.evidenceScope !== undefined &&
      !(EVIDENCE_SCOPES as readonly string[]).includes(claim.evidenceScope)
    ) {
      add(
        'claim_evidence_scope_unknown',
        `${path}.evidenceScope`,
        `Portée inconnue. Attendu : ${EVIDENCE_SCOPES.join(' | ')}.`,
      )
    }

    if (nonVide(claim.evidenceId)) {
      if (ctx.idsEvidence.has(claim.evidenceId)) {
        add(
          'claim_evidence_id_duplicate',
          `${path}.evidenceId`,
          `\`evidenceId\` « ${claim.evidenceId} » déjà employé. Deux evidences de même identifiant ` +
            'rendraient la sortie dépendante de l’ordre de lecture.',
        )
      }
      ctx.idsEvidence.add(claim.evidenceId)
    }

    if (nonVide(claim.targetAccountId) && !ctx.comptesConnus.has(claim.targetAccountId)) {
      add(
        'claim_target_account_unknown',
        `${path}.targetAccountId`,
        `Le compte « ${claim.targetAccountId} » n’est déclaré par aucune cible de ` +
          '`executionContext.targets`. L’evidence serait ORPHELINE : silencieusement ignorée par le ' +
          'moteur, alors que la fixture prétendrait la tester.',
      )
    } else if (nonVide(claim.targetAccountId)) {
      // ── SONDE DE LIAISON — POUR TOUTE CLAIM MAPPED, BLOQUÉE OU NON ───────
      //
      // ⚠️ LE TROU QUE CECI FERME. L'intégrité référentielle complète du runner
      // ne s'applique qu'au cas PROJETÉ, et un cas BLOQUÉ ne se projette jamais.
      // Une claim déjà MAPPED pouvait donc porter un `targetPersonId` que nulle
      // cible ne nomme, et personne ne l'apprenait avant que le blocage — sans
      // rapport — ne soit levé, des mois plus tard.
      //
      // ⚠️ CECI N'EST PAS UNE EVIDENCE RUNTIME FABRIQUÉE. C'est une SONDE DE
      // CIBLAGE : `evidenceMatchesTarget()` ne lit que `id`, `accountId`,
      // `personId` et `scope`, et rien d'autre n'est fourni. Aucune date, aucune
      // confiance, aucun provider — rien qui puisse être pris pour un fait.
      //
      // ⚠️ AUCUNE DOCTRINE DE CIBLAGE CONCURRENTE. On appelle le prédicat de
      // production ; la règle « une evidence portant `personId` n'est consommable
      // que par la cible (compte, personne) » n'est pas recopiée ici, elle est
      // interrogée là où elle vit.
      const sondeCiblage: any = {
        id: claim.evidenceId ?? 'sonde',
        accountId: claim.targetAccountId,
        scope: claim.evidenceScope,
      }
      if (claim.targetPersonId !== undefined) sondeCiblage.personId = claim.targetPersonId

      const consommable = ctx.ciblesConnues.some((t: any) =>
        evidenceMatchesTarget(sondeCiblage, { accountId: t.accountId, personId: t.personId }),
      )

      if (!consommable) {
        add(
          'claim_target_binding_unmatched',
          `${path}.targetPersonId`,
          `Aucune cible de \`executionContext.targets\` ne peut consommer cette claim (compte ` +
            `« ${claim.targetAccountId} », personne « ${claim.targetPersonId ?? '—'} », portée ` +
            `« ${claim.evidenceScope} »), selon \`evidenceMatchesTarget()\`. L’evidence projetée ` +
            'serait silencieusement écartée par le moteur, et la fixture prétendrait la tester.',
        )
      }
    }

    if (!nonVide(claim.assertionType)) {
      add(
        'claim_missing_runtime_fields',
        `${path}.assertionType`,
        '`assertionType` est requis pour une claim MAPPED.',
      )
    }
    if (!nonVide(claim.temporalNature) || !nonVide(claim.temporalPrecision)) {
      add(
        'claim_missing_runtime_fields',
        `${path}.temporalNature`,
        '`temporalNature` et `temporalPrecision` sont requis pour une claim MAPPED.',
      )
    }

    // ── Provider runtime : COMPORTEMENTALEMENT VIVANT ─────────────────────
    // `estFirstParty()` compare une chaîne à la liste blanche du pack Fabel, et
    // le raccourci first-party contourne des seuils. Inventer une catégorie qui
    // ressemble à de la provenance serait pire qu’une valeur ouvertement
    // synthétique.
    if (!estObjet(claim.runtimeSource) || !nonVide(claim.runtimeSource.provider)) {
      add(
        'claim_missing_runtime_fields',
        `${path}.runtimeSource.provider`,
        '`runtimeSource.provider` est requis et non vide (cf. `isEvidenceEvent`).',
      )
    } else {
      const provider = claim.runtimeSource.provider
      const synthetique = ctx.assumptions?.syntheticRuntimeProvider?.value

      // ⚠️ RÈGLE PUREMENT RÉFÉRENTIELLE, et volontairement. Elle ne dit pas ce
      // qu'un provider SIGNIFIE — un pack peut lui accorder des raccourcis, un
      // autre non — elle exige seulement que tout provider s'écartant de la
      // valeur synthétique déclarée soit JUSTIFIÉ. Cela couvre les providers
      // sensibles de n'importe quel vertical sans qu'aucune liste blanche de
      // pack n'entre dans l'infrastructure générique.
      if (provider !== synthetique && !nonVide(claim.rationale)) {
        add(
          'claim_provider_unjustified',
          `${path}.runtimeSource.provider`,
          `Le provider « ${provider} » n’est ni le provider synthétique déclaré dans ` +
            '`assumptions.syntheticRuntimeProvider`, ni justifié par un `rationale`. Une catégorie ' +
            'inventée (« web-press », « presse ») se lit comme de la provenance tout en étant une ' +
            'fiction : soit le provider correspond à une identité d’ingestion réelle et on le ' +
            'justifie, soit on emploie le provider synthétique déclaré. ⚠️ Un provider peut ouvrir ' +
            'des raccourcis dans un Rule Pack (première partie, canal privilégié) : la justification ' +
            'est ce qui empêche d’atteindre une telle branche par commodité.',
        )
      }
    }

    if (revues.length === 0 || !revueReelle) {
      add(
        'claim_missing_source_review',
        `${path}.sourceReview`,
        'Une claim MAPPED exige au moins une revue de classe ≠ NOT_REVIEWED. Une Evidence runtime ' +
          'ne doit JAMAIS naître d’une claim que personne n’a réellement examinée — si le support ' +
          'de source est insuffisant, la décision est `SOURCE_UNVERIFIED`, pas `MAPPED`.',
      )
    }
  } else {
    // ── Hors MAPPED : aucun champ de mapping runtime ──────────────────────
    for (const champ of CHAMPS_RUNTIME) {
      if (claim[champ] !== undefined) {
        add(
          'claim_runtime_fields_without_mapped',
          `${path}.${champ}`,
          `\`${champ}\` n’est légal que pour une claim MAPPED : ces champs n’existent que pour ` +
            'projeter une EvidenceEvent runtime. ⚠️ La sémantique (`assertionType`, ' +
            '`temporalNature`, `temporalPrecision`, `occurredAt`, `sourceReview`), elle, reste ' +
            'légale — on sait souvent ce qu’un fait EST avant de savoir le typer.',
        )
      }
    }

    if (!nonVide(claim.rationale)) {
      add(
        'claim_missing_rationale',
        `${path}.rationale`,
        `Une claim « ${claim.mappingDecision} » exige un \`rationale\` : il est bon marché ` +
          'd’enregistrer pourquoi un fait n’a pas pu être typé, et coûteux de découvrir plus tard ' +
          'qu’il a disparu.',
      )
    }

    if (claim.mappingDecision === 'MISSING_TYPE' && !revueReelle) {
      add(
        'claim_missing_source_review',
        `${path}.sourceReview`,
        'Une claim MISSING_TYPE exige au moins une revue de classe ≠ NOT_REVIEWED : un trou de ' +
          'taxonomie ne se déclare que sur un fait réellement lu.',
      )
    }
  }

  // ── occurredAt ⟺ projection en `dated_event` ─────────────────────────────
  if (mappee && nonVide(claim.temporalNature) && nonVide(claim.temporalPrecision)) {
    const projection = projectTemporality(claim.temporalNature, claim.temporalPrecision)

    if (projection.kind === 'dated_event') {
      if (!dateValide(claim.occurredAt)) {
        add(
          'claim_occurred_at_temporality_mismatch',
          `${path}.occurredAt`,
          'Un événement daté exige un `occurredAt` ISO-8601 valide.',
        )
      }
    } else if (projection.kind === 'undated_state') {
      if (claim.occurredAt !== undefined) {
        add(
          'claim_occurred_at_temporality_mismatch',
          `${path}.occurredAt`,
          'Un `STATE` projette en `undated_state`, qui INTERDIT `occurredAt` (cf. ' +
            '`UndatedStateEvidence.occurredAt?: never`). Une date de survenue sur un état non daté ' +
            'est une contradiction : on la refuse plutôt que de l’ignorer.',
        )
      }
    } else {
      add(
        'claim_temporal_projection_gap',
        `${path}.temporalPrecision`,
        projection.reason,
      )
    }
  }

  // ── NOT_MAPPABLE : la porte de sortie, verrouillée ───────────────────────
  if (claim.mappingDecision === 'NOT_MAPPABLE') {
    if (!(EXCLUSION_CLASSES as readonly string[]).includes(claim.exclusionClass)) {
      add(
        'claim_exclusion_class_missing',
        `${path}.exclusionClass`,
        `Une claim NOT_MAPPABLE exige une \`exclusionClass\` parmi ${EXCLUSION_CLASSES.join(' | ')}. ` +
          '⚠️ C’EST LE GARDE-FOU : un FAIT MÉTIER réel concernant le compte ne peut honnêtement ' +
          'porter aucune de ces classes, donc il reste `MISSING_TYPE`, donc il reste BLOQUANT. ' +
          'Sans cette exigence, `NOT_MAPPABLE` deviendrait l’échappatoire aux trous de taxonomie.',
      )
    }
    if (!revueReelle) {
      add(
        'claim_missing_source_review',
        `${path}.sourceReview`,
        'Une claim NOT_MAPPABLE exige au moins une revue de classe ≠ NOT_REVIEWED : on ne peut ' +
          'écarter comme non représentable un fait que personne n’a lu.',
      )
    }
    if (claim.exclusionClass === 'DUPLICATE_OF_CLAIM') {
      const ref = claim.duplicateOf
      if (!estObjet(ref) || !nonVide(ref.rawEvidenceId) || typeof ref.claimIndex !== 'number') {
        add(
          'claim_duplicate_reference_missing',
          `${path}.duplicateOf`,
          'Un doublon doit DÉSIGNER la claim conservée (`{rawEvidenceId, claimIndex}`). Sans ' +
            'référence, « doublon » supprime un fait au lieu de le dédoublonner.',
        )
      }
    }
  } else if (claim.exclusionClass !== undefined) {
    add(
      'claim_exclusion_class_unexpected',
      `${path}.exclusionClass`,
      '`exclusionClass` n’est légale que pour une claim NOT_MAPPABLE.',
    )
  }

  const blocage = claimEstBloquante(claim as AdjudicatedClaim)
  if (blocage) ctx.blocageAttendu.push(blocage)
}
