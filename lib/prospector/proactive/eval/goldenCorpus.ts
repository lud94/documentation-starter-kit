// EVAL-RUNNER-001b — CHARGEMENT ET RE-VALIDATION DU CORPUS GOLDEN.
//
// ── CE MODULE NE JUGE RIEN ──────────────────────────────────────────────────
// Il vérifie que le corpus est INTÈGRE, pas que le moteur a raison. Les deux
// questions sont distinctes et doivent le rester : un corpus corrompu rendrait
// toute métrique dénuée de sens, mais un corpus intègre ne dit rien de la
// qualité du moteur.
//
// ── AUCUN SECOND VALIDATEUR ─────────────────────────────────────────────────
// La structure passe par `validateGoldenCaseStructure`, l'ancrage par
// `validateGoldenCaseAgainstRaw`, la projection par `validateGoldenCase`. Aucun
// de ces contrôles n'est réécrit ici : ce module les ORCHESTRE.
//
// ── L'I/O VIT ICI, PAS DANS LES VALIDATEURS ─────────────────────────────────
// `caseSchema.ts` et `goldenRawIntegrity.ts` sont purs et reçoivent des valeurs
// déjà désérialisées. C'est ce module — et lui seul — qui lit le disque, puis
// leur INJECTE ce qu'il a lu. L'empreinte du dataset RAW est recalculée sur les
// OCTETS avant tout parsing : c'est la seule façon honnête de lier une identité
// à un contenu.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { validateGoldenCaseStructure } from './goldenSchema'
import { validateGoldenCase } from './goldenToEvalCase'
import {
  parseSha256Sums,
  validateGoldenCaseAgainstRaw,
  type RawDatasetArtifact,
  type RawManifestEntry,
} from './goldenRawIntegrity'
import type { GoldenCase } from './goldenSchema'

export const REPERTOIRE_RAW = 'fixtures/golden/raw'
export const REPERTOIRE_CAS = 'fixtures/golden/cases'
export const CHEMIN_DATASET = `${REPERTOIRE_RAW}/prospector-v3-golden-dataset.v0.1.json`

export interface CasCharge {
  /** Nom de fichier, pour désigner la source exacte d'un problème. */
  fichier: string
  caseId: string
  golden: GoldenCase
}

export interface ProblemeCorpus {
  fichier: string
  caseId: string | null
  code: string
  message: string
}

export interface CorpusGolden {
  artefact: RawDatasetArtifact
  manifeste: RawManifestEntry[]
  cas: CasCharge[]
  problemes: ProblemeCorpus[]
}

/**
 * Charge l'artefact RAW en calculant son empreinte SUR LES OCTETS.
 *
 * ⚠️ Le hachage précède le parsing, et c'est tout l'intérêt : le validateur
 * recalcule ensuite la même empreinte à partir du texte reçu. Un appelant ne
 * peut donc pas présenter l'identité d'un fichier avec le contenu d'un autre.
 */
export function chargerArtefactRaw(racine: string): RawDatasetArtifact {
  const texte = readFileSync(join(racine, CHEMIN_DATASET), 'utf8')
  return {
    path: CHEMIN_DATASET,
    sha256: createHash('sha256').update(texte, 'utf8').digest('hex'),
    text: texte,
  }
}

/**
 * Charge le manifeste committé.
 *
 * Les chemins d'un `SHA256SUMS` coreutils sont RELATIFS au répertoire du
 * manifeste : le préfixe est fourni ici, par l'appelant qui sait d'où il lit.
 */
export function chargerManifeste(racine: string): RawManifestEntry[] {
  return parseSha256Sums(
    readFileSync(join(racine, REPERTOIRE_RAW, 'SHA256SUMS'), 'utf8'),
    `${REPERTOIRE_RAW}/`,
  )
}

/**
 * Charge et RE-VALIDE l'intégralité du corpus Golden.
 *
 * ⚠️ ORDRE DÉTERMINISTE. Les fichiers sont triés par nom : deux exécutions sur
 * le même état du dépôt doivent produire le même rapport, octet pour octet.
 *
 * Un cas en échec n'interrompt pas le chargement — tous les problèmes sont
 * collectés. Corriger un corpus problème par problème, en relançant à chaque
 * fois, est le meilleur moyen d'abandonner avant d'avoir tout corrigé.
 */
export function chargerCorpusGolden(racine: string): CorpusGolden {
  const artefact = chargerArtefactRaw(racine)
  const manifeste = chargerManifeste(racine)

  const problemes: ProblemeCorpus[] = []
  const cas: CasCharge[] = []

  let fichiers: string[]
  try {
    fichiers = readdirSync(join(racine, REPERTOIRE_CAS))
      .filter((f) => f.endsWith('.golden.json'))
      .sort()
  } catch {
    return {
      artefact,
      manifeste,
      cas: [],
      problemes: [
        {
          fichier: REPERTOIRE_CAS,
          caseId: null,
          code: 'golden_corpus_unreadable',
          message: `Répertoire « ${REPERTOIRE_CAS} » illisible ou absent.`,
        },
      ],
    }
  }

  for (const fichier of fichiers) {
    const chemin = join(racine, REPERTOIRE_CAS, fichier)

    let brut: string
    try {
      brut = readFileSync(chemin, 'utf8')
    } catch {
      problemes.push({
        fichier,
        caseId: null,
        code: 'golden_case_unreadable',
        message: 'Fichier illisible.',
      })
      continue
    }

    let valeur: unknown
    try {
      valeur = JSON.parse(brut)
    } catch (e) {
      problemes.push({
        fichier,
        caseId: null,
        code: 'golden_case_json_invalid',
        message: `JSON invalide : ${(e as Error).message}`,
      })
      continue
    }

    // ── STRUCTURE ──────────────────────────────────────────────────────────
    const structure = validateGoldenCaseStructure(valeur)
    if (structure.ok === false) {
      const id = (valeur as any)?.caseId ?? null
      for (const err of structure.errors) {
        problemes.push({
          fichier,
          caseId: id,
          code: err.code,
          message: `${err.path} — ${err.message}`,
        })
      }
      continue
    }

    const golden = structure.case

    // ── ANCRAGE RAW — le validateur EXISTANT, jamais un second ─────────────
    const ancrage = validateGoldenCaseAgainstRaw(golden, artefact, manifeste)
    if (ancrage.ok === false) {
      for (const err of ancrage.errors) {
        problemes.push({
          fichier,
          caseId: golden.caseId,
          code: err.code,
          message: `${err.path} — ${err.message}`,
        })
      }
      continue
    }

    // ── VALIDATION COMPLÈTE ────────────────────────────────────────────────
    // Pour un cas EXECUTABLE elle projette et soumet le résultat au validateur
    // du runner. Pour un cas BLOQUÉ elle s'arrête à la structure — c'est le
    // comportement voulu, et un cas bloqué n'est PAS un cas en échec.
    const complete = validateGoldenCase(golden)
    if (complete.ok === false) {
      for (const err of complete.errors) {
        problemes.push({
          fichier,
          caseId: golden.caseId,
          code: err.code,
          message: `${err.path} — ${err.message}`,
        })
      }
      continue
    }

    cas.push({ fichier, caseId: golden.caseId, golden })
  }

  // Tri STABLE par caseId : l'ordre du système de fichiers ne doit pas
  // transparaître dans le rapport.
  cas.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
  problemes.sort((a, b) => {
    const fa = `${a.fichier}|${a.code}|${a.message}`
    const fb = `${b.fichier}|${b.code}|${b.message}`
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })

  return { artefact, manifeste, cas, problemes }
}
