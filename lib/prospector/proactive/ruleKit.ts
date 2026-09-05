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
import {
  EXTERNAL_SIGNAL_PROVIDER,
  type AnticipatedHorizon,
  type DatedEventEvidence,
  type EvidenceEvent,
  type SignalTemporalAuthority,
  type Situation,
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

        // ── SIGNAL_TEMPORAL_WINDOW_V0_001 : à confiance égale, DEUX ÉVÉNEMENTS
        // DATÉS se départagent par leur DATE MÉTIER, jamais par `observedAt` —
        // une re-adjudication d'aujourd'hui ne rajeunit pas un fait de 2021.
        // Tout autre couple conserve l'ordre antérieur (observedAt) : pour un
        // état non daté, l'entrée dans la projection reste le seul ordre connu.
        if (a.temporality === 'dated_event' && b.temporality === 'dated_event') {
          const ao = Date.parse((a as DatedEventEvidence).occurredAt)
          const bo = Date.parse((b as DatedEventEvidence).occurredAt)
          if (Number.isFinite(ao) && Number.isFinite(bo) && bo !== ao) {
            return bo - ao
          }
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

// ── SIGNAL_TEMPORAL_WINDOW_V0_001 — CLASSIFICATION TEMPORELLE DU CŒUR ───────
//
// Trois quantités STRICTEMENT distinctes, et ce module n'en fusionne aucune :
//   validité du FAIT        → validateurs + gate canonique (ailleurs)
//   fraîcheur du SIGNAL     → ces helpers (référence temporelle + fenêtre)
//   urgence de la SITUATION → `freshnessScore`/`urgencyFromEvidence`, inchangés
//
// L'âge n'est JAMAIS converti en confiance, et une donnée absente ne produit
// jamais une référence : INCONNU n'est pas récent.

const JOUR_UTC = /^\d{4}-\d{2}-\d{2}$/

/** Ce que le cœur SAIT du temps d'une evidence — jamais ce qu'il devine. */
export type TemporalReference =
  | { state: 'KNOWN'; granularity: 'DAY' | 'INSTANT'; ms: number }
  | { state: 'UNKNOWN' }
  | { state: 'INVALID_OR_FUTURE' }

/** Minuit UTC du jour de `now` — la comparaison de JOURS se fait en jours. */
function debutDeJourUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/**
 * RÉFÉRENCE TEMPORELLE D'UNE EVIDENCE — la seule horloge légitime, par nature :
 *
 *   ÉVÉNEMENT DATÉ          → `occurredAt` (la date métier, rien d'autre)
 *   ÉTAT EXTERNE            → side-car du gate canonique
 *                             (`EXTERNAL_STATE_OBSERVED_DAY`, histoire immuable)
 *   ÉTAT INTERNE (CRM)      → `observedAt` — LÉGITIME ici, et seulement ici :
 *                             `dataBridge` produit l'evidence À l'instant de
 *                             l'observation CRM, les deux horloges coïncident.
 *
 * JAMAIS `sourcePublishedAt`, JAMAIS `acceptance.confirmedAt`, JAMAIS
 * `retrievedAt` en aval, JAMAIS `observedAt` pour un fait externe — toutes ces
 * horloges mesurent la découverte ou l'adjudication, pas le monde.
 *
 * État externe sans autorité (side-car absent) ⇒ UNKNOWN — il ne satisfera
 * AUCUNE fenêtre déclarée. Le fait reste vrai ; il est temporellement muet.
 */
export function temporalReference(
  evidence: EvidenceEvent,
  now: Date,
  authority?: SignalTemporalAuthority,
): TemporalReference {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return { state: 'INVALID_OR_FUTURE' }

  if (evidence.temporality === 'dated_event') {
    const brut = (evidence as DatedEventEvidence).occurredAt
    if (typeof brut !== 'string') return { state: 'INVALID_OR_FUTURE' }
    const ms = Date.parse(brut)
    if (!Number.isFinite(ms)) return { state: 'INVALID_OR_FUTURE' }
    if (JOUR_UTC.test(brut)) {
      // Jour métier : futur au sens des JOURS UTC, jamais des heures locales.
      if (ms > debutDeJourUtc(now)) return { state: 'INVALID_OR_FUTURE' }
      return { state: 'KNOWN', granularity: 'DAY', ms }
    }
    if (ms > nowMs) return { state: 'INVALID_OR_FUTURE' }
    return { state: 'KNOWN', granularity: 'INSTANT', ms }
  }

  if (evidence.temporality !== 'undated_state') return { state: 'UNKNOWN' }

  if (evidence.source?.provider === EXTERNAL_SIGNAL_PROVIDER) {
    // ⚠️ AUCUN REPLI SUR `observedAt` : une adjudication d'aujourd'hui ne
    // rajeunit pas une page observée en mars. L'autorité vient du gate.
    if (!authority) return { state: 'UNKNOWN' }
    if (authority.basis !== 'EXTERNAL_STATE_OBSERVED_DAY') {
      return { state: 'INVALID_OR_FUTURE' } // autorité incohérente : refus
    }
    const jour = authority.referenceDay
    if (typeof jour !== 'string' || !JOUR_UTC.test(jour)) {
      return { state: 'INVALID_OR_FUTURE' }
    }
    const ms = Date.parse(jour)
    if (!Number.isFinite(ms)) return { state: 'INVALID_OR_FUTURE' }
    if (ms > debutDeJourUtc(now)) return { state: 'INVALID_OR_FUTURE' }
    return { state: 'KNOWN', granularity: 'DAY', ms }
  }

  // Interne (CRM) : l'observation EST l'instantané — durée exacte écoulée.
  const ms = Date.parse(evidence.observedAt)
  if (!Number.isFinite(ms)) return { state: 'INVALID_OR_FUTURE' }
  if (ms > nowMs) return { state: 'INVALID_OR_FUTURE' }
  return { state: 'KNOWN', granularity: 'INSTANT', ms }
}

/**
 * SIGNAL_TEMPORAL_WINDOW_V0_001_R1 — LECTURE D'UNE FENÊTRE DÉCLARÉE, FERMÉE.
 *
 * ABSENCE ≠ MALFORMATION, et les confondre est un échec OUVERT :
 *
 *   NONE     clé ABSENTE           → aucune fenêtre : comportement antérieur
 *   VALID    nombre ENTIER ≥ 0     → appliquer `withinMaxAgeDays`
 *   INVALID  clé PRÉSENTE, valeur  → FAIL CLOSED : l'evidence de ce type ne
 *            illisible               doit JAMAIS atteindre `detect` sous cette
 *                                    règle — une politique malformée ne peut
 *                                    que RETIRER de l'éligibilité, jamais en
 *                                    créer ni en élargir.
 *
 * ⚠️ AUCUNE COERCITION. `"90"` est INVALIDE — pas `Number("90")`. L'unité
 * déclarée est le JOUR CALENDAIRE : la valeur doit être un entier sûr, non
 * négatif et fini. NaN, ±Infinity, négatif, non-entier, non-nombre ⇒ INVALID.
 */
export type TemporalWindowLookup =
  | { kind: 'NONE' }
  | { kind: 'VALID'; maxAgeDays: number }
  | { kind: 'INVALID' }

export function temporalWindowLookup(
  maxAgeDaysByEvidenceType: Readonly<Record<string, unknown>> | undefined,
  evidenceType: string,
): TemporalWindowLookup {
  if (!maxAgeDaysByEvidenceType
    || !Object.prototype.hasOwnProperty.call(maxAgeDaysByEvidenceType, evidenceType)) {
    return { kind: 'NONE' }
  }
  const brut = maxAgeDaysByEvidenceType[evidenceType]
  if (typeof brut !== 'number' || !Number.isSafeInteger(brut) || brut < 0) {
    return { kind: 'INVALID' }
  }
  return { kind: 'VALID', maxAgeDays: brut }
}

/**
 * LA FENÊTRE. `maxAgeDays = N` : utilisable jusqu'au jour d'âge N INCLUS,
 * périmé à compter du jour UTC N+1 (granularité JOUR) ; durée exacte écoulée
 * pour une référence instantanée (CRM). UNKNOWN, invalide ou futur ne
 * satisfont JAMAIS une fenêtre déclarée — fail closed.
 */
export function withinMaxAgeDays(
  reference: TemporalReference,
  now: Date,
  maxAgeDays: number,
): boolean {
  if (reference.state !== 'KNOWN') return false
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return false

  if (reference.granularity === 'DAY') {
    const ageJours = Math.floor((debutDeJourUtc(now) - reference.ms) / DAY_MS)
    return ageJours >= 0 && ageJours <= maxAgeDays
  }
  const ecoule = now.getTime() - reference.ms
  return ecoule >= 0 && ecoule <= maxAgeDays * DAY_MS
}

/**
 * L'INSTANT où la référence sort de la fenêtre — pour BORNER la validité d'une
 * Situation persistée : filtrer à l'évaluation ne suffit pas, une Situation
 * produite au jour 89 d'une fenêtre de 90 ne doit pas survivre 30 jours de TTL.
 *
 *   JOUR    → minuit UTC du jour d'âge N+1 (premier instant périmé)
 *   INSTANT → référence + N jours exacts
 *
 * `null` si la référence n'est pas connue — l'appelant n'a alors rien à borner
 * puisque cette evidence n'a pas pu satisfaire la fenêtre.
 */
export function freshnessDeadlineMs(
  reference: TemporalReference,
  maxAgeDays: number,
): number | null {
  if (reference.state !== 'KNOWN') return null
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return null
  return reference.granularity === 'DAY'
    ? reference.ms + (maxAgeDays + 1) * DAY_MS
    : reference.ms + maxAgeDays * DAY_MS
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

/**
 * ARCH-HORIZON-001 — URGENCE D'UNE ÉCHÉANCE FUTURE.
 *
 * Miroir exact de `freshnessScore`, qui regarde le PASSÉ et décroît. Celle-ci
 * regarde l'AVENIR et croît.
 *
 * ── AUCUN SEUIL DANS LE CŒUR ────────────────────────────────────────────────
 * Une première version proposait des paliers 30/60/90 jours. C'était une
 * politique métier déguisée en primitive : trente jours avant une fin de bail
 * et trente jours avant une expiration de certificat n'ont pas la même
 * signification. La progression est donc NORMALISÉE sur la fenêtre que le pack
 * déclare — la forme de la montée appartient au pack, le calcul appartient au
 * cœur.
 *
 *     now < opensAt      → 0     (la fenêtre n'est pas ouverte)
 *     opensAt ≤ now < at → (now - opensAt) / (at - opensAt)   ∈ [0,1)
 *     now ≥ at           → 0     (l'échéance est atteinte : plus une anticipation)
 *
 * FAIL CLOSED : dates illisibles ou fenêtre dégénérée ⇒ 0. Une urgence ne se
 * déduit jamais d'une donnée qu'on n'a pas su lire.
 */
export function urgencyFromHorizon(
  horizon: AnticipatedHorizon,
  now: Date,
): number {
  if (!horizon) return 0

  const openMs = validDateMs(horizon.actionWindowOpensAt)
  const atMs = validDateMs(horizon.at)
  const nowMs = now.getTime()

  if (openMs === null || atMs === null || !Number.isFinite(nowMs)) return 0

  // Fenêtre dégénérée ou inversée : refusée plutôt qu'interprétée.
  if (atMs <= openMs) return 0

  if (nowMs < openMs) return 0
  if (nowMs >= atMs) return 0

  return roundScore((nowMs - openMs) / (atMs - openMs))
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
  /** Échéance métier anticipée, déclarée par le pack. Optionnelle. */
  anticipated?: AnticipatedHorizon
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
  const horizon = input.anticipated

  // ── VALIDITÉ DE L'INTERPRÉTATION, BORNÉE PAR L'ÉCHÉANCE MÉTIER ────────────
  // Ce n'est PAS un détournement de `expiresAt`, et la distinction tient à qui
  // décide : `anticipated.at` est une ENTRÉE déclarée par le pack, `expiresAt`
  // reste une SORTIE calculée par le cœur. Celui-ci se borne à constater qu'une
  // interprétation fondée sur une opportunité future ne peut pas rester valide
  // après cette opportunité — c'est exactement la nature d'une borne de
  // validité.
  //
  // ── RÉPARTITION DES RESPONSABILITÉS (corrigée en ARCH-HORIZON-001a) ──────
  // Une version antérieure de ce commentaire attribuait la borne gauche au
  // Rule Pack. C'est FAUX depuis ARCH-HORIZON-001 : les deux bornes sont
  // portées par le cœur, et aucune ne dépend de la vigilance d'un pack.
  //
  //   Eligibility (cœur)        → borne GAUCHE : `anticipated_window_not_open`
  //                               tant que `now < actionWindowOpensAt`
  //   Eligibility (cœur)        → borne DROITE, en DIRECT : `situation_expired`
  //                               dès `now ≥ anticipated.at`, même si
  //                               `expiresAt` relu est incohérent
  //   buildSituation (ici)      → borne de VALIDITÉ persistée : le clamp
  //                               ci-dessous, plus le garde de `validators.ts`
  //                               qui exige `expiresAt ≤ anticipated.at`
  //
  // Ce clamp reste donc nécessaire — il produit des objets cohérents — mais il
  // n'est plus la SEULE protection : un objet relu depuis la base n'a pas
  // forcément été fabriqué par la version courante de cette fonction.
  const expiryReglementaire = situationExpiry(evidence, context.now, input.ttlDays)
  const horizonMs = horizon ? validDateMs(horizon.at) : null
  const expiresAt =
    horizonMs !== null && horizonMs < Date.parse(expiryReglementaire)
      ? new Date(horizonMs).toISOString()
      : expiryReglementaire

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
    // ⚠️ `max`, jamais un remplacement : une evidence récente ne doit pas
    // perdre l'urgence qu'elle justifie parce qu'une échéance est lointaine.
    // Le composant horizon ne peut qu'AJOUTER de l'urgence.
    urgency: Math.max(
      urgencyFromEvidence(evidence, context.now),
      horizon ? urgencyFromHorizon(horizon, context.now) : 0,
    ),
    rationale: input.rationale,
    rulePackId: input.rulePackId,
    rulePackVersion: input.rulePackVersion,
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    lensId: context.lensId,
    lensVersion: context.lensVersion,
    ...(horizon ? { anticipated: horizon } : {}),
    createdAt: nowIso,
    lastEvaluatedAt: nowIso,
    expiresAt,
  }
}
