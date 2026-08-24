// GOLDEN-SCHEMA-001a — ANCRAGE SUR LES SOURCES RAW IMMUABLES.
//
// ── POURQUOI CE MODULE EST SÉPARÉ DE `goldenSchema.ts` ──────────────────────
// `caseSchema.ts` n'effectue AUCUNE I/O : il valide une valeur déjà
// désérialisée, et la lecture de fichier appartient à la CLI. Cette doctrine est
// préservée ici. Un validateur qui ouvrirait `SHA256SUMS` deviendrait
// dépendant du disque, donc non testable hors contexte, donc tenté de
// « réparer » ce qu'il ne trouve pas.
//
// Les dépendances sont INJECTÉES : le dataset RAW parsé et le manifeste parsé
// sont des paramètres. Les tests les chargent ; la fonction reste pure.
//
// ── CE QUE CET ANCRAGE GARANTIT ─────────────────────────────────────────────
//   • Le cas Golden désigne un artefact PRÉCIS — chemin ET empreinte.
//   • Aucune Evidence RAW n'a disparu             (couverture).
//   • Aucune claim ne cite une Evidence inexistante (existence).
//   • Aucune référence historique ne pointe dans le vide.
//
// Couverture + existence sont la forme MÉCANIQUE de « aucune suppression
// silencieuse » : rien ne s'évapore, rien ne s'invente.

export interface RawManifestEntry {
  path: string
  sha256: string
}

export interface RawIntegrityError {
  code: string
  path: string
  message: string
}

export type RawIntegrityValidation =
  | { ok: true }
  | { ok: false; errors: RawIntegrityError[] }

/**
 * Résout un JSON Pointer RFC 6901 contre une valeur.
 *
 * ⚠️ RFC 6901, PAS un chemin pointé maison. Un parseur de `a.b.c` inventé pour
 * l'occasion se casse sur la première clé contenant un point et n'a aucune
 * sémantique définie pour les index de tableau. Le standard existe ; les
 * échappements `~1` (`/`) et `~0` (`~`) en font partie, et l'ordre de
 * dé-échappement est normatif — `~1` d'abord.
 *
 * Rend `undefined` lorsque le pointeur ne résout pas. La chaîne vide désigne le
 * document entier.
 */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined

  let courant: any = document

  for (const segmentBrut of pointer.slice(1).split('/')) {
    const segment = segmentBrut.replace(/~1/g, '/').replace(/~0/g, '~')

    if (courant === null || courant === undefined) return undefined

    if (Array.isArray(courant)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined
      const index = Number(segment)
      if (index >= courant.length) return undefined
      courant = courant[index]
      continue
    }

    if (typeof courant !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(courant, segment)) return undefined

    courant = courant[segment]
  }

  return courant
}

/**
 * Vérifie un cas Golden contre le dataset RAW et son manifeste. PURE.
 *
 * @param golden      cas Golden déjà validé structurellement
 * @param rawDataset  contenu parsé de `prospector-v3-golden-dataset.v0.1.json`
 * @param rawManifest entrées parsées de `SHA256SUMS`
 */
