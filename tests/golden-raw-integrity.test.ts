// GOLDEN-SCHEMA-001a — ANCRAGE SUR LES SOURCES RAW RÉELLEMENT COMMITTÉES.
//
// ⚠️ CES TESTS LISENT LES FICHIERS ; LE VALIDATEUR, NON. C'est la doctrine de
// `caseSchema.ts` : la lecture appartient à la CLI et aux tests, la validation
// reçoit des valeurs déjà désérialisées. Les dépendances sont donc INJECTÉES.
//
// ⚠️ AUCUN FICHIER DE `fixtures/golden/raw/` N'EST MODIFIÉ. Ces tests les
// ouvrent en lecture seule et vérifient que l'ancrage décrit l'artefact réel.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseSha256Sums,
  resolveJsonPointer,
  validateGoldenCaseAgainstRaw,
} from '../lib/prospector/proactive/eval/goldenRawIntegrity'
import { casSigne, clone } from './golden-fixtures'

const REPERTOIRE_RAW = 'fixtures/golden/raw'
const CHEMIN_DATASET = `${REPERTOIRE_RAW}/prospector-v3-golden-dataset.v0.1.json`

const RAW_DATASET = JSON.parse(readFileSync(join(process.cwd(), CHEMIN_DATASET), 'utf8'))

// Les chemins d'un `SHA256SUMS` coreutils sont RELATIFS au répertoire du
// manifeste. Le préfixe est fourni par l'appelant — lui seul sait d'où il lit.
const MANIFESTE = parseSha256Sums(
  readFileSync(join(process.cwd(), REPERTOIRE_RAW, 'SHA256SUMS'), 'utf8'),
  `${REPERTOIRE_RAW}/`,
)

/** Cas Golden ancré sur une vraie Evidence RAW du dataset committé. */
function casAncre(): any {
  const c = casSigne()
  const rawCase = RAW_DATASET.cases.find((x: any) => x.caseId === 'GD-006')

  c.rawSource.originalCaseId = 'GD-006'
  c.adjudication.rawEvidence[0].rawEvidenceId = rawCase.evidence[0].id
  return c
}

function codes(r: any): string[] {
  return r.ok === false ? r.errors.map((e: any) => e.code) : []
}

// ── LE DATASET RÉELLEMENT COMMITTÉ ──────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — dataset RAW committé', () => {
  it('porte les identifiants EXACTS, non normalisés', () => {
    expect(RAW_DATASET.schemaVersion).toBe('prospector-v3-golden-dataset/0.1')
    expect(RAW_DATASET.datasetVersion).toBe('0.1')
    expect(RAW_DATASET.caseCount).toBe(40)
    expect(RAW_DATASET.cases).toHaveLength(40)
  })

  it('le manifeste porte l’empreinte attendue pour le dataset', () => {
    const entree = MANIFESTE.find((e) => e.path === CHEMIN_DATASET)
    expect(entree?.sha256).toBe(
      '131236360e882fc60b4dc077923983f7d6b8a071ce9c3b4e76bd253a5fb6803d',
    )
  })

  it('`parseSha256Sums` lit les deux entrées committées', () => {
    expect(MANIFESTE).toHaveLength(2)
    expect(MANIFESTE.map((e) => e.path)).toContain(
      `${REPERTOIRE_RAW}/prospector-v3-policies.v0.1.json`,
    )
  })
})

// ── ANCRAGE ─────────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — ancrage', () => {
  it('accepte un cas correctement ancré', () => {
    const r = validateGoldenCaseAgainstRaw(casAncre(), RAW_DATASET, MANIFESTE)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('refuse un chemin absent du manifeste', () => {
    const c = casAncre()
    c.rawSource.datasetPath = 'fixtures/golden/raw/autre.json'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_dataset_path_not_in_manifest',
    )
  })

  it('refuse une empreinte qui ne correspond pas AU CHEMIN déclaré', () => {
    // ⚠️ Le cœur de la vérification par COUPLE. Ici l'empreinte est authentique
    // — c'est celle du fichier de POLITIQUES — mais elle est associée au
    // dataset. Une vérification « l'empreinte figure quelque part » laisserait
    // passer, et l'ancrage n'ancrerait rien.
    const c = casAncre()
    c.rawSource.datasetSha256 =
      '72c194d8ccfa18eee5ed9abf9b3f5ddc8c345b8d740bba96de00aeea3880b5f3'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_sha_mismatch',
    )
  })

  it('refuse une version de schéma NORMALISÉE', () => {
    // « prospector-v3 » au lieu de « prospector-v3-golden-dataset/0.1 » : un
    // ancrage qui nettoie l'identifiant qu'il ancre n'ancre plus rien.
    const c = casAncre()
    c.rawSource.datasetSchemaVersion = 'prospector-v3'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_dataset_schema_version_mismatch',
    )
  })

  it('refuse une version de dataset NORMALISÉE', () => {
    const c = casAncre()
    c.rawSource.datasetVersion = 'v0.1'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_dataset_version_mismatch',
    )
  })

  it('refuse un cas RAW inexistant', () => {
    const c = casAncre()
    c.rawSource.originalCaseId = 'GD-999'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_case_id_unknown',
    )
  })
})

