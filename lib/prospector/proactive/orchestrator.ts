// JARVIS-PROACTIVE-01D
// Orchestration déterministe.
//
//   données Prospector → EvidenceEvent[] → evaluateSituations() → recommendationDecision()
//
// ── CE QUE CE MODULE NE FAIT PAS, ET NE DOIT JAMAIS FAIRE ───────────────────
// Aucune action métier. Aucun lead modifié. Aucun message généré. Aucune
// notification créée. Aucun appel LLM, aucun réseau. `evaluate()` est une
// fonction PURE : mêmes entrées, même sortie, y compris l'heure qui est
// injectée.
//
// La seule fonction impure du fichier est `persistEvaluation()`, isolée en fin
// de module et nommée pour qu'on ne l'appelle pas par accident.
import type { BusinessContextV0 } from './lens/context'
import {
  evaluateEvidence,
  resolveBusinessContext,
  type KernelTarget,
} from './decisionKernel'
import type { Lead } from '../../../types/prospector'
import {
  accountIdForLead,
  evidenceFromLeadsWithStrength,
  personIdForLead,
  type TaskSnapshot,
} from './dataBridge'
import type { EligibilityContext } from './eligibility'
import { isEvidenceEvent } from './validators'
import type {
  EvidenceEvent,
  EvidenceStrengthV0,
  Recommendation,
  SignalTemporalAuthority,
  Situation,
} from './types'
import {
  saveEvidenceBatch,
  saveRecommendation,
  saveSituation,
} from './persistence'

/** Cible d'évaluation : un compte, éventuellement une personne de ce compte. */
export interface EvaluationTarget {
  accountId: string
  personId?: string
}

export interface ProactiveEvaluationInput {
  leads: readonly Lead[]
  now: Date

  /** Complétude PROUVÉE — voir `TaskSnapshot` dans `dataBridge`. */
  tasks: TaskSnapshot

  /**
   * Pertinence ICP/offre par compte, 0..1.
   *
   * ⚠️ Le Situation Engine exige cette valeur et refuse de l'inventer — elle
   * appartient au contexte Prospector. À défaut de résolveur fourni, on retombe
   * sur la SEULE donnée de pertinence réellement persistée : `Lead.score`
   * (0-100), ramené à 0..1, et pris au maximum parmi les leads du compte.
   *
   * Ce n'est pas un modèle ICP — c'est le score existant du produit, assumé
   * comme tel. Un appelant qui dispose de mieux passe son propre résolveur.
   */
  relevanceFor?: (target: EvaluationTarget) => number

  /**
   * Garde-fous relationnels, par cible.
   *
   * Ces faits — opt-out, rendez-vous pris, recommandation active, dernier
   * contact — ne sont PAS persistés aujourd'hui. Ce qui n'est pas fourni n'est
   * pas supposé : seul `meetingScheduled` est déduit, et uniquement d'une donnée
   * réelle (`stage === 'meeting'`), parce que cette déduction ne peut que
   * BLOQUER une recommandation, jamais en autoriser une.
   */
  eligibilityFor?: (target: EvaluationTarget) => Partial<EligibilityContext>

  /**
   * BUSINESS CONTEXT — OBLIGATOIRE, sans valeur par défaut.
   *
   * ⚠️ Il n'est PAS optionnel, et aucun contexte « default » n'est synthétisé
   * lorsqu'il manque. Fabriquer un contexte reviendrait à décider à la place de
   * l'appelant quelles capacités il détient — exactement ce que l'invariant
   * d'autorité interdit. Un contexte absent ou invalide rend une évaluation
   * VIDE : fail closed.
   */
  businessContext: BusinessContextV0

  /**
   * Evidences DÉJÀ NORMALISÉES, produites hors des leads.
   *
   * ⚠️ POURQUOI CE CHAMP EXISTE. `evidenceFromLeads` ne sait produire que des
   * evidences d'ÉTAT tirées des fiches CRM : le Decision Kernel était donc
   * INATTEIGNABLE depuis toute source externe, quelle qu'elle soit. C'est le
   * point d'entrée du Signal Bridge, et il est volontairement le plus étroit
   * possible — une liste de faits déjà validés, rien d'autre.
   *
   * ⚠️ AUCUNE VALIDATION ALLÉGÉE ICI. Ces evidences traversent exactement les
   * mêmes gardes que celles des leads : `evidenceIsUsable` du Situation Engine
   * les filtre sur confiance, temporalité, fraîcheur et cible. Ce champ ouvre
   * une PORTE D'ENTRÉE, jamais une dérogation.
   */
  externalEvidence?: readonly EvidenceEvent[]

  /**
   * SIGNAL_TEMPORAL_WINDOW_V0_001 — autorité temporelle des Signaux externes,
   * side-car du gate canonique, transmise TELLE QUELLE au kernel. Jamais
   * fabriquée ici, jamais persistée. Absente ⇒ toute evidence externe non
   * datée sous fenêtre déclarée échoue fermé pour la règle concernée.
   */
  temporalAuthorityByEvidenceId?: Readonly<Record<string, SignalTemporalAuthority>>

