// ARCH-RULEPACK-001 — BOÎTE À OUTILS DES RÈGLES.
//
// ── POURQUOI CE MODULE EXISTE ───────────────────────────────────────────────
// Ces fonctions vivaient dans `situationEngine.ts`, où les trois détecteurs les
// utilisaient. Les packs en ont besoin ; or le moteur doit désormais importer
// le registre des packs pour les exécuter. Laisser les helpers dans le moteur
// aurait donc produit le cycle : packs → situationEngine → registry → packs.
//
// ── CE MODULE EST STÉRILE, ET DOIT LE RESTER ────────────────────────────────
// Fonctions PURES uniquement. Aucun I/O, aucun import vers `packs/registry` ni
// vers `lens/registry`, aucune logique propre à un métier. C'est ce qui lui
// permet d'être en amont de tout le monde dans le graphe d'imports.
//
// ⚠️ DÉPLACEMENT SANS RÉÉCRITURE. Les corps sont ceux de `situationEngine.ts`,
// à l'identique. Toute divergence de comportement serait un défaut, pas une
// amélioration : les 158 tests existants sont l'oracle d'équivalence.
import type {
  DatedEventEvidence,
  EvidenceEvent,
  Situation,
} from './types'
import type { SituationEvaluationContext } from './rulePack'

export const DAY_MS = 24 * 60 * 60 * 1000

export function validDateMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

export function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * IDENTITÉ STABLE — encodage NON AMBIGU.
 *
 * ⚠️ L'ANCIENNE FORME ÉTAIT COLLISION-PRONE. Elle concaténait les composants
 * par `_` puis remplaçait tout caractère non sûr par `_`. Deux entrées
 * distinctes pouvaient donc produire le même identifiant :
 *
 *   accountId 'a_b', type 'c'   →  'a_b_c'
 *   accountId 'a',   type 'b_c' →  'a_b_c'
 *
 * Et l'assainissement aggravait le problème : `a.b` et `a_b` devenaient
 * identiques. Sur un magasin dont la clé primaire est `(kind, id,
 * workspace_id)`, une collision n'est pas un désagrément d'affichage : c'est
 * une situation qui en écrase silencieusement une autre.
 *
 * L'encodage retenu préfixe chaque composant par SA LONGUEUR. Le décodage est
 * univoque, donc l'encodage est injectif : deux tuples distincts ne peuvent
 * pas produire la même chaîne, quels que soient les caractères employés.
 */
export function stableId(prefix: string, parts: readonly (string | undefined)[]): string {
  const encoded = parts
    .map((part) => {
      const v = part ?? ''
      return `${v.length}:${v}`
    })
    .join('|')

  return `${prefix}_${encoded}`
}

export function bestEvidenceByType(
  evidence: readonly EvidenceEvent[],
  types: readonly string[],
): EvidenceEvent[] {
  const selected: EvidenceEvent[] = []

  for (const type of types) {
    const candidates = evidence
      .filter((item) => item.type === type)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) {
          return b.confidence - a.confidence
        }

        return (
          Date.parse(b.observedAt) -
          Date.parse(a.observedAt)
        )
      })

    if (candidates[0]) selected.push(candidates[0])
  }

  return selected
}

export function averageConfidence(evidence: readonly EvidenceEvent[]): number {
  if (evidence.length === 0) return 0

  return roundScore(
    evidence.reduce((sum, item) => sum + item.confidence, 0) /
      evidence.length,
  )
}

export function hasFact(evidence: readonly EvidenceEvent[]): boolean {
  return evidence.some((item) => item.assertionType === 'fact')
}

export function freshnessScore(
  evidence: DatedEventEvidence,
  now: Date,
): number {
  const occurredMs = Date.parse(evidence.occurredAt)
  const ageDays = (now.getTime() - occurredMs) / DAY_MS

  if (ageDays <= 7) return 1
  if (ageDays <= 30) return 0.8
  if (ageDays <= 90) return 0.6

  return 0.4
}

