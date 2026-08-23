// RULE PACK — `real-estate-fabel` (FABEL-RULEPACK-001).
//
// ── CE QUE CE PACK PROUVE ───────────────────────────────────────────────────
// Que le Decision Kernel universel accueille un vertical NON-Sales sans rien
// apprendre de son métier. Aucun fichier du cœur n'a été modifié pour lui : les
// mots « bureau », « bail », « flex », « m² » n'existent que dans ce dossier.
//
// ── LES TROIS HYPOTHÈSES, ET CE QU'ELLES NE SONT PAS ────────────────────────
//
//   space_expansion      croissance observable → pression FUTURE POSSIBLE sur
//                        la capacité. JAMAIS « besoin de bureaux ».
//   space_contraction    convergence de signaux → contraction immobilière
//                        POSSIBLE. JAMAIS un ratio RH → mètres carrés.
//   flex_remove_window   début déclaré + durée déclarée → fenêtre de revue
//                        DÉRIVÉE. JAMAIS une correspondance d'adresse.
//
// Une Situation est une INTERPRÉTATION. Elle ne réécrit aucune Evidence, et le
// moteur n'offre aucun chemin pour qu'une de ses sorties redevienne un fait.
import { defineRulePack, type SituationEvaluationContext } from '../../rulePack'
import type { AnticipatedHorizon, EvidenceEvent, Situation } from '../../types'
import { averageConfidence, buildSituation, hasFact } from '../../ruleKit'
import {
  CONTRACTION_CONTRADICTIONS,
  CONTRACTION_FAMILIES,
  CONTRACTION_REQUIRED_FAMILIES,
  EXPANSION_CONTRADICTIONS,
  EXPANSION_DYNAMIC_FAMILIES,
  EXPANSION_FAMILIES,
  MIN_FAMILY_EVIDENCE_CONFIDENCE,
  MIN_SITUATION_CONFIDENCE_CONTRACTION,
  MIN_SITUATION_CONFIDENCE_EXPANSION,
  MIN_SITUATION_CONFIDENCE_FLEX,
  contradictionBloquante,
  contributeursDeFamille,
  famillesRepresentees,
} from './families'
import {
  addMonthsUTC,
  dureeEnMois,
  ordonnerContributeurs,
  toutesLesEvidencesDeTypes,
} from './aggregate'
import { estDeclarationFiable } from './provenance'

export const FABEL_PACK_ID = 'real-estate-fabel'
export const FABEL_PACK_VERSION = 'v0.1'

/**
 * Délai avant échéance à partir duquel une fenêtre de revue devient utile.
 *
 *     PROVISIONAL PACK POLICY
 *
 * Six mois est une pratique de courtage, pas une vérité. Cette constante vit
 * ICI et ne remontera jamais dans le cœur : trente jours avant l'expiration
 * d'un certificat et six mois avant une fin de bail décrivent le même concept
 * universel avec des valeurs incomparables.
 */
const LEAD_MONTHS = 6

const SITUATION_TYPES = [
  'space_expansion',
  'space_contraction',
  'flex_remove_window',
] as const

const EVIDENCE_TYPES = [
  // ── Réutilisés du catalogue existant, sémantique inchangée ───────────────
  'recent_funding',
  'headcount_acceleration',

  // ── Transverses : utiles à d'autres verticaux (Finance, RH, Procurement) ─
  'hiring_volume_surge',
  'site_expansion',
  'geo_expansion',
  'workforce_contraction',
  'hiring_freeze',
  'hiring_decline',
  'restructuring_announced',
  'cost_reduction_program',
  'financial_distress',
  'legal_pressure',

  // ── Domain-specific : NAMESPACÉS dès la V0 ───────────────────────────────
  // Convention de nommage, pas de refactor du catalogue : elle évite qu'un
  // futur pack déclare `capacity_pressure_reported` avec une autre sémantique.
  'real_estate.capacity_pressure_reported',
  'real_estate.space_reduction_reported',
  'real_estate.flex_occupancy_observed',
  'real_estate.occupancy_start_declared',
  'real_estate.occupancy_duration_months_declared',
] as const

