// RESEARCH_MISSION_ARTIFACT_V0_001 — ARTEFACT DE RECHERCHE BRUT, IMMUABLE.
//
// ── LA FRONTIÈRE, EN UNE PHRASE ─────────────────────────────────────────────
// Un ResearchArtifact est de la MATIÈRE DE RECHERCHE BRUTE. Le persister
// signifie « cette sortie de recherche a été importée » — JAMAIS « son contenu
// est vrai ». Il peut contenir des erreurs, des contradictions, de la prose de
// modèle et de mauvaises sources : tout cela est conservé TEL QUEL.
//
// Ce n'est NI une Evidence, NI une SourceEvidence, NI une SourceAssertion,
// NI un fait canonique, NI un SignalCandidate, NI une source vérifiée.
// AUCUN chemin automatique ResearchArtifact → Evidence n'existe ici — la
// compilation (interprétation) est un ticket SÉPARÉ et ULTÉRIEUR
// (RESEARCH_ARTIFACT_COMPILER_V0_001).
//
// ── CONSERVATION EXACTE ─────────────────────────────────────────────────────
// `rawContent` est préservé caractère pour caractère : pas de réécriture, pas
// de résumé, pas de normalisation de prose, pas de « nettoyage », pas de
// suppression d'affirmations contradictoires. `contentHash` (SHA-256 COMPLET)
// verrouille cette exactitude à la relecture.
import { createHash } from 'node:crypto'

import { canonicalJson } from '../proactive/acquisitionV2'
import { isStrictInstant } from '../proactive/types'
import { getItemStrict, insertItemIfAbsent } from '../../supabase/store'
import { readResearchMission } from './missionV0'

/** `kind` du magasin — SERVEUR UNIQUEMENT, absent de toute liste blanche navigateur. */
export const RESEARCH_ARTIFACT_KIND = 'prospector_research_artifact'
export const RESEARCH_ARTIFACT_CONTRACT = 'research-artifact-v0'

export interface ResearchArtifactProvenanceV0 {
  importMode: 'MANUAL'
  /** Provenance DESCRIPTIVE (« ChatGPT Deep Research », « Manual analyst research »…) — jamais un score d'autorité. */
  originLabel: string
  model?: string
  /** Instant d'exécution EXTERNE, fourni à l'import — jamais déduit d'importedAt. */
  executedAt?: string
  /** Horloge SERVEUR de l'import. */
  importedAt: string
}

export interface ResearchArtifactV0 {
  id: string
  workspaceId: string
  contractVersion: 'research-artifact-v0'
  missionId: string
  missionSpecHash: string
  format: 'MARKDOWN'
  rawContent: string
  contentHash: string
  /** Inventaire de TRAÇABILITÉ — pas des sources vérifiées, pas des Evidence. */
  referencedUrls: string[]
  provenance: ResearchArtifactProvenanceV0
  /**
   * INTÉGRITÉ de l'enregistrement immuable COMPLET (R1) — à ne pas confondre
   * avec `id` :
   *   id         = identité / idempotence (espace + mission + contenu)
   *   recordHash = SHA-256 COMPLET du JSON canonique de TOUT l'enregistrement
   *                sauf `id` et `recordHash` eux-mêmes — provenance comprise.
   * Une provenance qui passe d'une valeur valide à une autre ne laisse donc
   * jamais un enregistrement d'audit valide.
   */
  recordHash: string
}

const sha256 = (charge: string) => createHash('sha256').update(charge, 'utf8').digest('hex')

/** SHA-256 COMPLET du contenu brut EXACT. */
export function researchContentHash(rawContent: string): string {
  return sha256(rawContent)
}

/** Intégrité du record complet — voir `ResearchArtifactV0.recordHash`. */
export function researchRecordHash(a: Omit<ResearchArtifactV0, 'id' | 'recordHash'>): string {
  return sha256(canonicalJson({
    workspaceId: a.workspaceId,
    contractVersion: a.contractVersion,
    missionId: a.missionId,
    missionSpecHash: a.missionSpecHash,
    format: a.format,
    contentHash: a.contentHash, // couvre `rawContent` via la vérification de condensat
    referencedUrls: a.referencedUrls,
    provenance: a.provenance,
  }))
}

/**
 * Identité d'artefact : espace + mission + condensat de contenu.
 *   même mission + même Markdown exact  → même identité (rejeu idempotent)
 *   même Markdown + autre mission       → autre identité
 */
export function researchArtifactId(workspaceId: string, missionId: string, contentHash: string): string {
  return `ra_${sha256(`research-artifact:v0:${workspaceId}\n${missionId}\n${contentHash}`).slice(0, 32)}`
}

