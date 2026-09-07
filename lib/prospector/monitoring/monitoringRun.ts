// JS-013 — RUNNER DE MONITORING. Orchestration PURE des ports injectés.
//
// ── CE QUE CE MODULE FAIT ───────────────────────────────────────────────────
// Un run ADMIS (autorité + politique + cadence déjà passées par la route) :
//   bail d'opération → RE-LECTURE STRICTE du moniteur COURANT → admission
//   (lastAttemptAt vérifié) → producteurs configurés → reçus par moniteur →
//   évaluateur de matérialité EN MÉMOIRE → deriveBusinessAssessment (l'UNIQUE
//   constructeur) → persistance du RÉSULTAT DE RUN d'abord, des reçus ENSUITE,
//   des horodatages de synthèse en dernier — chaque écriture VÉRIFIÉE.
//
// ── POURQUOI CET ORDRE (R1, Fix 3-bis) ──────────────────────────────────────
// Un reçu durable ne doit JAMAIS masquer une évaluation dont le résultat de
// run n'a pas été durablement enregistré : reçu d'abord + crash = surfaçage
// PERDU en silence. Résultat d'abord + crash = ré-évaluation au run suivant —
// un doublon possible, jamais une perte. AT-LEAST-ONCE > perte de matériel.
//
// ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────
// AUCUN seuil métier ici (la matérialité appartient au port injecté). AUCUN
// scheduler. AUCUNE création de Situation/Signal/Evidence : la vérité métier
// n'entre que par les chemins canoniques existants. AUCUNE écriture sur refus,
// et JAMAIS de succès fabriqué sur panne du magasin.
import { randomUUID } from 'node:crypto'

import type {
  AccountMonitorV0,
  AccountMonitoringProducerV0,
  MaterialityEvaluatorV0,
  MaterialityOutcome,
  MonitoringRunResultV0,
  MonitorEvaluationReceiptV0,
  ProducerObservationV0,
  OperationalBlockReason,
  ExecutionState,
  CoverageState,
} from './accountMonitor'
import {
  MONITORING_RUN_SCHEMA_VERSION,
  MONITOR_EVAL_RECEIPT_SCHEMA_VERSION,
  cadenceEligibility,
  deriveBusinessAssessment,
  evaluationInputFingerprint,
  evaluationReceiptId,
} from './accountMonitor'
import {
  acquireMonitorOperationLease,
  loadMonitor,
  persistMonitorTimestamps,
  persistReceipt,
  persistRunResult,
  receiptExists,
  releaseMonitorOperationLease,
} from './monitoringStore'
import { LENS_REGISTRY } from '../proactive/lens/registry'

/**
 * Runtime injecté. En V0 il n'existe AUCUN producteur d'acquisition canonique
 * ciblé compte dans le repo (audit R2-1) : le défaut est VIDE — le runner rend
 * alors NOT_EVALUATED, jamais un silence. Les tests injectent un producteur
 * contrôlé ; les vrais producteurs (news/hiring/exécutifs) sont JS-014 et
 * implémenteront cette interface.
 */
export interface MonitoringRuntimeV0 {
  producers: readonly AccountMonitoringProducerV0[]
  evaluator: MaterialityEvaluatorV0 | null
}

export function defaultMonitoringRuntime(): MonitoringRuntimeV0 {
  return { producers: [], evaluator: null }
}

export type MonitoringRunOutcome =
  | { ok: true; run: MonitoringRunResultV0; monitor: AccountMonitorV0 }
  | { ok: false; reason: 'CLAIM_HELD' }
  | { ok: false; reason: 'MONITOR_STOPPED' | 'MONITOR_MISSING' }
  | { ok: false; reason: 'NOT_ELIGIBLE_YET'; nextEligibleAt: string }
  | {
      ok: false
      reason: 'STORE_FAILURE'
      stage: 'lease' | 'monitor_reread' | 'admission_timestamp' | 'receipt_lookup'
        | 'run_result_write' | 'receipt_write' | 'summary_timestamp_write'
      /** Présent quand le résultat de run EST durable malgré l'échec aval. */
      run?: MonitoringRunResultV0
    }

