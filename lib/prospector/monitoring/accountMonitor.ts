// JS-013_ACCOUNT_MONITORING_MISSION_V0_001 — CONTRATS DU MONITORING DE COMPTE.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// L'ÉTAT DE CONTRÔLE opérationnel du monitoring : AccountMonitorV0 (intention
// persistante), MonitoringRunResultV0 (télémétrie d'un run), et
// MonitorEvaluationReceiptV0 (consommation d'évaluation PAR MONITEUR). Plus
// les deux PORTS injectables : producteur ciblé compte et évaluateur de
// matérialité. Tout est PUR : aucune E/S ici.
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// PAS de la vérité métier. Aucun de ces objets n'est une SourceAssertion, une
// Evidence, un événement canonique, un Signal ni une Situation — le moteur de
// situations et le kernel ne doivent JAMAIS les lire. La Mission existante
// reste l'objet d'exécution gouverné et TERMINAL ; le moniteur est un état de
// contrôle persistant, pas une Mission perpétuelle.
//
// ── SILENCE ─────────────────────────────────────────────────────────────────
// NO_MATERIAL_CHANGE ≠ zéro évidence : un fait réel NON matériel entre
// normalement dans la chaîne canonique, puis se tait. Interdit absolu :
// fabriquer une évidence « rien ne s'est passé » — le silence n'a pas d'objet
// de vérité, seulement de la télémétrie de run.
import { createHash } from 'node:crypto'

import type { LensId } from '../proactive/lens/registry'
import { isLensId } from '../proactive/lens/registry'
import type { EvidenceStrengthV0, SignalTemporalAuthority } from '../proactive/types'

// ── ACCOUNT MONITOR ─────────────────────────────────────────────────────────

export const ACCOUNT_MONITOR_SCHEMA_VERSION = 'account-monitor-v0.1'
export const MONITORING_RUN_SCHEMA_VERSION = 'monitoring-run-v0.1'
export const MONITOR_EVAL_RECEIPT_SCHEMA_VERSION = 'monitor-eval-receipt-v0.1'

/** Bornes de cadence V0 : entre 1 heure et 30 jours. */
export const MIN_CADENCE_HOURS = 1
export const MAX_CADENCE_HOURS = 720

export type MonitorStatus = 'ACTIVE' | 'STOPPED'

export interface CadencePolicyV0 {
  readonly kind: 'MIN_INTERVAL'
  readonly minIntervalHours: number
}

/**
 * AccountMonitorV0 — état de contrôle persistant, PROPRIÉTÉ DU SERVEUR.
 *
 * `accountRef` est OPAQUE ici : aucune sémantique SIREN/France dans le contrat
 * durable. C'est l'ADAPTATEUR d'exécution courant qui ne supporte que les
 * comptes SIREN vérifiés (TARGET_UNSUPPORTED_V0 sinon).
 *
 * `createdByActorId` est de la PROVENANCE, rien d'autre : jamais une autorité
 * d'exécution, jamais une identité de scheduler, jamais une possession de
 * compte. Chaque run ré-évalue l'autorité de l'ACTEUR APPELANT.
 */
export interface AccountMonitorV0 {
  schemaVersion: typeof ACCOUNT_MONITOR_SCHEMA_VERSION
  id: string
  workspaceId: string
  accountRef: string
  lensId: LensId
  desiredOutcome: 'SURFACE_MATERIAL_CHANGE'
  cadencePolicy: CadencePolicyV0
  status: MonitorStatus
  createdByActorId: string
  createdAt: string
  updatedAt: string
  revisionId: string
  stoppedAt?: string
  stoppedByActorId?: string
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastMaterialChangeAt?: string
}

/**
 * Validation STRUCTURELLE de l'accountRef opaque — et RIEN de plus.
 * Ni SIREN, ni France, ni résolution de nom : chaîne bornée, sans saut de
 * ligne ni caractère de contrôle (les identités canoniques utilisent `\n`
 * comme séparateur de condensat — un accountRef qui en contiendrait pourrait
 * forger des collisions).
 */