// ── INVENTAIRE D'URL — TRAÇABILITÉ SEULE, MEILLEUR EFFORT DÉTERMINISTE ──────
//
// ⚠️ AUCUN fetch, AUCUNE gradation, AUCUNE attribution URL→affirmation, AUCUN
// réseau. Une URL malformée n'échoue jamais l'artefact et ne touche jamais
// `rawContent`. Manipulation CONSERVATRICE et exacte — on ne réutilise pas
// `normalizeSourceUrl` (identité d'assertion : retrait de www/fragment) pour
// ne pas fabriquer une seconde sémantique d'équivalence là où seul un
// inventaire est demandé.
const URL_DANS_TEXTE = /https?:\/\/[^\s<>()"'\]]+/g
const PONCTUATION_FINALE = /[.,;:!?»…]+$/

export function extractReferencedUrls(rawContent: string): string[] {
  const vues = new Set<string>()
  for (const brute of rawContent.match(URL_DANS_TEXTE) ?? []) {
    const candidate = brute.replace(PONCTUATION_FINALE, '')
    try {
      // Validation syntaxique SEULE — jamais de normalisation de la valeur.
      // Une URL informe ne rejoint pas l'inventaire, mais ne casse rien.
      void new URL(candidate)
      vues.add(candidate)
    } catch { /* malformée ⇒ ignorée, l'artefact reste intact */ }
  }
  return [...vues].sort()
}

// ── IMPORT — INSERTION SEULE, REJEU IDEMPOTENT PROUVÉ PAR RELECTURE ─────────

export interface ArtifactImportInput {
  missionId: string
  rawContent: string
  originLabel: string
  model?: string
  executedAt?: string
}

export type ArtifactImport =
  | { ok: true; artifact: ResearchArtifactV0; created: boolean }
  | {
      ok: false
      reason:
        | 'INVALID_INPUT'
        | 'MISSION_UNKNOWN'
        | 'MISSION_TAMPERED'
        | 'STORE_UNAVAILABLE'
        | 'WRITE_FAILED'
        | 'PROVENANCE_CONFLICT'
    }

/**
 * Importe un artefact IMMUABLE. Horloge injectable (importedAt = serveur).
 *
 * ⚠️ Un échec d'`insertItemIfAbsent` n'est JAMAIS classé « existe déjà » à
 * l'aveugle : la relecture STRICTE tranche entre le rejeu idempotent d'un
 * artefact identique valide et une panne de persistance. Une base muette ne
 * devient pas une déduplication réussie.
 */
export async function importResearchArtifact(
  input: ArtifactImportInput, ws: string, now: () => Date = () => new Date(),
): Promise<ArtifactImport> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (!input || typeof input !== 'object') return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.missionId !== 'string' || input.missionId.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.rawContent !== 'string' || input.rawContent === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (typeof input.originLabel !== 'string' || input.originLabel.trim() === '') return { ok: false, reason: 'INVALID_INPUT' }
  if (input.model !== undefined && typeof input.model !== 'string') return { ok: false, reason: 'INVALID_INPUT' }
  // `executedAt` : optionnel ; s'il est fourni, il doit être un instant STRICT
  // (le validateur de production) — jamais déduit d'`importedAt`.
  if (input.executedAt !== undefined && !isStrictInstant(input.executedAt)) {
    return { ok: false, reason: 'INVALID_INPUT' }
  }

  // La mission doit EXISTER, dans CET espace, et se relire intacte.
  const mission = await readResearchMission(input.missionId, ws)
  if (mission.ok === false) {
    return { ok: false, reason: mission.reason === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : mission.reason }
  }

  const importedAt = now().toISOString()
  if (!isStrictInstant(importedAt)) return { ok: false, reason: 'INVALID_INPUT' }

  const contentHash = researchContentHash(input.rawContent)
  const sansIntegrite: Omit<ResearchArtifactV0, 'id' | 'recordHash'> = {
    workspaceId: ws,
    contractVersion: RESEARCH_ARTIFACT_CONTRACT,
    missionId: mission.mission.id,
    missionSpecHash: mission.mission.specHash,
    format: 'MARKDOWN',
    rawContent: input.rawContent, // EXACT — aucun octet réécrit
    contentHash,
    referencedUrls: extractReferencedUrls(input.rawContent),
    provenance: {
      importMode: 'MANUAL',
      originLabel: input.originLabel.trim(),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.executedAt !== undefined ? { executedAt: input.executedAt } : {}),
      importedAt,
    },
  }
  const artifact: ResearchArtifactV0 = {
    id: researchArtifactId(ws, mission.mission.id, contentHash),
    ...sansIntegrite,
    recordHash: researchRecordHash(sansIntegrite),
  }

  if (await insertItemIfAbsent(RESEARCH_ARTIFACT_KIND, artifact.id, artifact, ws)) {
    return { ok: true, artifact, created: true }
  }
  const relu = await readResearchArtifact(artifact.id, ws)
  if (relu.ok === true) {
    // ── REJEU vs CONFLIT DE PROVENANCE (R1 §5) ────────────────────────────
    // Même identité (mission + contenu), mais la provenance FOURNIE compare
    // séparément de l'horloge serveur : `importedAt` diffère légitimement à
    // chaque tentative et ne fait jamais échouer un vrai rejeu. Une
    // provenance immuable DIFFÉRENTE, elle, n'est ni écrasée, ni fusionnée,
    // ni annoncée comme rejeu : conflit explicite, le premier artefact reste.
    const stockee = relu.artifact.provenance
    const memeProvenance =
      stockee.originLabel === input.originLabel.trim()
      && stockee.model === input.model
      && stockee.executedAt === input.executedAt
    if (!memeProvenance) return { ok: false, reason: 'PROVENANCE_CONFLICT' }
    // Rejeu exact : l'`importedAt` d'ORIGINE est conservé (artefact stocké).
    return { ok: true, artifact: relu.artifact, created: false }
  }
  return { ok: false, reason: 'WRITE_FAILED' }
}

