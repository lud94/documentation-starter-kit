// SEC-004_MISSION_EXEC_AUTHORITY_V0_001 — CONTRAT CANONIQUE DE MISSION.
//
// ── PLANNER ≠ CONTROLLER ────────────────────────────────────────────────────
// Une Mission fournie par le navigateur (ou par le planificateur, qui transite
// par le navigateur) est une ENTRÉE, jamais une autorité d'exécution. Avant ce
// lot, `POST /api/missions` persistait l'objet reçu tel quel (seul `id` était
// vérifié) : un client authentifié pouvait forger `needsApproval: false`, un
// `cursor` arbitraire, un `context` pré-rempli, un statut « running » — et
// exécuter des outils d'écriture/coûteux sans aucune gouvernance.
//
// Ce module RECONSTRUIT le contrat exécutable côté serveur. Le client propose
// des étapes (outil, libellé, paramètres, souhait d'approbation) ; le serveur
// décide de TOUT le reste. Un champ client ne peut jamais accorder : ni outil
// inconnu, ni contournement d'approbation, ni position de curseur, ni état
// d'exécution, ni contexte, ni étape déjà « terminée ».
//
// ── APPROBATION : LE CLIENT NE PEUT QUE DURCIR ──────────────────────────────
//   canonicalNeedsApproval = write ∨ costly ∨ souhaitClient
// Un outil qui écrit ou qui coûte exige l'approbation QUOI QU'EN DISE le
// client ; un souhait client d'approbation sur un outil de lecture est honoré.
//
// MODULE PUR : validation et canonicalisation locales, déterministes (l'horloge
// est un paramètre). Aucun stockage, aucun réseau, aucun LLM.
import { createHash } from 'node:crypto'

import { MISSION_TOOL_META } from '../../types/prospector'
import type { Mission, MissionStep, MissionTool } from '../../types/prospector'
import { MAX_COMPANIES, MAX_ENRICH } from './missionTools'

export const MISSION_CONTRACT_VERSION = 'mission-contract-v0.1'

/** Bornes existantes, réutilisées — jamais dupliquées avec d'autres valeurs. */
export const MAX_STEPS = 8

const TOOLS = Object.keys(MISSION_TOOL_META) as readonly MissionTool[]

export type MissionRejection =
  | 'mission_missing'
  | 'mission_id_invalid'
  | 'steps_missing'
  | 'too_many_steps'
  | 'step_invalid'
  | 'unknown_tool'
  | 'authority_instance_invalid'

export type MissionCanonicalization =
  | { ok: true; mission: Mission }
  | { ok: false; reason: MissionRejection; detail?: string }

function texte(v: unknown, max: number, fallback = ''): string {
  return (typeof v === 'string' ? v : fallback).slice(0, max)
}

function borneEntier(v: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, max)
  return Math.min(n, max)
}

/**
 * Paramètres CANONIQUES d'un outil — liste FERMÉE par outil.
 *
 * Seuls les paramètres réellement consommés par l'exécuteur survivent ; tout
 * champ étranger est retiré. En particulier, aucun `context`, aucun mapping de
 * comptes, aucun état d'exécution ne peut voyager dans `params`.
 */
export function canonicalParams(tool: MissionTool, brut: unknown): Record<string, any> {
  const p = (brut && typeof brut === 'object' && !Array.isArray(brut) ? brut : {}) as Record<string, unknown>
  switch (tool) {
    case 'source_companies': {
      const out: Record<string, any> = { limit: borneEntier(p.limit, 20, MAX_COMPANIES) }
      if (typeof p.sector === 'string' && p.sector.trim()) out.sector = texte(p.sector, 80)
      if (typeof p.location === 'string' && p.location.trim()) out.location = texte(p.location, 80)
      if (typeof p.size === 'string' && p.size.trim()) out.size = texte(p.size, 20)
      return out
    }
    case 'enrich_companies':
      return { limit: borneEntier(p.limit, 5, MAX_ENRICH) }
    case 'create_list':
    case 'create_sequence': {
      const out: Record<string, any> = {}
      if (typeof p.name === 'string' && p.name.trim()) out.name = texte(p.name, 80)
      return out
    }
    case 'import_companies':
    case 'resolve_dirigeants':
      return {}
  }
}

