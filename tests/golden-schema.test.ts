// GOLDEN-SCHEMA-001a — VALIDATION STRUCTURELLE DU CONTRAT `proactive-golden-v0.1`.
//
// ⚠️ CHAQUE RÈGLE EST TESTÉE PAR SA VIOLATION. Un test qui n'affirme que le cas
// nominal ne prouve rien : il passerait tout aussi bien si le validateur rendait
// `ok: true` inconditionnellement. Le cas nominal sert de TÉMOIN — on part de
// lui, on casse UNE chose, et on exige le code d'erreur exact.
import { describe, expect, it } from 'vitest'

import {
  GOLDEN_SCHEMA_VERSION,
  claimEstBloquante,
  projectTemporality,
  situationTypesActifsPourLens,
  validateGoldenCaseStructure,
} from '../lib/prospector/proactive/eval/goldenSchema'
import {
  projectGoldenCase,
  validateGoldenCase,
} from '../lib/prospector/proactive/eval/goldenToEvalCase'
// ⚠️ Import de pack AUTORISÉ ICI, et seulement ici : test d'intégration de
// compatibilité (cf. le describe « compatibilité pack pilote » en fin de
// fichier). L'infrastructure Golden générique, elle, n'importe aucun pack.
import {
  FIRST_PARTY_PROVIDERS,
  estFirstParty,
} from '../lib/prospector/proactive/packs/real-estate-fabel/provenance'
import { casGD025, casSigne, casTypeManquant, clone } from './golden-fixtures'

function codes(resultat: any): string[] {
  return resultat.ok === false ? resultat.errors.map((e: any) => e.code) : []
}

function chemins(resultat: any): string[] {
  return resultat.ok === false ? resultat.errors.map((e: any) => e.path) : []
}

// ── TÉMOINS ─────────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — témoins', () => {
  it('accepte un cas signé', () => {
    const r = validateGoldenCaseStructure(casSigne())
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('accepte un cas bloqué par un trou de taxonomie', () => {
    const r = validateGoldenCaseStructure(casTypeManquant())
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('rend TOUTES les erreurs, pas seulement la première', () => {
    const c = casSigne()
    delete c.caseId
    c.goldenSchemaVersion = 'autre'
    const r = validateGoldenCaseStructure(c)
    expect(r.ok).toBe(false)
    expect(codes(r).length).toBeGreaterThan(1)
  })

  it('refuse une valeur non objet', () => {
    expect(codes(validateGoldenCaseStructure(null))).toContain('golden_case_not_object')
    expect(codes(validateGoldenCaseStructure([]))).toContain('golden_case_not_object')
  })
})

// ── RACINE FERMÉE ───────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — racine fermée', () => {
  it('refuse une clé racine inconnue', () => {
    const c = casSigne()
    c.input = { evidence: [] }
    expect(codes(validateGoldenCaseStructure(c))).toContain('golden_root_key_unknown')
  })

  it('refuse une clé racine manquante', () => {
    const c = casSigne()
    delete c.legacyAssessment
    expect(codes(validateGoldenCaseStructure(c))).toContain('golden_root_key_missing')
  })

  it('refuse une version de contrat inconnue', () => {
    const c = casSigne()
    c.goldenSchemaVersion = 'proactive-golden-v0.2'
    expect(codes(validateGoldenCaseStructure(c))).toContain('golden_schema_version_unknown')
  })

  it('n’accepte pas `_comment`, contrairement au contrat du runner', () => {
    const c = casSigne()
    c._comment = 'documentation'
    expect(codes(validateGoldenCaseStructure(c))).toContain('golden_root_key_unknown')
  })
})

// ── PROFIL D'ÉVALUATION ─────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — evaluationProfile', () => {
  it('refuse un RULE PACK ID employé comme lensId', () => {
    const c = casSigne()
    c.evaluationProfile.lensId = 'real-estate-fabel'
    c.executionContext.businessContext.lensId = 'real-estate-fabel'
    expect(codes(validateGoldenCaseStructure(c))).toContain('profile_lens_unknown')
  })

  it('refuse une version de lens divergente du registre', () => {
    const c = casSigne()
    c.evaluationProfile.lensVersion = 'v9.9'
    c.executionContext.businessContext.lensVersion = 'v9.9'
    expect(codes(validateGoldenCaseStructure(c))).toContain('profile_lens_version_mismatch')
  })

  it('refuse un profil et un Business Context de lens différentes', () => {
    const c = casSigne()
    c.executionContext.businessContext.lensId = 'sales-default'
    expect(codes(validateGoldenCaseStructure(c))).toContain('profile_lens_mismatch')
  })

  it('refuse un rail inconnu', () => {
    const c = casSigne()
    c.evaluationProfile.rail = 'RELEVANCE'
    expect(codes(validateGoldenCaseStructure(c))).toContain('profile_rail_unknown')
  })
})

// ── PROVENANCE ──────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — provenance', () => {
  it('refuse un horodatage plus précis que le jour', () => {
    const c = casSigne()
    c.provenance.adjudicatedOn = '2026-08-23T00:00:00.000Z'
    expect(codes(validateGoldenCaseStructure(c))).toContain('provenance_timestamp_over_precise')
  })

  it('refuse une provenance incomplète', () => {
    const c = casSigne()
    delete c.provenance.adjudicationProtocol
    expect(codes(validateGoldenCaseStructure(c))).toContain('provenance_incomplete')
  })
})

// ── ANCRAGE RAW (forme seulement — l'ancrage réel est testé ailleurs) ───────

describe('GOLDEN-SCHEMA-001a — rawSource', () => {
  it('exige `datasetPath`', () => {
    const c = casSigne()
    delete c.rawSource.datasetPath
    expect(codes(validateGoldenCaseStructure(c))).toContain('raw_source_incomplete')
  })
})

// ── HYPOTHÈSES DE REJEU ─────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — assumptions', () => {
  it('refuse une pertinence hors [0,1]', () => {
    const c = casSigne()
    c.assumptions.targetRelevance.value = 1.4
    expect(codes(validateGoldenCaseStructure(c))).toContain('assumptions_invalid')
  })

  it('refuse une constante sans justification', () => {
    const c = casSigne()
    c.assumptions.evidenceConfidence.rationale = ''
    expect(codes(validateGoldenCaseStructure(c))).toContain('assumptions_invalid')
  })
})

// ── ADJUDICATION ────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — adjudication', () => {
  it('refuse deux adjudications de la même Evidence RAW', () => {
    const c = casSigne()
    c.adjudication.rawEvidence.push(clone(c.adjudication.rawEvidence[0]))
    expect(codes(validateGoldenCaseStructure(c))).toContain('raw_evidence_adjudication_duplicate')
  })

  it('exige `decompositionStatus: COMPLETE`', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].decompositionStatus = 'PARTIAL'
    expect(codes(validateGoldenCaseStructure(c))).toContain('decomposition_status_invalid')
  })

  it('refuse une Evidence RAW sans claim', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims = []
    expect(codes(validateGoldenCaseStructure(c))).toContain('raw_evidence_claims_empty')
  })

  it('refuse des claimIndex non contigus', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].claimIndex = 3
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_index_non_contiguous')
  })

  it('refuse une décision de mapping inconnue', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].mappingDecision = 'PROBABLY'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_mapping_decision_unknown')
  })

  it('refuse deux evidenceId identiques', () => {
    const c = casTypeManquant()
    const claim = clone(c.adjudication.rawEvidence[0].claims[0])
    c.adjudication.rawEvidence[1].claims = [{ ...claim, claimIndex: 0 }]
    c.executability = 'EXECUTABLE'
    c.caseStatus = { state: 'SIGNED_SEMANTIC_GOLDEN', blockers: [] }
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_evidence_id_duplicate')
  })

  it('refuse une claim rattachée à un compte hors executionContext', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].targetAccountId = 'autre-compte'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_account_unknown')
  })
})

// ── SÉMANTIQUE VS MAPPING RUNTIME ───────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — sémantique ≠ mapping runtime', () => {
  it('CONSERVE la sémantique d’une claim MISSING_TYPE', () => {
    // La régression que ce test verrouille : une version antérieure n'autorisait
    // `assertionType` / `temporalNature` / `occurredAt` que sur `MAPPED`. Elle
    // aurait supprimé l'analyse qui JUSTIFIE d'ouvrir un ticket de taxonomie.
    const r = validateGoldenCaseStructure(casTypeManquant())
    expect(r.ok).toBe(true)
  })

  it('refuse un champ de mapping runtime hors MAPPED', () => {
    const c = casTypeManquant()
    c.adjudication.rawEvidence[1].claims[0].evidenceType = 'recent_funding'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_runtime_fields_without_mapped')
  })

  it('exige un rationale hors MAPPED', () => {
    const c = casTypeManquant()
    delete c.adjudication.rawEvidence[1].claims[0].rationale
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_rationale')
  })

  it('exige les champs de mapping runtime sur MAPPED', () => {
    const c = casSigne()
    delete c.adjudication.rawEvidence[0].claims[0].evidenceScope
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_runtime_fields')
  })
})

