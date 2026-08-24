// GOLDEN-SCHEMA-001a — PROJECTION GOLDEN → EVALCASE.
//
// ── LA SEULE SOURCE DE VÉRITÉ SÉMANTIQUE EST `adjudication` ─────────────────
//
//     GoldenCase  →  projectGoldenCase()  →  cas runtime JSON
//                                              ↓
//                                        validateEvalCase()      (celui du runner)
//                                              ↓
//                                            EvalCase
//
// Rien n'est recopié : `now`, `relevance`, `observedAt`, `confidence` et la
// totalité de `evidence[]` sont DÉRIVÉS. Le Golden ne persiste que ce qui ne
// l'est pas — le Business Context et l'identité des cibles.
//
// ── L'ENSEMBLE DE LECTURE EST RESTREINT, ET C'EST TESTÉ ─────────────────────
//
//   PEUT lire :  evaluationProfile · assumptions · adjudication
//                executionContext · executability
//   NE DOIT PAS : expected · legacyAssessment · caseStatus · provenance · rawSource
//
// ⚠️ AUCUN VALIDATEUR NE PEUT PROUVER CELA. Un validateur voit des valeurs,
// jamais des dérivations : si quelqu'un recopiait `expected` dans une
// pertinence, toute vérification structurelle passerait. La preuve est donc
// OBSERVATIONNELLE — `tests/golden-anti-leakage.test.ts` mute arbitrairement les
// blocs interdits et exige une sortie BYTE-IDENTIQUE. C'est la seule preuve
// disponible sans analyse statique, et elle échoue bruyamment dès qu'une fuite
// est câblée.
//
// `rawSource` figure dans l'ensemble interdit pour une raison supplémentaire :
// un projecteur qui lirait l'archive y réintroduirait de l'I/O.
//
// ── COUCHE SUPÉRIEURE, SENS UNIQUE ──────────────────────────────────────────
//
//     caseSchema  ←  goldenSchema  ←  goldenToEvalCase
//
// Ce module importe `goldenSchema` ; `goldenSchema` ne l'importe PAS en retour.
// L'inverse existait — `goldenSchema` important `projectGoldenCase` pendant que
// ce fichier importait `projectTemporality` — et formait un CYCLE D'IMPORTS à
// l'exécution. `validateGoldenCase()` vit donc ICI, au-dessus des deux.
import { EVAL_SCHEMA_VERSION, validateEvalCase } from './caseSchema'
import { projectTemporality, validateGoldenCaseStructure } from './goldenSchema'
import type { AdjudicatedClaim, GoldenCase, GoldenError, GoldenValidation } from './goldenSchema'

export type GoldenProjection =
  | { ok: true; evalCase: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * Construit le cas runtime JSON à partir d'un cas Golden.
 *
 * Rend un objet JSON BRUT — `now` y est une chaîne ISO — car c'est exactement ce
 * qu'attend `validateEvalCase`, qui le convertit ensuite en `Date`. Projeter
 * directement un `EvalCase` reviendrait à court-circuiter le validateur du
 * runner, donc à autoriser un cas Golden « valide » que le runner refuserait.
 */
export function projectGoldenCase(golden: GoldenCase | any): GoldenProjection {
  if (!golden || typeof golden !== 'object') {
    return { ok: false, reason: 'Cas Golden absent ou non objet.' }
  }

  // ── PREMIÈRE OPÉRATION, avant toute construction ─────────────────────────
  // Un cas bloqué n'a pas d'exécution « partielle » : projeter ses seules
  // claims MAPPED produirait un résultat vert calculé sur un jeu de faits dont
  // on SAIT qu'il est incomplet — vrai de la fixture, faux du monde.
  if (golden.executability !== 'EXECUTABLE') {
    return {
      ok: false,
      reason:
        `Projection refusée : \`executability\` vaut « ${golden.executability} ». Un cas non ` +
        'exécutable ne se projette pas partiellement — les claims non mappées manquent, et un ' +
        'résultat calculé sans elles serait vrai de la fixture et faux du monde.',
    }
  }

  const assumptions = golden.assumptions
  if (!assumptions || typeof assumptions !== 'object') {
    return { ok: false, reason: 'Projection refusée : `assumptions` absentes.' }
  }

  const executionContext = golden.executionContext
  if (!executionContext || typeof executionContext !== 'object') {
    return { ok: false, reason: 'Projection refusée : `executionContext` absent.' }
  }

  const relevance = assumptions.targetRelevance?.value
  const confidence = assumptions.evidenceConfidence?.value
  const observedAt = assumptions.observedAt?.value
  const now = assumptions.now?.value

  const targets = (executionContext.targets ?? []).map((t: any) => {
    // `relevance` est INJECTÉE, jamais persistée : une valeur écrite cas par cas
    // pourrait diverger de la constante déclarée, et c'est exactement la forme
    // que prendrait une fuite depuis `account.lensFitExpected`.
    const projete: Record<string, unknown> = { accountId: t.accountId, relevance }
    if (t.personId !== undefined) projete.personId = t.personId
    if (t.eligibility !== undefined) projete.eligibility = t.eligibility
    return projete
  })

  const claims: AdjudicatedClaim[] = (golden.adjudication?.rawEvidence ?? []).flatMap(
    (groupe: any) => (Array.isArray(groupe?.claims) ? groupe.claims : []),
  )

  const evidence: Record<string, unknown>[] = []

  for (const claim of claims) {
    if (claim.mappingDecision !== 'MAPPED') continue

    const projection = projectTemporality(claim.temporalNature!, claim.temporalPrecision!)
    if (projection.kind === 'gap') {
      return {
        ok: false,
        reason:
          `Projection refusée : la claim « ${claim.semanticClaim} » ne projette aucune ` +
          `temporalité runtime. ${projection.reason}`,
      }
    }

    const item: Record<string, unknown> = {
      id: claim.evidenceId,
      accountId: claim.targetAccountId,
      scope: claim.evidenceScope,
      type: claim.evidenceType,
      assertionType: claim.assertionType,
      confidence,
      observedAt,
      source: claim.runtimeSource,
    }

    if (claim.targetPersonId !== undefined) item.personId = claim.targetPersonId

    if (projection.kind === 'dated_event') {
      item.temporality = 'dated_event'
      item.occurredAt = claim.occurredAt
    } else {
      // ⚠️ `occurredAt` n'est PAS écrit — le type l'interdit sur un état non
      // daté, et `isEvidenceEvent` le refuserait. Un `undefined` explicite
      // suffirait d'ailleurs à faire échouer `temporaliteCoherente`.
      item.temporality = 'undated_state'
    }

    evidence.push(item)
  }

  // Ordre STABLE : deux projections du même cas doivent être byte-identiques,
  // et l'ordre de lecture des groupes ne doit pas transparaître dans la sortie.
  evidence.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))

  return {
    ok: true,
    evalCase: {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now,
      businessContext: executionContext.businessContext,
      targets,
      evidence,
    },
  }
}

