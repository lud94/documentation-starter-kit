// JS-015 B2A — RÉDACTEUR CONTRAINT V0 : MOTEUR + POST-VALIDATEUR DÉTERMINISTE.
//
// ── ARCHITECTURE IMPOSÉE ────────────────────────────────────────────────────
//   contexte validé → compilation de prompt déterministe → modèle contraint
//   → validation déterministe de sortie → DraftMessageV0.
// La sortie du LLM est UNTRUSTED : rien n'atteint DraftMessageV0 sans passer
// le validateur. `shownEvidenceRefs` est DÉRIVÉ des assertions validées —
// jamais une liste libre du modèle qui pourrait en diverger.
//
// ── HONNÊTETÉ DU VALIDATEUR ─────────────────────────────────────────────────
// Le validateur prouve ce qu'il vérifie STRUCTURELLEMENT : schéma exact,
// budgets, appartenance des refs, incertitude jamais rendue certaine,
// interdits, non-fuite d'identifiants. Il ne prétend PAS prouver la
// fidélité sémantique d'une paraphrase arbitraire — et (R2) il ne sait PAS
// distinguer un fait primaire d'une interprétation attachée à la même ref :
// la discipline des contre-signaux (bloquer la montée interprétative, pas le
// fait) vit dans le prompt de confiance et le harnais comportemental. Ce
// résiduel est exposé, pas masqué.
//
// ── AUCUNE RÉCUPÉRATION DE DONNÉES CACHÉE ───────────────────────────────────
// Le moteur ne lit AUCUN store, AUCUNE fiche, AUCUN fil : ses seules entrées
// métier sont le contexte validé et la politique de canal ; sa seule
// dépendance d'exécution est l'invocateur injecté à la construction.
import type { ValidatedMessageReadyContextV0 } from './messageContext'
import { isValidatedContext } from './messageContext'
import type { ChannelPolicyV0 } from './channelPolicy'
import type {
  DraftMessageV0,
  MessageAssertionAuditV0,
  MessageComposeResultV0,
  MessageEngineV0,
} from './messageEngineBoundary'
import { compileMessagePrompt } from './promptCompiler'
import type { MessageModelInvokerV0 } from './modelInvoker'
import { checkForbiddenClaims } from './claimPolicy'

const RENDERINGS = ['DIRECT', 'QUALIFIED'] as const

const texteNonVide = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

type EchecValidation = Extract<MessageComposeResultV0, { ok: false }>
const echec = (
  reason: EchecValidation['reason'],
  detail: EchecValidation['detail'],
): EchecValidation => ({ ok: false, reason, detail })

/**
 * Valide la sortie BRUTE du modèle contre le contexte — DÉTERMINISTE, PUR.
 * Exporté pour testabilité directe et pour le harnais d'évaluation.
 */