// ── REVUE DE SOURCE ─────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — revue de source', () => {
  it('refuse une claim MAPPED sans revue', () => {
    const c = casSigne()
    delete c.adjudication.rawEvidence[0].claims[0].sourceReview
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_source_review')
  })

  it('refuse une claim MAPPED dont la seule revue est NOT_REVIEWED', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].sourceReview = [{ reviewClass: 'NOT_REVIEWED' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_source_review')
  })

  it('l’exigence vaut AUSSI dans un cas bloqué', () => {
    // Une Evidence runtime ne doit jamais naître d'une claim non examinée, même
    // si le cas ne s'exécute pas aujourd'hui : il s'exécutera un jour.
    const c = casTypeManquant()
    c.adjudication.rawEvidence[0].claims[0].sourceReview = [{ reviewClass: 'NOT_REVIEWED' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_source_review')
  })

  it('refuse une classe de revue inconnue', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].sourceReview = [{ reviewClass: 'J’AI_REGARDÉ' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_source_review_invalid')
  })
})

// ── PROVIDER RUNTIME ────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — provider runtime', () => {
  it('refuse une catégorie inventée non justifiée', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].runtimeSource.provider = 'web-press'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_provider_unjustified')
  })

  it('accepte un provider distinct s’il est justifié', () => {
    const c = casSigne()
    // Le provider synthétique n'est alors plus employé : le déclarer quand même
    // serait une hypothèse fausse (cf. `synthetic_provider_unused`).
    delete c.assumptions.syntheticRuntimeProvider
    c.adjudication.rawEvidence[0].claims[0].runtimeSource.provider = 'pappers'
    c.adjudication.rawEvidence[0].claims[0].rationale = 'Identité de provider d’ingestion réelle.'
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('refuse tout provider s’écartant du synthétique sans justification', () => {
    // ⚠️ RÈGLE GÉNÉRIQUE, non spécifique à un vertical : elle ne dit pas ce
    // qu'un provider signifie, seulement qu'il doit être justifié. Elle couvre
    // donc aussi les providers sensibles d'un pack, sans que l'infrastructure
    // n'importe la liste blanche de ce pack.
    for (const provider of ['client-declared', 'fabel-crm', 'web-press', 'n-importe-quoi']) {
      const c = casSigne()
      c.adjudication.rawEvidence[0].claims[0].runtimeSource.provider = provider
      expect(codes(validateGoldenCaseStructure(c))).toContain('claim_provider_unjustified')
    }
  })
})

// ── MODÈLE TEMPOREL ─────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — nature ≠ précision', () => {
  it('table de projection', () => {
    expect(projectTemporality('EVENT', 'DAY').kind).toBe('dated_event')
    expect(projectTemporality('EVENT', 'TIMESTAMP').kind).toBe('dated_event')
    expect(projectTemporality('STATE', 'UNKNOWN').kind).toBe('undated_state')
    expect(projectTemporality('STATE', 'DAY').kind).toBe('undated_state')
    expect(projectTemporality('EVENT', 'MONTH').kind).toBe('gap')
    expect(projectTemporality('EVENT', 'YEAR').kind).toBe('gap')
    expect(projectTemporality('EVENT', 'UNKNOWN').kind).toBe('gap')
    expect(projectTemporality('UNKNOWN', 'DAY').kind).toBe('gap')
  })

  it('un ÉVÉNEMENT de date inconnue n’est JAMAIS un état non daté', () => {
    // `undated_state` affirme un état constaté d'ancienneté inconnue ; un
    // événement dont la date nous échappe est autre chose, et
    // `contradictionBloquante` traite les deux différemment.
    expect(projectTemporality('EVENT', 'UNKNOWN').kind).toBe('gap')
    expect(projectTemporality('STATE', 'UNKNOWN').kind).toBe('undated_state')
  })

  it('un trou de précision est un cas BLOQUÉ VALIDE, pas un schéma malformé', () => {
    // ⚠️ LE DÉFAUT QUE CE TEST VERROUILLE. Une version antérieure émettait une
    // erreur STRUCTURELLE dès qu'une claim MAPPED ne projetait pas. Elle rendait
    // invalide un cas parfaitement légitime — GD-025, dont les licenciements
    // sont un ÉVÉNEMENT réel de date inconnue — et forçait donc l'auteur à
    // INVENTER un jour pour rendre son fichier acceptable. L'exact contraire de
    // ce que ce corpus protège.
    const c = casGD025()

    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
    expect(validateGoldenCase(c).ok).toBe(true)

    // …et la projection, elle, refuse toujours.
    const projete = projectGoldenCase(c)
    expect(projete.ok).toBe(false)
  })

  it('le même cas SANS blocage déclaré est refusé', () => {
    const c = casGD025()
    c.caseStatus.blockers = []
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('refuse `occurredAt` sur un STATE', () => {
    const c = casSigne()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.temporalNature = 'STATE'
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_temporality_mismatch',
    )
  })

  it('exige `occurredAt` sur un EVENT daté', () => {
    const c = casSigne()
    delete c.adjudication.rawEvidence[0].claims[0].occurredAt
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_temporality_mismatch',
    )
  })

  it('refuse une nature temporelle inconnue', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].temporalNature = 'PROBABLEMENT_PASSÉ'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_temporal_nature_unknown')
  })

  it('`claimEstBloquante` classe chaque décision', () => {
    expect(claimEstBloquante({ mappingDecision: 'MISSING_TYPE' } as any)).toBe('EVIDENCE_TYPE_GAP')
    expect(claimEstBloquante({ mappingDecision: 'SOURCE_UNVERIFIED' } as any)).toBe(
      'SOURCE_REVIEW_REQUIRED',
    )
    expect(
      claimEstBloquante({ mappingDecision: 'NOT_MAPPABLE', exclusionClass: 'DATASET_METADATA' } as any),
    ).toBeNull()
    expect(
      claimEstBloquante({
        mappingDecision: 'MAPPED',
        temporalNature: 'EVENT',
        temporalPrecision: 'MONTH',
      } as any),
    ).toBe('TEMPORAL_PRECISION_GAP')
  })
})

