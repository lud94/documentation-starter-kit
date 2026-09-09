// JS-015 B2A — INVOCATION MODÈLE : ABSTRACTION ÉTROITE + ADAPTATEUR GATEWAY.
//
// ── L'ABSTRACTION ───────────────────────────────────────────────────────────
// MessageModelInvokerV0 reçoit un prompt COMPILÉ (system + user) et rend du
// texte brut, un blocage ou une erreur — RIEN d'autre ne traverse. Les tests
// unitaires injectent un faux invocateur : la CI n'exige JAMAIS Anthropic.
//
// ── L'ADAPTATEUR DE PRODUCTION ──────────────────────────────────────────────
// SEUL chemin fournisseur autorisé : la passerelle centrale existante
// lib/prospector/llm.ts → callClaude(), task 'write'. AUCUN fetch direct vers
// Anthropic, AUCUN SDK fournisseur, AUCUN outil, AUCUNE recherche web, AUCUN
// cache (pas de convention de cache établie pour la rédaction de brouillons).
//
// ── TENANT = MÉTADONNÉE D'EXÉCUTION ─────────────────────────────────────────
// Le TenantContext est lié PAR FABRIQUE à la construction de l'adaptateur :
// c'est de l'imputation/budget, jamais un intrant du raisonnement métier — il
// n'entre pas dans compose() et n'apparaît pas dans le prompt.
//
// ── AUCUNE FUITE DE DIAGNOSTIC ──────────────────────────────────────────────
// Les erreurs fournisseur sont projetées sur des motifs FERMÉS ; aucun message
// d'exception brut ne traverse vers l'appelant.
import type { TenantContext } from '../tenant'
import { callClaude } from '../llm'
import type { CompiledModelRequestV0 } from './promptCompiler'

export type ModelInvocationV0 =
  | { ok: true; rawText: string }
  | { ok: false; reason: 'PROVIDER_BLOCKED' | 'PROVIDER_ERROR' | 'PROVIDER_INCOMPLETE' | 'PROVIDER_OFF' }

export interface MessageModelInvokerV0 {
  invoke(request: CompiledModelRequestV0): Promise<ModelInvocationV0>
}

/** Libellé de suivi de consommation du rédacteur contraint. */
export const MESSAGE_COMPOSE_AGENT = 'message-compose-v0'

/**
 * Fabrique de l'adaptateur Claude de production — passerelle centrale
 * UNIQUEMENT. Un tour inachevé/tronqué n'est PAS un résultat partiel : le
 * contrat central l'affirme, on le respecte (PROVIDER_INCOMPLETE, fail closed).
 */
export function createClaudeMessageInvoker(tenant: TenantContext): MessageModelInvokerV0 {
  return {
    async invoke(request: CompiledModelRequestV0): Promise<ModelInvocationV0> {
      let r
      try {
        r = await callClaude({
          tenant,
          task: 'write',
          agent: MESSAGE_COMPOSE_AGENT,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        })
      } catch {
        return { ok: false, reason: 'PROVIDER_ERROR' }
      }
      if (r.blocked) return { ok: false, reason: 'PROVIDER_BLOCKED' }
      if (r.error === 'off') return { ok: false, reason: 'PROVIDER_OFF' }
      if (r.error) return { ok: false, reason: 'PROVIDER_ERROR' }
      if (r.incomplete || r.truncated) return { ok: false, reason: 'PROVIDER_INCOMPLETE' }
      if (typeof r.text !== 'string' || r.text.trim().length === 0) {
        return { ok: false, reason: 'PROVIDER_ERROR' }
      }
      return { ok: true, rawText: r.text }
    },
  }
}