export function validateGoldenCaseAgainstRaw(
  golden: any,
  rawDataset: any,
  rawManifest: readonly RawManifestEntry[],
): RawIntegrityValidation {
  const errors: RawIntegrityError[] = []
  const add = (code: string, path: string, message: string) =>
    errors.push({ code, path, message })

  const anchor = golden?.rawSource
  if (!anchor || typeof anchor !== 'object') {
    return {
      ok: false,
      errors: [
        { code: 'raw_source_incomplete', path: 'rawSource', message: '`rawSource` absent.' },
      ],
    }
  }

  // ── LE COUPLE chemin+empreinte, jamais l'empreinte seule ─────────────────
  //
  // ⚠️ Chercher seulement si l'empreinte « figure quelque part » dans le
  // manifeste laisserait passer un cas qui déclare le fichier de POLITIQUES et
  // l'empreinte du DATASET : les deux valeurs seraient présentes, le couple
  // faux, et l'ancrage n'ancrerait rien.
  const entree = (rawManifest ?? []).find((e) => e && e.path === anchor.datasetPath)

  if (!entree) {
    add(
      'raw_dataset_path_not_in_manifest',
      'rawSource.datasetPath',
      `Le chemin « ${anchor.datasetPath} » ne figure pas dans le manifeste des sources RAW.`,
    )
  } else if (entree.sha256 !== anchor.datasetSha256) {
    add(
      'raw_sha_mismatch',
      'rawSource.datasetSha256',
      `Empreinte déclarée « ${anchor.datasetSha256} » ≠ « ${entree.sha256} » enregistrée pour ` +
        `« ${anchor.datasetPath} ». L’ancrage ne survit pas à une réécriture de l’archive — c’est ` +
        'précisément ce qu’il existe pour empêcher.',
    )
  }

  // ── Le dataset FOURNI est-il bien celui que le cas prétend ancrer ? ──────
  if (anchor.datasetSchemaVersion !== rawDataset?.schemaVersion) {
    add(
      'raw_dataset_schema_version_mismatch',
      'rawSource.datasetSchemaVersion',
      `Version de schéma déclarée « ${anchor.datasetSchemaVersion} » ≠ ` +
        `« ${rawDataset?.schemaVersion} » du dataset. ⚠️ La valeur RAW n’est jamais NORMALISÉE : ` +
        'un ancrage qui « nettoie » l’identifiant qu’il ancre n’ancre plus rien.',
    )
  }
  if (anchor.datasetVersion !== rawDataset?.datasetVersion) {
    add(
      'raw_dataset_version_mismatch',
      'rawSource.datasetVersion',
      `Version de dataset déclarée « ${anchor.datasetVersion} » ≠ ` +
        `« ${rawDataset?.datasetVersion} » du dataset.`,
    )
  }

  // ── Le cas RAW existe-t-il ? ─────────────────────────────────────────────
  const cases = Array.isArray(rawDataset?.cases) ? rawDataset.cases : []
  const rawCase = cases.find((c: any) => c?.caseId === anchor.originalCaseId)

  if (!rawCase) {
    add(
      'raw_case_id_unknown',
      'rawSource.originalCaseId',
      `Aucun cas « ${anchor.originalCaseId} » dans le dataset RAW fourni.`,
    )
    return { ok: false, errors }
  }

  // ── Couverture et existence ──────────────────────────────────────────────
  const groupes = Array.isArray(golden?.adjudication?.rawEvidence)
    ? golden.adjudication.rawEvidence
    : []

  const adjuges = new Map<string, number>()
  for (const groupe of groupes) {
    const id = groupe?.rawEvidenceId
    if (typeof id !== 'string') continue
    adjuges.set(id, (adjuges.get(id) ?? 0) + 1)
  }

  const rawEvidence = Array.isArray(rawCase.evidence) ? rawCase.evidence : []
  const idsRaw = new Set<string>(rawEvidence.map((e: any) => e?.id).filter(Boolean))

  for (const id of idsRaw) {
    if (!adjuges.has(id)) {
      add(
        'raw_evidence_not_covered',
        'adjudication.rawEvidence',
        `L’Evidence RAW « ${id} » n’est adjugée nulle part. Une Evidence non adjugée a DISPARU de ` +
          'la migration sans décision enregistrée — exactement ce que « aucune suppression ' +
          'silencieuse » interdit.',
      )
    }
  }

  for (const id of adjuges.keys()) {
    if (!idsRaw.has(id)) {
      add(
        'raw_evidence_adjudication_orphan',
        'adjudication.rawEvidence',
        `L’adjudication cite « ${id} », qui n’existe pas dans le cas RAW « ` +
          `${anchor.originalCaseId} ». Un fait INVENTÉ est aussi grave qu’un fait supprimé.`,
      )
    }
  }

  // ── Références historiques ───────────────────────────────────────────────
  const items = Array.isArray(golden?.legacyAssessment?.items) ? golden.legacyAssessment.items : []

  items.forEach((item: any, i: number) => {
    const pointeur = item?.rawRef
    if (typeof pointeur !== 'string') return

    if (resolveJsonPointer(rawCase, pointeur) === undefined) {
      add(
        'legacy_raw_ref_unresolvable',
        `legacyAssessment.items[${i}].rawRef`,
        `Le JSON Pointer « ${pointeur} » ne résout pas dans le cas RAW « ` +
          `${anchor.originalCaseId} ». Une référence qui ne résout pas ne réfère à rien : le ` +
          'libellé historique serait « évalué » sans que personne ne puisse le relire.',
      )
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Parse un fichier `SHA256SUMS` au format coreutils.
 *
 * ⚠️ Les chemins y sont RELATIFS au répertoire du manifeste — c'est la
 * convention de `sha256sum`. Le préfixe est donc fourni par l'appelant plutôt
 * que deviné : c'est l'appelant qui sait où le manifeste a été lu.
 *
 * Fourni pour les tests et la future CLI. `validateGoldenCaseAgainstRaw` ne
 * l'appelle jamais : elle reçoit le résultat déjà parsé.
 */
export function parseSha256Sums(contenu: string, prefixe = ''): RawManifestEntry[] {
  const entrees: RawManifestEntry[] = []

  for (const ligne of contenu.split('\n')) {
    const nettoyee = ligne.trim()
    if (!nettoyee) continue

    // `<sha256>  <nom>` — deux espaces en mode texte, ` *` en mode binaire.
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(nettoyee)
    if (!match) continue

    entrees.push({ path: `${prefixe}${match[2]}`, sha256: match[1] })
  }

  return entrees
}
