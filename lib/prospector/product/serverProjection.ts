// PFV0-2A — PROJECTION SERVEUR GOUVERNÉE (LECTURE SEULE).
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// La COMPOSITION DE LECTURE côté serveur qui alimente les read models purs de
// PFV0-1 depuis la vérité intelligence RÉELLE (persistance proactive,
// monitoring, ancres canoniques). Zéro écriture, zéro HTTP, zéro UI :
// PFV0-2B exposera les routes après revue.
//
// ── AUTORISATION ≠ PROJECTION ───────────────────────────────────────────────
// Ce module NE résout NI acteur NI rôle : l'autorisation (`read:accounts`,
// JS-020) appartient à la frontière route/service — pattern monitoring/run.
// L'espace (`workspaceId`) lui est FOURNI par un appelant déjà passé par la
// résolution de tenant serveur. Toute lecture reste cloisonnée par espace via
// les primitives strictes existantes.
//
// ── WHAT CHANGED = COUCHE CANONIQUE/ÉVIDENCE, JAMAIS L'INTERPRÉTATION ───────
// `Situation.rationale`, `Situation.type` et `Recommendation.reason` ne
// deviennent JAMAIS `whatChanged`. Le changement factuel est résolu depuis les
// objets factuels existants : EvidenceEvent typé (voie situation) et ancres
// canoniques (voie monitoring), formatés DÉTERMINISTIQUEMENT sans conclusion
// domaine. Sans changement factuel résoluble : OMISSION, jamais d'invention.
//
// ── HORLOGES ────────────────────────────────────────────────────────────────
// Aucune horloge ici : la fenêtre `since/until` est FOURNIE par l'appelant
// (l'API future la définira). Les horloges comparées sont les horloges SOURCE
// existantes, chacune dans sa sémantique : `occurredAt` (événement daté),
// `observedAt` (état constaté), `finishedAt` (run de monitoring). Aucune
// n'est réinterprétée comme une autre.
import {
  isRecommendation,
  isSituation,
  listEvidenceStrict,
  PROACTIVE_KINDS,
} from '../proactive/persistence'
import type { EvidenceEvent, Recommendation, Situation } from '../proactive/types'
import {
  isCanonicalEvent,
  isCanonicalExecutiveEvent,
  isCanonicalStateSnapshot,
  readCanonicalEvent,
  readCanonicalStateSnapshot,
} from '../proactive/canonicalFact'
import { getItemStrict, listItemsStrict } from '../../supabase/store'
import { MONITORING_RUN_KIND, ACCOUNT_MONITOR_KIND } from '../monitoring/monitoringStore'
import type { AccountMonitorV0, MonitoringRunResultV0 } from '../monitoring/accountMonitor'
import {
  projectAttentionCandidatesV0,
  type AttentionCandidateV0,
  type MonitoringCandidateInputV0,
  type QualifyingSituationChangeV0,
  type RecommendationSourceV0,
} from './attentionCandidate'
import {
  buildCompanyWorkspaceViewV0,
  type CompanyWorkspaceViewV0,
  type WorkspaceDomainAssessmentV0,
  type WorkspaceEvidenceItemV0,
  type WorkspaceSituationSummaryV0,
} from './companyWorkspaceView'

// ── FENÊTRE DE LECTURE — FOURNIE, JAMAIS DÉDUITE ────────────────────────────

export interface ProjectionWindowV0 {
  /** Borne basse INCLUSE (ISO). Fournie par l'appelant — jamais Date.now ici. */
  readonly since: string
  /** Borne haute INCLUSE (ISO). */
  readonly until: string
}

function isIsoInstant(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 10 && Number.isFinite(Date.parse(v))
}

function isValidWindow(w: ProjectionWindowV0): boolean {
  return isIsoInstant(w.since) && isIsoInstant(w.until) && Date.parse(w.since) <= Date.parse(w.until)
}

function inWindow(clock: string, w: ProjectionWindowV0): boolean {
  const t = Date.parse(clock)
  return Number.isFinite(t) && t >= Date.parse(w.since) && t <= Date.parse(w.until)
}

function validWorkspace(ws: unknown): ws is string {
  return typeof ws === 'string' && ws.trim().length > 0
}

// ── RÉSULTATS TYPÉS — jamais d'erreur SDK brute sérialisée ──────────────────

export type ProjectionFailureReason = 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE'

export type TodayProjectionResultV0 =
  | { ok: true; candidates: readonly AttentionCandidateV0[] }
  | { ok: false; reason: ProjectionFailureReason }

export type CompanyWorkspaceProjectionResultV0 =
  | { ok: true; view: CompanyWorkspaceViewV0 }
  | { ok: false; reason: ProjectionFailureReason }

