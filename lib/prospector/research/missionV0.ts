// RESEARCH_MISSION_ARTIFACT_V0_001 — MISSION DE RECHERCHE, V0 MANUELLE.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// Le plus petit socle durable pour :
//
//   RESEARCH MISSION (intention utilisateur, immuable)
//     → brief de recherche DÉTERMINISTE (à copier dans un outil externe)
//     → exécution MANUELLE hors Prospector
//     → import d'un ResearchArtifact brut (module voisin)
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// Ni agent autonome, ni intégration fournisseur, ni compilateur LLM, ni
// producteur de SignalHit/Candidate/Evidence/SourceAssertion/CanonicalFact,
// ni Situation, ni Jarvis. AUCUN appel réseau, aucun coût.
//
// ── FRONTIÈRE SÉMANTIQUE ────────────────────────────────────────────────────
// La spécification décrit une INTENTION, jamais des faits d'entreprise. Son
// identité n'est PAS une identité factuelle : aucun identifiant de
// revendication, d'assertion ou d'ancre n'est réutilisé ici.
//
// ── CYCLE DE VIE V0 ─────────────────────────────────────────────────────────
// IMMUABLE. Une spécification modifiée est une NOUVELLE mission — jamais une
// réécriture. Aucun statut RUNNING/PAUSED/COMPLETE, aucun ordonnanceur :
// cela appartient au futur Mission Engine automatisé.
import { createHash } from 'node:crypto'

import { canonicalJson } from '../proactive/acquisitionV2'
import { isStrictInstant } from '../proactive/types'
import { getItemStrict, insertItemIfAbsent } from '../../supabase/store'

/** `kind` du magasin — SERVEUR UNIQUEMENT, absent de toute liste blanche navigateur. */
export const RESEARCH_MISSION_KIND = 'prospector_research_mission'

export const RESEARCH_MISSION_CONTRACT = 'research-mission-v0'
export const RESEARCH_BRIEF_VERSION = 'research-brief-v0'
/** Borne haute EXPLICITE et conservatrice du nombre d'entreprises visées. */
export const TARGET_COUNT_MAX = 200
const FRESHNESS_DAYS_MAX = 730

const FAMILLES = Object.freeze(['FUNDING', 'EXECUTIVE_CHANGE', 'HIRING_SNAPSHOT'] as const)
const MODES_COUVERTURE = Object.freeze(['EXPLORATORY', 'SYSTEMATIC'] as const)

export type ResearchSignalFamily = (typeof FAMILLES)[number]
export type ResearchCoverageMode = (typeof MODES_COUVERTURE)[number]

export interface ResearchMissionScopeV0 {
  location?: string
  sector?: string
  employeeMin?: number
  employeeMax?: number
  freshnessDays?: number
  keywords?: string[]
}

export interface ResearchMissionSpecV0 {
  contractVersion: 'research-mission-v0'
  thesis: string
  coverageMode: ResearchCoverageMode
  targetCount: number
  signalFamilies: ResearchSignalFamily[]
  scope: ResearchMissionScopeV0
}

export interface ResearchMissionV0 {
  id: string
  workspaceId: string
  contractVersion: 'research-mission-v0'
  spec: ResearchMissionSpecV0
  specHash: string
  createdAt: string
  briefVersion: 'research-brief-v0'
  researchBrief: string
  /** V0 : l'outil de recherche externe est CHOISI PAR L'UTILISATEUR. */
  executionMode: 'MANUAL_PREMIUM_RESEARCH'
}

// ── VALIDATION — ENSEMBLES DE CLÉS CLOS, REJET EXPLICITE ────────────────────
// Aucune clé inconnue acceptée en silence, aucune réparation d'entrée
// malformée : l'intention de l'utilisateur se rejette ou se prend telle quelle.

function clesCloses(obj: Record<string, unknown>, requises: readonly string[], optionnelles: readonly string[] = []): boolean {
  for (const k of requises) if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  for (const k of Object.keys(obj)) {
    if (requises.indexOf(k) === -1 && optionnelles.indexOf(k) === -1) return false
  }
  return true
}
const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const entier = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

