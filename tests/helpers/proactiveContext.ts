// ARCH-RULEPACK-001 — CONTEXTE DE TEST PARTAGÉ.
//
// ⚠️ CE HELPER N'EST PAS UNE VALEUR PAR DÉFAUT DÉGUISÉE. Le moteur n'accepte
// aucun contexte implicite : un contexte absent ou invalide rend une évaluation
// VIDE. Ce fichier existe uniquement pour ne pas redéclarer 23 fois la même
// configuration dans les tests — pas pour contourner l'exigence.
//
// Il décrit une configuration RÉELLE et STABLE : `contextId` identifie une
// configuration, jamais une exécution. Deux évaluations successives avec ce
// même contexte doivent produire les mêmes identifiants de recommandation.
import { SALES_DEFAULT_LENS } from '../../lib/prospector/proactive/lens/registry'
import type { BusinessContextV0 } from '../../lib/prospector/proactive/lens/context'

/**
 * Contexte de référence des tests : toutes capacités accordées.
 *
 * Choisi ainsi pour que le CONTRÔLE n'interfère pas avec les assertions
 * métier existantes — celles-ci portent sur `decision`, jamais sur `control`.
 */
export const TEST_BUSINESS_CONTEXT: BusinessContextV0 = {
  contextId: 'test-sales',
  contextVersion: 'v0.1',
  role: 'sales_rep',
  scope: { mode: 'workspace' },
  authorizedMotions: {
    prepare_outreach: 'allowed',
    contact_prospect: 'allowed',
    enrich_data: 'allowed',
    schedule_reminder: 'allowed',
  },
  lensId: SALES_DEFAULT_LENS.lensId as 'sales-default',
  lensVersion: SALES_DEFAULT_LENS.lensVersion,
}

/** Variante : la prise de contact exige une approbation humaine. */
export const TEST_CONTEXT_APPROVAL: BusinessContextV0 = {
  ...TEST_BUSINESS_CONTEXT,
  contextId: 'test-sales-approval',
  authorizedMotions: {
    prepare_outreach: 'allowed',
    contact_prospect: 'approval_required',
    enrich_data: 'allowed',
    schedule_reminder: 'allowed',
  },
}

/** Part du contexte attendue par `recommendationDecision`. */
export const TEST_RECOMMENDATION_CONTEXT = {
  contextId: TEST_BUSINESS_CONTEXT.contextId,
  contextVersion: TEST_BUSINESS_CONTEXT.contextVersion,
  authorizedMotions: TEST_BUSINESS_CONTEXT.authorizedMotions,
}

/** Provenance de pack, pour les `Situation` construites à la main. */
export const TEST_SITUATION_PROVENANCE = {
  rulePackId: 'sales-core',
  rulePackVersion: 'v0.1',
  lensId: 'sales-default',
  lensVersion: 'v0.1',
}