type FabelSituationType = (typeof SITUATION_TYPES)[number]
type FabelEvidenceType = (typeof EVIDENCE_TYPES)[number]

/**
 * ⚠️ Les détecteurs sont typés sur le catalogue DU PACK, pas sur
 * `EvidenceEvent` générique. `E` de `RulePack<S, E>` s'infère depuis les
 * signatures de `detect` — une position contravariante — et un paramètre
 * générique y élargirait le catalogue dérivé à `string`, le rouvrant en
 * silence. Défaut déjà rencontré et corrigé lors d'ARCH-RULEPACK-001.
 */
type FabelEvidence = EvidenceEvent<FabelEvidenceType>

const LIBELLES: Readonly<Partial<Record<string, string>>> = {
  recent_funding: 'levée récente',
  headcount_acceleration: 'accélération des effectifs',
  hiring_volume_surge: 'volume d’offres en hausse',
  site_expansion: 'ouverture de site',
  geo_expansion: 'implantation géographique nouvelle',
  workforce_contraction: 'réduction d’effectifs',
  hiring_freeze: 'gel des recrutements',
  hiring_decline: 'baisse du volume de recrutement',
  restructuring_announced: 'réorganisation annoncée',
  cost_reduction_program: 'programme de réduction de coûts',
  financial_distress: 'difficulté financière',
  legal_pressure: 'pression juridique',
  'real_estate.capacity_pressure_reported': 'pression de capacité déclarée',
  'real_estate.space_reduction_reported': 'réduction de surface déclarée',
  'real_estate.flex_occupancy_observed': 'occupation flex constatée',
  'real_estate.occupancy_start_declared': 'date d’entrée déclarée',
  'real_estate.occupancy_duration_months_declared': 'durée déclarée',
}

function decrire(evidence: readonly EvidenceEvent[]): string {
  return evidence.map((item) => LIBELLES[item.type] ?? item.type).join(', ')
}