/** L'approbation canonique — le client peut durcir, jamais assouplir. */
export function canonicalNeedsApproval(tool: MissionTool, souhaitClient: unknown): boolean {
  const meta = MISSION_TOOL_META[tool]
  return !!meta.write || !!meta.costly || souhaitClient === true
}

function outilConnu(tool: unknown): tool is MissionTool {
  return typeof tool === 'string' && (TOOLS as readonly string[]).includes(tool)
}

/**
 * Reconstruit la Mission CANONIQUE à partir d'une entrée non fiable.
 *
 * ⚠️ OUTIL INCONNU ⇒ REFUS DE TOUTE LA MISSION. Le retirer en silence ferait
 * exécuter un plan différent de celui que l'utilisateur a lu et validé.
 *
 * ⚠️ `authorityInstanceId` (R2) est fourni PAR LA ROUTE, générée côté serveur
 * (aléatoire opaque). La valeur proposée par le client dans sa Mission est
 * IGNORÉE — l'objet canonique n'est jamais construit par étalement de
 * l'entrée. Ce paramètre explicite garde le module pur et déterministe.
 */
export function canonicalizeMission(
  input: unknown,
  nowMs: number,
  authorityInstanceId: string,
): MissionCanonicalization {
  if (typeof authorityInstanceId !== 'string' || !authorityInstanceId.trim()) {
    return { ok: false, reason: 'authority_instance_invalid' }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'mission_missing' }
  }
  const m = input as Record<string, unknown>

  const id = typeof m.id === 'string' ? m.id.trim() : ''
  if (!id || id.length > 64) return { ok: false, reason: 'mission_id_invalid' }

  if (!Array.isArray(m.steps) || m.steps.length === 0) return { ok: false, reason: 'steps_missing' }
  if (m.steps.length > MAX_STEPS) return { ok: false, reason: 'too_many_steps' }

  const steps: MissionStep[] = []
  for (let i = 0; i < m.steps.length; i++) {
    const brut = m.steps[i] as Record<string, unknown>
    if (!brut || typeof brut !== 'object') return { ok: false, reason: 'step_invalid', detail: `#${i + 1}` }
    if (!outilConnu(brut.tool)) {
      return { ok: false, reason: 'unknown_tool', detail: String(brut?.tool ?? '') .slice(0, 40) }
    }
    const tool = brut.tool
    const meta = MISSION_TOOL_META[tool]
    // Reconstruction INTÉGRALE : identifiant, statut, résultat et horodatage
    // sont serveur ; aucun état « déjà exécuté » ne peut être injecté.
    steps.push({
      id: `st_${i + 1}`,
      tool,
      label: texte(brut.label, 120, meta.label) || meta.label,
      params: canonicalParams(tool, brut.params),
      status: 'pending',
      needsApproval: canonicalNeedsApproval(tool, brut.needsApproval),
    })
  }

  const mission: Mission = {
    id,
    title: texte(m.title, 80, 'Mission') || 'Mission',
    request: texte(m.request, 400),
    objective: texte(m.objective, 400),
    // ── ÉTAT D'EXÉCUTION : SERVEUR, INTÉGRALEMENT. ──
    status: 'draft',
    autonomy: steps.some((s) => MISSION_TOOL_META[s.tool].write) ? 'create' : 'read_only',
    steps,
    assumptions: (Array.isArray(m.assumptions) ? m.assumptions : []).map((x) => String(x).slice(0, 200)).slice(0, 6),
    missing: (Array.isArray(m.missing) ? m.missing : []).map((x) => String(x).slice(0, 200)).slice(0, 6),
    context: {},
    log: [],
    cursor: 0,
    createdAt: nowMs,
    // R2 — instance d'autorité SERVEUR ; jamais celle du client.
    authorityInstanceId,
  }
  return { ok: true, mission }
}