// ── NOT_MAPPABLE ────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — NOT_MAPPABLE', () => {
  function avecExclusion(exclusionClass: string, extra: any = {}): any {
    const c = casSigne()
    c.adjudication.rawEvidence.push({
      rawEvidenceId: 'TEST-ev2',
      decompositionStatus: 'COMPLETE',
      claims: [
        {
          claimIndex: 0,
          semanticClaim: 'Commentaire éditorial du corpus.',
          mappingDecision: 'NOT_MAPPABLE',
          exclusionClass,
          rationale: 'Hors du modèle Evidence.',
          sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
          ...extra,
        },
      ],
    })
    return c
  }

  it('est NON BLOQUANT : un cas peut rester signé', () => {
    const r = validateGoldenCaseStructure(avecExclusion('NON_FACTUAL_NARRATIVE'))
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('exige une exclusionClass — LE GARDE-FOU', () => {
    const c = avecExclusion('NON_FACTUAL_NARRATIVE')
    delete c.adjudication.rawEvidence[1].claims[0].exclusionClass
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_exclusion_class_missing')
  })

  it('refuse une exclusionClass inconnue — pas de « fait métier non typé »', () => {
    // La tentative que ce test bloque : requalifier un trou de taxonomie en
    // exclusion pour rendre le cas exécutable.
    const c = avecExclusion('BUSINESS_FACT_WITHOUT_TYPE')
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_exclusion_class_missing')
  })

  it('exige une revue réelle', () => {
    const c = avecExclusion('DATASET_METADATA')
    c.adjudication.rawEvidence[1].claims[0].sourceReview = [{ reviewClass: 'NOT_REVIEWED' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_source_review')
  })

  it('exige une référence structurée pour DUPLICATE_OF_CLAIM', () => {
    const c = avecExclusion('DUPLICATE_OF_CLAIM')
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_duplicate_reference_missing')
  })

  it('refuse un doublon désignant une claim inexistante', () => {
    const c = avecExclusion('DUPLICATE_OF_CLAIM', {
      duplicateOf: { rawEvidenceId: 'TEST-ev9', claimIndex: 0 },
    })
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_duplicate_reference_unknown')
  })

  it('accepte un doublon désignant une claim existante', () => {
    const c = avecExclusion('DUPLICATE_OF_CLAIM', {
      duplicateOf: { rawEvidenceId: 'TEST-ev1', claimIndex: 0 },
    })
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('refuse une exclusionClass hors NOT_MAPPABLE', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].exclusionClass = 'DATASET_METADATA'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_exclusion_class_unexpected')
  })
})

// ── ORACLE PARTIEL ──────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — oracle partiel', () => {
  it('un cas signé PEUT porter des UNSPECIFIED', () => {
    // La régression que ce test verrouille : une version antérieure exigeait
    // l'exhaustivité et fabriquait donc des FORBIDDEN non adjugés, déduits des
    // tables de familles — c'est-à-dire du code que le corpus doit juger.
    const c = casSigne()
    expect(c.expected.situations.space_contraction.assertion).toBe('UNSPECIFIED')
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('refuse un cas signé entièrement UNSPECIFIED', () => {
    const c = casSigne()
    c.expected.situations.space_expansion.assertion = 'UNSPECIFIED'
    expect(codes(validateGoldenCaseStructure(c))).toContain('signed_case_without_assertion')
  })

  it('exige un rationale, y compris sur UNSPECIFIED', () => {
    const c = casSigne()
    c.expected.situations.space_contraction.rationale = ''
    expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_rationale_missing')
  })

  it('refuse un SituationType inconnu', () => {
    const c = casSigne()
    c.expected.situations.attention_queue_top = { assertion: 'REQUIRED', rationale: 'x' }
    expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_situation_unknown')
  })

  it('refuse un SituationType INACTIF pour la lens', () => {
    // `sales_scale_up` existe globalement mais aucun pack de `fabel-broker` ne
    // le déclare : l'attente serait INERTE, trivialement satisfaite.
    const actifsSales = situationTypesActifsPourLens('sales-default')
    const inactif = [...(actifsSales ?? [])].find(
      (t) => !(situationTypesActifsPourLens('fabel-broker') ?? new Set()).has(t),
    )
    expect(inactif).toBeTruthy()

    const c = casSigne()
    c.expected.situations[inactif!] = { assertion: 'FORBIDDEN', rationale: 'x' }
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'expectation_situation_inactive_for_lens',
    )
  })

  it('refuse un SituationType actif ABSENT', () => {
    const c = casSigne()
    delete c.expected.situations.flex_remove_window
    expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_missing_active_situation')
  })

  it('refuse une clé RAIL R dans `expected`', () => {
    const c = casSigne()
    c.expected.behavior = 'RESEARCH_ONLY'
    expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_forbidden_key')
  })

  it('refuse une assertion inconnue', () => {
    const c = casSigne()
    c.expected.situations.space_expansion.assertion = 'PROBABLE'
    expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_assertion_unknown')
  })
})

// ── LEGACY ASSESSMENT ───────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — legacyAssessment', () => {
  it('exige un JSON Pointer', () => {
    const c = casSigne()
    c.legacyAssessment.items[0].rawRef = 'expected.primaryHypothesis'
    expect(codes(validateGoldenCaseStructure(c))).toContain('legacy_raw_ref_invalid')
  })

  it('refuse une portée inconnue', () => {
    const c = casSigne()
    c.legacyAssessment.items[0].scope = 'RAIL_X'
    expect(codes(validateGoldenCaseStructure(c))).toContain('legacy_scope_unknown')
  })

  it('refuse un statut inconnu', () => {
    const c = casSigne()
    c.legacyAssessment.items[0].status = 'REFUTED'
    expect(codes(validateGoldenCaseStructure(c))).toContain('legacy_status_unknown')
  })

  it('accepte NOT_SUPPORTED sans imposer l’attente inverse', () => {
    // Le point critique GD-003 : réfuter le SOUTIEN d'un libellé n'affirme pas
    // sa négation. Le cas reste UNSPECIFIED sur la Situation concernée.
    const c = casSigne()
    c.expected.situations.space_expansion = {
      assertion: 'UNSPECIFIED',
      rationale: 'Neutralité délibérée malgré un libellé historique non soutenu.',
    }
    c.expected.situations.space_contraction = {
      assertion: 'FORBIDDEN',
      rationale: 'Aucune famille de contraction adjugée.',
    }
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })
})

// ── CASE STATUS ─────────────────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — caseStatus', () => {
  it('refuse un cas signé portant un blocage', () => {
    const c = casSigne()
    c.caseStatus.blockers = [{ kind: 'EVIDENCE_TYPE_GAP', note: 'x' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('case_status_executability_mismatch')
  })

  it('refuse un cas bloqué déclaré EXECUTABLE', () => {
    const c = casTypeManquant()
    c.executability = 'EXECUTABLE'
    expect(codes(validateGoldenCaseStructure(c))).toContain('case_status_executability_mismatch')
  })

  it('refuse un cas BLOCKED sans aucun blocage', () => {
    const c = casSigne()
    c.caseStatus.state = 'BLOCKED'
    c.executability = 'ADJUDICATED_NON_EXECUTABLE'
    expect(codes(validateGoldenCaseStructure(c))).toContain('case_status_executability_mismatch')
  })

  it('refuse un blocage réel non déclaré', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers = []
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('refuse un blocage déclaré qu’aucune claim n’impose', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers.push({ kind: 'SOURCE_REVIEW_REQUIRED', note: 'inventé' })
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('accepte PLUSIEURS blocages de nature différente, sans priorité', () => {
    // GD-025 dans le monde réel : un trou de taxonomie ET une date
    // inexploitable. Un `primaryStatus` unique en aurait caché un.
    const c = casGD025()
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
    expect(c.caseStatus.blockers.map((b: any) => b.kind).sort()).toEqual([
      'EVIDENCE_TYPE_GAP',
      'TEMPORAL_PRECISION_GAP',
    ])
  })


  it('refuse un genre de blocage inconnu', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers = [{ kind: 'EVIDENCE_TYPE_GAP_AND_TEMPORAL', note: 'composite' }]
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_kind_unknown')
  })
})

// ── SONDE DU CONTEXTE D'EXÉCUTION ───────────────────────────────────────────
//
// `executionContext` est persisté même pour un cas BLOQUÉ, précisément pour que
// lever un blocage ne demande pas d'inventer plus tard des données d'exécution.
// Il doit donc être valide DÈS MAINTENANT — sans quoi on découvrirait un
// contexte cassé des mois après, au moment où l'on croit avoir fini.

describe('GOLDEN-SCHEMA-001a — sonde du contexte d’exécution', () => {
  it('refuse un Business Context incomplet, via le validateur DU RUNNER', () => {
    const c = casSigne()
    delete c.executionContext.businessContext.contextId
    const r = validateGoldenCaseStructure(c)
    expect(codes(r)).toContain('business_context_context_id_missing')
    expect(chemins(r)).toContain('executionContext.businessContext')
  })

  it('refuse des targets vides', () => {
    const c = casSigne()
    c.executionContext.targets = []
    expect(codes(validateGoldenCaseStructure(c))).toContain('targets_empty')
  })

  it('refuse une cible en double', () => {
    const c = casSigne()
    c.executionContext.targets.push({ accountId: 'test-acct' })
    expect(codes(validateGoldenCaseStructure(c))).toContain('target_duplicate')
  })

  it('refuse une cible hors du périmètre du Business Context', () => {
    const c = casSigne()
    c.executionContext.businessContext.scope = { mode: 'accounts', accountIds: ['autre'] }
    expect(codes(validateGoldenCaseStructure(c))).toContain('target_out_of_scope')
  })

  it('refuse un champ d’éligibilité inconnu', () => {
    const c = casSigne()
    c.executionContext.targets[0].eligibility = { optedOut: false, inventé: true }
    expect(codes(validateGoldenCaseStructure(c))).toContain('target_eligibility_unknown_field')
  })

  // ── LES MÊMES, SUR UN CAS BLOQUÉ ──────────────────────────────────────────
  // C'est le point de ce lot : la sonde ne dépend pas de l'exécutabilité.

  it('BLOQUÉ + contextId manquant est refusé MAINTENANT', () => {
    const c = casTypeManquant()
    delete c.executionContext.businessContext.contextId
    expect(codes(validateGoldenCaseStructure(c))).toContain('business_context_context_id_missing')
  })

  it('BLOQUÉ + targets vides est refusé MAINTENANT', () => {
    const c = casTypeManquant()
    c.executionContext.targets = []
    const r = validateGoldenCaseStructure(c)
    expect(codes(r)).toContain('targets_empty')
  })

  it('BLOQUÉ + cible hors périmètre est refusé MAINTENANT', () => {
    const c = casTypeManquant()
    c.executionContext.businessContext.scope = { mode: 'accounts', accountIds: ['autre'] }
    expect(codes(validateGoldenCaseStructure(c))).toContain('target_out_of_scope')
  })

  it('BLOQUÉ + cible en double est refusé MAINTENANT', () => {
    const c = casTypeManquant()
    c.executionContext.targets.push({ accountId: 'test-acct' })
    expect(codes(validateGoldenCaseStructure(c))).toContain('target_duplicate')
  })

  it('remappe les chemins de la sonde vers les champs Golden RÉELS', () => {
    const c = casSigne()
    c.assumptions.now.value = 'pas-une-date'
    const r = validateGoldenCaseStructure(c)
    expect(chemins(r)).toContain('assumptions.now.value')
  })

  it('la sonde n’injecte AUCUNE evidence — un cas bloqué reste validable', () => {
    // Si la sonde projetait les claims, `casTypeManquant()` échouerait sur sa
    // claim MISSING_TYPE au lieu d'être accepté.
    expect(validateGoldenCaseStructure(casTypeManquant()).ok).toBe(true)
  })
})

// ── AUCUN CHEMIN `input.` ───────────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — chemins d’erreur réels', () => {
  it('aucun chemin rendu ne commence par `input.`', () => {
    // La racine `input` a été SUPPRIMÉE du contrat (R2). Un chemin qui la nomme
    // enverrait le lecteur corriger un champ qui n'existe pas dans le fichier.
    const casCasses = [
      () => {
        const c = casSigne()
        delete c.executionContext.businessContext.contextId
        return c
      },
      () => {
        const c = casSigne()
        c.executionContext.targets = []
        return c
      },
      () => {
        const c = casSigne()
        c.assumptions.now.value = 'pas-une-date'
        return c
      },
      () => {
        const c = casSigne()
        c.adjudication.rawEvidence[0].claims[0].evidenceType = 'type_inexistant'
        return c
      },
      () => {
        const c = casSigne()
        c.executionContext.targets[0].eligibility = { inventé: true }
        return c
      },
    ]

    for (const construire of casCasses) {
      const golden = construire()
      const resultats = [validateGoldenCaseStructure(golden), validateGoldenCase(golden)]

      // ⚠️ Les deux couches ne rejettent PAS les mêmes choses, et c'est voulu :
      // un `evidenceType` inconnu n'apparaît qu'à la projection. On exige donc
      // qu'AU MOINS une couche refuse, et qu'aucune ne rende un chemin fantôme.
      expect(resultats.some((r) => r.ok === false)).toBe(true)

      for (const r of resultats) {
        for (const chemin of chemins(r)) {
          expect(chemin.startsWith('input.')).toBe(false)
        }
      }
    }
  })
})