// ── FORMATAGE FACTUEL DÉTERMINISTE — SANS CONCLUSION DOMAINE ────────────────

/**
 * Représentation factuelle d'une évidence typée : type + valeur observée +
 * horloge SOURCE dans sa sémantique propre. Aucune phrase fabriquée, aucune
 * inférence (« la société grandit », « probable déménagement » : INTERDIT ici
 * — l'interprétation domaine vit dans ses champs dédiés).
 */
function formatEvidenceChange(e: EvidenceEvent): string {
  const valeur = e.value !== undefined ? ` = ${String(e.value)}` : ''
  const quand = e.temporality === 'dated_event'
    ? `événement du ${e.occurredAt}`
    : `état observé le ${e.observedAt}`
  return `${e.type}${valeur} (${quand})`
}

/** Représentation factuelle d'une ancre canonique — champs de l'ancre, rien d'autre. */
function formatAnchorChange(anchor: unknown): string | null {
  if (isCanonicalEvent(anchor)) {
    return `${anchor.type} (événement du ${anchor.occurredAt})`
  }
  if (isCanonicalExecutiveEvent(anchor)) {
    return `${anchor.type} — ${anchor.roleFunction} (événement du ${anchor.occurredAt})`
  }
  if (isCanonicalStateSnapshot(anchor)) {
    return `${anchor.type} (état observé le ${anchor.stateObservedDay})`
  }
  return null
}

// ── LECTURES SERVEUR CLOISONNÉES ────────────────────────────────────────────

/** Garde structurelle MINIMALE d'un run persisté — champs consommés ici. */
function isRunShape(v: any): v is MonitoringRunResultV0 {
  return v && typeof v === 'object'
    && typeof v.runId === 'string'
    && typeof v.monitorId === 'string'
    && typeof v.workspaceId === 'string'
    && typeof v.businessAssessment === 'string'
    && typeof v.finishedAt === 'string'
    && Array.isArray(v.canonicalRefsMaterial)
}

function isMonitorShape(v: any): v is AccountMonitorV0 {
  return v && typeof v === 'object'
    && typeof v.id === 'string'
    && typeof v.accountRef === 'string'
    && typeof v.workspaceId === 'string'
}

interface IntelligenceReads {
  evidence: EvidenceEvent[]
  situations: Situation[]
  recommendations: Recommendation[]
  runs: MonitoringRunResultV0[]
}

/**
 * Lecture STRICTE projection-locale — même doctrine que `listEvidenceStrict` :
 * « la base n'a pas répondu » ≠ « collection vide », et une ligne MALFORMÉE
 * fait échouer la lecture au lieu d'être écartée en silence (une ligne
 * corrompue relue comme « cet objet n'existe pas » est exactement la
 * confusion que la lecture stricte existe pour empêcher). VIDE reste VALIDE.
 */
async function listStrictOrFail<T>(
  kind: string,
  guard: (v: any) => v is T,
  ws: string,
): Promise<{ ok: true; values: T[] } | { ok: false }> {
  const lu = await listItemsStrict<any>(kind, ws)
  if (lu.ok === false) return { ok: false }
  if (!lu.values.every((v) => guard(v))) return { ok: false }
  return { ok: true, values: lu.values as T[] }
}

/**
 * Lit l'état intelligence d'UN espace — STRICT PARTOUT (PFV0-2A.1) :
 * évidence, runs, Situations ET Recommendations. Une indisponibilité ou une
 * ligne malformée sur N'IMPORTE laquelle de ces sources fait échouer la
 * projection entière (SOURCE_UNAVAILABLE) — jamais un succès qui présenterait
 * une panne comme une absence, ni une interprétation domaine silencieusement
 * manquante. Aucun mode dégradé, aucun repli.
 */
async function readIntelligence(ws: string): Promise<
  { ok: true; reads: IntelligenceReads } | { ok: false }
> {
  const evidence = await listEvidenceStrict(ws)
  if (evidence.ok === false) return { ok: false }
  const runsLus = await listStrictOrFail<MonitoringRunResultV0>(MONITORING_RUN_KIND, isRunShape, ws)
  if (runsLus.ok === false) return { ok: false }
  const situations = await listStrictOrFail<Situation>(PROACTIVE_KINDS.situation, isSituation, ws)
  if (situations.ok === false) return { ok: false }
  const recommendations = await listStrictOrFail<Recommendation>(
    PROACTIVE_KINDS.recommendation, isRecommendation, ws,
  )
  if (recommendations.ok === false) return { ok: false }
  return {
    ok: true,
    reads: {
      evidence: evidence.values,
      situations: situations.values,
      recommendations: recommendations.values,
      runs: runsLus.values,
    },
  }
}

// ── ADMISSION SITUATION — CHANGEMENT FACTUEL DANS LA FENÊTRE ────────────────

