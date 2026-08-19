// JARVIS-PROACTIVE-01D
// Persistance du Decision Model.
//
// ── CE QUE CETTE COUCHE EST ─────────────────────────────────────────────────
// Un adaptateur MINCE au-dessus de `lib/supabase/store`. Elle ne crée ni base,
// ni table, ni mécanisme : `prospector_store (kind, id, workspace_id, data)`
// existe déjà, sa clé primaire est exactement `(kind, id, workspace_id)`, et
// c'est elle qui porte à la fois le cloisonnement par espace et l'idempotence.
//
// ── POURQUOI RÉUTILISER PLUTÔT QUE CRÉER ────────────────────────────────────
// Un second mécanisme de persistance, c'est un second endroit où l'isolation
// par workspace peut être oubliée. Le magasin existant applique déjà
// `writeAllowed()` à chaque écriture, exige `ws` à chaque appel, et n'a aucun
// chemin qui traverse les espaces. Tout ce que ce module a à faire, c'est de ne
// pas contourner cela.
//
// ── L'ESPACE EST TOUJOURS EXIGÉ, JAMAIS DEVINÉ ──────────────────────────────
// Aucune fonction ici n'a de valeur par défaut pour `ws`. Un identifiant vide
// est refusé, il n'est pas remplacé par « admin » ni par un espace système : la
// doctrine MT-0 a fermé exactement ce repli ailleurs dans le dépôt, et une
// couche de persistance ne doit pas le rouvrir par commodité.
//
// ── CE MODULE N'EST PAS UNE ROUTE ───────────────────────────────────────────
// Il ne lit aucune requête HTTP et ne résout aucun tenant. L'espace lui est
// FOURNI par un appelant qui, lui, est passé par `resolveTenantFromRequest`.
// C'est ce qui rend impossible qu'un identifiant d'espace vienne du corps de la
// requête ou de la query.
import {
  listItems,
  getItemStrict,
  upsertItem,
  deleteItem,
  type StrictRead,
} from '../../supabase/store'
import type {
  EvidenceEvent,
  Outcome,
  Recommendation,
  Situation,
} from './types'

/**
 * Les quatre `kind` du Decision Model.
 *
 * Préfixés `proactive_` pour une raison précise : le magasin est partagé avec
 * `sequence`, `task`, `thread`, `list`, `mission`, `notification`. Un nom court
 * comme `evidence` finirait par entrer en collision avec un usage futur, et une
 * collision de `kind` dans un magasin clé/valeur, c'est deux jeux de données qui
 * se mélangent sans que rien ne l'annonce.
 */
export const PROACTIVE_KINDS = {
  evidence: 'proactive_evidence',
  situation: 'proactive_situation',
  recommendation: 'proactive_recommendation',
  outcome: 'proactive_outcome',
} as const

export type ProactiveKind =
  typeof PROACTIVE_KINDS[keyof typeof PROACTIVE_KINDS]

export const PROACTIVE_KIND_LIST: readonly ProactiveKind[] = [
  PROACTIVE_KINDS.evidence,
  PROACTIVE_KINDS.situation,
  PROACTIVE_KINDS.recommendation,
  PROACTIVE_KINDS.outcome,
]

export function isProactiveKind(value: string): value is ProactiveKind {
  return (PROACTIVE_KIND_LIST as readonly string[]).includes(value)
}

/**
 * Issue d'une écriture.
 *
 * `denied` couvre tout ce qui n'est pas un succès clair : espace absent, objet
 * invalide, environnement interdit en écriture, base injoignable. Les
 * distinguer n'aiderait aucun appelant — aucun de ces cas n'est un succès — et
 * offrirait un oracle sur la configuration.
 */
export type ProactiveWrite = { ok: true } | { ok: false; reason: 'denied' }

const DENIED: ProactiveWrite = { ok: false, reason: 'denied' }
const OK: ProactiveWrite = { ok: true }