/**
 * Exécute UN run. Pré-conditions garanties par la route : acteur résolu,
 * monitoring:run ALLOWED, politique d'espace du producteur concret
 * satisfaite. Le moniteur et la cadence sont RE-VALIDÉS ICI, SOUS BAIL, sur
 * l'état COURANT (R1, Fix 2) : un objet ACTIVE périmé chargé avant un STOP
 * commité ne produit NI producteur, NI horodatage, NI résurrection.
 */
export async function executeMonitoringRun(
  monitor: AccountMonitorV0,
  runtime: MonitoringRuntimeV0,
  nowMs: number,
): Promise<MonitoringRunOutcome> {
  const ws = monitor.workspaceId

  const bail = await acquireMonitorOperationLease(ws, monitor.id, nowMs)
  if (bail.ok === false) {
    return bail.reason === 'STORE_FAILURE'
      ? { ok: false, reason: 'STORE_FAILURE', stage: 'lease' }
      : { ok: false, reason: 'CLAIM_HELD' }
  }

  try {
    // ── RE-LECTURE STRICTE SOUS BAIL — l'objet reçu peut être périmé. ────────
    const relu = await loadMonitor(ws, monitor.id)
    if (relu.ok === false) return { ok: false, reason: 'STORE_FAILURE', stage: 'monitor_reread' }
    if (relu.monitor === null) return { ok: false, reason: 'MONITOR_MISSING' }
    if (relu.monitor.status !== 'ACTIVE') return { ok: false, reason: 'MONITOR_STOPPED' }
    const courant = relu.monitor

    // Cadence RE-VÉRIFIÉE sur l'état courant (un run vient peut-être de finir).
    const cadence = cadenceEligibility(courant, new Date(nowMs))
    if (cadence.eligible === false) {
      return { ok: false, reason: 'NOT_ELIGIBLE_YET', nextEligibleAt: cadence.nextEligibleAt }
    }

    // ── ADMISSION : lastAttemptAt VÉRIFIÉ. Échec ⇒ AUCUN producteur. ────────
    const startedAt = new Date(nowMs).toISOString()
    const admission = await persistMonitorTimestamps(ws, monitor.id, { lastAttemptAt: startedAt }, nowMs)
    if (admission.ok === false) {
      if (admission.reason === 'MONITOR_STOPPED') return { ok: false, reason: 'MONITOR_STOPPED' }
      if (admission.reason === 'MONITOR_MISSING') return { ok: false, reason: 'MONITOR_MISSING' }
      return { ok: false, reason: 'STORE_FAILURE', stage: 'admission_timestamp' }
    }
    let monitorCourant = admission.monitor

    const lensVersion = LENS_REGISTRY[courant.lensId].lensVersion
    const producersConfigured = runtime.producers.length
    let producersSucceeded = 0
    let producersFailed = 0
    let blockedReason: OperationalBlockReason | undefined
    const observations: ProducerObservationV0[] = []

    if (producersConfigured === 0) {
      blockedReason = 'NO_CONFIGURED_PRODUCER'
    } else {
      for (const producer of runtime.producers) {
        if (!producer.supports(courant.accountRef)) {
          producersFailed++
          blockedReason = blockedReason ?? 'TARGET_UNSUPPORTED_V0'
          continue
        }
        try {
          const r = await producer.produce({
            workspaceId: ws, accountRef: courant.accountRef, lensId: courant.lensId, now: new Date(nowMs),
          })
          if (r.ok === false) {
            producersFailed++
            if (r.reason === 'TARGET_UNSUPPORTED_V0' || r.reason === 'TARGET_UNRESOLVED') {
              blockedReason = blockedReason ?? r.reason
            }
            continue
          }
          // Frontière structurelle : une observation pour un AUTRE compte que
          // celui demandé est un défaut de producteur — rejet du lot entier.
          if (r.accountRef !== courant.accountRef) { producersFailed++; continue }
          producersSucceeded++
          observations.push(...r.observations)
        } catch {
          producersFailed++
        }
      }
    }

    // ── ÉTAT D'EXÉCUTION / COUVERTURE — relatifs aux producteurs CONFIGURÉS.
    let executionState: ExecutionState
    let coverageState: CoverageState
    if (producersConfigured === 0) {
      executionState = 'BLOCKED'; coverageState = 'NONE'
    } else if (producersSucceeded === 0) {
      executionState = blockedReason ? 'BLOCKED' : 'FAILED'
      coverageState = 'NONE'
    } else if (producersFailed > 0) {
      executionState = 'PARTIAL'; coverageState = 'PARTIAL'
    } else {
      executionState = 'SUCCEEDED'; coverageState = 'COMPLETE_FOR_CONFIGURED_PRODUCERS'
    }

    // ── ÉVALUATION EN MÉMOIRE — reçus PAR MONITEUR, matérialité (port pur). ─
    const evaluatorAvailable = runtime.evaluator !== null
    if (!evaluatorAvailable && executionState !== 'BLOCKED' && executionState !== 'FAILED') {
      blockedReason = blockedReason ?? 'NO_MATERIALITY_EVALUATOR'
    }
    const evaluations: MaterialityOutcome[] = []
    const refsEvalues: string[] = []
    const refsMateriels: string[] = []
    const refsSautes: string[] = []
    // Les reçus des NOUVELLES évaluations sont préparés ICI mais écrits
    // SEULEMENT APRÈS le résultat de run durable (Fix 3-bis).
    const recusEnAttente: MonitorEvaluationReceiptV0[] = []

    if (evaluatorAvailable && (executionState === 'SUCCEEDED' || executionState === 'PARTIAL')) {
      const evaluator = runtime.evaluator as MaterialityEvaluatorV0
      for (const obs of observations) {
        // Fix 1 — les sidecars du producteur entrent TELS QUELS dans
        // l'empreinte ET dans l'évaluateur : parité exacte des entrées.
        const fingerprint = evaluationInputFingerprint({
          evidenceRefs: obs.evidenceRefs,
          evidenceStrengthByRef: obs.evidenceStrengthByRef,
          temporalAuthorityByRef: obs.temporalAuthorityByRef,
          materialityPolicyId: evaluator.policyRef.policyId,
          materialityPolicyVersion: evaluator.policyRef.policyVersion,
          lensVersion,
        })
        const receiptId = evaluationReceiptId(courant.id, obs.canonicalRef, fingerprint)
        const deja = await receiptExists(ws, receiptId)
        // Fix 3-C — « on ne sait pas si cet état a été consommé » N'EST PAS
        // « il ne l'a pas été » : panne de lecture ⇒ échec typé, pas de faux
        // skip, pas de faux silence, aucune consommation mutée.
        if (deja.ok === false) return { ok: false, reason: 'STORE_FAILURE', stage: 'receipt_lookup' }
        if (deja.exists) {
          // CE moniteur a déjà évalué CET état d'évaluation : skip. (La dédup
          // canonique `existing` ne suffit JAMAIS à conclure cela.)
          refsSautes.push(obs.canonicalRef)
          continue
        }
        const resultat = evaluator.evaluate({
          canonicalRef: obs.canonicalRef,
          evidenceRefs: obs.evidenceRefs,
          evidenceStrengthByRef: obs.evidenceStrengthByRef,
          temporalAuthorityByRef: obs.temporalAuthorityByRef,
          lensId: courant.lensId,
        })
        evaluations.push(resultat)
        refsEvalues.push(obs.canonicalRef)
        if (resultat === 'MATERIAL') refsMateriels.push(obs.canonicalRef)
        recusEnAttente.push({
          schemaVersion: MONITOR_EVAL_RECEIPT_SCHEMA_VERSION,
          id: receiptId,
          monitorId: courant.id,
          workspaceId: ws,
          canonicalRef: obs.canonicalRef,
          evaluationInputFingerprint: fingerprint,
          evaluatedAt: new Date(nowMs).toISOString(),
          materialityResult: resultat,
          policyVersions: {
            materialityPolicyId: evaluator.policyRef.policyId,
            materialityPolicyVersion: evaluator.policyRef.policyVersion,
            lensVersion,
          },
        })
      }
    }

    // ── L'UNIQUE CONSTRUCTEUR — aucune branche n'invente ce verdict ailleurs.
    const businessAssessment = deriveBusinessAssessment({
      executionState, coverageState, evaluations,
      producersConfigured, producersSucceeded, evaluatorAvailable,
    })

    const finishedAt = new Date(Date.now()).toISOString()
    const run: MonitoringRunResultV0 = {
      schemaVersion: MONITORING_RUN_SCHEMA_VERSION,
      runId: `mrun_${randomUUID()}`,
      monitorId: courant.id,
      workspaceId: ws,
      startedAt,
      finishedAt,
      executionState,
      coverageState,
      businessAssessment,
      producersConfigured,
      producersSucceeded,
      producersFailed,
      canonicalRefsEvaluated: refsEvalues,
      canonicalRefsMaterial: refsMateriels,
      canonicalRefsSkippedAlreadyEvaluated: refsSautes,
      policyVersions: {
        ...(runtime.evaluator ? {
          materialityPolicyId: runtime.evaluator.policyRef.policyId,
          materialityPolicyVersion: runtime.evaluator.policyRef.policyVersion,
        } : {}),
        lensVersion,
      },
      ...(blockedReason ? { blockedReason } : {}),
    }

    // ── FIX 3-BIS — LE RÉSULTAT DE RUN D'ABORD, LES REÇUS ENSUITE. ──────────
    // Résultat non durable ⇒ AUCUN reçu neuf ne devient durable ⇒ le run
    // suivant ré-évalue (doublon possible, perte impossible).
    const runEcrit = await persistRunResult(run)
    if (!runEcrit) {
      return { ok: false, reason: 'STORE_FAILURE', stage: 'run_result_write' }
    }
    for (const recu of recusEnAttente) {
      const ecrit = await persistReceipt(recu)
      if (!ecrit) {
        // insertItemIfAbsent rend false sur conflit COMME sur panne : on relit
        // strictement pour trancher. Présent ⇒ durable (rien à faire) ;
        // absent/illisible ⇒ échec honnête — le résultat de run RESTE durable,
        // le run suivant pourra ré-évaluer (at-least-once).
        const verif = await receiptExists(ws, recu.id)
        if (!(verif.ok === true && verif.exists)) {
          return { ok: false, reason: 'STORE_FAILURE', stage: 'receipt_write', run }
        }
      }
    }

    // ── HORODATAGES DE SYNTHÈSE — VÉRIFIÉS, EN DERNIER. ─────────────────────
    const patch: { lastSuccessAt?: string; lastMaterialChangeAt?: string } = {}
    if (executionState === 'SUCCEEDED' && coverageState === 'COMPLETE_FOR_CONFIGURED_PRODUCERS') {
      patch.lastSuccessAt = finishedAt
    }
    if (businessAssessment === 'MATERIAL_CHANGE_FOUND') {
      patch.lastMaterialChangeAt = finishedAt
    }
    if (patch.lastSuccessAt || patch.lastMaterialChangeAt) {
      const synthese = await persistMonitorTimestamps(ws, monitor.id, patch, Date.now())
      if (synthese.ok === false) {
        // La vérité (résultat + reçus) EST durable ; seul le résumé a échoué.
        // On le dit honnêtement — jamais un moniteur prétendant des horodatages
        // non persistés.
        return { ok: false, reason: 'STORE_FAILURE', stage: 'summary_timestamp_write', run }
      }
      monitorCourant = synthese.monitor
    }
    return { ok: true, run, monitor: monitorCourant }
  } finally {
    await releaseMonitorOperationLease(ws, monitor.id, bail.leaseToken)
  }
}