// ── VALIDATION COMPLÈTE (couche supérieure) ─────────────────────────────────

describe('GOLDEN-SCHEMA-001a — validateGoldenCase', () => {
  it('accepte les deux témoins', () => {
    expect(validateGoldenCase(casSigne()).ok).toBe(true)
    expect(validateGoldenCase(casTypeManquant()).ok).toBe(true)
  })

  it('remonte les erreurs du runner sous `projectedEvalCase.`', () => {
    const c = casSigne()
    // Type d'evidence INACTIF pour la lens Fabel — détecté par le validateur du
    // runner sur le cas PROJETÉ, pas réimplémenté ici.
    c.adjudication.rawEvidence[0].claims[0].evidenceType = 'sales_signal_inexistant'
    const r = validateGoldenCase(c)
    expect(r.ok).toBe(false)
    expect(chemins(r).some((p) => p.startsWith('projectedEvalCase.'))).toBe(true)
  })

  it('nomme l’evidence fautive par son evidenceId, l’indice trié étant inutilisable', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].evidenceType = 'sales_signal_inexistant'
    const r = validateGoldenCase(c)
    expect(r.ok === false && r.errors.some((e) => e.message.includes('test-ev1'))).toBe(true)
  })

  it('ne projette pas un cas bloqué', () => {
    // La claim MISSING_TYPE n'a aucun `evidenceType` : si la couche supérieure
    // projetait quand même, elle échouerait ici.
    expect(validateGoldenCase(casTypeManquant()).ok).toBe(true)
  })
})

// ── PROVIDER SYNTHÉTIQUE : OPTIONNEL ET CONDITIONNEL ────────────────────────

describe('GOLDEN-SCHEMA-001a — provider synthétique conditionnel', () => {
  it('peut être ABSENT si chaque claim MAPPED porte un provider justifié', () => {
    const c = casSigne()
    delete c.assumptions.syntheticRuntimeProvider
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.runtimeSource.provider = 'pappers'
    claim.rationale = 'Identité de provider d’ingestion réelle.'
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('absent, un provider NON justifié reste refusé', () => {
    const c = casSigne()
    delete c.assumptions.syntheticRuntimeProvider
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_provider_unjustified')
  })

  it('déclaré mais employé par AUCUNE claim MAPPED est refusé', () => {
    const c = casSigne()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.runtimeSource.provider = 'pappers'
    claim.rationale = 'Identité de provider d’ingestion réelle.'
    expect(codes(validateGoldenCaseStructure(c))).toContain('synthetic_provider_unused')
  })

  it('présent mais malformé reste refusé', () => {
    const c = casSigne()
    c.assumptions.syntheticRuntimeProvider = { rationale: 'sans valeur' }
    expect(codes(validateGoldenCaseStructure(c))).toContain('assumptions_invalid')
  })
})

// ── LIAISON DES CIBLES ──────────────────────────────────────────────────────
//
// Les champs `evidenceScope` / `targetAccountId` / `targetPersonId` sont les
// LIAISONS runtime. Ils doivent reproduire la sémantique de
// `evidenceMatchesTarget()`, jamais en créer une seconde.

describe('GOLDEN-SCHEMA-001a — liaison des cibles', () => {
  it('refuse un compte inconnu de executionContext', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].targetAccountId = 'compte-fantome'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_account_unknown')
  })

  it('refuse une evidence liée à une PERSONNE qu’aucune cible ne nomme', () => {
    // Sémantique du kernel : une evidence portant `personId` n'est consommable
    // QUE par la cible (compte, personne). Une cible « compte » seule ne suffit
    // pas — le moteur l'écarterait en silence.
    //
    // ⚠️ Détecté par la SONDE DE LIAISON, donc dès la validation structurelle et
    // non plus seulement à la projection : la règle vaut désormais aussi pour un
    // cas BLOQUÉ, qui ne se projette jamais.
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].targetPersonId = 'personne-absente'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_binding_unmatched')
    expect(codes(validateGoldenCase(c))).toContain('claim_target_binding_unmatched')
  })

  it('accepte une evidence de personne quand la cible correspondante existe', () => {
    const c = casSigne()
    c.executionContext.targets = [{ accountId: 'test-acct', personId: 'p1' }]
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.targetPersonId = 'p1'
    claim.evidenceScope = 'person'
    expect(validateGoldenCase(c).ok).toBe(true)
  })

  it('refuse une evidence de portée `person` SANS personId face à une cible personne', () => {
    // Miroir exact de `evidenceMatchesTarget` : scope person + personId absent
    // ⇒ écartée au niveau personne. Aucune cible ne peut la consommer.
    const c = casSigne()
    c.executionContext.targets = [{ accountId: 'test-acct', personId: 'p1' }]
    c.adjudication.rawEvidence[0].claims[0].evidenceScope = 'person'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_binding_unmatched')
  })
})

// ── CONTRÔLES INDÉPENDANTS DU BUILDER PARTAGÉ ───────────────────────────────
//
// ⚠️ RISQUE DE TESTS CORRÉLÉS. Tout ce qui précède part de `casSigne()`. Si ce
// builder devenait subtilement faux — ou si le validateur s'accordait avec lui
// par accident — chaque « négatif » ne prouverait plus que « ce builder, muté à
// cet endroit, est refusé », jamais que le contrat est réellement fermé.
//
// Les objets ci-dessous sont écrits À LA MAIN, littéralement, sans passer par
// `golden-fixtures.ts`. Ils vérifient que le validateur refuse ce qui n'a jamais
// ressemblé à un cas Golden — et qu'il l'a bien fait pour la BONNE raison.