// ── COUVERTURE ET EXISTENCE ─────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — aucune suppression silencieuse', () => {
  it('refuse une Evidence RAW non adjugée', () => {
    // GD-026 porte DEUX evidences ; n'en adjuger qu'une ferait disparaître la
    // seconde sans décision enregistrée.
    const c = casAncre()
    c.rawSource.originalCaseId = 'GD-026'
    c.adjudication.rawEvidence[0].rawEvidenceId = 'GD-026-ev1'

    const r = validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE)
    expect(codes(r)).toContain('raw_evidence_not_covered')
    expect(r.ok === false && r.errors.some((e) => e.message.includes('GD-026-ev2'))).toBe(true)
  })

  it('refuse une adjudication citant une Evidence inexistante', () => {
    const c = casAncre()
    c.adjudication.rawEvidence[0].rawEvidenceId = 'GD-006-ev42'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'raw_evidence_adjudication_orphan',
    )
  })

  it('accepte plusieurs claims pour UNE Evidence RAW', () => {
    // Une Evidence RAW → N faits atomiques. C'est légal et c'est le cas de
    // GD-025 dans le monde réel ; seule la couverture est vérifiée ici.
    const c = casAncre()
    const groupe = c.adjudication.rawEvidence[0]
    const seconde = clone(groupe.claims[0])
    seconde.claimIndex = 1
    seconde.evidenceId = 'test-ev1b'
    groupe.claims.push(seconde)

    expect(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE).ok).toBe(true)
  })
})

// ── JSON POINTER ────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — JSON Pointer RFC 6901', () => {
  const doc = {
    expected: { primaryHypothesis: 'SPACE_EXPANSION' },
    evidence: [{ id: 'ev1' }, { id: 'ev2' }],
    'a/b': 1,
    'c~d': 2,
    vide: '',
    faux: false,
  }

  it('résout les chemins usuels', () => {
    expect(resolveJsonPointer(doc, '/expected/primaryHypothesis')).toBe('SPACE_EXPANSION')
    expect(resolveJsonPointer(doc, '/evidence/1/id')).toBe('ev2')
    expect(resolveJsonPointer(doc, '')).toBe(doc)
  })

  it('applique les échappements ~1 et ~0', () => {
    expect(resolveJsonPointer(doc, '/a~1b')).toBe(1)
    expect(resolveJsonPointer(doc, '/c~0d')).toBe(2)
  })

  it('distingue « valeur falsy » de « absent »', () => {
    // Un pointeur qui résout vers `''` ou `false` RÉSOUT. Confondre les deux
    // ferait passer une référence valide pour cassée.
    expect(resolveJsonPointer(doc, '/vide')).toBe('')
    expect(resolveJsonPointer(doc, '/faux')).toBe(false)
    expect(resolveJsonPointer(doc, '/absent')).toBeUndefined()
  })

  it('refuse un chemin pointé maison et un index hors bornes', () => {
    expect(resolveJsonPointer(doc, 'expected.primaryHypothesis')).toBeUndefined()
    expect(resolveJsonPointer(doc, '/evidence/9')).toBeUndefined()
    expect(resolveJsonPointer(doc, '/evidence/01')).toBeUndefined()
  })

  it('résout les références historiques du cas RAW réel', () => {
    const rawCase = RAW_DATASET.cases.find((x: any) => x.caseId === 'GD-006')
    for (const pointeur of [
      '/expected/primaryHypothesis',
      '/expected/behavior',
      '/whyThisCaseMatters',
      '/notes',
      '/account/lensFitExpected',
    ]) {
      expect(resolveJsonPointer(rawCase, pointeur)).toBeDefined()
    }
  })

  it('refuse une référence historique qui ne résout pas', () => {
    const c = casAncre()
    c.legacyAssessment.items[0].rawRef = '/expected/inexistant'
    expect(codes(validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE))).toContain(
      'legacy_raw_ref_unresolvable',
    )
  })
})

// ── PURETÉ ──────────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — pureté du validateur', () => {
  it('n’effectue aucune I/O : sans manifeste, il refuse au lieu de lire le disque', () => {
    const r = validateGoldenCaseAgainstRaw(casAncre(), RAW_DATASET, [])
    expect(codes(r)).toContain('raw_dataset_path_not_in_manifest')
  })

  it('ne mute pas ses entrées', () => {
    const c = casAncre()
    const avantGolden = JSON.stringify(c)
    const avantDataset = JSON.stringify(RAW_DATASET)

    validateGoldenCaseAgainstRaw(c, RAW_DATASET, MANIFESTE)

    expect(JSON.stringify(c)).toBe(avantGolden)
    expect(JSON.stringify(RAW_DATASET)).toBe(avantDataset)
  })
})