  /**
   * SIGNAL_EVIDENCE_STRENGTH_V0_001 — force structurelle des Signaux EXTERNES,
   * side-car du gate canonique (l'autorité externe naît APRÈS la vérification
   * de l'histoire immuable — jamais dans le bridge). La force INTERNE, elle,
   * est dérivée ICI par `evidenceFromLeadsWithStrength` : aucun appelant ne
   * fournit de classe pour une evidence CRM.
   */
  evidenceStrengthByEvidenceId?: Readonly<Record<string, EvidenceStrengthV0>>
}

export interface ProactiveEvaluation {
  evidence: EvidenceEvent[]
  situations: Situation[]
  recommendations: Recommendation[]
}

const VIDE: ProactiveEvaluation = {
  evidence: [],
  situations: [],
  recommendations: [],
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return Math.round(value * 100) / 100
}

interface AccountIndex {
  /** Meilleur score connu du compte, 0..1. */
  relevance: number
  /** Un rendez-vous est déjà pris pour cette cible. */
  meetingScheduled: boolean
}

function indexKey(target: EvaluationTarget): string {
  return `${target.accountId}::${target.personId ?? ''}`
}

/**
 * Construit, à partir des leads réels, ce que l'on sait de chaque cible.
 *
 * Deux informations seulement, toutes deux tirées de champs persistés :
 * la pertinence (score) et l'existence d'un rendez-vous (stage).
 */
function buildIndex(leads: readonly Lead[]): Map<string, AccountIndex> {
  const index = new Map<string, AccountIndex>()

  for (const lead of leads) {
    if (!lead || typeof lead !== 'object') continue
    const accountId = accountIdForLead(lead)
    if (!accountId) continue

    const personId = personIdForLead(lead)
    const score =
      typeof lead.score === 'number' && Number.isFinite(lead.score)
        ? clampScore(lead.score / 100)
        : 0
    const meeting = lead.stage === 'meeting'

    // La cible « compte » agrège tous ses leads ; la cible « personne » ne
    // reçoit que les siens. Un rendez-vous pris avec quelqu'un du compte
    // bloque aussi le niveau compte : recommander une approche générique
    // pendant qu'un rendez-vous est calé serait exactement le doublon que
    // l'Eligibility Engine existe pour éviter.
    for (const key of personId
      ? [indexKey({ accountId }), indexKey({ accountId, personId })]
      : [indexKey({ accountId })]) {
      const courant = index.get(key)
      index.set(key, {
        relevance: Math.max(courant?.relevance ?? 0, score),
        meetingScheduled: (courant?.meetingScheduled ?? false) || meeting,
      })
    }
  }

  return index
}

/**
 * Énumère les cibles d'évaluation, dans un ordre STABLE.
 *
 * L'ordre compte : deux exécutions identiques doivent produire deux sorties
 * identiques, y compris dans l'ordre des tableaux. Sans tri explicite, l'ordre
 * dépendrait de celui des leads en entrée, lui-même dépendant d'un `order by`
 * en base.
 */
function targetsFromEvidence(evidence: readonly EvidenceEvent[]): EvaluationTarget[] {
  const vus = new Map<string, EvaluationTarget>()

  for (const item of evidence) {
    const compte: EvaluationTarget = { accountId: item.accountId }
    vus.set(indexKey(compte), compte)

    if (item.personId) {
      const personne: EvaluationTarget = {
        accountId: item.accountId,
        personId: item.personId,
      }
      vus.set(indexKey(personne), personne)
    }
  }

  return Array.from(vus.values()).sort((a, b) => {
    if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
    const ap = a.personId ?? ''
    const bp = b.personId ?? ''
    if (ap === bp) return 0
    return ap < bp ? -1 : 1
  })
}

/**
 * CHAÎNE COMPLÈTE, PURE ET DÉTERMINISTE.
 *
 * Rend toujours les trois collections, même vides. Une entrée qui ne produit
 * rien n'est pas une erreur : c'est le cas nominal quand les données ne
 * soutiennent aucune situation.
 */