describe('GOLDEN-SCHEMA-001a — contrôles indépendants', () => {
  it('refuse un objet vide en nommant CHAQUE clé racine manquante', () => {
    const r = validateGoldenCaseStructure({})
    expect(r.ok).toBe(false)
    const manquantes = r.ok === false
      ? r.errors.filter((e) => e.code === 'golden_root_key_missing').map((e) => e.path)
      : []
    // Les douze, ni plus ni moins : le contrat est fermé DANS LES DEUX SENS.
    expect(manquantes.sort()).toEqual(
      [
        'adjudication',
        'assumptions',
        'caseId',
        'caseStatus',
        'evaluationProfile',
        'executability',
        'executionContext',
        'expected',
        'goldenSchemaVersion',
        'legacyAssessment',
        'provenance',
        'rawSource',
      ].sort(),
    )
  })

  it('refuse un objet ne portant QUE la bonne version de contrat', () => {
    const r = validateGoldenCaseStructure({ goldenSchemaVersion: GOLDEN_SCHEMA_VERSION })
    expect(r.ok).toBe(false)
    expect(codes(r)).not.toContain('golden_schema_version_unknown')
    expect(codes(r)).toContain('golden_root_key_missing')
  })

  it('refuse des scalaires et des tableaux', () => {
    for (const valeur of [undefined, null, 0, '', 'golden', true, [], [{}]]) {
      expect(validateGoldenCaseStructure(valeur).ok).toBe(false)
    }
  })

  it('la table temporelle est exhaustive, sans passer par aucune fixture', () => {
    const natures = ['EVENT', 'STATE', 'UNKNOWN'] as const
    const precisions = ['TIMESTAMP', 'DAY', 'MONTH', 'YEAR', 'UNKNOWN'] as const
    const attendu: Record<string, string> = {
      'EVENT|TIMESTAMP': 'dated_event',
      'EVENT|DAY': 'dated_event',
      'EVENT|MONTH': 'gap',
      'EVENT|YEAR': 'gap',
      'EVENT|UNKNOWN': 'gap',
      'STATE|TIMESTAMP': 'undated_state',
      'STATE|DAY': 'undated_state',
      'STATE|MONTH': 'undated_state',
      'STATE|YEAR': 'undated_state',
      'STATE|UNKNOWN': 'undated_state',
      'UNKNOWN|TIMESTAMP': 'gap',
      'UNKNOWN|DAY': 'gap',
      'UNKNOWN|MONTH': 'gap',
      'UNKNOWN|YEAR': 'gap',
      'UNKNOWN|UNKNOWN': 'gap',
    }
    // Les 15 combinaisons, énumérées : aucune n'est laissée au hasard.
    for (const n of natures) {
      for (const p of precisions) {
        expect(projectTemporality(n, p).kind).toBe(attendu[`${n}|${p}`])
      }
    }
  })

  it('`claimEstBloquante` sur des claims littérales', () => {
    expect(claimEstBloquante({ mappingDecision: 'MAPPED' } as any)).toBe('TEMPORAL_PRECISION_GAP')
    expect(
      claimEstBloquante({
        mappingDecision: 'MAPPED',
        temporalNature: 'STATE',
        temporalPrecision: 'UNKNOWN',
      } as any),
    ).toBeNull()
  })

  it('le témoin partagé n’est pas la seule porte : un cas écrit à la main passe', () => {
    // Contre-preuve du risque de corrélation : le validateur n'accepte pas
    // seulement « l'objet de golden-fixtures ». Ce cas est écrit ici, sans
    // aucun `casSigne()`, avec des identifiants différents.
    const aLaMain: any = {
      goldenSchemaVersion: GOLDEN_SCHEMA_VERSION,
      caseId: 'INDEP-001',
      evaluationProfile: { rail: 'SEMANTIC', lensId: 'fabel-broker', lensVersion: 'v0.1' },
      provenance: {
        materializationTicket: 'T',
        adjudicationProtocol: 'P',
        adjudicatedOn: '2026-01-02',
      },
      rawSource: {
        datasetPath: 'p',
        datasetSchemaVersion: 's',
        datasetVersion: 'v',
        datasetSha256: 'h',
        originalCaseId: 'GD-000',
      },
      assumptions: {
        now: { value: '2026-08-07', source: 's', precision: 'DAY' },
        observedAt: { value: '2026-08-07', source: 's' },
        targetRelevance: { value: 0.5, rationale: 'r' },
        evidenceConfidence: { value: 1, rationale: 'r' },
      },
      adjudication: {
        rawEvidence: [
          {
            rawEvidenceId: 'X-ev1',
            decompositionStatus: 'COMPLETE',
            claims: [
              {
                claimIndex: 0,
                semanticClaim: 'Un état de difficulté financière est constaté.',
                mappingDecision: 'MAPPED',
                assertionType: 'fact',
                temporalNature: 'STATE',
                temporalPrecision: 'UNKNOWN',
                evidenceType: 'financial_distress',
                evidenceId: 'x1',
                evidenceScope: 'account',
                targetAccountId: 'indep-acct',
                runtimeSource: { provider: 'pappers' },
                rationale: 'Identité de provider d’ingestion réelle.',
                sourceReview: [{ reviewClass: 'RAW_SOURCE_DIRECTLY_REVIEWED' }],
              },
            ],
          },
        ],
      },
      executability: 'EXECUTABLE',
      executionContext: {
        businessContext: {
          contextId: 'indep',
          contextVersion: 'v0.1',
          role: 'analyst',
          scope: { mode: 'accounts', accountIds: ['indep-acct'] },
          authorizedMotions: { email_outbound: 'approval_required' },
          lensId: 'fabel-broker',
          lensVersion: 'v0.1',
        },
        targets: [{ accountId: 'indep-acct' }],
      },
      expected: {
        situations: {
          space_expansion: { assertion: 'UNSPECIFIED', rationale: 'r' },
          space_contraction: { assertion: 'REQUIRED', rationale: 'r' },
          flex_remove_window: { assertion: 'UNSPECIFIED', rationale: 'r' },
        },
      },
      legacyAssessment: {
        items: [{ rawRef: '/expected', scope: 'RAIL_S', status: 'SUPPORTED', rationale: 'r' }],
      },
      caseStatus: { state: 'SIGNED_SEMANTIC_GOLDEN', blockers: [] },
    }

    const r = validateGoldenCase(aLaMain)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })
})

// ── COMPATIBILITÉ AVEC LA POLITIQUE DU PACK PILOTE ──────────────────────────
//
// ⚠️ CE TEST A LE DROIT D'IMPORTER LE PACK ; L'INFRASTRUCTURE, NON.
// `goldenSchema.ts` est générique : il ne peut pas trancher universellement ce
// qu'est un provider « first-party » — la notion n'existe même pas dans
// `EvidenceSource`, et chaque pack en décide. Une version antérieure importait
// `FIRST_PARTY_PROVIDERS` depuis `packs/real-estate-fabel` : une inversion de
// couches qui aurait fait dépendre la validité d'un cas Golden, tous verticaux
// confondus, de la liste blanche d'UN pack.
//
// La garantie reste nécessaire pour le pilote. Elle est simplement exprimée
// LÀ OÙ ELLE EST VRAIE : au point de contact entre le corpus et le pack Fabel.
describe('GOLDEN-SCHEMA-001a — compatibilité pack pilote (intégration)', () => {
  it('la valeur synthétique du pilote n’est PAS first-party pour Fabel', () => {
    // Si elle l'était, une fixture emprunterait le raccourci first-party du pack
    // — un chemin de code atteint par accident, jamais par une source.
    const synthetique = casSigne().assumptions.syntheticRuntimeProvider.value

    expect(FIRST_PARTY_PROVIDERS).not.toContain(synthetique)
    expect(
      estFirstParty({ source: { provider: synthetique } } as any),
    ).toBe(false)
  })

  it('le contrôle mord : un provider réellement first-party est reconnu', () => {
    // Contre-preuve — sans elle, l'assertion ci-dessus passerait même si
    // `estFirstParty` rendait `false` en toutes circonstances.
    expect(estFirstParty({ source: { provider: FIRST_PARTY_PROVIDERS[0] } } as any)).toBe(true)
  })
})

// ── LIAISON DE CIBLE SUR CAS BLOQUÉ ─────────────────────────────────────────
//
// L'intégrité référentielle complète du runner ne s'applique qu'au cas PROJETÉ,
// et un cas BLOQUÉ ne se projette jamais. Ses claims DÉJÀ MAPPED doivent donc
// être liées correctement DÈS MAINTENANT — sinon on l'apprendrait après la levée
// d'un blocage sans rapport.

