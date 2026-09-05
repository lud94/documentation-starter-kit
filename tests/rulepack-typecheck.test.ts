// ARCH-RULEPACK-001 — PREUVES À LA COMPILATION.
//
// ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────
// Les autres tests prouvent des comportements. Celui-ci prouve des REFUS : un
// pack inexistant, un `situationType` mal orthographié, un `type` d'evidence
// inconnu ne doivent pas atteindre l'exécution — ils doivent être impossibles
// à écrire.
//
// ⚠️ CE FICHIER EST UN TEST NÉGATIF, ET IL MORD RÉELLEMENT. `@ts-expect-error`
// échoue à la compilation lorsque la ligne suivante NE produit PAS d'erreur :
// si une frontière s'ouvrait, `npm run typecheck` deviendrait ROUGE ici. Un
// commentaire affirmant « c'est fermé » n'aurait, lui, jamais rien détecté.
//
// `tsconfig.json` inclut `**/*.ts` : ce fichier est donc bien typé par la
// gate. Les assertions d'exécution ne sont qu'un rappel de sa raison d'être.
import { describe, it, expect } from 'vitest'

import type { RulePackId } from '../lib/prospector/proactive/packs/registry'
import type {
  SituationType,
  EvidenceType,
  KnownEvidenceEvent,
} from '../lib/prospector/proactive/catalog'
import type { LensId } from '../lib/prospector/proactive/lens/registry'
import type { BusinessContextV0 } from '../lib/prospector/proactive/lens/context'
import type { AuthorizedMotion, MotionControl } from '../lib/prospector/proactive/motions'
import { SITUATION_TYPES, EVIDENCE_TYPES } from '../lib/prospector/proactive/catalog'

// ── 1. PACK INCONNU ─────────────────────────────────────────────────────────
const packConnu: RulePackId = 'sales-core'

// @ts-expect-error — un pack non enregistré n'est pas un RulePackId.
const packInconnu: RulePackId = 'fabel-core'

// @ts-expect-error — une faute de frappe ne « ressemble » pas : elle est refusée.
const packFauteDeFrappe: RulePackId = 'sales-cor'

// ── 2. SITUATION TYPE INVALIDE ──────────────────────────────────────────────
const situationConnue: SituationType = 'sales_scale_up'

// ⚠️ FABEL-RULEPACK-001 — `space_expansion` était la valeur témoin ici. Elle
// est devenue VALIDE dès l'enregistrement de `real-estate-fabel` : le catalogue
// dérivé s'est étendu tout seul, sans qu'une ligne du cœur bouge. C'est
// exactement l'effet recherché, et cette fixture doit donc désigner un type qui
// reste inconnu de TOUS les packs enregistrés.
// @ts-expect-error — type de situation non déclaré par un pack enregistré.
const situationInconnue: SituationType = 'warehouse_relocation'

// @ts-expect-error — faute de frappe sur un type pourtant déclaré.
const situationFauteDeFrappe: SituationType = 'sales_scale_upp'

// ── 3. EVIDENCE TYPE INVALIDE ───────────────────────────────────────────────
const evidenceConnue: EvidenceType = 'recent_funding'

// @ts-expect-error — type d'evidence non déclaré par un pack enregistré.
const evidenceInconnue: EvidenceType = 'lease_expiry'

// ── 4. LA FRONTIÈRE FERMÉE `KnownEvidenceEvent` ─────────────────────────────
// C'est ici que le catalogue sert vraiment : le `EvidenceEvent` générique
// existe pour casser un cycle d'imports, pas pour laisser passer n'importe
// quoi. Aux frontières d'ingestion, c'est cette forme-ci qui s'applique.
const evenementValide: KnownEvidenceEvent = {
  id: 'ev_1',
  accountId: 'acc_1',
  type: 'recent_funding',
  scope: 'account',
  assertionType: 'fact',
  temporality: 'dated_event',
  occurredAt: '2026-01-01T00:00:00.000Z',
  observedAt: '2026-01-02T00:00:00.000Z',
  confidence: 0.9,
  source: { provider: 'test' },
}