export function isResearchMissionSpecV0(v: unknown): v is ResearchMissionSpecV0 {
  if (!objet(v)) return false
  if (!clesCloses(v, ['contractVersion', 'thesis', 'coverageMode', 'targetCount', 'signalFamilies', 'scope'])) return false
  if (v.contractVersion !== RESEARCH_MISSION_CONTRACT) return false
  if (typeof v.thesis !== 'string' || v.thesis.trim() === '' || v.thesis !== v.thesis.trim()) return false
  if (!(MODES_COUVERTURE as readonly unknown[]).includes(v.coverageMode)) return false
  if (!entier(v.targetCount) || v.targetCount < 1 || v.targetCount > TARGET_COUNT_MAX) return false

  const familles = v.signalFamilies
  if (!Array.isArray(familles) || familles.length === 0) return false
  if (new Set(familles).size !== familles.length) return false
  for (const f of familles) if (!(FAMILLES as readonly unknown[]).includes(f)) return false

  const s = v.scope
  if (!objet(s)) return false
  if (!clesCloses(s, [], ['location', 'sector', 'employeeMin', 'employeeMax', 'freshnessDays', 'keywords'])) return false
  for (const champ of ['location', 'sector'] as const) {
    if (s[champ] !== undefined && (typeof s[champ] !== 'string' || (s[champ] as string).trim() === '')) return false
  }
  for (const champ of ['employeeMin', 'employeeMax'] as const) {
    if (s[champ] !== undefined && (!entier(s[champ]) || (s[champ] as number) < 0)) return false
  }
  if (s.employeeMin !== undefined && s.employeeMax !== undefined
    && (s.employeeMin as number) > (s.employeeMax as number)) return false
  if (s.freshnessDays !== undefined
    && (!entier(s.freshnessDays) || (s.freshnessDays as number) < 1 || (s.freshnessDays as number) > FRESHNESS_DAYS_MAX)) return false
  if (s.keywords !== undefined) {
    if (!Array.isArray(s.keywords) || s.keywords.length === 0) return false
    for (const k of s.keywords) if (typeof k !== 'string' || k.trim() === '') return false
  }
  return true
}

// ── IDENTITÉ — INTÉGRITÉ DÉRIVÉE CÔTÉ SERVEUR, JAMAIS FACTUELLE ─────────────

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

/** Condensat COMPLET du JSON canonique de la spécification validée. */
export function researchSpecHash(spec: ResearchMissionSpecV0): string {
  return sha256(canonicalJson(spec))
}

/**
 * Identité de mission : espace + instant serveur + condensat de spec.
 * Le même contenu au même instant dans DEUX espaces rend DEUX identités.
 */
export function researchMissionId(workspaceId: string, createdAt: string, specHash: string): string {
  return `rm_${sha256(`research-mission:v0:${workspaceId}\n${createdAt}\n${specHash}`).slice(0, 32)}`
}

// ── BRIEF DE RECHERCHE — PUR, DÉTERMINISTE, VERSIONNÉ ───────────────────────
//
// ⚠️ Le brief demande de la RECHERCHE, jamais de la vérité canonique. Il
// n'exige AUCUN identifiant, condensat, clé de personne, montant en centimes
// ni score de confiance : ces valeurs appartiennent au code déterministe de
// Prospector, pas à un outil externe.

export function buildResearchBrief(spec: ResearchMissionSpecV0): string {
  const familles = spec.signalFamilies.map((f) => `- ${f}`).join('\n')
  const s = spec.scope
  const portee = [
    s.location ? `- Géographie cible : ${s.location}` : null,
    s.sector ? `- Secteur : ${s.sector}` : null,
    s.employeeMin !== undefined || s.employeeMax !== undefined
      ? `- Effectif : ${s.employeeMin ?? 0} à ${s.employeeMax ?? 'illimité'} employés`
      : null,
    s.freshnessDays !== undefined ? `- Fenêtre de fraîcheur : ${s.freshnessDays} derniers jours` : null,
    s.keywords && s.keywords.length > 0 ? `- Mots-clés : ${s.keywords.join(', ')}` : null,
  ].filter(Boolean).join('\n')

  return `# BRIEF DE RECHERCHE (${RESEARCH_BRIEF_VERSION})

## Objectif
${spec.thesis}

## Couverture
${spec.coverageMode === 'SYSTEMATIC'
    ? 'SYSTÉMATIQUE — balayer méthodiquement le périmètre ; signaler explicitement les zones non couvertes.'
    : 'EXPLORATOIRE — privilégier les signaux les plus nets du périmètre.'}
Nombre d'entreprises visé : ${spec.targetCount}.

## Périmètre
${portee || '- (aucune contrainte de périmètre)'}

## Familles factuelles demandées
${familles}

## RÈGLES DE RECHERCHE — NON NÉGOCIABLES
- Entreprises RÉELLES uniquement ; aucune entreprise inventée ou composite.
- Pour CHAQUE affirmation : l'URL de la source.
- Donner la DATE DE PUBLICATION de la source quand elle est connue.
- Donner la DATE DE L'ÉVÉNEMENT MÉTIER SÉPARÉMENT de la date de publication —
  ce sont deux dates différentes, ne jamais substituer l'une à l'autre.
- N'inventer AUCUNE date : une date inconnue s'écrit « inconnue ».
- N'inventer AUCUN montant de levée : recopier la chaîne publiée, sinon « inconnu ».
- N'inventer AUCUN décompte de postes : uniquement un nombre énoncé par la source.
- Distinguer un ÉTAT ACTUEL (poste ouvert aujourd'hui) d'un ÉVÉNEMENT DATÉ
  (levée bouclée, nomination).
- Marquer clairement toute information INCONNUE — ne jamais combler.
- CONSERVER les désaccords entre sources ; ne pas arbitrer, ne pas lisser.
- « Rien trouvé » n'est PAS la preuve qu'aucun signal n'existe — le dire tel quel.
- Privilégier les sources PRIMAIRES / officielles / de l'entreprise quand elles existent.
- Rendre un Markdown RICHE EN SOURCES.

## Format attendu
Markdown librement structuré, une section par entreprise, sources en liens.
`
}