export function validateModelDraft(
  rawText: string,
  validated: ValidatedMessageReadyContextV0,
  policy: ChannelPolicyV0,
): MessageComposeResultV0 {
  const c = validated.context

  // 1) JSON STRICT : la totalité de la sortie est UN objet JSON — pas
  //    d'extraction indulgente au milieu de prose ni de clôtures markdown.
  let brut: unknown
  try { brut = JSON.parse(rawText.trim()) } catch { return echec('MALFORMED_MODEL_OUTPUT', 'NOT_JSON') }
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) {
    return echec('MALFORMED_MODEL_OUTPUT', 'NOT_JSON')
  }

  // 2) SCHÉMA EXACT : {text, assertions} et rien d'autre — un champ de
  //    stratégie supplémentaire (offre alternative, score, canal…) est REFUSÉ.
  const cles = Object.keys(brut as Record<string, unknown>)
  if (cles.length !== 2 || !cles.includes('text') || !cles.includes('assertions')) {
    return echec('MALFORMED_MODEL_OUTPUT', 'SCHEMA_MISMATCH')
  }
  const texte = (brut as Record<string, unknown>).text
  const assertionsBrutes = (brut as Record<string, unknown>).assertions
  if (!texteNonVide(texte)) return echec('MALFORMED_MODEL_OUTPUT', 'EMPTY_TEXT')
  if (!Array.isArray(assertionsBrutes)) return echec('MALFORMED_MODEL_OUTPUT', 'SCHEMA_MISMATCH')

  // 3) ASSERTIONS : forme exacte {assertion, evidenceRefs, rendering}.
  const assertions: MessageAssertionAuditV0[] = []
  for (const a of assertionsBrutes) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      return echec('MALFORMED_MODEL_OUTPUT', 'ASSERTION_MALFORMED')
    }
    const clesA = Object.keys(a as Record<string, unknown>)
    if (clesA.length !== 3 || !clesA.includes('assertion') || !clesA.includes('evidenceRefs') || !clesA.includes('rendering')) {
      return echec('MALFORMED_MODEL_OUTPUT', 'ASSERTION_MALFORMED')
    }
    const { assertion, evidenceRefs, rendering } = a as Record<string, unknown>
    if (!texteNonVide(assertion)) return echec('MALFORMED_MODEL_OUTPUT', 'ASSERTION_MALFORMED')
    if (!(RENDERINGS as readonly string[]).includes(rendering as string)) {
      return echec('MALFORMED_MODEL_OUTPUT', 'ASSERTION_MALFORMED')
    }
    if (!Array.isArray(evidenceRefs) || evidenceRefs.some((r) => !texteNonVide(r))) {
      return echec('MALFORMED_MODEL_OUTPUT', 'ASSERTION_MALFORMED')
    }
    // Une assertion factuelle SANS ref d'évidence n'existe pas dans ce contrat.
    if (evidenceRefs.length === 0) return echec('POLICY_VIOLATION', 'ASSERTION_WITHOUT_EVIDENCE')
    assertions.push(Object.freeze({
      assertion: assertion as string,
      evidenceRefs: Object.freeze([...(evidenceRefs as string[])]),
      rendering: rendering as MessageAssertionAuditV0['rendering'],
    }))
  }

  // 4) BUDGETS D'ASSERTION : maxAssertions ET assertionBudget (0 ⇒ aucune).
  const plafondAssertions = Math.min(c.claimConstraints.maxAssertions, c.budgets.assertionBudget)
  if (assertions.length > plafondAssertions) {
    return echec('POLICY_VIOLATION', 'ASSERTION_BUDGET_EXCEEDED')
  }

  // 5) REFS : connues, montrables, dans le budget Shown — Shown ⊆ eligible Used.
  const refsConnues = new Set(c.communicationEvidence.map((e) => e.evidenceRef))
  const montrables = new Set(c.claimConstraints.showableEvidenceRefs)
  const incertaines = new Set(c.claimConstraints.uncertainAssertionRefs)
  const shownRefs: string[] = []
  const dejaVues = new Set<string>()
  for (const a of assertions) {
    for (const r of a.evidenceRefs) {
      if (!refsConnues.has(r)) return echec('POLICY_VIOLATION', 'UNKNOWN_EVIDENCE_REF')
      if (!montrables.has(r)) return echec('POLICY_VIOLATION', 'NON_SHOWABLE_EVIDENCE_REF')
      if (!dejaVues.has(r)) { dejaVues.add(r); shownRefs.push(r) }
      // 6) INCERTITUDE : jamais rendue certaine.
      //    R2 — CONTRE-SIGNAL ≠ INCERTITUDE, jusque dans le validateur : un
      //    contre-signal affaiblit une INTERPRÉTATION, pas le fait primaire
      //    évidencé — un fait certain porté par une ref à contre-signaux PEUT
      //    être rendu DIRECT. Le validateur déterministe ne sait PAS distinguer
      //    un fait primaire d'une interprétation attachée à la même ref : cette
      //    discipline vit dans les règles de confiance du prompt et le harnais
      //    comportemental (résiduel sémantique assumé). Les counterSignalRefs
      //    d'origine restent auditables dans le contexte canonique.
      if (a.rendering === 'DIRECT' && incertaines.has(r)) {
        return echec('POLICY_VIOLATION', 'DIRECT_RENDERING_ON_UNCERTAIN_REF')
      }
    }
  }
  const plafondShown = Math.min(c.budgets.researchShownBudget, c.budgets.evidenceBudget)
  if (shownRefs.length > plafondShown) return echec('POLICY_VIOLATION', 'SHOWN_BUDGET_EXCEEDED')

  // 7) INTERDITS : bloquants, jamais advisory.
  if (checkForbiddenClaims(texte as string, c.forbiddenClaims).ok === false) {
    return echec('POLICY_VIOLATION', 'FORBIDDEN_CLAIM')
  }

  // 8) NON-FUITE : aucun identifiant interne (refs d'évidence/source/offre/
  //    destinataire/situation/relation/contre-signal) dans le texte visible.
  const basText = (texte as string).toLowerCase()
  const identifiantsInternes = new Set<string>([
    c.recipientRef, c.offerRef, c.selectedSituation,
    ...(c.relationshipContextRef !== undefined ? [c.relationshipContextRef] : []),
  ])
  for (const e of c.communicationEvidence) {
    identifiantsInternes.add(e.evidenceRef)
    identifiantsInternes.add(e.provenance.sourceRef)
    for (const cs of e.counterSignalRefs ?? []) identifiantsInternes.add(cs)
  }
  for (const id of identifiantsInternes) {
    if (texteNonVide(id) && basText.includes(id.toLowerCase())) {
      return echec('POLICY_VIOLATION', 'INTERNAL_REF_LEAKED')
    }
  }

  const draft: DraftMessageV0 = Object.freeze({
    text: texte as string,
    shownEvidenceRefs: Object.freeze(shownRefs),
    channelPolicyApplied: policy.channel,
    assertionsAudit: Object.freeze(assertions),
  })
  return { ok: true, draft }
}