/**
 * Sérialisation STABLE de la projection — support des tests de non-fuite.
 *
 * Le tri des clés rend la comparaison byte-à-byte indépendante de l'ordre
 * d'insertion, donc de la structure interne du projecteur. Même doctrine que
 * `serializeEvalOutput`.
 */
export function serializeProjection(value: unknown): string {
  return JSON.stringify(value, triCles, 2) + '\n'
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

// ── VALIDATION COMPLÈTE ─────────────────────────────────────────────────────

/**
 * Validation COMPLÈTE d'un cas Golden : structure, puis projection, puis
 * validation du cas runtime par le validateur DU RUNNER.
 *
 * ⚠️ AUCUN SECOND VALIDATEUR D'EVALCASE. Un cas Golden ne peut donc pas être
 * « valide » d'une manière que `proactive-eval` refuserait.
 *
 * ── POURQUOI CETTE FONCTION EST ICI, ET NON DANS `goldenSchema` ─────────────
 * Parce que `goldenSchema` ne doit pas importer le projecteur : ce serait le
 * cycle d'imports décrit en tête de fichier. La structure appartient à la couche
 * du dessous, l'orchestration à celle-ci.
 *
 * `validateGoldenCaseStructure` reste utilisable seule — elle sonde déjà
 * `executionContext`, y compris pour les cas BLOQUÉS.
 */
export function validateGoldenCase(input: unknown): GoldenValidation {
  const structure = validateGoldenCaseStructure(input)
  if (structure.ok === false) return structure

  const golden = structure.case

  // Un cas non exécutable s'arrête ici : ses claims irrésolues n'ont rien à
  // projeter, et son contexte d'exécution a DÉJÀ été éprouvé par la sonde.
  if (golden.executability !== 'EXECUTABLE') return structure

  const errors: GoldenError[] = []

  const projete = projectGoldenCase(golden)
  if (projete.ok === false) {
    errors.push({
      code: 'projection_failed',
      path: 'adjudication',
      message: projete.reason,
    })
    return { ok: false, errors }
  }

  const runtime = validateEvalCase(projete.evalCase)
  if (runtime.ok === false) {
    for (const err of runtime.errors) {
      errors.push({
        code: err.code,
        // ⚠️ JAMAIS `input.` : cette racine a été SUPPRIMÉE du contrat Golden
        // (R2, « dériver, ne pas dupliquer »). Un chemin qui nomme une structure
        // inexistante envoie le lecteur corriger un champ absent du fichier.
        // `projectedEvalCase` nomme honnêtement une COUCHE DÉRIVÉE.
        path: `projectedEvalCase.${err.path}`,
        message: `${err.message}${origineProjetee(projete.evalCase, err.path)}`,
      })
    }
    return { ok: false, errors }
  }

  return structure
}

/**
 * Rattache une erreur portant sur `evidence[i]` à l'evidence RÉELLEMENT fautive.
 *
 * L'indice seul est inutilisable : la projection trie les evidences, donc `i` ne
 * correspond à aucun ordre du fichier Golden. L'`evidenceId`, lui, est unique et
 * apparaît tel quel dans `adjudication`, ce qui rend l'erreur actionnable sans
 * reconstruire un chemin inverse fragile.
 */
function origineProjetee(evalCase: Record<string, unknown>, path: string): string {
  const match = /^evidence\[(\d+)\]/.exec(path)
  if (!match) return ''

  const item = (evalCase.evidence as any[])?.[Number(match[1])]
  if (!item?.id) return ''

  return ` (evidence projetée « ${item.id} » — voir la claim MAPPED portant cet \`evidenceId\` dans \`adjudication\`)`
}