/**
 * Une Situation N'EST PAS automatiquement « à l'attention » : elle ne
 * qualifie que si AU MOINS une évidence qu'elle cite porte un changement
 * factuel dont l'horloge SOURCE tombe dans la fenêtre demandée.
 *   - `changeRef` = l'id de l'évidence factuelle (référence canonique la plus
 *     précise existante) — jamais l'id de Situation, jamais un id aléatoire ;
 *   - plusieurs évidences qualifiantes ⇒ PLUSIEURS changements qualifiants
 *     pour la même Situation (identités distinctes, PFV0-1.1) ;
 *   - aucune sélection « première / plus confiante » : TOUTES les évidences
 *     citées qualifiantes produisent chacune leur changement ;
 *   - rien de résoluble dans la fenêtre ⇒ OMISSION.
 */
function qualifyingChangesFor(
  situation: Situation,
  evidenceById: ReadonlyMap<string, EvidenceEvent>,
  window: ProjectionWindowV0,
): QualifyingSituationChangeV0[] {
  const sorties: QualifyingSituationChangeV0[] = []
  for (const evidenceId of situation.evidenceIds) {
    const e = evidenceById.get(evidenceId)
    if (!e) continue
    // Cloisonnement de COMPTE : une évidence citée qui n'appartient pas au
    // compte de la Situation est un lien incohérent — fail closed, exclue.
    if (e.accountId !== situation.accountId) continue
    const horlogeSource = e.temporality === 'dated_event' ? e.occurredAt : e.observedAt
    if (!inWindow(horlogeSource, window)) continue
    sorties.push({
      situation: {
        id: situation.id,
        accountId: situation.accountId,
        type: situation.type,
        evidenceIds: situation.evidenceIds,
        rationale: situation.rationale,
        lastEvaluatedAt: situation.lastEvaluatedAt,
      },
      changeRef: e.id,
      whatChanged: formatEvidenceChange(e),
      observedAt: e.observedAt,
    })
  }
  return sorties
}

// ── ADMISSION MONITORING — FAIT MATÉRIEL RÉSOLUBLE ──────────────────────────

/**
 * Un run MATERIAL_CHANGE_FOUND ne devient une entrée candidate QUE si :
 *   - son moniteur (accountRef canonique) est lisible dans CET espace ;
 *   - au moins une ancre canonique matérielle est résoluble ET appartient au
 *     compte du moniteur (cloisonnement de compte, fail closed) ;
 * sinon : OMISSION — jamais `MATERIAL_CHANGE_FOUND` comme whatChanged.
 */
async function monitoringInputFor(
  run: MonitoringRunResultV0,
  ws: string,
  monitorCache: Map<string, AccountMonitorV0 | null>,
): Promise<MonitoringCandidateInputV0 | null> {
  if (run.businessAssessment !== 'MATERIAL_CHANGE_FOUND') return null
  if (!monitorCache.has(run.monitorId)) {
    const lu = await getItemStrict<any>(ACCOUNT_MONITOR_KIND, run.monitorId, ws)
    monitorCache.set(run.monitorId, lu.ok === true && isMonitorShape(lu.value) ? lu.value : null)
  }
  const monitor = monitorCache.get(run.monitorId)
  if (!monitor) return null

  const descriptions: string[] = []
  for (const ref of run.canonicalRefsMaterial) {
    if (typeof ref !== 'string') continue
    const lu = ref.startsWith('csn_')
      ? await readCanonicalStateSnapshot(ref, ws)
      : await readCanonicalEvent(ref, ws)
    if (lu.ok !== true || lu.value === null) continue
    const ancre: any = lu.value
    if (ancre.accountId !== monitor.accountRef) continue
    const texte = formatAnchorChange(ancre)
    if (texte !== null) descriptions.push(texte)
  }
  if (descriptions.length === 0) return null

  return {
    run: {
      runId: run.runId,
      businessAssessment: run.businessAssessment,
      canonicalRefsMaterial: run.canonicalRefsMaterial,
      finishedAt: run.finishedAt,
    },
    accountRef: monitor.accountRef,
    whatChanged: descriptions.sort().join(' ; '),
  }
}

function toRecommendationSource(r: Recommendation): RecommendationSourceV0 {
  return {
    id: r.id,
    situationId: r.situationId,
    decision: r.decision,
    reason: r.reason,
    whyNow: r.whyNow,
    ...(r.play !== undefined ? { play: r.play } : {}),
    ...(r.recommendedAction !== undefined ? { recommendedAction: r.recommendedAction } : {}),
  }
}

