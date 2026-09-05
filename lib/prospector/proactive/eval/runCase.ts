// EVAL-RUNNER-001a — EXÉCUTION D'UN CAS. PURE.
//
// Ce module ne lit aucun fichier, n'écrit nulle part, n'ouvre aucune connexion
// et n'appelle jamais `persistEvaluation()`. Il traduit un cas VALIDÉ en appel
// du Decision Kernel, puis met le résultat en forme.
//
// ⚠️ IL N'EST PAS UN MOTEUR. Il ne contient aucune règle, aucun seuil, aucune
// décision : toute la logique appartient à `evaluateEvidence()`, celui-là même
// qu'appelle `orchestrator.evaluate()` pour Prospector. C'est ce qui rend la
// mesure honnête — le runner observe le moteur de production, il ne le simule
// pas.
import { evaluateEvidence } from '../decisionKernel'
import type { EvalCase } from './caseSchema'
import type { EvidenceEvent, Recommendation, Situation } from '../types'

export interface EvalOutput {
  evidence: readonly EvidenceEvent[]
  situations: readonly Situation[]
  recommendations: readonly Recommendation[]
}

/**
 * Exécute un cas déjà validé.
 *
 * Le temps vient exclusivement de `evalCase.now`. Aucun `Date.now()`, aucun
 * identifiant aléatoire, aucun horodatage d'exécution : deux appels sur le même
 * cas rendent deux résultats identiques.
 */
export function runEvalCase(evalCase: EvalCase): EvalOutput {
  const { situations, recommendations } = evaluateEvidence({
    now: evalCase.now,
    businessContext: evalCase.businessContext,
    evidence: evalCase.evidence,
    targets: evalCase.targets,
    // SIGNAL_TEMPORAL_WINDOW_V0_001 : même chemin que la production — l'autorité
    // vient du CAS (comme du gate en prod). Absente ⇒ fail closed sous fenêtre,
    // jamais un repli silencieux sur `observedAt`.
    ...(evalCase.temporalAuthorityByEvidenceId
      ? { temporalAuthorityByEvidenceId: evalCase.temporalAuthorityByEvidenceId }
      : {}),
    // SIGNAL_EVIDENCE_STRENGTH_V0_001 : même chemin que la production — la
    // force structurelle vient du CAS (comme du gate/producteur en prod).
    ...(evalCase.evidenceStrengthByEvidenceId
      ? { evidenceStrengthByEvidenceId: evalCase.evidenceStrengthByEvidenceId }
      : {}),
  })

  return {
    // L'evidence est RENDUE TELLE QUELLE : c'est l'entrée du moteur, et la
    // relire dans la sortie permet de vérifier ce qui a réellement été soumis.
    evidence: evalCase.evidence,
    situations,
    recommendations,
  }
}

/**
 * Sérialisation STABLE de la sortie.
 *
 * ⚠️ L'ordre des clés d'un objet JS est celui de leur insertion, donc
 * déterministe ici — mais il dépend de l'ordre de construction dans le moteur.
 * Le tri explicite des clés rend la sortie reproductible byte-for-byte même si
 * un champ change de place dans une structure interne.
 */
export function serializeEvalOutput(output: EvalOutput): string {
  return JSON.stringify(output, triCles, 2) + '\n'
}

function triCles(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>
    const trie: Record<string, unknown> = {}
    for (const cle of Object.keys(source).sort()) trie[cle] = source[cle]
    return trie
  }
  return value
}