export type ArtifactRead =
  | { ok: true; artifact: ResearchArtifactV0 }
  | { ok: false; reason: 'ARTIFACT_UNKNOWN' | 'ARTIFACT_TAMPERED' | 'STORE_UNAVAILABLE' }

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const clesCloses = (obj: Record<string, unknown>, requises: readonly string[], optionnelles: readonly string[] = []): boolean => {
  for (const k of requises) if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  for (const k of Object.keys(obj)) {
    if (requises.indexOf(k) === -1 && optionnelles.indexOf(k) === -1) return false
  }
  return true
}

/**
 * Relecture STRICTE et défiante : contrat complet revalidé, condensat de
 * contenu RECALCULÉ sur le brut relu, identité RECALCULÉE, et
 * `missionSpecHash` vérifié contre la MISSION relue elle-même. Une ligne
 * altérée sous un identifiant existant ne se fait pas passer pour l'artefact.
 */
export async function readResearchArtifact(id: string, ws: string): Promise<ArtifactRead> {
  const lu = await getItemStrict<ResearchArtifactV0>(RESEARCH_ARTIFACT_KIND, id, ws)
  if (lu.ok === false) return { ok: false, reason: 'STORE_UNAVAILABLE' }
  if (!lu.value) return { ok: false, reason: 'ARTIFACT_UNKNOWN' }
  const a: any = lu.value

  const forme =
    objet(a)
    && clesCloses(a, ['id', 'workspaceId', 'contractVersion', 'missionId', 'missionSpecHash', 'format', 'rawContent', 'contentHash', 'referencedUrls', 'provenance', 'recordHash'])
    && a.contractVersion === RESEARCH_ARTIFACT_CONTRACT
    && a.workspaceId === ws
    && a.format === 'MARKDOWN'
    && typeof a.rawContent === 'string' && a.rawContent !== ''
    && Array.isArray(a.referencedUrls) && a.referencedUrls.every((u: unknown) => typeof u === 'string')
    && objet(a.provenance)
    && clesCloses(a.provenance, ['importMode', 'originLabel', 'importedAt'], ['model', 'executedAt'])
    && a.provenance.importMode === 'MANUAL'
    && typeof a.provenance.originLabel === 'string' && a.provenance.originLabel.trim() !== ''
    && isStrictInstant(a.provenance.importedAt)
    && (a.provenance.executedAt === undefined || isStrictInstant(a.provenance.executedAt))
    && (a.provenance.model === undefined || typeof a.provenance.model === 'string')
  if (!forme) return { ok: false, reason: 'ARTIFACT_TAMPERED' }

  if (a.contentHash !== researchContentHash(String(a.rawContent))) return { ok: false, reason: 'ARTIFACT_TAMPERED' }
  // ⚠️ L'inventaire d'URL est une PROJECTION DÉTERMINISTE du brut : il est
  // RECALCULÉ, jamais cru parce que chaque élément « ressemble » à une URL.
  if (canonicalJson(a.referencedUrls) !== canonicalJson(extractReferencedUrls(String(a.rawContent)))) {
    return { ok: false, reason: 'ARTIFACT_TAMPERED' }
  }
  // ⚠️ INTÉGRITÉ DU RECORD COMPLET — provenance comprise (R1 §3/§4).
  const { id: _id, recordHash: _rh, ...sansIntegrite } = a
  if (a.recordHash !== researchRecordHash(sansIntegrite as any)) {
    return { ok: false, reason: 'ARTIFACT_TAMPERED' }
  }
  if (a.id !== researchArtifactId(ws, String(a.missionId), String(a.contentHash))) return { ok: false, reason: 'ARTIFACT_TAMPERED' }

  const mission = await readResearchMission(String(a.missionId), ws)
  if (mission.ok === false) {
    return { ok: false, reason: mission.reason === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'ARTIFACT_TAMPERED' }
  }
  if (a.missionSpecHash !== mission.mission.specHash) return { ok: false, reason: 'ARTIFACT_TAMPERED' }

  return { ok: true, artifact: a as unknown as ResearchArtifactV0 }
}