describe('GOLDEN-SCHEMA-001a — liaison de cible sur cas BLOQUÉ', () => {
  /** Cas BLOQUÉ dont la claim MAPPED vise une personne. */
  function bloqueAvecPersonne(cibles: any[], liaison: any): any {
    const c = casTypeManquant()
    c.executionContext.targets = cibles
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.evidenceScope = liaison.scope
    claim.targetAccountId = liaison.accountId
    if (liaison.personId !== undefined) claim.targetPersonId = liaison.personId
    return c
  }

  it('BLOQUÉ + claim personne + cible personne correspondante → accepté', () => {
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct', personId: 'p1' }],
      { scope: 'person', accountId: 'test-acct', personId: 'p1' },
    )
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('BLOQUÉ + claim personne + MAUVAISE personne → refusé', () => {
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct', personId: 'p1' }],
      { scope: 'person', accountId: 'test-acct', personId: 'p2' },
    )
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_binding_unmatched')
  })

  it('BLOQUÉ + claim personne + AUCUNE cible personne → refusé', () => {
    // Sémantique du kernel : une cible « compte » seule ne consomme pas une
    // evidence portant `personId`.
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct' }],
      { scope: 'person', accountId: 'test-acct', personId: 'p1' },
    )
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_binding_unmatched')
  })

  it('BLOQUÉ + claim de portée `person` SANS personId face à une cible personne → refusé', () => {
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct', personId: 'p1' }],
      { scope: 'person', accountId: 'test-acct' },
    )
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_target_binding_unmatched')
  })

  it('BLOQUÉ + claim de portée compte → accepté', () => {
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct' }],
      { scope: 'account', accountId: 'test-acct' },
    )
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('BLOQUÉ + claim SANS personId face à une cible personne → accepté', () => {
    // ⚠️ AUCUNE DOCTRINE PLUS STRICTE QUE LE KERNEL. Une evidence de compte
    // reste consommable par une cible personne du même compte : c'est ce que dit
    // `evidenceMatchesTarget`, et le Golden n'ajoute rien.
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct', personId: 'p1' }],
      { scope: 'account', accountId: 'test-acct' },
    )
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('l’erreur désigne la CLAIM, pas le cas dérivé', () => {
    const c = bloqueAvecPersonne(
      [{ accountId: 'test-acct' }],
      { scope: 'person', accountId: 'test-acct', personId: 'p1' },
    )
    const r = validateGoldenCaseStructure(c)
    const chemin = chemins(r).find((p) => p.includes('targetPersonId'))
    expect(chemin).toMatch(/^adjudication\.rawEvidence\[\d+\]\.claims\[\d+\]\./)
    expect(chemin?.startsWith('projectedEvalCase.')).toBe(false)
  })

  it('la sonde de ciblage n’est PAS une evidence fabriquée', () => {
    // Elle ne porte ni date, ni confiance, ni provider : rien qui puisse être
    // pris pour un fait. Preuve indirecte — une claim dont la temporalité ne
    // projette pas reste liable, donc la sonde n'a jamais eu besoin d'une date.
    const c = casTypeManquant()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.temporalPrecision = 'MONTH'
    delete claim.occurredAt
    c.caseStatus.blockers.push({
      kind: 'TEMPORAL_PRECISION_GAP',
      rawEvidenceId: 'TEST-ev1',
      claimIndex: 0,
      note: 'Précision insuffisante.',
    })
    expect(codes(validateGoldenCaseStructure(c))).not.toContain('claim_target_binding_unmatched')
  })
})

// ── DOUBLONS : NI CYCLE, NI CHAÎNE ──────────────────────────────────────────
//
// Prouver que la cible existe ne suffit pas : A → A et A ⇄ B écartent TOUTES les
// représentations du fait, qui disparaît alors sans qu'aucune règle ne semble
// violée. C'est précisément la suppression silencieuse que ce contrat interdit.

describe('GOLDEN-SCHEMA-001a — doublons sans cycle', () => {
  /** Ajoute une claim au cas et rend sa clé. */
  function ajouter(c: any, rawEvidenceId: string, claim: any): string {
    c.adjudication.rawEvidence.push({
      rawEvidenceId,
      decompositionStatus: 'COMPLETE',
      claims: [{ claimIndex: 0, ...claim }],
    })
    return `${rawEvidenceId}#0`
  }

  function doublon(duplicateOf: any): any {
    return {
      semanticClaim: 'Répétition d’un fait déjà adjugé.',
      mappingDecision: 'NOT_MAPPABLE',
      exclusionClass: 'DUPLICATE_OF_CLAIM',
      duplicateOf,
      rationale: 'Redit un fait conservé ailleurs.',
      sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
    }
  }

  it('A → A est refusé', () => {
    const c = casSigne()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-dupA', claimIndex: 0 }))
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_duplicate_self_reference')
  })

  it('A → B et B → A est refusé', () => {
    const c = casSigne()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-dupB', claimIndex: 0 }))
    ajouter(c, 'TEST-dupB', doublon({ rawEvidenceId: 'TEST-dupA', claimIndex: 0 }))
    const codesRendus = codes(validateGoldenCaseStructure(c))
    expect(codesRendus).toContain('claim_duplicate_target_is_duplicate')
    // Le cycle est signalé DES DEUX CÔTÉS : aucun des deux ne peut se prétendre
    // le survivant.
    expect(codesRendus.filter((k) => k === 'claim_duplicate_target_is_duplicate')).toHaveLength(2)
  })

  it('A → B où B est lui-même un doublon est refusé (chaîne)', () => {
    const c = casSigne()
    ajouter(c, 'TEST-dupB', doublon({ rawEvidenceId: 'TEST-ev1', claimIndex: 0 }))
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-dupB', claimIndex: 0 }))
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_duplicate_target_is_duplicate')
  })

  it('A → claim MAPPED canonique est accepté', () => {
    const c = casSigne()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-ev1', claimIndex: 0 }))
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('A → claim MISSING_TYPE canonique est accepté', () => {
    // Le canonique n'a pas à être exécutable : il doit seulement SUBSISTER comme
    // représentation du fait. Un `MISSING_TYPE` reste pleinement visible dans
    // l'adjudication, et bloque le cas — ce qui est le comportement voulu.
    const c = casTypeManquant()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-ev2', claimIndex: 0 }))
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('A → claim inexistante reste refusé', () => {
    const c = casSigne()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-fantome', claimIndex: 0 }))
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_duplicate_reference_unknown')
  })

  it('au moins une représentation du fait survit toujours', () => {
    // L'invariant que toutes les règles ci-dessus servent : il existe une claim
    // NON écartée comme doublon vers laquelle chaque doublon pointe.
    const c = casSigne()
    ajouter(c, 'TEST-dupA', doublon({ rawEvidenceId: 'TEST-ev1', claimIndex: 0 }))
    expect(validateGoldenCaseStructure(c).ok).toBe(true)

    const survivantes = c.adjudication.rawEvidence
      .flatMap((g: any) => g.claims)
      .filter((cl: any) => cl.exclusionClass !== 'DUPLICATE_OF_CLAIM')
    expect(survivantes.length).toBeGreaterThan(0)
  })
})

// ── F2 — BLOCAGES : IDENTITÉ EXACTE DE LA CLAIM ─────────────────────────────
//
// Comparer les seuls `kind` laissait passer un blocage attribué à la mauvaise
// claim, et faisait couvrir DEUX causes par UNE ligne. Celui qui corrigeait la
// claim nommée retrouvait le cas bloqué, sans motif visible.

describe('GOLDEN-SCHEMA-001a — blocages par identité exacte', () => {
  /** Cas bloqué par DEUX claims MISSING_TYPE distinctes. */
  function deuxTypesManquants(): any {
    const c = casTypeManquant()
    c.adjudication.rawEvidence.push({
      rawEvidenceId: 'TEST-ev3',
      decompositionStatus: 'COMPLETE',
      claims: [
        {
          claimIndex: 0,
          semanticClaim: 'Une production a été suspendue sur un site industriel.',
          mappingDecision: 'MISSING_TYPE',
          assertionType: 'fact',
          temporalNature: 'STATE',
          temporalPrecision: 'UNKNOWN',
          rationale: 'Aucun EvidenceType ne couvre la suspension de capacité industrielle.',
          sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
        },
      ],
    })
    return c
  }

  it('deux claims MISSING_TYPE + UN seul blocage → refusé', () => {
    const c = deuxTypesManquants()
    // Un seul blocage déclaré (celui de TEST-ev2) pour deux causes réelles.
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('un blocage EXACT par claim → accepté', () => {
    const c = deuxTypesManquants()
    c.caseStatus.blockers.push({
      kind: 'EVIDENCE_TYPE_GAP',
      rawEvidenceId: 'TEST-ev3',
      claimIndex: 0,
      note: 'Suspension de capacité industrielle.',
    })
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })

  it('bon genre + MAUVAIS rawEvidenceId → refusé', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers[0].rawEvidenceId = 'TEST-ev9'
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('bon genre + MAUVAIS claimIndex → refusé', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers[0].claimIndex = 7
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_inconsistent_with_claims')
  })

  it('`EXPECTATION_AMBIGUOUS` ne référence AUCUNE claim', () => {
    // Il porte sur l'attente, pas sur un fait : exiger une identité de claim
    // serait lui inventer une cause qu'il n'a pas.
    const c = casTypeManquant()
    c.caseStatus.blockers.push({
      kind: 'EXPECTATION_AMBIGUOUS',
      note: 'L’attente n’est pas décidable en l’état.',
    })
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })
})

// ── F3 — ASSERTION TYPE FERMÉ ───────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — assertionType fermé', () => {
  it('refuse « intent » sur une claim MISSING_TYPE BLOQUÉE', () => {
    // ⚠️ Le cas exact que ce contrat a tranché : une intention ANNONCÉE est un
    // `fact` observé — l'annonce a eu lieu — et c'est son CONTENU qui est
    // prospectif. Accepter `intent` rouvrirait la confusion épistémique, et le
    // ferait d'abord sur les claims bloquées, celles dont la sémantique survit
    // précisément pour justifier un futur ticket de taxonomie.
    const c = casTypeManquant()
    c.adjudication.rawEvidence[1].claims[0].assertionType = 'intent'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_assertion_type_unknown')
  })

  it('refuse toute valeur hors du catalogue, à TOUTE décision', () => {
    for (const valeur of ['intent', 'prediction', 'opinion', 'FACT', 'n’importe quoi', '']) {
      const mappee = casSigne()
      mappee.adjudication.rawEvidence[0].claims[0].assertionType = valeur
      expect(codes(validateGoldenCaseStructure(mappee))).toContain('claim_assertion_type_unknown')

      const bloquee = casTypeManquant()
      bloquee.adjudication.rawEvidence[1].claims[0].assertionType = valeur
      expect(codes(validateGoldenCaseStructure(bloquee))).toContain('claim_assertion_type_unknown')
    }
  })

  it('accepte les trois valeurs du cœur', () => {
    for (const valeur of ['fact', 'inference', 'assumption']) {
      const c = casTypeManquant()
      c.adjudication.rawEvidence[1].claims[0].assertionType = valeur
      expect(validateGoldenCaseStructure(c).ok).toBe(true)
    }
  })

  it('une claim MAPPED exige toujours le champ', () => {
    const c = casSigne()
    delete c.adjudication.rawEvidence[0].claims[0].assertionType
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_missing_runtime_fields')
  })
})

// ── F5 — AUCUN CHAMP RUNTIME DÉRIVÉ NE SE PERSISTE ──────────────────────────
//
// Fermer la racine ne suffisait pas : ces champs étaient silencieusement
// acceptés parce que le projecteur les écrase. Deux valeurs possibles pour une
// même donnée, dont une seule est lue — la copie d'EvalCase par la porte basse.

describe('GOLDEN-SCHEMA-001a — champs dérivés interdits', () => {
  it('refuse `relevance` sur une cible', () => {
    const c = casSigne()
    c.executionContext.targets[0].relevance = 0.9
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'execution_context_target_key_unknown',
    )
  })

  it('refuse `confidence`, `observedAt` et `temporality` sur une claim', () => {
    for (const [cle, valeur] of [
      ['confidence', 1],
      ['observedAt', '2026-08-07'],
      ['temporality', 'dated_event'],
    ] as [string, unknown][]) {
      const c = casSigne()
      c.adjudication.rawEvidence[0].claims[0][cle] = valeur
      expect(codes(validateGoldenCaseStructure(c))).toContain('claim_key_unknown')
    }
  })

  it('PRÉSERVE les champs sémantiques légitimes', () => {
    // `occurredAt`, `temporalNature`, `temporalPrecision`, `assertionType`
    // appartiennent à l'adjudication : les fermer aussi aurait détruit la
    // sémantique que ce contrat existe pour conserver.
    const c = casSigne()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    expect(claim.occurredAt).toBeTruthy()
    expect(claim.temporalNature).toBeTruthy()
    expect(claim.temporalPrecision).toBeTruthy()
    expect(claim.assertionType).toBeTruthy()
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('refuse une clé inventée sur une cible ou une claim', () => {
    const t = casSigne()
    t.executionContext.targets[0].scoreIcp = 0.7
    expect(codes(validateGoldenCaseStructure(t))).toContain(
      'execution_context_target_key_unknown',
    )

    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].lensFitExpected = 'LIKELY'
    expect(codes(validateGoldenCaseStructure(c))).toContain('claim_key_unknown')
  })
})

// ── F6 — COHÉRENCES DE CONTRAT ──────────────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — cohérences de contrat', () => {
  it('refuse `duplicateOf` hors NOT_MAPPABLE / DUPLICATE_OF_CLAIM', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].duplicateOf = {
      rawEvidenceId: 'TEST-ev1',
      claimIndex: 0,
    }
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_duplicate_reference_unexpected',
    )
  })

  it('refuse STATE + occurredAt même sur une claim NON MAPPED', () => {
    const c = casTypeManquant()
    const claim = c.adjudication.rawEvidence[1].claims[0]
    claim.temporalNature = 'STATE'
    claim.occurredAt = '2026-05-20'
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_temporality_mismatch',
    )
  })

  it('refuse EVENT + DAY sans occurredAt même sur une claim NON MAPPED', () => {
    const c = casTypeManquant()
    delete c.adjudication.rawEvidence[1].claims[0].occurredAt
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_temporality_mismatch',
    )
  })

  it('refuse une date d’adjudication qui n’existe pas au calendrier', () => {
    // La forme ne suffit pas : `2026-02-31` satisfait l'expression régulière, et
    // `Date.parse` la décale silencieusement. Un contrôle de forme seul
    // laisserait une date fabriquée dans le champ qui date l'adjudication.
    for (const jour of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31']) {
      const c = casSigne()
      c.provenance.adjudicatedOn = jour
      expect(codes(validateGoldenCaseStructure(c))).toContain(
        'provenance_timestamp_over_precise',
      )
    }
  })

  it('accepte un 29 février d’année bissextile', () => {
    const c = casSigne()
    c.provenance.adjudicatedOn = '2028-02-29'
    expect(validateGoldenCaseStructure(c).ok).toBe(true)
  })

  it('refuse un 29 février d’année NON bissextile', () => {
    const c = casSigne()
    c.provenance.adjudicatedOn = '2027-02-29'
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'provenance_timestamp_over_precise',
    )
  })
})