function validWorkspace(ws: unknown): ws is string {
  return typeof ws === 'string' && ws.trim().length > 0
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function optionalDate(value: unknown): boolean {
  return value === undefined || validDate(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmpty(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmpty(item))
}

/**
 * ── POURQUOI REVALIDER À LA LECTURE ─────────────────────────────────────────
 * Une ligne relue est une ENTRÉE, pas une valeur de confiance. Elle vient d'un
 * processus distant, elle a pu être écrite par une version antérieure du code,
 * et `data` est un `jsonb` que rien ne contraint côté base. Faire confiance à sa
 * forme reviendrait à laisser un objet arbitraire entrer dans le moteur de
 * décision — lequel calcule ensuite des scores et des dates à partir de ces
 * champs. Un objet invalide est donc IGNORÉ, jamais réparé ni complété.
 */
export function isEvidenceEvent(value: any): value is EvidenceEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.scope) &&
    nonEmpty(value.type) &&
    !!value.source &&
    typeof value.source === 'object' &&
    nonEmpty(value.source.provider) &&
    nonEmpty(value.assertionType) &&
    validScore(value.confidence) &&
    validDate(value.observedAt) &&
    optionalDate(value.lastVerifiedAt) &&
    optionalDate(value.expiresAt) &&
    temporaliteCoherente(value)
  )
}

/**
 * INVARIANTS TEMPORELS — vérifiés à l'écriture ET à la lecture.
 *
 * ⚠️ AUCUNE VALEUR PAR DÉFAUT. Une temporalité absente est INVALIDE, elle n'est
 * jamais promue en `dated_event`. C'était le fail-open de la première version :
 * une ingestion qui oublie le champ verrait ses evidences devenir des événements
 * datés, donc porteuses d'urgence, sans que personne ne l'ait décidé.
 *
 *   `dated_event`   ⇒ `occurredAt` présent ET valide.
 *   `undated_state` ⇒ `occurredAt` ABSENT. Une date de survenue sur un état non
 *                     daté est une contradiction : on la refuse plutôt que de
 *                     l'ignorer, sans quoi elle finirait par être lue quelque
 *                     part.
 */
function temporaliteCoherente(value: any): boolean {
  if (value.temporality === 'dated_event') return validDate(value.occurredAt)
  if (value.temporality === 'undated_state') return value.occurredAt === undefined
  return false
}

export function isSituation(value: any): value is Situation {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.type) &&
    stringArray(value.evidenceIds) &&
    validScore(value.confidence) &&
    validScore(value.relevance) &&
    validScore(value.urgency) &&
    typeof value.rationale === 'string' &&
    nonEmpty(value.ruleId) &&
    nonEmpty(value.ruleVersion) &&
    validDate(value.createdAt) &&
    validDate(value.lastEvaluatedAt) &&
    optionalDate(value.expiresAt)
  )
}

export function isRecommendation(value: any): value is Recommendation {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.situationId) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    (value.decision === 'recommend' || value.decision === 'no_action') &&
    typeof value.reason === 'string' &&
    typeof value.whyNow === 'string' &&
    (value.priority === 'low' || value.priority === 'medium' || value.priority === 'high') &&
    validScore(value.confidence) &&
    optionalString(value.play) &&
    optionalString(value.recommendedAction) &&
    nonEmpty(value.ruleId) &&
    nonEmpty(value.ruleVersion) &&
    validDate(value.createdAt) &&
    optionalDate(value.expiresAt) &&
    // Un `no_action` qui porte un play serait contradictoire : il annoncerait
    // une action tout en déclarant n'en recommander aucune.
    (value.decision === 'recommend' || (value.play === undefined && value.recommendedAction === undefined))
  )
}

export function isOutcome(value: any): value is Outcome {
  return (
    !!value &&
    typeof value === 'object' &&
    nonEmpty(value.id) &&
    nonEmpty(value.recommendationId) &&
    nonEmpty(value.accountId) &&
    optionalString(value.personId) &&
    nonEmpty(value.type) &&
    (value.note === undefined || typeof value.note === 'string') &&
    validDate(value.occurredAt)
  )
}

type Guard<T> = (value: any) => value is T

async function save<T extends { id: string }>(
  kind: ProactiveKind,
  guard: Guard<T>,
  item: T,
  ws: string,
): Promise<ProactiveWrite> {
  if (!validWorkspace(ws)) return DENIED
  // On valide AVANT d'écrire : un objet malformé ne doit pas exister en base,
  // sans quoi la validation de lecture ne ferait que masquer un défaut au lieu
  // de l'empêcher.
  if (!guard(item)) return DENIED
  // `upsertItem` applique `writeAllowed()` et écrit sur la clé primaire
  // (kind, id, workspace_id) : réécrire le même identifiant REMPLACE la ligne,
  // il n'en crée jamais une seconde. C'est de là que vient l'idempotence.
  return (await upsertItem(kind, item.id, item, ws)) ? OK : DENIED
}