/**
 * Référence d'INSTANCE d'autorité d'une Mission CHARGÉE DU SERVEUR (R2).
 *
 * ⚠️ À n'appeler QUE sur une mission relue du magasin — jamais sur une entrée
 * client. Mission canonique neuve : son `authorityInstanceId` aléatoire.
 * Mission HÉRITÉE (persistée avant R2, champ absent) : un espace de noms
 * hérité EXPLICITE, dérivé de champs immuables déjà persistés (id + createdAt)
 * sous un préfixe distinct — `mai_legacy_…` ne peut jamais entrer en collision
 * avec un `mai_<uuid>` aléatoire, donc supprimer une mission héritée puis
 * recréer son id produit une instance NEUVE, jamais l'héritée. Aucun repli
 * ouvert : la fonction rend toujours une référence non vide et déterministe.
 */
export function missionAuthorityInstanceOf(mission: {
  id: string
  createdAt?: number
  authorityInstanceId?: unknown
}): string {
  const explicite = mission.authorityInstanceId
  if (typeof explicite === 'string' && explicite.trim()) return explicite
  const canonique = `${mission.id}\n${mission.createdAt ?? 0}`
  return `mai_legacy_${createHash('sha256').update(canonique, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * L'étape est-elle EXÉCUTABLE au moment de l'exécution ?
 *
 * Revalidée À CHAQUE run, indépendamment de la création : une ligne persistée
 * corrompue (outil inconnu, params non canoniques) ne doit jamais atteindre
 * l'exécuteur. La frontière de sécurité est cette validation — pas un
 * TypeError accidentel en aval.
 */
const EXEC_PARAM_KEYS: Record<MissionTool, readonly string[]> = {
  source_companies: ['limit', 'sector', 'location', 'size'],
  enrich_companies: ['limit'],
  create_list: ['name'],
  create_sequence: ['name'],
  import_companies: [],
  resolve_dirigeants: [],
}

function limiteValide(v: unknown, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 1 && v <= max
}

function texteExecValide(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}

export function validateExecutableStep(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false
  const s = step as Record<string, unknown>
  if (!outilConnu(s.tool)) return false
  if (typeof s.id !== 'string' || !s.id) return false
  if (s.params !== undefined && (typeof s.params !== 'object' || Array.isArray(s.params) || s.params === null)) return false

  // ── R1-3 : VOCABULAIRE FERMÉ + VALEURS VALIDES, PAS ÉGALITÉ D'OCTETS. ────
  // Toute clé hors du vocabulaire de l'outil rend l'étape inexécutable — un
  // champ étranger dans une ligne persistée n'atteint jamais l'exécuteur.
  // L'ABSENCE d'une clé reste exécutable (les missions héritées portent des
  // params minimaux ; runStep possède ses défauts) : on ferme la forme, on
  // n'exige pas la présence physique des défauts.
  const p = (s.params || {}) as Record<string, unknown>
  const tool = s.tool as MissionTool
  const autorisees = EXEC_PARAM_KEYS[tool]
  for (const cle of Object.keys(p)) {
    if (!autorisees.includes(cle)) return false
  }
  if ((tool === 'source_companies' || tool === 'enrich_companies') && p.limit !== undefined) {
    if (!limiteValide(p.limit, tool === 'source_companies' ? MAX_COMPANIES : MAX_ENRICH)) return false
  }
  if (tool === 'source_companies') {
    if (p.sector !== undefined && !texteExecValide(p.sector, 80)) return false
    if (p.location !== undefined && !texteExecValide(p.location, 80)) return false
    if (p.size !== undefined && !texteExecValide(p.size, 20)) return false
  }
  if ((tool === 'create_list' || tool === 'create_sequence') && p.name !== undefined) {
    if (!texteExecValide(p.name, 80)) return false
  }
  return true
}

/**
 * Empreinte CANONIQUE de l'action exécutable — insensible à l'ordre des clés.
 *
 * Elle lie une approbation à CE QUI sera exécuté : outil + paramètres
 * canoniques. Si l'un ou l'autre change entre l'approbation et l'exécution,
 * l'empreinte change, et l'approbation ne se consomme plus.
 */
export function actionFingerprint(tool: MissionTool, params: Record<string, any>): string {
  const cles = Object.keys(params || {}).sort()
  const canonique = JSON.stringify([tool, cles.map((k) => [k, params[k]])])
  return createHash('sha256').update(canonique, 'utf8').digest('hex')
}