function situationDe(
  type: FabelSituationType,
  evidence: readonly EvidenceEvent[],
  context: SituationEvaluationContext,
  ruleId: string,
  ttlDays: number,
  rationale: string,
  anticipated?: AnticipatedHorizon,
): Situation {
  return buildSituation({
    type,
    evidence: ordonnerContributeurs(evidence),
    context,
    ruleId,
    ruleVersion: FABEL_PACK_VERSION,
    rulePackId: FABEL_PACK_ID,
    rulePackVersion: FABEL_PACK_VERSION,
    ttlDays,
    rationale,
    anticipated,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SPACE_EXPANSION
// ─────────────────────────────────────────────────────────────────────────────
function detectSpaceExpansion(
  evidence: readonly FabelEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  // ── CHEMIN B : déclaration first-party de pression de capacité ────────────
  // Le seul raccourci à signal unique du pack, et il est étroit : le compte
  // lui-même doit l'avoir dit, comme un FAIT, et de façon DATÉE.
  const declarations = toutesLesEvidencesDeTypes(evidence, [
    'real_estate.capacity_pressure_reported',
  ]).filter(
    (item) =>
      item.temporality === 'dated_event' &&
      // Seuil de SITUATION, pour la même raison que côté contraction. Il vaut
      // ici la même valeur que le seuil de famille, mais l'intention doit être
      // lisible : c'est une situation qu'on produit, pas une famille qu'on
      // compte.
      estDeclarationFiable(item, MIN_SITUATION_CONFIDENCE_EXPANSION),
  )

  if (declarations.length > 0) {
    const bloquante = contradictionBloquante(
      evidence,
      EXPANSION_CONTRADICTIONS,
      declarations,
    )
    if (!bloquante) {
      return situationDe(
        'space_expansion',
        declarations,
        context,
        'space-expansion-first-party',
        60,
        `Le compte a lui-même signalé une pression de capacité : ${decrire(declarations)}. ` +
          'Une pression future sur l’occupation est donc possible.',
      )
    }
  }

  // ── CHEMIN A : convergence de familles ────────────────────────────────────
  const contributeurs = contributeursDeFamille(evidence, EXPANSION_FAMILIES)
  const familles = famillesRepresentees(contributeurs, EXPANSION_FAMILIES)

  // Deux familles DISTINCTES minimum. Deux evidences d'une même famille ne
  // décrivent qu'une seule réalité.
  if (familles.size < 2) return null

  // Et au moins un signal DYNAMIQUE : une levée seule finance une croissance,
  // elle ne la constate pas.
  const aUneDynamique = EXPANSION_DYNAMIC_FAMILIES.some((f) => familles.has(f))
  if (!aUneDynamique) return null

  if (!hasFact(contributeurs)) return null
  if (averageConfidence(contributeurs) < MIN_SITUATION_CONFIDENCE_EXPANSION) return null

  if (contradictionBloquante(evidence, EXPANSION_CONTRADICTIONS, contributeurs)) {
    return null
  }

  return situationDe(
    'space_expansion',
    contributeurs,
    context,
    'space-expansion-convergence',
    60,
    `Plusieurs signaux distincts de croissance convergent : ${decrire(contributeurs)}. ` +
      'Une pression future possible sur la capacité d’occupation en découle — ' +
      'aucun besoin immobilier n’est constaté à ce stade.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SPACE_CONTRACTION
// ─────────────────────────────────────────────────────────────────────────────
function detectSpaceContraction(
  evidence: readonly FabelEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  // ── CHEMIN A : réduction de surface DÉCLARÉE par le compte ────────────────
  //
  // ⚠️ LE SEUIL EST CELUI DE LA SITUATION, PAS CELUI DES FAMILLES.
  // Une première version filtrait ici sur `MIN_FAMILY_EVIDENCE_CONFIDENCE`
  // (0.70) : le raccourci first-party produisait donc une `space_contraction`
  // à 0.70, là où le chemin de convergence en exige 0.75. Le raccourci
  // CONTOURNAIT le seuil sensible — exactement ce qu'un raccourci ne doit
  // jamais faire. Être déclarée par le compte rend une information plus
  // crédible, jamais moins exigeante.
  const declarations = toutesLesEvidencesDeTypes(evidence, [
    'real_estate.space_reduction_reported',
  ]).filter(
    (item) =>
      item.temporality === 'dated_event' &&
      estDeclarationFiable(item, MIN_SITUATION_CONFIDENCE_CONTRACTION),
  )

  if (declarations.length > 0) {
    const bloquante = contradictionBloquante(
      evidence,
      CONTRACTION_CONTRADICTIONS,
      declarations,
    )
    if (!bloquante) {
      return situationDe(
        'space_contraction',
        declarations,
        context,
        'space-contraction-first-party',
        45,
        `Le compte a lui-même déclaré une réduction de surface : ${decrire(declarations)}.`,
      )
    }
  }

  // ── CHEMIN B : convergence ────────────────────────────────────────────────
  const contributeurs = contributeursDeFamille(evidence, CONTRACTION_FAMILIES)
  const familles = famillesRepresentees(contributeurs, CONTRACTION_FAMILIES)

  if (familles.size < 2) return null

  // Un changement d'ORGANISATION est exigé : du discours de coûts, ou une
  // difficulté financière, ne déplacent pas à eux seuls des mètres carrés.
  const aUnChangementOrganisationnel = CONTRACTION_REQUIRED_FAMILIES.some((f) =>
    familles.has(f),
  )
  if (!aUnChangementOrganisationnel) return null

  if (!hasFact(contributeurs)) return null
  if (averageConfidence(contributeurs) < MIN_SITUATION_CONFIDENCE_CONTRACTION) return null

  if (contradictionBloquante(evidence, CONTRACTION_CONTRADICTIONS, contributeurs)) {
    return null
  }

  // ⚠️ AUCUNE MAGNITUDE, NULLE PART. La règle n'exprime aucun ratio entre
  // effectifs et surface — « −20 % de salariés » ne devient jamais « −20 % de
  // bureaux ». La Situation ouvre une hypothèse ; elle ne la quantifie pas, et
  // `Situation` n'offre d'ailleurs aucun champ pour le faire.
  return situationDe(
    'space_contraction',
    contributeurs,
    context,
    'space-contraction-convergence',
    45,
    `Plusieurs signaux de contraction convergent : ${decrire(contributeurs)}. ` +
      'Une révision à la baisse des besoins immobiliers est possible — ' +
      'aucune réduction de surface n’est constatée, et aucune ampleur n’est déduite.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FLEX_REMOVE_WINDOW
// ─────────────────────────────────────────────────────────────────────────────
function detectFlexRemoveWindow(
  evidence: readonly FabelEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  // ⚠️ `real_estate.flex_occupancy_observed` N'APPARAÎT PAS ICI, et c'est le
  // cœur du contrat. Une correspondance d'adresse n'est ni une relation client,
  // ni un début de contrat, ni une durée. Une occupation constatée seule ne
  // produit donc AUCUNE situation — la preuve est insuffisante, et une
  // insuffisance de preuve ne se transforme pas en situation métier.

  const debuts = toutesLesEvidencesDeTypes(evidence, [
    'real_estate.occupancy_start_declared',
  ]).filter(
    (item) =>
      item.temporality === 'dated_event' &&
      estDeclarationFiable(item, MIN_SITUATION_CONFIDENCE_FLEX),
  )

  const durees = toutesLesEvidencesDeTypes(evidence, [
    'real_estate.occupancy_duration_months_declared',
  ]).filter((item) => estDeclarationFiable(item, MIN_SITUATION_CONFIDENCE_FLEX))

  // ── APPARIEMENT NON AMBIGU — EXACTEMENT UN DE CHAQUE ─────────────────────
  //
  // ⚠️ LE MODÈLE NE PORTE AUCUNE CLÉ DE CORRÉLATION. `EvidenceEvent` n'a ni
  // identifiant de contrat, ni de relation, ni de site : rien ne permet
  // d'affirmer qu'un début et une durée décrivent le MÊME engagement.
  //
  // Une première version prenait le dernier de chaque liste. Sur un compte
  // ayant déclaré deux occupations, elle appariait donc le début du contrat A
  // avec la durée du contrat B — et produisait une échéance qui n'a jamais
  // existé, étiquetée `inference` avec un `derivedFrom` parfaitement
  // traçable. Une date fausse, impeccablement auditée.
  //
  // Faute de clé métier, la seule position honnête est de REFUSER l'ambiguïté.
  // Un mécanisme de corrélation appartiendra au pack ou au Signal-Evidence
  // Bridge le jour où la donnée le permettra — jamais au cœur.
  if (debuts.length !== 1 || durees.length !== 1) return null

  const debut = debuts[0]
  const duree = durees[0]

  const mois = dureeEnMois(duree)
  if (mois === null) return null

  const fin = addMonthsUTC((debut as any).occurredAt, mois)
  if (!fin) return null

  const ouverture = addMonthsUTC(fin, -LEAD_MONTHS)
  if (!ouverture) return null

  const finMs = Date.parse(fin)
  const ouvertureMs = Date.parse(ouverture)
  if (!Number.isFinite(finMs) || !Number.isFinite(ouvertureMs)) return null

  // Fenêtre dégénérée : refusée plutôt qu'interprétée.
  if (ouvertureMs >= finMs) return null

  // ── NE PAS FABRIQUER UNE FENÊTRE DÉJÀ ÉCHUE ───────────────────────────────
  // Le cœur refuserait de toute façon d'agir (`situation_expired`), mais créer
  // une Situation morte à la naissance encombrerait la persistance sans jamais
  // rien produire. Le cœur reste la défense en profondeur, pas l'excuse.
  if (context.now.getTime() >= finMs) return null

  const contributeurs = [debut, duree]

  const anticipated: AnticipatedHorizon = {
    at: fin,
    actionWindowOpensAt: ouverture,
    // ⚠️ `inference`, JAMAIS `fact`. La date de fin n'a pas été observée : elle
    // est CALCULÉE depuis un début et une durée. L'étiqueter `fact`
    // transformerait une dérivation en vérité constatée — précisément la
    // promotion que le contrat interdit.
    assertionType: 'inference',
    derivedFrom: [debut.id, duree.id],
  }

  return situationDe(
    'flex_remove_window',
    contributeurs,
    context,
    'flex-remove-window-declared',
    365,
    `Début d’occupation et durée ont été déclarés par le compte (${decrire(contributeurs)}). ` +
      `Une fenêtre de revue est DÉRIVÉE — non observée — et se situe autour du ${fin}.`,
    anticipated,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export const REAL_ESTATE_FABEL = defineRulePack({
  packId: FABEL_PACK_ID,
  packVersion: FABEL_PACK_VERSION,
  declaredSituationTypes: SITUATION_TYPES,
  declaredEvidenceTypes: EVIDENCE_TYPES,

  rules: [
    {
      ruleId: 'space-expansion',
      situationType: 'space_expansion',
      detect: detectSpaceExpansion,
    },
    {
      ruleId: 'space-contraction',
      situationType: 'space_contraction',
      detect: detectSpaceContraction,
    },
    {
      ruleId: 'flex-remove-window',
      situationType: 'flex_remove_window',
      detect: detectFlexRemoveWindow,
    },
  ],

  plays: {
    space_expansion: {
      play: 'engage_or_reengage',
      recommendedAction:
        'Prendre contact pour explorer les besoins d’espace à venir.',
      reason:
        'Plusieurs signaux de croissance convergent, rendant une pression future sur la capacité possible.',
    },

    space_contraction: {
      play: 'engage_or_reengage',
      recommendedAction:
        'Préparer une approche prudente sur une éventuelle révision des besoins.',
      reason:
        'Des signaux de contraction convergent ; une révision des besoins immobiliers est possible.',
    },

    flex_remove_window: {
      play: 'engage_or_reengage',
      recommendedAction:
        'Préparer la discussion de renouvellement avant l’échéance déclarée.',
      reason:
        'Une fenêtre de revue dérivée d’un début et d’une durée déclarés approche.',
    },
  },

  /**
   * ⚠️ CONSERVATIVE V0 POLICY — PAS UNE VÉRITÉ MÉTIER UNIVERSELLE.
   *
   * Le plancher s'applique à TOUTES les `space_contraction`, y compris celles
   * issues d'une réduction de surface que le compte a lui-même déclarée — un
   * cas qui n'a rien de sensible. C'est donc PLUS STRICT que le contrat métier
   * final, qui n'exigerait une approbation que lorsque la recommandation repose
   * matériellement sur des licenciements, une restructuration ou une détresse.
   *
   * Un plancher conditionnel aux evidences contributrices exigerait un
   * `controlFloor` dynamique, que le cœur ne permet pas (il est statique par
   * type de situation). Dette assumée, à rouvrir si le chemin non sensible
   * devient fréquent.
   *
   * Ce que cela exprime, et que l'architecture rend possible :
   *     decision = recommend          « ce compte mérite d'être examiné »
   *     control  = approval_required  « mais pas de contact automatique »
   */
  controlFloor: {
    space_contraction: 'approval_required',
  },
})