export function isValidOpaqueAccountRef(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length === 0 || v.length > 200 || v !== value) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value)
}

export function isValidCadencePolicy(value: unknown): value is CadencePolicyV0 {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return c.kind === 'MIN_INTERVAL'
    && typeof c.minIntervalHours === 'number'
    && Number.isFinite(c.minIntervalHours)
    && Number.isInteger(c.minIntervalHours)
    && c.minIntervalHours >= MIN_CADENCE_HOURS
    && c.minIntervalHours <= MAX_CADENCE_HOURS
}

/**
 * IDENTITÉ LOGIQUE du moniteur : workspace + accountRef + lens — et RIEN
 * d'autre. Jamais de version de pack/politique (elles évoluent) ; jamais le
 * desiredOutcome (fixe en V0). L'identifiant DÉRIVÉ rend l'anti-doublon
 * ACTIVE atomique par `insertItemIfAbsent` : même contexte logique ⇒ même id
 * ⇒ le second create échoue, sans migration ni verrou.
 * WALLIX/Fabel ≠ WALLIX/Cyber : deux lens ⇒ deux ids ⇒ deux moniteurs licites.
 */
export function monitorIdFor(workspaceId: string, accountRef: string, lensId: LensId): string {
  const charge = `account-monitor:v1:${workspaceId}\n${accountRef}\n${lensId}`
  return `mon_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

export function validateAccountMonitorInput(input: {
  accountRef: unknown; lensId: unknown; cadencePolicy: unknown
}): { ok: true; accountRef: string; lensId: LensId; cadencePolicy: CadencePolicyV0 } | { ok: false; reason: string } {
  if (!isValidOpaqueAccountRef(input.accountRef)) return { ok: false, reason: 'invalid_account_ref' }
  if (typeof input.lensId !== 'string' || !isLensId(input.lensId)) return { ok: false, reason: 'invalid_lens' }
  if (!isValidCadencePolicy(input.cadencePolicy)) return { ok: false, reason: 'invalid_cadence' }
  return { ok: true, accountRef: input.accountRef, lensId: input.lensId, cadencePolicy: input.cadencePolicy }
}

// ── CADENCE — DÉRIVÉE, JAMAIS PERSISTÉE ─────────────────────────────────────

/**
 * `nextEligibleAt = lastAttemptAt + minIntervalHours`. Aucune tentative
 * antérieure ⇒ éligible. Borne INCLUSE : `now === nextEligibleAt` ⇒ éligible.
 */
export function cadenceEligibility(
  monitor: Pick<AccountMonitorV0, 'cadencePolicy' | 'lastAttemptAt'>,
  now: Date,
): { eligible: true } | { eligible: false; reason: 'NOT_ELIGIBLE_YET'; nextEligibleAt: string } {
  if (!monitor.lastAttemptAt) return { eligible: true }
  const last = Date.parse(monitor.lastAttemptAt)
  if (!Number.isFinite(last)) return { eligible: true } // horodatage illisible : ne bloque pas à vie
  const nextEligibleMs = last + monitor.cadencePolicy.minIntervalHours * 3600_000
  if (now.getTime() >= nextEligibleMs) return { eligible: true }
  return { eligible: false, reason: 'NOT_ELIGIBLE_YET', nextEligibleAt: new Date(nextEligibleMs).toISOString() }
}

// ── PORT PRODUCTEUR — STRUCTURELLEMENT CIBLÉ COMPTE ─────────────────────────
//
// ⚠️ FIREWALL signals.ts : la découverte large (requête libre, secteur,
// localisation, mots-clés) N'EST PAS un producteur de monitoring. L'identité ne dépend
// JAMAIS d'une interprétation de prompt — le port reçoit l'accountRef vérifié,
// pas un nom d'entreprise à interpoler. Il n'existe aujourd'hui AUCUN
// producteur d'acquisition canonique ciblé compte : la preuve V0 utilise un
// producteur CONTRÔLÉ/INJECTÉ ; les vrais producteurs (news/hiring/exécutifs)
// sont JS-014 et implémenteront EXACTEMENT cette interface.

export interface ProducerObservationV0 {
  /** Référence canonique (cev_/csn_) STRUCTURELLEMENT liée à l'accountRef demandé. */
  readonly canonicalRef: string
  readonly evidenceRefs: readonly string[]
  /**
   * Sidecars AUTORITAIRES fournis par le producteur (R1, Fix 1) — les types
   * EXISTANTS, jamais un second modèle d'évidence. Ils entrent TELS QUELS dans
   * l'empreinte d'évaluation ET dans l'évaluateur de matérialité : une force
   * d'évidence ou une autorité temporelle CHANGÉE sur les mêmes refs change
   * l'empreinte, donc force la ré-évaluation. Jamais recalculés ici, jamais
   * déduits d'horodatages, jamais relus du magasin par l'évaluateur.
   */
  readonly evidenceStrengthByRef?: Readonly<Record<string, EvidenceStrengthV0>>
  readonly temporalAuthorityByRef?: Readonly<Record<string, SignalTemporalAuthority>>
}

export type ProducerFailureReason =
  | 'TARGET_UNSUPPORTED_V0'
  | 'TARGET_UNRESOLVED'
  | 'SOURCE_UNAVAILABLE'

export type ProducerResultV0 =
  | { ok: true; accountRef: string; observations: readonly ProducerObservationV0[] }
  | { ok: false; reason: ProducerFailureReason }

export interface AccountMonitoringProducerV0 {
  readonly producerId: string
  /** Éligibilité STRUCTURELLE de la cible (l'adaptateur courant : SIREN vérifié seul). */
  supports(accountRef: string): boolean
  /** Le producteur déclare s'il invoque une capacité IA externe/web (politique d'espace). */
  readonly requiresExternalAI: boolean
  produce(input: {
    workspaceId: string
    accountRef: string
    lensId: LensId
    now: Date
  }): Promise<ProducerResultV0>
}

/**
 * Adaptateur d'ÉLIGIBILITÉ courant : seuls les comptes SIREN vérifiés sont
 * supportés par l'implémentation canonique actuelle. Jamais d'inférence de
 * SIREN depuis un nom, jamais de coercition : non supporté ⇒
 * TARGET_UNSUPPORTED_V0 au run ADMIS.
 */
export const CURRENT_ADAPTER_ACCOUNT_REF = /^acc_siren_\d{9}$/
export function currentAdapterSupports(accountRef: string): boolean {
  return CURRENT_ADAPTER_ACCOUNT_REF.test(accountRef)
}

// ── PORT MATÉRIALITÉ — PUR, INJECTABLE ──────────────────────────────────────
//
// ⚠️ MATÉRIALITÉ ≠ DÉTECTION DE SITUATION. Les RulePacks possèdent la
// détection de Situations ; il n'existe AUCUNE politique de matérialité
// autonome dans le code aujourd'hui — on ne détourne pas `SituationRule.detect`
// ni ses seuils pour la simuler. Un changement de CFO peut être MATERIAL puis
// le moteur de situations ne produire AUCUNE Situation : les deux verdicts
// coexistent sans contradiction. ZÉRO E/S, ZÉRO LLM, ZÉRO horloge cachée,
// ZÉRO écriture, ZÉRO Situation créée ici.

export type MaterialityOutcome = 'MATERIAL' | 'NOT_MATERIAL' | 'NEEDS_REVIEW'

export interface MaterialityEvaluationInputV0 {
  readonly canonicalRef: string
  readonly evidenceRefs: readonly string[]
  readonly evidenceStrengthByRef?: Readonly<Record<string, EvidenceStrengthV0>>
  readonly temporalAuthorityByRef?: Readonly<Record<string, SignalTemporalAuthority>>
  readonly lensId: LensId
}

export interface MaterialityEvaluatorV0 {
  readonly policyRef: { readonly policyId: string; readonly policyVersion: string }
  evaluate(input: MaterialityEvaluationInputV0): MaterialityOutcome
}

// ── REÇU D'ÉVALUATION — CONSOMMATION PAR MONITEUR ───────────────────────────
//
// La dédup canonique (`created`/`existing`) répond : « la vérité contient-elle
// déjà cet objet ? ». Elle ne répond JAMAIS : « CE moniteur a-t-il évalué CET
// état d'évaluation ? ». Le reçu porte cette seconde question — état de
// CONTRÔLE, pas de la vérité. Un événement canonique `existing` jamais évalué
// par CE moniteur DOIT être évalué (multi-moniteurs, §6 du gel R1).

export interface MonitorEvaluationReceiptV0 {
  schemaVersion: typeof MONITOR_EVAL_RECEIPT_SCHEMA_VERSION
  id: string
  monitorId: string
  workspaceId: string
  canonicalRef: string
  evaluationInputFingerprint: string
  evaluatedAt: string
  materialityResult: MaterialityOutcome
  policyVersions: {
    materialityPolicyId: string
    materialityPolicyVersion: string
    lensVersion: string
  }
}

/**
 * EMPREINTE D'ENTRÉE D'ÉVALUATION — déterministe, ZÉRO prose libre.
 *
 * Composants, TRIÉS puis joints par `\n` (aucun composant ne peut en
 * contenir — même défense que les identités canoniques) :
 *   - refs d'évidence (l'ARRIVÉE d'une évidence change l'empreinte),
 *   - force structurelle par ref (une évidence RENFORCÉE change l'empreinte),
 *   - autorité temporelle par ref,
 *   - versions de politique de matérialité et de lens (un changement de
 *     politique susceptible de changer la matérialité FORCE la ré-évaluation).
 * Même moniteur + même canonicalRef + même empreinte ⇒ déjà évalué ⇒ skip.
 * Empreinte différente ⇒ ré-évaluation obligatoire.
 */
export function evaluationInputFingerprint(input: {
  evidenceRefs: readonly string[]
  evidenceStrengthByRef?: Readonly<Record<string, EvidenceStrengthV0>>
  temporalAuthorityByRef?: Readonly<Record<string, SignalTemporalAuthority>>
  materialityPolicyId: string
  materialityPolicyVersion: string
  lensVersion: string
}): string {
  const parts: string[] = []
  for (const ref of [...input.evidenceRefs].sort()) {
    const strength = input.evidenceStrengthByRef?.[ref]
    const temporal = input.temporalAuthorityByRef?.[ref]
    parts.push(`ev:${ref}`)
    parts.push(`st:${ref}:${strength === undefined ? '-' : JSON.stringify(strength)}`)
    parts.push(`ta:${ref}:${temporal === undefined ? '-' : JSON.stringify(temporal)}`)
  }
  parts.push(`pol:${input.materialityPolicyId}:${input.materialityPolicyVersion}`)
  parts.push(`lens:${input.lensVersion}`)
  const charge = `monitor-eval:v1\n${parts.join('\n')}`
  return `mef_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

/** Id de reçu DÉRIVÉ : l'insertItemIfAbsent sur cet id EST la dédup du skip. */
export function evaluationReceiptId(
  monitorId: string, canonicalRef: string, fingerprint: string,
): string {
  const charge = `monitor-eval-receipt:v1:${monitorId}\n${canonicalRef}\n${fingerprint}`
  return `mer_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

// ── RÉSULTAT DE RUN — TROIS DIMENSIONS INDÉPENDANTES ────────────────────────

export type ExecutionState = 'SUCCEEDED' | 'PARTIAL' | 'BLOCKED' | 'FAILED'
export type CoverageState = 'COMPLETE_FOR_CONFIGURED_PRODUCERS' | 'PARTIAL' | 'NONE'
export type BusinessAssessment =
  | 'NO_MATERIAL_CHANGE'
  | 'MATERIAL_CHANGE_FOUND'
  | 'NEEDS_REVIEW'
  | 'NOT_EVALUATED'

export type OperationalBlockReason =
  | 'TARGET_UNSUPPORTED_V0'
  | 'TARGET_UNRESOLVED'
  | 'IDENTITY_UNAVAILABLE'
  | 'NO_CONFIGURED_PRODUCER'
  | 'NO_MATERIALITY_EVALUATOR'
  | 'PRODUCER_BLOCKED'

export interface MonitoringRunResultV0 {
  schemaVersion: typeof MONITORING_RUN_SCHEMA_VERSION
  runId: string
  monitorId: string
  workspaceId: string
  startedAt: string
  finishedAt: string
  executionState: ExecutionState
  coverageState: CoverageState
  businessAssessment: BusinessAssessment
  producersConfigured: number
  producersSucceeded: number
  producersFailed: number
  canonicalRefsEvaluated: readonly string[]
  canonicalRefsMaterial: readonly string[]
  canonicalRefsSkippedAlreadyEvaluated: readonly string[]
  policyVersions: {
    materialityPolicyId?: string
    materialityPolicyVersion?: string
    lensVersion: string
  }
  blockedReason?: OperationalBlockReason
}

/**
 * L'UNIQUE CONSTRUCTEUR de businessAssessment — la table de vérité R2-4/§14-15
 * en code EXÉCUTABLE, pas en commentaire. Aucune route, aucune branche du
 * runtime n'invente cette valeur ailleurs.
 *
 * ⚠️ Le bi-conditionnel « SUCCEEDED+COMPLETE ⇔ NO_MATERIAL_CHANGE » est FAUX
 * et interdit : NO_MATERIAL_CHANGE IMPLIQUE SUCCEEDED+COMPLETE, jamais
 * l'inverse. Une observation VIDE n'est un silence légitime QUE si une vraie
 * observation configurée a effectivement eu lieu (readiness) : zéro producteur
 * configuré, zéro exécution réussie, ou évaluateur absent ⇒ NOT_EVALUATED —
 * « on n'a rien trouvé » ≠ « rien n'a changé ».
 */
export function deriveBusinessAssessment(input: {
  executionState: ExecutionState
  coverageState: CoverageState
  evaluations: readonly MaterialityOutcome[]
  producersConfigured: number
  producersSucceeded: number
  evaluatorAvailable: boolean
}): BusinessAssessment {
  const { executionState, coverageState, evaluations } = input

  // 1 — un run FAILED/BLOCKED n'évalue rien.
  if (executionState === 'FAILED' || executionState === 'BLOCKED') return 'NOT_EVALUATED'

  // 2 — readiness : sans observation configurée RÉELLEMENT exécutée et sans
  //     évaluateur, RIEN n'a été jugé. Jamais un silence.
  if (input.producersConfigured === 0) return 'NOT_EVALUATED'
  if (input.producersSucceeded === 0) return 'NOT_EVALUATED'
  if (!input.evaluatorAvailable) return 'NOT_EVALUATED'

  // 3 — le matériel domine, même sous couverture PARTIELLE (elle le RESTE).
  if (evaluations.includes('MATERIAL')) return 'MATERIAL_CHANGE_FOUND'

  // 4 — l'ambigu ensuite.
  if (evaluations.includes('NEEDS_REVIEW')) return 'NEEDS_REVIEW'

  // 5 — une couverture PARTIELLE sans matériel n'autorise JAMAIS le silence.
  if (coverageState !== 'COMPLETE_FOR_CONFIGURED_PRODUCERS') return 'NOT_EVALUATED'
  if (executionState !== 'SUCCEEDED') return 'NOT_EVALUATED'

  // 6 — observation complète, réussie, tout évalué NOT_MATERIAL (ou aucun
  //     changement nouvellement évaluable) : LE silence légitime.
  return 'NO_MATERIAL_CHANGE'
}