async function buildCandidates(
  reads: IntelligenceReads,
  ws: string,
  window: ProjectionWindowV0,
  accountFilter?: string,
): Promise<readonly AttentionCandidateV0[]> {
  const evidenceById = new Map(reads.evidence.map((e) => [e.id, e] as const))
  const situations = accountFilter
    ? reads.situations.filter((s) => s.accountId === accountFilter)
    : reads.situations
  const qualifying: QualifyingSituationChangeV0[] = []
  for (const s of situations) qualifying.push(...qualifyingChangesFor(s, evidenceById, window))

  const monitorCache = new Map<string, AccountMonitorV0 | null>()
  const monitoring: MonitoringCandidateInputV0[] = []
  for (const run of reads.runs) {
    if (!inWindow(run.finishedAt, window)) continue
    const input = await monitoringInputFor(run, ws, monitorCache)
    if (input === null) continue
    if (accountFilter && input.accountRef !== accountFilter) continue
    monitoring.push(input)
  }

  return projectAttentionCandidatesV0({
    qualifyingSituationChanges: qualifying,
    recommendations: reads.recommendations.map(toRecommendationSource),
    monitoring,
  })
}

// ── PROJECTION « TODAY » ────────────────────────────────────────────────────

export async function buildTodayProjectionV0(input: {
  workspaceId: string
  window: ProjectionWindowV0
}): Promise<TodayProjectionResultV0> {
  if (!validWorkspace(input.workspaceId) || !isValidWindow(input.window)) {
    return { ok: false, reason: 'INVALID_INPUT' }
  }
  const lu = await readIntelligence(input.workspaceId)
  if (lu.ok === false) return { ok: false, reason: 'SOURCE_UNAVAILABLE' }
  const candidates = await buildCandidates(lu.reads, input.workspaceId, input.window)
  return { ok: true, candidates }
}

// ── PROJECTION « COMPANY WORKSPACE » ────────────────────────────────────────

/** Identité de compte CANONIQUE — chaîne bornée, jamais un nom, jamais un lead. */
function isValidAccountId(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  // eslint-disable-next-line no-control-regex
  return t.length > 0 && t.length <= 200 && t === v && !/[ -\n]/.test(v)
}

export async function buildCompanyWorkspaceProjectionV0(input: {
  workspaceId: string
  accountId: string
  window: ProjectionWindowV0
}): Promise<CompanyWorkspaceProjectionResultV0> {
  if (!validWorkspace(input.workspaceId) || !isValidAccountId(input.accountId) || !isValidWindow(input.window)) {
    return { ok: false, reason: 'INVALID_INPUT' }
  }
  const lu = await readIntelligence(input.workspaceId)
  if (lu.ok === false) return { ok: false, reason: 'SOURCE_UNAVAILABLE' }
  const { reads } = lu
  const accountId = input.accountId

  // CLOISONNEMENT DE COMPTE : chaque section ne contient QUE ce compte.
  const situations = reads.situations.filter((s) => s.accountId === accountId)
  const evidence = reads.evidence.filter((e) => e.accountId === accountId)

  const recentChanges = await buildCandidates(reads, input.workspaceId, input.window, accountId)

  const currentSituations: WorkspaceSituationSummaryV0[] = situations.map((s) => ({
    situationRef: s.id,
    situationType: s.type,
    rationale: s.rationale,
    evidenceRefs: s.evidenceIds,
    observedAt: s.lastEvaluatedAt,
  }))

  const evidenceItems: WorkspaceEvidenceItemV0[] = evidence.map((e) => ({
    evidenceRef: e.id,
    label: formatEvidenceChange(e),
    observedAt: e.observedAt,
  }))

  // Verdicts de monitoring du COMPTE — transportés tels quels, tous verdicts.
  const monitorCache = new Map<string, AccountMonitorV0 | null>()
  const domainAssessments: WorkspaceDomainAssessmentV0[] = []
  for (const run of reads.runs) {
    if (!monitorCache.has(run.monitorId)) {
      const m = await getItemStrict<any>(ACCOUNT_MONITOR_KIND, run.monitorId, input.workspaceId)
      monitorCache.set(run.monitorId, m.ok === true && isMonitorShape(m.value) ? m.value : null)
    }
    const monitor = monitorCache.get(run.monitorId)
    if (!monitor || monitor.accountRef !== accountId) continue
    domainAssessments.push({
      runRef: run.runId,
      businessAssessment: run.businessAssessment,
      observedAt: run.finishedAt,
    })
  }

  // Sections sans producteur canonique aujourd'hui : ABSENTES, jamais
  // fabriquées — people, businessContext, missions, counterSignals.
  // organizationName : aucun registre Organization canonique — absent (§17).
  const view = buildCompanyWorkspaceViewV0({
    organizationRef: accountId,
    currentSituations,
    recentChanges,
    evidence: evidenceItems,
    domainAssessments,
  })
  return { ok: true, view }
}
