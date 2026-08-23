// EVAL-RUNNER-001a — CONTRAT D'ENTRÉE V0 DU RUNNER OFFLINE.
//
// ── CE QUE CE MODULE GARANTIT ───────────────────────────────────────────────
// Un fichier accepté ici décrit une évaluation COMPLÈTE et NON AMBIGUË. Rien
// n'est complété, deviné, ni ramené dans les bornes : une donnée absente ou
// hors domaine est un REFUS, pas une occasion d'appliquer un défaut.
//
// ⚠️ POURQUOI `relevance` EST OBLIGATOIRE. C'est la décision de conception la
// plus importante du contrat. La rendre optionnelle imposerait un repli, et il
// n'en existe aucun d'honnête :
//   • `0` affirmerait « ce compte n'est pas pertinent » — une affirmation, pas
//     une absence ;
//   • `Lead.score` n'existe pas ici : le runner ne connaît pas les leads ;
//   • `Lens.relevance()` est DORMANTE, et s'en servir pour boucher un trou
//     inventerait un score ICP que personne n'a défini (verrou :
//     `tests/proactive-relevance-lockin.test.ts`).
// Un jeu d'évaluation dont la pertinence serait fabriquée mesurerait le repli,
// pas le moteur.
//
// Ce module n'effectue AUCUNE I/O : il valide une valeur déjà désérialisée.
// La lecture de fichier appartient à la CLI, la décision appartient au kernel.
import { EVIDENCE_TYPES } from '../catalog'
import { isEvidenceEvent } from '../validators'
import { evidenceMatchesTarget } from '../situationEngine'
import { resolveBusinessContext, targetInScope } from '../decisionKernel'
import { LENS_REGISTRY } from '../lens/registry'
import { PACK_REGISTRY } from '../packs/registry'
import type { BusinessContextV0 } from '../lens/context'
import type { KernelTarget } from '../decisionKernel'
import type { EvidenceEvent } from '../types'

/** Version de contrat. Toute autre valeur est refusée — jamais « tolérée ». */
export const EVAL_SCHEMA_VERSION = 'proactive-eval-v0.1'

/**
 * Clés racine AUTORISÉES — liste FERMÉE.
 *
 * ⚠️ POURQUOI FERMER PLUTÔT QUE TOLÉRER. Une clé racine inconnue est presque
 * toujours une faute de frappe : `"evidnce"` serait accepté comme metadata
 * sans effet, et le cas s'exécuterait avec ZÉRO evidence — en rendant un
 * résultat vide parfaitement valide en apparence. Refuser l'excédent est le
 * seul moyen de distinguer « rien à évaluer » de « je me suis trompé de nom ».
 *
 * `_comment` est la SEULE extension libre de la V0 : les fixtures doivent
 * pouvoir se documenter elles-mêmes, et une fixture technique doit pouvoir
 * crier qu'elle n'est pas de la ground truth.
 */
const CLES_RACINE = [
  'schemaVersion',
  'now',
  'businessContext',
  'targets',
  'evidence',
  '_comment',
] as const

export interface EvalCase {
  schemaVersion: typeof EVAL_SCHEMA_VERSION
  now: Date
  businessContext: BusinessContextV0
  targets: readonly KernelTarget[]
  evidence: readonly EvidenceEvent[]
}

export interface EvalError {
  /** Code STABLE, pensé pour être assertable par un test. */
  code: string
  /** Chemin JSON de la donnée fautive, ex. `targets[1].relevance`. */
  path: string
  message: string
}

export type EvalCaseValidation =
  | { ok: true; case: EvalCase }
  | { ok: false; errors: readonly EvalError[] }

/**
 * Champs d'éligibilité acceptés.
 *
 * ⚠️ LISTE FERMÉE, ET `now` EN EST ABSENT VOLONTAIREMENT. L'horloge vient de
 * `case.now` et de nulle part ailleurs ; laisser une cible porter son propre
 * `now` permettrait de décaler l'éligibilité d'une seule cible et de rendre le
 * fichier non reproductible. Une clé inconnue est refusée plutôt qu'ignorée :
 * une faute de frappe dans une fixture doit se voir, pas se taire.
 */
const CHAMPS_ELIGIBILITE: Readonly<Record<string, 'boolean' | 'string' | 'number'>> = {
  optedOut: 'boolean',
  meetingScheduled: 'boolean',
  actionScheduled: 'boolean',
  activeRecommendationExists: 'boolean',
  lastContactAt: 'string',
  contactCooldownHours: 'number',
}