const evenementInvalide: KnownEvidenceEvent = {
  id: 'ev_2',
  accountId: 'acc_1',
  // @ts-expect-error — `type` hors catalogue, refusé à la frontière fermée.
  type: 'office_space_saturated',
  scope: 'account',
  assertionType: 'fact',
  temporality: 'dated_event',
  occurredAt: '2026-01-01T00:00:00.000Z',
  observedAt: '2026-01-02T00:00:00.000Z',
  confidence: 0.9,
  source: { provider: 'test' },
}

// ── 5. LENS INCONNUE DANS UN BUSINESS CONTEXT ───────────────────────────────
// Le contexte est une DONNÉE fournie de l'extérieur : il ne doit pas pouvoir
// désigner du code qui n'existe pas dans le dépôt.
const lensConnue: LensId = 'sales-default'

// ⚠️ Même raison : `fabel-broker` est désormais une lens enregistrée.
// @ts-expect-error — aucune lens de ce nom n'est enregistrée.
const lensInconnue: LensId = 'procurement-default'

const contexteInvalide: BusinessContextV0 = {
  contextId: 'x',
  contextVersion: 'v0.1',
  role: 'sales_rep',
  scope: { mode: 'workspace' },
  authorizedMotions: {},
  // @ts-expect-error — lens non enregistrée : refusée dès le typage.
  lensId: 'lens-maison',
  lensVersion: 'v0.1',
}

// ── 6. SCOPE — L'UNION DISCRIMINÉE NE LAISSE PAS DE FORME AMBIGUË ───────────
// `accountIds?: string[]` aurait été fail-open (champ oublié ⇒ tout permis).
// Le discriminant rend l'intention obligatoire, et c'est vérifiable :

// @ts-expect-error — `mode` absent : aucune forme par défaut n'est tolérée.
const scopeSansMode: BusinessContextV0['scope'] = { accountIds: ['acc_1'] }

// @ts-expect-error — `mode:'accounts'` sans la liste : refusé, jamais élargi.
const scopeIncomplet: BusinessContextV0['scope'] = { mode: 'accounts' }

// @ts-expect-error — mode inconnu.
const scopeModeInconnu: BusinessContextV0['scope'] = { mode: 'everything' }

// ── 7. CAPACITÉS ────────────────────────────────────────────────────────────
const motionConnue: AuthorizedMotion = 'contact_prospect'

// @ts-expect-error — capacité non déclarée : inexprimable, donc inaccordable.
const motionInconnue: AuthorizedMotion = 'delete_account'

// @ts-expect-error — niveau de contrôle hors du vocabulaire fermé.
const controleInconnu: MotionControl = 'maybe'

describe('Preuves de typage — les frontières fermées le sont vraiment', () => {
  it('les fixtures ci-dessus sont vérifiées par `npm run typecheck`', () => {
    // Ces valeurs sont référencées pour qu'aucun linter ne les supprime : leur
    // vraie assertion est la compilation elle-même, pas cette ligne.
    expect([
      packConnu,
      packInconnu,
      packFauteDeFrappe,
      situationConnue,
      situationInconnue,
      situationFauteDeFrappe,
      evidenceConnue,
      evidenceInconnue,
      lensConnue,
      lensInconnue,
      motionConnue,
      motionInconnue,
      controleInconnu,
      scopeSansMode,
      scopeIncomplet,
      scopeModeInconnu,
      evenementValide,
      evenementInvalide,
      contexteInvalide,
    ]).toHaveLength(19)
  })

  it('le catalogue d’exécution reste aligné sur les packs enregistrés', () => {
    // Le typage ferme la compilation ; ces listes ferment l'exécution. Les
    // deux doivent décrire le même monde.
    expect(SITUATION_TYPES).toContain('sales_scale_up')
    // Étendu par `real-estate-fabel`, sans modification du cœur.
    expect(SITUATION_TYPES).toContain('space_expansion')
    expect(SITUATION_TYPES).not.toContain('warehouse_relocation')
    expect(EVIDENCE_TYPES).toContain('recent_funding')
    expect(EVIDENCE_TYPES).toContain('real_estate.flex_occupancy_observed')
    expect(EVIDENCE_TYPES).not.toContain('lease_expiry')
  })
})