export const CONSTRAINED_COMPOSE_ENGINE_ID = 'constrained-copywriter-v0'

/**
 * Construit le moteur. L'invocateur (et derrière lui le tenant d'imputation)
 * est une dépendance d'EXÉCUTION liée ici — compose() ne reçoit JAMAIS de
 * tenant, de compte, ni de donnée brute supplémentaire.
 */
export function createConstrainedComposeEngine(invoker: MessageModelInvokerV0): MessageEngineV0 {
  return {
    engineId: CONSTRAINED_COMPOSE_ENGINE_ID,
    async compose(input: ValidatedMessageReadyContextV0, policy: ChannelPolicyV0): Promise<MessageComposeResultV0> {
      // La frontière est re-vérifiée ICI : un objet forgé sans la marque du
      // validateur n'atteint ni le compilateur ni le modèle.
      if (!isValidatedContext(input)) {
        return echec('UNSUPPORTED_ACTION_CONTEXT', 'CONTEXT_NOT_VALIDATED')
      }
      const compiled = compileMessagePrompt(input, policy)
      if (compiled.ok === false) return echec(compiled.reason, compiled.detail)

      const invocation = await invoker.invoke(compiled.request)
      if (invocation.ok === false) {
        if (invocation.reason === 'PROVIDER_BLOCKED') return echec('PROVIDER_BLOCKED', 'PROVIDER_BUDGET_BLOCKED')
        if (invocation.reason === 'PROVIDER_INCOMPLETE') return echec('PROVIDER_UNAVAILABLE', 'PROVIDER_INCOMPLETE')
        if (invocation.reason === 'PROVIDER_OFF') return echec('PROVIDER_UNAVAILABLE', 'PROVIDER_OFF')
        return echec('PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR')
      }
      return validateModelDraft(invocation.rawText, input, policy)
    },
  }
}