function dateValide(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function cleTarget(accountId: string, personId?: string): string {
  return `${accountId}::${personId ?? ''}`
}

/**
 * FABEL-RULEPACK-001 (M.1) — TYPES D'EVIDENCE ACTIFS POUR **CETTE** LENS.
 *
 * ── LE TROU QUE CECI FERME ──────────────────────────────────────────────────
 * `EVIDENCE_TYPES` est l'union PLATE de tous les packs enregistrés. Tant qu'il
 * n'existait qu'un pack, valider contre cette union revenait au même. Avec un
 * second vertical, ce n'est plus vrai : un cas déclarant `lensId:
 * 'sales-default'` acceptait une evidence `real_estate.flex_occupancy_observed`
 * — globalement connue, mais qu'AUCUN pack de cette lens ne lit jamais.
 *
 * Elle n'était pas orpheline au sens de l'intégrité référentielle (le compte
 * correspond), elle était simplement INERTE : le cas s'exécutait, ne produisait
 * rien de cette evidence, et rendait un résultat parfaitement valide en
 * apparence. C'est exactement le silence que ce runner existe pour supprimer.
 */
function typesActifsPourLens(lensId: string): Set<string> | null {
  const lens = (LENS_REGISTRY as any)[lensId]
  if (!lens) return null

  const actifs = new Set<string>()
  for (const packId of lens.rulePacks ?? []) {
    const pack = (PACK_REGISTRY as any)[packId]
    if (!pack) continue
    for (const type of pack.declaredEvidenceTypes) actifs.add(type)
  }

  return actifs
}

/**
 * Valide un cas d'évaluation. FAIL CLOSED, et EXHAUSTIF.
 *
 * Rend TOUTES les erreurs plutôt que la première : corriger une fixture erreur
 * par erreur, en relançant à chaque fois, est le meilleur moyen d'abandonner
 * avant d'avoir tout corrigé.
 */
export function validateEvalCase(input: unknown): EvalCaseValidation {
  const errors: EvalError[] = []
  const add = (code: string, path: string, message: string) =>
    errors.push({ code, path, message })

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: [
        { code: 'case_not_object', path: '$', message: 'Le cas doit être un objet JSON.' },
      ],
    }
  }

  const c = input as Record<string, any>

  // ── Clés racine ───────────────────────────────────────────────────────────
  for (const cle of Object.keys(c)) {
    if (!(CLES_RACINE as readonly string[]).includes(cle)) {
      add(
        'root_key_unknown',
        cle,
        `Clé racine inconnue « ${cle} ». Les clés racine forment une liste fermée ` +
          `(${CLES_RACINE.join(', ')}) : une faute de frappe doit être refusée, ` +
          'jamais acceptée comme metadata sans effet.',
      )
    }
  }

  // ── schemaVersion ─────────────────────────────────────────────────────────
  if (c.schemaVersion !== EVAL_SCHEMA_VERSION) {
    add(
      'schema_version_unknown',
      'schemaVersion',
      `Version de schéma attendue « ${EVAL_SCHEMA_VERSION} », reçue « ${String(c.schemaVersion)} ». ` +
        'Une version inconnue est refusée : interpréter un format non reconnu produirait un résultat sans signification.',
    )
  }

  // ── now ───────────────────────────────────────────────────────────────────
  if (!dateValide(c.now)) {
    add(
      'now_invalid',
      'now',
      '`now` doit être un horodatage ISO-8601 valide. Le temps du moteur vient EXCLUSIVEMENT de ce champ.',
    )
  }

  // ── businessContext ───────────────────────────────────────────────────────
  // Réutilise la validation du kernel : lens inconnue et version divergente y
  // sont déjà traitées. La recopier ici créerait deux définitions de « contexte
  // valide », dont une finirait par diverger.
  if (!c.businessContext || typeof c.businessContext !== 'object') {
    add(
      'business_context_missing',
      'businessContext',
      'Le Business Context est OBLIGATOIRE. Aucun contexte par défaut n’est fabriqué : ' +
        'décider à la place de l’appelant quelles capacités il détient violerait l’invariant d’autorité.',
    )
  } else {
    const validation = resolveBusinessContext(c.businessContext)
    // ⚠️ `=== false` et non `!validation.ok` : le dépôt compile avec
    // `"strict": false`, où la négation NE rétrécit PAS une union discriminée.
    // Vérifié lors d'ARCH-RULEPACK-001 — ce n'est pas un choix de style.
    if (validation.ok === false) {
      add(
        `business_context_${validation.reason}`,
        'businessContext',
        `Business Context refusé : ${validation.reason}.`,
      )
    }
  }

  // ── evidence ──────────────────────────────────────────────────────────────
  // Les types actifs ne sont calculables que si la lens est elle-même valide :
  // reprocher « inactif pour la lens » à cause d'une lens inconnue masquerait
  // la vraie erreur, déjà signalée plus haut.
  const typesActifs =
    c.businessContext && typeof c.businessContext === 'object'
      ? typesActifsPourLens(c.businessContext.lensId)
      : null

  if (!Array.isArray(c.evidence)) {
    add('evidence_not_array', 'evidence', '`evidence` doit être un tableau (éventuellement vide).')
  } else {
    c.evidence.forEach((item: any, i: number) => {
      if (!isEvidenceEvent(item)) {
        add(
          'evidence_invalid',
          `evidence[${i}]`,
          'Evidence malformée : champs requis manquants, score hors [0,1], date invalide ou temporalité incohérente.',
        )
        return
      }
      // Le catalogue ferme la COMPILATION ; ici l'entrée vient d'un fichier.
      if (!EVIDENCE_TYPES.includes(item.type)) {
        add(
          'evidence_type_unknown',
          `evidence[${i}].type`,
          `Type d’evidence « ${item.type} » déclaré par aucun Rule Pack enregistré.`,
        )
        return
      }

      // ── DEUX REFUS DISTINCTS, ET LA DISTINCTION COMPTE ───────────────────
      //   `evidence_type_unknown`          → le type n'existe nulle part
      //   `evidence_type_inactive_for_lens` → il existe, mais aucun pack de la
      //                                       lens active ne le lit
      // Les confondre priverait l'auteur d'une fixture de l'information qui
      // lui manque réellement : s'est-il trompé de nom, ou de lens ?
      if (typesActifs && !typesActifs.has(item.type)) {
        add(
          'evidence_type_inactive_for_lens',
          `evidence[${i}].type`,
          `Type d’evidence « ${item.type} » connu du catalogue, mais déclaré par aucun ` +
            `Rule Pack de la lens « ${c.businessContext?.lensId} ». Il serait INERTE : ` +
            'accepté, puis jamais lu, en rendant un résultat vide d’apparence valide.',
        )
      }
    })
  }

  // ── targets ───────────────────────────────────────────────────────────────
  if (!Array.isArray(c.targets)) {
    add('targets_not_array', 'targets', '`targets` doit être un tableau.')
  } else if (c.targets.length === 0) {
    add(
      'targets_empty',
      'targets',
      'Au moins une cible est requise : un cas sans cible n’évalue rien et ne prouve rien.',
    )
  } else {
    const vues = new Map<string, any>()

    // Le périmètre n'est vérifiable que si le contexte est lui-même valide :
    // reprocher « hors périmètre » à cause d'un `scope` malformé masquerait la
    // vraie erreur, déjà signalée plus haut.
    const scopeUtilisable =
      !!c.businessContext &&
      typeof c.businessContext === 'object' &&
      resolveBusinessContext(c.businessContext).ok === true

    c.targets.forEach((t: any, i: number) => {
      const path = `targets[${i}]`

      if (!t || typeof t !== 'object') {
        add('target_not_object', path, 'Chaque cible doit être un objet.')
        return
      }

      if (typeof t.accountId !== 'string' || !t.accountId.trim()) {
        add('target_account_id_missing', `${path}.accountId`, '`accountId` est requis et non vide.')
      }

      // ── PÉRIMÈTRE MÉTIER ────────────────────────────────────────────────
      // Une cible hors `scope` est REFUSÉE, jamais écartée en silence. Un cas
      // amputé d'une de ses cibles rendrait un résultat « complet » qui ne
      // répond pas à la question posée.
      if (
        typeof t.accountId === 'string' &&
        t.accountId.trim() &&
        c.businessContext &&
        typeof c.businessContext === 'object' &&
        scopeUtilisable &&
        !targetInScope({ accountId: t.accountId }, c.businessContext)
      ) {
        add(
          'target_out_of_scope',
          `${path}.accountId`,
          `La cible « ${t.accountId} » est hors du périmètre déclaré par le Business Context. ` +
            'Le contexte ne peut que RESTREINDRE : une cible hors périmètre est refusée, pas ignorée.',
        )
      }

      if (t.personId !== undefined && (typeof t.personId !== 'string' || !t.personId.trim())) {
        add('target_person_id_invalid', `${path}.personId`, '`personId`, s’il est présent, doit être une chaîne non vide.')
      }

      if (t.relevance === undefined || t.relevance === null) {
        add(
          'target_relevance_missing',
          `${path}.relevance`,
          '`relevance` est OBLIGATOIRE. Le runner n’invente aucun score ICP et n’appelle pas la lens dormante pour combler une absence.',
        )
      } else if (typeof t.relevance !== 'number' || !Number.isFinite(t.relevance)) {
        add('target_relevance_invalid', `${path}.relevance`, '`relevance` doit être un nombre fini.')
      } else if (t.relevance < 0 || t.relevance > 1) {
        add(
          'target_relevance_out_of_range',
          `${path}.relevance`,
          `\`relevance\` doit appartenir à [0,1] ; reçu ${t.relevance}. La valeur n’est PAS ramenée dans les bornes : ` +
            'un ramenage silencieux masquerait une fixture fausse.',
        )
      }

      if (t.eligibility !== undefined) {
        if (!t.eligibility || typeof t.eligibility !== 'object' || Array.isArray(t.eligibility)) {
          add('target_eligibility_invalid', `${path}.eligibility`, '`eligibility` doit être un objet.')
        } else {
          for (const [cle, valeur] of Object.entries(t.eligibility)) {
            const attendu = CHAMPS_ELIGIBILITE[cle]
            if (!attendu) {
              add(
                'target_eligibility_unknown_field',
                `${path}.eligibility.${cle}`,
                `Champ d’éligibilité inconnu « ${cle} ». Les clés inconnues sont refusées, jamais ignorées.`,
              )
              continue
            }
            if (typeof valeur !== attendu) {
              add(
                'target_eligibility_field_invalid',
                `${path}.eligibility.${cle}`,
                `« ${cle} » doit être de type ${attendu}.`,
              )
            }
            if (cle === 'lastContactAt' && !dateValide(valeur)) {
              add(
                'target_eligibility_field_invalid',
                `${path}.eligibility.lastContactAt`,
                '`lastContactAt` doit être un horodatage ISO-8601 valide.',
              )
            }
          }
        }
      }

      // ── Doublons ────────────────────────────────────────────────────────
      // Deux cibles identiques et CONTRADICTOIRES rendraient le résultat
      // dépendant de l'ordre de lecture du fichier. Un doublon strictement
      // identique reste refusé aussi : il n'apporte rien et signale une
      // fixture engendrée par erreur.
      if (typeof t.accountId === 'string') {
        const cle = cleTarget(t.accountId, t.personId)
        if (vues.has(cle)) {
          add(
            'target_duplicate',
            path,
            `Cible en double (${cle}). Une cible doit apparaître une seule fois : deux définitions rendraient le résultat dépendant de l’ordre du fichier.`,
          )
        } else {
          vues.set(cle, t)
        }
      }
    })
  }

  // ── INTÉGRITÉ RÉFÉRENTIELLE Evidence ↔ Target ─────────────────────────────
  //
  // ⚠️ RÈGLE RETENUE — **OPTION B**, et elle n'est pas un choix d'intuition :
  // elle est déjà DÉTERMINÉE par `evidenceMatchesTarget()`, le prédicat que le
  // Decision Kernel applique réellement. On ne fait ici que refuser en amont ce
  // que le moteur écarterait en silence.
  //
  //   • Evidence SANS `personId`      → consommable par toute cible du compte,
  //                                     niveau compte comme niveau personne.
  //   • Evidence AVEC `personId: P`   → consommable UNIQUEMENT par la cible
  //                                     (compte, P). Une cible « compte » seule
  //                                     ne suffit PAS : le moteur l'écarte.
  //   • Evidence de portée `person`
  //     SANS `personId`               → écartée au niveau personne, mais
  //                                     valable au niveau compte : elle a donc
  //                                     bien une cible, et n'est pas orpheline.
  //
  // Une evidence qu'AUCUNE cible ne peut consommer est une fixture fausse :
  // elle serait silencieusement ignorée et l'auteur croirait l'avoir testée.
  // C'est exactement le genre de trou qui rend un jeu d'évaluation rassurant.
  //
  // Le filtrage TEMPOREL n'entre pas dans ce contrôle : une evidence expirée ou
  // datée du futur est légitimement présente, simplement inexploitable — la
  // refuser interdirait de tester les invariants temporels eux-mêmes.
  if (errors.length === 0 && Array.isArray(c.evidence) && Array.isArray(c.targets)) {
    c.evidence.forEach((item: any, i: number) => {
      const consommable = c.targets.some((t: any) =>
        evidenceMatchesTarget(item, { accountId: t.accountId, personId: t.personId }),
      )

      if (!consommable) {
        add(
          'evidence_orphan',
          `evidence[${i}]`,
          item.personId
            ? `Evidence rattachée à la personne « ${item.personId} » du compte « ${item.accountId} » : ` +
              'aucune cible (compte + personne) ne peut la consommer. Une cible « compte » seule ne suffit pas — ' +
              'le moteur écarte les evidences de relation au niveau compte.'
            : `Evidence rattachée au compte « ${item.accountId} » : aucune cible d’évaluation ne correspond. ` +
              'Elle serait silencieusement ignorée, et la fixture prétendrait la tester.',
        )
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    case: {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: new Date(c.now),
      businessContext: c.businessContext as BusinessContextV0,
      targets: c.targets.map((t: any) => ({
        accountId: t.accountId,
        personId: t.personId,
        relevance: t.relevance,
        eligibility: t.eligibility,
      })),
      evidence: c.evidence as EvidenceEvent[],
    },
  }
}