// ── CRÉATION / PERSISTANCE / RELECTURE STRICTE ──────────────────────────────

export type MissionCreate =
  | { ok: true; mission: ResearchMissionV0; created: boolean }
  | { ok: false; reason: 'INVALID_SPEC' | 'INVALID_WORKSPACE' | 'CLOCK_INVALID' | 'WRITE_FAILED' }

/**
 * Crée et PERSISTE une mission immuable. Horloge INJECTABLE (tests
 * déterministes) ; en production, l'horloge SERVEUR — jamais le client.
 */
export async function createResearchMission(
  spec: unknown, ws: string, now: () => Date = () => new Date(),
): Promise<MissionCreate> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_WORKSPACE' }
  if (!isResearchMissionSpecV0(spec)) return { ok: false, reason: 'INVALID_SPEC' }

  const createdAt = now().toISOString()
  if (!isStrictInstant(createdAt)) return { ok: false, reason: 'CLOCK_INVALID' }

  const specHash = researchSpecHash(spec)
  const mission: ResearchMissionV0 = {
    id: researchMissionId(ws, createdAt, specHash),
    workspaceId: ws,
    contractVersion: RESEARCH_MISSION_CONTRACT,
    spec, specHash, createdAt,
    briefVersion: RESEARCH_BRIEF_VERSION,
    researchBrief: buildResearchBrief(spec),
    executionMode: 'MANUAL_PREMIUM_RESEARCH',
  }

  // INSERTION SEULE — une mission ne s'écrase jamais. `false` est ambigu
  // (« existe déjà » OU « base muette ») : on RELIT pour trancher.
  if (await insertItemIfAbsent(RESEARCH_MISSION_KIND, mission.id, mission, ws)) {
    return { ok: true, mission, created: true }
  }
  const relu = await readResearchMission(mission.id, ws)
  if (relu.ok === true) return { ok: true, mission: relu.mission, created: false }
  return { ok: false, reason: 'WRITE_FAILED' }
}

export type MissionRead =
  | { ok: true; mission: ResearchMissionV0 }
  | { ok: false; reason: 'MISSION_UNKNOWN' | 'MISSION_TAMPERED' | 'STORE_UNAVAILABLE' }

/**
 * Relecture STRICTE et défiante : une ligne `jsonb` n'est pas crue parce
 * qu'elle existe. Contrat complet revalidé, condensat de spec RECALCULÉ,
 * identité RECALCULÉE, brief RECALCULÉ — toute divergence est un rejet.
 */
export async function readResearchMission(id: string, ws: string): Promise<MissionRead> {
  const lu = await getItemStrict<ResearchMissionV0>(RESEARCH_MISSION_KIND, id, ws)
  if (lu.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  if (!lu.value) return { ok: false, reason: 'MISSION_UNKNOWN' }
  const m: any = lu.value

  const valide =
    objet(m)
    && clesCloses(m, ['id', 'workspaceId', 'contractVersion', 'spec', 'specHash', 'createdAt', 'briefVersion', 'researchBrief', 'executionMode'])
    && m.contractVersion === RESEARCH_MISSION_CONTRACT
    && m.workspaceId === ws
    && m.briefVersion === RESEARCH_BRIEF_VERSION
    && m.executionMode === 'MANUAL_PREMIUM_RESEARCH'
    && isStrictInstant(m.createdAt)
    && isResearchMissionSpecV0(m.spec)
    && m.specHash === researchSpecHash(m.spec)
    && m.id === researchMissionId(ws, String(m.createdAt), String(m.specHash))
    && m.researchBrief === buildResearchBrief(m.spec)
  if (!valide) return { ok: false, reason: 'MISSION_TAMPERED' }
  return { ok: true, mission: m as unknown as ResearchMissionV0 }
}