async function readOne<T>(
  kind: ProactiveKind,
  guard: Guard<T>,
  id: string,
  ws: string,
): Promise<StrictRead<T>> {
  if (!validWorkspace(ws) || !nonEmpty(id)) return { ok: false }
  // ⚠️ LECTURE STRICTE. `getItem` rend `null` aussi bien pour « absent » que
  // pour « base muette » ; cette confusion a déjà produit un fail-open dans ce
  // dépôt (SEC-EXT-0.1). Ici, un appelant qui ne sait pas si une recommandation
  // existe ne doit surtout pas conclure qu'elle n'existe pas.
  const read = await getItemStrict<any>(kind, id, ws)
  if (!read.ok) return { ok: false }
  if (read.value === null) return { ok: true, value: null }
  return guard(read.value) ? { ok: true, value: read.value } : { ok: true, value: null }
}

async function readAll<T>(
  kind: ProactiveKind,
  guard: Guard<T>,
  ws: string,
): Promise<T[]> {
  if (!validWorkspace(ws)) return []
  // ⚠️ `listItems` est INDULGENT : il rend `[]` sur erreur comme sur collection
  // vide. Cette couche ne peut donc pas distinguer les deux, et il faut le
  // savoir plutôt que l'ignorer. C'est acceptable ICI parce que la conséquence
  // d'une liste vide est l'ABSENCE de situation et donc de recommandation :
  // l'échec va dans le sens fermé.
  //
  // Ce raisonnement ne se transporte PAS aux données dont l'absence AUTORISE
  // quelque chose. C'est exactement pourquoi `dataBridge` refuse de lire les
  // tâches lui-même et exige un instantané dont la complétude est prouvée.
  const items = await listItems<any>(kind, ws)
  return items.filter((item) => guard(item))
}

// ── Evidence ────────────────────────────────────────────────────────────────

export function saveEvidence(item: EvidenceEvent, ws: string) {
  return save(PROACTIVE_KINDS.evidence, isEvidenceEvent, item, ws)
}

export function readEvidence(id: string, ws: string) {
  return readOne<EvidenceEvent>(PROACTIVE_KINDS.evidence, isEvidenceEvent, id, ws)
}

export function listEvidence(ws: string) {
  return readAll<EvidenceEvent>(PROACTIVE_KINDS.evidence, isEvidenceEvent, ws)
}

/** Écrit un lot et rend le nombre d'objets réellement persistés. */
export async function saveEvidenceBatch(items: EvidenceEvent[], ws: string): Promise<number> {
  let saved = 0
  for (const item of items) {
    if ((await saveEvidence(item, ws)).ok) saved++
  }
  return saved
}

// ── Situation ───────────────────────────────────────────────────────────────

export function saveSituation(item: Situation, ws: string) {
  return save(PROACTIVE_KINDS.situation, isSituation, item, ws)
}

export function readSituation(id: string, ws: string) {
  return readOne<Situation>(PROACTIVE_KINDS.situation, isSituation, id, ws)
}

export function listSituations(ws: string) {
  return readAll<Situation>(PROACTIVE_KINDS.situation, isSituation, ws)
}

// ── Recommendation ──────────────────────────────────────────────────────────

export function saveRecommendation(item: Recommendation, ws: string) {
  return save(PROACTIVE_KINDS.recommendation, isRecommendation, item, ws)
}

export function readRecommendation(id: string, ws: string) {
  return readOne<Recommendation>(PROACTIVE_KINDS.recommendation, isRecommendation, id, ws)
}

export function listRecommendations(ws: string) {
  return readAll<Recommendation>(PROACTIVE_KINDS.recommendation, isRecommendation, ws)
}

// ── Outcome ─────────────────────────────────────────────────────────────────

export function saveOutcome(item: Outcome, ws: string) {
  return save(PROACTIVE_KINDS.outcome, isOutcome, item, ws)
}

export function readOutcome(id: string, ws: string) {
  return readOne<Outcome>(PROACTIVE_KINDS.outcome, isOutcome, id, ws)
}

export function listOutcomes(ws: string) {
  return readAll<Outcome>(PROACTIVE_KINDS.outcome, isOutcome, ws)
}

/**
 * Suppression ciblée — réservée à l'entretien.
 *
 * Aucune purge de masse n'est exposée : effacer l'historique de décision d'un
 * espace entier n'est pas une opération que le moteur doit pouvoir déclencher.
 */
export async function deleteProactiveItem(
  kind: ProactiveKind,
  id: string,
  ws: string,
): Promise<boolean> {
  if (!validWorkspace(ws) || !nonEmpty(id) || !isProactiveKind(kind)) return false
  return deleteItem(kind, id, ws)
}
