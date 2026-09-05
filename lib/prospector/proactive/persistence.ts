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
// ── ÉTAT MATÉRIALISÉ, PAS DECISION LEDGER ───────────────────────────────────
// ⚠️ À NE PAS CONFONDRE, ET LA CONFUSION SERAIT COÛTEUSE. La clé primaire
// `(kind, id, workspace_id)` fait qu'une réécriture du MÊME identifiant
// REMPLACE la ligne. C'est précisément ce qui donne l'idempotence — réévaluer
// trois fois ne crée pas trois recommandations — et c'est exactement ce qui
// interdit d'y lire un historique : la valeur précédente n'existe plus.
//
// Ce module offre donc « le dernier état connu », jamais « ce qui a été décidé
// le 12 mars ». Une auditabilité historique exige un journal append-only, qui
// n'existe PAS dans ce dépôt. Le prétendre reviendrait à promettre une preuve
// que la base ne peut pas produire.
//
// ── CE MODULE N'EST PAS UNE ROUTE ───────────────────────────────────────────
// Il ne lit aucune requête HTTP et ne résout aucun tenant. L'espace lui est
// FOURNI par un appelant qui, lui, est passé par `resolveTenantFromRequest`.
// C'est ce qui rend impossible qu'un identifiant d'espace vienne du corps de la
// requête ou de la query.
import {
  listItems,
  listItemsStrict,
  getItemStrict,
  upsertItem,
  deleteItem,
  type StrictRead,
} from '../../supabase/store'
// ⚠️ LES GARDES DE FORME VIVENT DANS `validators.ts` — module PUR, sans I/O.
// Elles sont RÉEXPORTÉES ici parce que du code et des tests les importent
// depuis cette couche depuis JARVIS-PROACTIVE-01D. La définition, elle, est
// unique : le runner d'évaluation applique les mêmes, sans passer par Supabase.
export {
  isEvidenceEvent,
  isSituation,
  isRecommendation,
  isOutcome,
} from './validators'
import {
  isEvidenceEvent,
  isSituation,
  isRecommendation,
  isOutcome,
  nonEmpty,
} from './validators'
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
  // savoir plutôt que l'ignorer.
  //
  // ⚠️ CORRECTION (R1c) — L'ANCIENNE JUSTIFICATION ÉTAIT FAUSSE. On lisait ici
  // que l'indulgence était sans danger « parce que l'échec va dans le sens
  // fermé : moins de situations ». C'est INEXACT dès qu'un pack ARBITRE entre
  // plusieurs situations. Avec `sales-core`, un fait historique manquant ne
  // retire pas seulement `sales_scale_up` : il fait BASCULER l'arbitrage vers
  // `strong_signal_low_context`. Une panne de lecture change alors la
  // RECOMMANDATION, elle ne se contente pas d'en supprimer une. Moins de
  // données n'est pas la même chose qu'un résultat plus prudent.
  //
  // Cette fonction reste indulgente pour ses appelants d'affichage, où lire
  // « rien pour l'instant » est acceptable. Tout appelant qui RAISONNE sur
  // l'absence doit utiliser `listEvidenceStrict` — voir plus bas.
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

/**
 * Faits persistés d'un espace, avec la distinction « vide » / « injoignable ».
 *
 * ⚠️ À UTILISER DÈS QUE L'ABSENCE CHANGE UNE DÉCISION. `listEvidence` rend `[]`
 * dans les deux cas ; interpréter une panne de stockage comme « zéro fait
 * historique » fait produire une conclusion à partir d'une ignorance. Les
 * règles de `sales-core` arbitrent entre situations concurrentes : l'historique
 * manquant y change la recommandation émise, il ne la retire pas.
 *
 * ⚠️ UNE LIGNE MALFORMÉE FAIT ÉCHOUER LA LECTURE — elle n'est PAS écartée en
 * silence. Une version antérieure appliquait `.filter(isEvidenceEvent)` et
 * rendait `ok: true` : une ligne corrompue devenait alors « ce fait n'existe
 * pas », c'est-à-dire exactement la confusion que cette fonction existe pour
 * empêcher, une couche plus bas. La lecture est stricte au TRANSPORT et au
 * CONTENU, sans quoi elle n'est stricte qu'à moitié.
 *
 * Conséquence assumée : une seule ligne abîmée bloque le raisonnement sur tout
 * l'espace. C'est le bon sens de l'échec — refuser de conclure plutôt que
 * conclure à partir d'un historique dont on sait qu'il est incomplet.
 *
 * `reason` distingue les deux causes : `unavailable` se réessaie, `invalid`
 * demande une réparation. Les confondre enverrait attendre au lieu d'agir.
 */
export async function listEvidenceStrict(
  ws: string,
): Promise<
  | { ok: true; values: EvidenceEvent[] }
  | { ok: false; reason: 'invalid' | 'unavailable' }
> {
  if (!validWorkspace(ws)) return { ok: false, reason: 'unavailable' }
  const lu = await listItemsStrict<any>(PROACTIVE_KINDS.evidence, ws)
  if (lu.ok === false) return { ok: false, reason: 'unavailable' }
  if (!lu.values.every((item) => isEvidenceEvent(item))) return { ok: false, reason: 'invalid' }
  return { ok: true, values: lu.values as EvidenceEvent[] }
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