// ── R2 — LA VALEUR TEMPORELLE PORTE EXACTEMENT SA PRÉCISION ─────────────────
//
// `Date.parse` est permissif : « 2026-05 » y devient `2026-05-01`. Une claim
// déclarée `DAY` portant « 2026-05 » projetait donc une date au premier du mois
// — et comme `freshnessScore` lit `occurredAt`, cette normalisation FABRIQUE une
// fraîcheur, donc une urgence, à partir d'une précision que la source n'a pas.

describe('GOLDEN-SCHEMA-001a — valeur ↔ précision temporelle', () => {
  /** Cas SIGNÉ dont l'unique claim porte la précision et la valeur données. */
  function avecTemps(precision: string, occurredAt?: string): any {
    const c = casSigne()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.temporalNature = 'EVENT'
    claim.temporalPrecision = precision
    if (occurredAt === undefined) delete claim.occurredAt
    else claim.occurredAt = occurredAt
    return c
  }

  /** Même chose, mais BLOQUÉ — pour les précisions qui ne projettent pas. */
  function bloqueAvecTemps(precision: string, occurredAt?: string): any {
    const c = avecTemps(precision, occurredAt)
    c.executability = 'ADJUDICATED_NON_EXECUTABLE'
    c.caseStatus = {
      state: 'BLOCKED',
      blockers: [
        {
          kind: 'TEMPORAL_PRECISION_GAP',
          rawEvidenceId: 'TEST-ev1',
          claimIndex: 0,
          note: 'Précision insuffisante pour projeter.',
        },
      ],
    }
    return c
  }

  it('EVENT + DAY + « 2026-05 » → refusé', () => {
    expect(codes(validateGoldenCaseStructure(avecTemps('DAY', '2026-05')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('EVENT + DAY + « 2026-05-20 » → accepté', () => {
    expect(validateGoldenCaseStructure(avecTemps('DAY', '2026-05-20')).ok).toBe(true)
  })

  it('EVENT + DAY + « 2026-02-31 » → refusé', () => {
    expect(codes(validateGoldenCaseStructure(avecTemps('DAY', '2026-02-31')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('EVENT + TIMESTAMP + « 2026-05-20 » → refusé', () => {
    // Annoncer un horodatage sur une valeur qui ne porte pas d’heure.
    expect(codes(validateGoldenCaseStructure(avecTemps('TIMESTAMP', '2026-05-20')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('EVENT + TIMESTAMP + horodatage complet AVEC fuseau → accepté', () => {
    for (const valeur of ['2026-05-20T14:30:00Z', '2026-05-20T14:30:00.500+02:00']) {
      const r = validateGoldenCaseStructure(avecTemps('TIMESTAMP', valeur))
      if (r.ok === false) throw new Error(`${valeur} : ${JSON.stringify(r.errors, null, 2)}`)
      expect(r.ok).toBe(true)
    }
  })

  it('EVENT + TIMESTAMP SANS fuseau → refusé', () => {
    // Un horodatage sans fuseau est interprété localement : le même fichier
    // rejoué sur deux machines ne décrirait pas le même instant.
    expect(
      codes(validateGoldenCaseStructure(avecTemps('TIMESTAMP', '2026-05-20T14:30:00'))),
    ).toContain('claim_occurred_at_precision_mismatch')
  })

  it('EVENT + MONTH + « 2026-05 » → BLOQUÉ VALIDE', () => {
    const c = bloqueAvecTemps('MONTH', '2026-05')
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
    expect(projectGoldenCase(c).ok).toBe(false)
  })

  it('EVENT + MONTH + « 2026-05-20 » → refusé', () => {
    expect(codes(validateGoldenCaseStructure(bloqueAvecTemps('MONTH', '2026-05-20')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('EVENT + YEAR + « 2026 » → BLOQUÉ VALIDE', () => {
    const c = bloqueAvecTemps('YEAR', '2026')
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
    expect(projectGoldenCase(c).ok).toBe(false)
  })

  it('EVENT + UNKNOWN + occurredAt PRÉSENT → refusé', () => {
    expect(codes(validateGoldenCaseStructure(bloqueAvecTemps('UNKNOWN', '2026-05-20')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('EVENT + UNKNOWN + occurredAt ABSENT → BLOQUÉ VALIDE', () => {
    const c = bloqueAvecTemps('UNKNOWN')
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
    expect(projectGoldenCase(c).ok).toBe(false)
  })

  it('`projectTemporality` reste inchangée', () => {
    expect(projectTemporality('EVENT', 'MONTH').kind).toBe('gap')
    expect(projectTemporality('EVENT', 'YEAR').kind).toBe('gap')
    expect(projectTemporality('EVENT', 'UNKNOWN').kind).toBe('gap')
    expect(projectTemporality('EVENT', 'DAY').kind).toBe('dated_event')
    expect(projectTemporality('EVENT', 'TIMESTAMP').kind).toBe('dated_event')
  })

  it('STATE conserve son interdiction d’`occurredAt`', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].temporalNature = 'STATE'
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_temporality_mismatch',
    )
  })
})

// ── R3 — SURFACES IMBRIQUÉES RESTANTES ──────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — executionContext et attentes fermés', () => {
  it('refuse une clé inconnue sur `executionContext`', () => {
    for (const cle of ['evidence', 'now', 'relevance', 'schemaVersion', 'inventé']) {
      const c = casSigne()
      c.executionContext[cle] = 'x'
      expect(codes(validateGoldenCaseStructure(c))).toContain('execution_context_key_unknown')
    }
  })

  it('refuse une clé RAIL R NICHÉE dans une attente', () => {
    // La racine `expected` était fermée ; chaque attente, non. Le pare-feu entre
    // les deux rails redevenait déclaratif d’un cran plus bas.
    for (const cle of ['priority', 'confidence', 'control', 'ranking', 'lensFitExpected']) {
      const c = casSigne()
      c.expected.situations.space_expansion[cle] = 'HIGH'
      expect(codes(validateGoldenCaseStructure(c))).toContain('expectation_forbidden_key')
    }
  })

  it('préserve `assertion` et `rationale`', () => {
    expect(validateGoldenCaseStructure(casSigne()).ok).toBe(true)
  })
})

// ── R4 — IDENTITÉS DE BLOCAGE EN DOUBLE ─────────────────────────────────────

describe('GOLDEN-SCHEMA-001a — blocages non dupliqués', () => {
  it('refuse deux lignes STRICTEMENT identiques', () => {
    const c = casTypeManquant()
    c.caseStatus.blockers.push({ ...c.caseStatus.blockers[0] })
    expect(codes(validateGoldenCaseStructure(c))).toContain('blocker_duplicate_identity')
  })

  it('accepte deux blocages du même genre sur des claims DIFFÉRENTES', () => {
    // Ce n’est pas une priorité : deux causes distinctes exigent deux lignes.
    const c = casTypeManquant()
    c.adjudication.rawEvidence.push({
      rawEvidenceId: 'TEST-ev4',
      decompositionStatus: 'COMPLETE',
      claims: [
        {
          claimIndex: 0,
          semanticClaim: 'Un second fait sans type.',
          mappingDecision: 'MISSING_TYPE',
          assertionType: 'fact',
          temporalNature: 'STATE',
          temporalPrecision: 'UNKNOWN',
          rationale: 'Aucun EvidenceType ne le porte.',
          sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
        },
      ],
    })
    c.caseStatus.blockers.push({
      kind: 'EVIDENCE_TYPE_GAP',
      rawEvidenceId: 'TEST-ev4',
      claimIndex: 0,
      note: 'Second trou de taxonomie.',
    })
    const r = validateGoldenCaseStructure(c)
    if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
    expect(r.ok).toBe(true)
  })
})

// ── DOMAINE STRICT DES HORODATAGES ──────────────────────────────────────────
//
// ⚠️ LE DÉFAUT QUE CE BLOC VERROUILLE. La forme `\d{2}:\d{2}:\d{2}` comptait les
// chiffres sans vérifier leur DOMAINE. « 24:00:00 » y passait — et `Date.parse`
// le NORMALISE vers le JOUR SUIVANT. Un fait du 20 mai serait devenu un fait du
// 21, avec la fraîcheur — donc l'urgence — qui suit. C'est exactement
// l'invariant que la vérification valeur↔précision existe pour tenir.

describe('GOLDEN-SCHEMA-001a — horodatages : domaine strict', () => {
  function avecHorodatage(valeur: string): any {
    const c = casSigne()
    const claim = c.adjudication.rawEvidence[0].claims[0]
    claim.temporalNature = 'EVENT'
    claim.temporalPrecision = 'TIMESTAMP'
    claim.occurredAt = valeur
    return c
  }

  const acceptes = [
    '2026-05-20T23:59:59Z',
    '2026-05-20T00:00:00Z',
    '2026-05-20T14:30:00.500+02:00',
  ]

  const refuses: [string, string][] = [
    ['2026-05-20T24:00:00Z', 'heure 24 — glisse au jour suivant'],
    ['2026-05-20T23:60:00Z', 'minute 60'],
    ['2026-05-20T23:59:60Z', 'seconde intercalaire, non rejouable ici'],
    ['2026-05-20T23:59:59+24:00', 'décalage horaire 24'],
    ['2026-05-20T23:59:59+14:60', 'minutes de décalage 60'],
    ['2026-05-20T14:30:00', 'aucun fuseau explicite'],
    ['2026-02-31T14:30:00Z', 'jour inexistant au calendrier'],
  ]

  for (const valeur of acceptes) {
    it(`ACCEPTE ${valeur}`, () => {
      const r = validateGoldenCaseStructure(avecHorodatage(valeur))
      if (r.ok === false) throw new Error(JSON.stringify(r.errors, null, 2))
      expect(r.ok).toBe(true)
    })
  }

  for (const [valeur, motif] of refuses) {
    it(`REFUSE ${valeur} — ${motif}`, () => {
      expect(codes(validateGoldenCaseStructure(avecHorodatage(valeur)))).toContain(
        'claim_occurred_at_precision_mismatch',
      )
    })
  }

  it('RÉGRESSION : Node accepte « 24:00:00Z » et le décale d’un JOUR — le Golden le refuse AVANT', () => {
    // ⚠️ Ce test documente le vecteur exact, et prouve que la garde Golden est
    // volontairement PLUS STRICTE que `Date.parse` — et non qu'elle s'appuie
    // dessus par accident.
    const vecteur = '2026-05-20T24:00:00Z'

    // 1. Node l'accepte…
    const parse = Date.parse(vecteur)
    expect(Number.isFinite(parse)).toBe(true)

    // 2. …en le NORMALISANT vers le jour suivant. C'est là toute la nuisance :
    //    la valeur ne devient pas invalide, elle devient FAUSSE.
    expect(new Date(parse).toISOString()).toBe('2026-05-21T00:00:00.000Z')
    expect(new Date(parse).toISOString().slice(0, 10)).not.toBe('2026-05-20')

    // 3. Le Golden le refuse malgré tout, AVANT toute projection runtime.
    const c = avecHorodatage(vecteur)
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_precision_mismatch',
    )

    // ⚠️ Le refus vient de la couche STRUCTURELLE, et c'est le bon endroit :
    // `validateGoldenCase` valide la structure AVANT de projeter, donc la
    // projection n'a jamais lieu. `projectGoldenCase` seule, elle, projetterait
    // — elle est la couche du dessous et ne juge que la NATURE/PRÉCISION, pas la
    // valeur. Le cas ne peut donc pas atteindre le runtime, ce qui est
    // exactement l'invariant demandé.
    expect(validateGoldenCase(c).ok).toBe(false)
    expect(codes(validateGoldenCase(c))).toContain('claim_occurred_at_precision_mismatch')
  })

  it('la garde `Date.parse` ne SERT PAS à déterminer la précision', () => {
    // `2026-05-20` est fini pour `Date.parse`, et pourtant refusé en TIMESTAMP :
    // c'est la syntaxe Golden qui décide, jamais le moteur permissif.
    expect(Number.isFinite(Date.parse('2026-05-20'))).toBe(true)
    expect(codes(validateGoldenCaseStructure(avecHorodatage('2026-05-20')))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })

  it('la validation stricte de la DATE reste inchangée', () => {
    const c = casSigne()
    c.adjudication.rawEvidence[0].claims[0].occurredAt = '2026-02-31'
    expect(codes(validateGoldenCaseStructure(c))).toContain(
      'claim_occurred_at_precision_mismatch',
    )
  })
})