export function evaluate(input: ProactiveEvaluationInput): ProactiveEvaluation {
  if (!input || !Array.isArray(input.leads)) return VIDE
  if (!input.now || !Number.isFinite(input.now.getTime())) return VIDE

  // ⚠️ FAIL CLOSED SUR LE CONTEXTE, ET AVANT TOUT TRAVAIL. Un contexte
  // invalide doit rendre une évaluation VIDE — evidences comprises. Valider
  // seulement dans le kernel rendrait `evidence` non vide alors que rien n'a
  // été évalué : une sortie à moitié vraie, ce qui est pire que rien.
  //
  // La RÈGLE de validation n'est pas recopiée ici : `resolveBusinessContext`
  // est celle-là même que le kernel applique.
  const validation = resolveBusinessContext(input.businessContext)
  if (!validation.ok) return VIDE

  // Faits du CRM et faits externes entrent par la MÊME porte et subissent les
  // MÊMES contrôles. L'ordre est déterministe : leads d'abord, externes ensuite.
  //
  // ⚠️ LES FAITS EXTERNES SONT REVALIDÉS À L'EXÉCUTION, ET C'EST INDISPENSABLE.
  // Le typage TypeScript n'est PAS une frontière de confiance : `externalEvidence`
  // est un point d'entrée public, et un appelant peut y déposer un objet
  // parfaitement typé mais forgé — un fait `web_signal_search` sans adjudication,
  // par exemple. Sans ce filtre, ce champ contournerait tout le Signal Bridge.
  //
  // `isEvidenceEvent` est le validateur de LECTURE existant, celui-là même qui
  // protège les lignes relues du magasin. Une evidence externe invalide est
  // IGNORÉE — jamais réparée, jamais complétée — et n'atteint aucun Rule Pack.
  const interne = evidenceFromLeadsWithStrength(input.leads, {
    now: input.now,
    tasks: input.tasks,
  })
  const evidence: EvidenceEvent[] = [
    ...interne.evidence,
    ...(input.externalEvidence ?? []).filter(isEvidenceEvent),
  ]

  if (evidence.length === 0) return { ...VIDE, evidence: [] }

  const index = buildIndex(input.leads)

  // ── LA PART PROPRE À PROSPECTOR ───────────────────────────────────────────
  // Construire les cibles À PARTIR DE LEADS : c'est ici, et nulle part
  // ailleurs, que `Lead.score` devient une pertinence. Le kernel reçoit des
  // cibles déjà constituées et n'a aucune idée de ce qu'est un lead.
  const targets: KernelTarget[] = targetsFromEvidence(evidence).map((cible) => {
    const connu = index.get(indexKey(cible))
    const fourni = input.eligibilityFor ? input.eligibilityFor(cible) : {}

    return {
      accountId: cible.accountId,
      personId: cible.personId,
      relevance: input.relevanceFor
        ? clampScore(input.relevanceFor(cible))
        : (connu?.relevance ?? 0),
      eligibility: {
        ...fourni,
        meetingScheduled:
          fourni.meetingScheduled ?? connu?.meetingScheduled ?? false,
      },
    }
  })

  const { situations, recommendations } = evaluateEvidence({
    now: input.now,
    businessContext: input.businessContext,
    evidence,
    targets,
    ...(input.temporalAuthorityByEvidenceId
      ? { temporalAuthorityByEvidenceId: input.temporalAuthorityByEvidenceId }
      : {}),
    // ── FORCE STRUCTURELLE : interne (dérivée ici, du producteur CRM) +
    // externe (side-car du gate, transmis par l'appelant). Les identifiants
    // sont disjoints par construction (`ev_...` CRM vs `ev_ext_...` bridge) ;
    // l'entrée appelant ne peut de toute façon jamais parler POUR une evidence
    // interne qu'elle ne produit pas.
    // L'INTERNE EN DERNIER : même en cas de collision d'identifiant, un
    // appelant ne peut jamais substituer sa classe à celle que le producteur
    // CRM vient de dériver.
    evidenceStrengthByEvidenceId: {
      ...(input.evidenceStrengthByEvidenceId ?? {}),
      ...interne.evidenceStrengthByEvidenceId,
    },
  })

  return { evidence, situations, recommendations }
}

/**
 * ⚠️ SEULE FONCTION IMPURE DU MODULE.
 *
 * Écrit le résultat d'une évaluation dans le magasin cloisonné. Ne déclenche
 * aucune action métier : elle range des faits, des interprétations et des
 * décisions — elle n'en exécute aucune.
 *
 * L'espace est EXIGÉ et n'est jamais deviné ; il vient d'un appelant passé par
 * `resolveTenantFromRequest`.
 *
 * Idempotente par construction : tous les identifiants sont stables, et le
 * magasin écrit sur la clé primaire `(kind, id, workspace_id)`. Réévaluer deux
 * fois remplace les mêmes lignes, il n'en crée pas de secondes.
 */
export async function persistEvaluation(
  evaluation: ProactiveEvaluation,
  ws: string,
): Promise<{ evidence: number; situations: number; recommendations: number }> {
  const evidence = await saveEvidenceBatch(evaluation.evidence, ws)

  let situations = 0
  for (const situation of evaluation.situations) {
    if ((await saveSituation(situation, ws)).ok) situations++
  }

  let recommendations = 0
  for (const recommendation of evaluation.recommendations) {
    if ((await saveRecommendation(recommendation, ws)).ok) recommendations++
  }

  return { evidence, situations, recommendations }
}