/**
 * L'evidence porte-t-elle une date MÉTIER exploitable ?
 *
 * `undated_state` signifie « je constate un état, j'ignore depuis quand ». Une
 * telle evidence n'a PAS de `occurredAt` — le type l'interdit — et il n'existe
 * AUCUN repli sur `observedAt` pour en fabriquer une : lire la date
 * d'observation comme une date de survenue ferait passer une fiche vieille de
 * dix-huit mois pour un fait du jour.
 */
export function aUneDateMetier(
  evidence: EvidenceEvent,
): evidence is DatedEventEvidence {
  return evidence.temporality === 'dated_event'
}

/**
 * URGENCE — calculée UNIQUEMENT sur les evidences réellement datées.
 *
 * ⚠️ INCONNU N'EST PAS RÉCENT. Une evidence dont la date métier est inconnue ne
 * contribue à aucune urgence : ni maximale (ce serait inventer une actualité),
 * ni minimale (ce serait inventer une ancienneté). Une information absente ne
 * doit pas produire de score.
 */
export function urgencyFromEvidence(
  evidence: readonly EvidenceEvent[],
  now: Date,
): number {
  const datees = evidence.filter(aUneDateMetier)

  if (datees.length === 0) return 0

  return roundScore(
    Math.max(
      ...datees.map((item) => freshnessScore(item, now)),
    ),
  )
}

export function situationExpiry(
  evidence: readonly EvidenceEvent[],
  now: Date,
  ttlDays: number,
): string {
  const ruleExpiryMs = now.getTime() + ttlDays * DAY_MS

  const evidenceExpiries = evidence
    .map((item) =>
      item.expiresAt ? Date.parse(item.expiresAt) : null,
    )
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value),
    )

  const expiresMs =
    evidenceExpiries.length > 0
      ? Math.min(ruleExpiryMs, ...evidenceExpiries)
      : ruleExpiryMs

  return new Date(expiresMs).toISOString()
}

/** Options de fabrication, portées par le pack appelant. */
export interface BuildSituationInput {
  type: string
  evidence: readonly EvidenceEvent[]
  context: SituationEvaluationContext
  ruleId: string
  ruleVersion: string
  rulePackId: string
  rulePackVersion: string
  ttlDays: number
  rationale: string
}

/**
 * FABRIQUE UNIQUE DE SITUATION.
 *
 * ⚠️ AUCUN PACK NE CONSTRUIT UNE `Situation` À LA MAIN. Passer par cette
 * fabrique est ce qui garantit que l'identité, l'urgence, la confiance et la
 * péremption sont calculées par le CŒUR — un pack qui les forgerait pourrait
 * inventer une urgence sur des données non datées, ou une identité qui entre
 * en collision avec celle d'un autre pack.
 *
 * L'identité comprend `lensId` et `rulePackId` : `relevance` dépend de la lens,
 * et deux packs peuvent légitimement produire le même `situationType`.
 * Les VERSIONS n'y entrent pas — une montée de version remplace la ligne
 * courante, elle n'en crée pas une seconde.
 */
export function buildSituation(input: BuildSituationInput): Situation {
  const { context, evidence } = input
  const nowIso = context.now.toISOString()

  return {
    id: stableId('sit', [
      context.lensId,
      input.rulePackId,
      context.accountId,
      context.personId,
      input.type,
    ]),
    accountId: context.accountId,
    personId: context.personId,
    type: input.type,
    evidenceIds: evidence.map((item) => item.id),
    confidence: averageConfidence(evidence),
    relevance: roundScore(context.relevance),
    urgency: urgencyFromEvidence(evidence, context.now),
    rationale: input.rationale,
    rulePackId: input.rulePackId,
    rulePackVersion: input.rulePackVersion,
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    lensId: context.lensId,
    lensVersion: context.lensVersion,
    createdAt: nowIso,
    lastEvaluatedAt: nowIso,
    expiresAt: situationExpiry(evidence, context.now, input.ttlDays),
  }
}
