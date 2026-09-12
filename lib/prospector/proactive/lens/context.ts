// ARCH-RULEPACK-001 — BUSINESS CONTEXT V0.
//
// ── UN OBJET DE DONNÉES, ET RIEN D'AUTRE ────────────────────────────────────
// Aucune fonction ici : le contexte est sérialisable, donc persistable et
// transmissible sans mécanisme particulier. Les fonctions (`relevance`, choix
// des packs) vivent dans `LensDefinition`, du code statique et versionné.
//
// ── L'INVARIANT D'AUTORITÉ ──────────────────────────────────────────────────
//
//   Tenant / Auth / Control Plane  →  autorité MAXIMALE
//   BusinessContext                →  peut UNIQUEMENT restreindre
//
// Un contexte fourni par un client ne doit jamais pouvoir s'accorder un droit
// nouveau. C'est vrai ici PAR CONSTRUCTION, et non par déclaration : il
// n'existe aucun champ qui élargisse quoi que ce soit.
//
//   • `scope` se réduit par INTERSECTION avec le périmètre du tenant. Un
//     `mode:'accounts'` filtre à l'intérieur du `ws` ; il ne peut pas nommer un
//     compte hors du `ws`, car la persistance exige `ws` à chaque appel et n'a
//     aucun chemin transverse (`persistence.ts`).
//   • `authorizedMotions` ne fait que DURCIR : une capacité absente vaut
//     `forbidden` (`motions.ts`).
//   • `controlFloor` d'un pack ne peut pas être assoupli par un contexte.
//   • `lensId` est contraint aux lenses enregistrées : aucun code ne peut être
//     introduit par un contexte.
//
// ⚠️ CE LOT NE CONSTRUIT PAS LE CONTROL PLANE, et ne prétend pas qu'une
// autorité account-level existe déjà — elle n'existe pas. `effectiveScope()`
// est écrit pour ACCUEILLIR cette autorité quand elle sera fournie, sans
// inventer aujourd'hui un mécanisme qui n'a rien à contrôler.
import type { AuthorizedMotion, MotionControl } from '../motions'
import { isLensId, type LensId } from './registry'

/**
 * Périmètre métier — union DISCRIMINÉE, jamais un optionnel.
 *
 * ⚠️ `accountIds?: string[]` avec « absent = tout » serait un fail-open : un
 * champ oublié élargirait le périmètre au lieu de le fermer. Le discriminant
 * `mode` rend l'intention obligatoire.
 *
 * ⚠️ Le dépôt compile avec `"strict": false`. Vérifié : `if (!s.accountIds)` ne
 * rétrécit PAS une union, alors que `s.mode === 'accounts'` le fait. Le
 * discriminant en chaîne n'est donc pas un choix de style, c'est le seul qui
 * fonctionne réellement ici.
 */
export type BusinessScope =
  | { mode: 'workspace' }
  | { mode: 'accounts'; accountIds: readonly string[] }

export interface BusinessContextV0 {
  /**
   * IDENTITÉ d'une CONFIGURATION — jamais d'une requête ni d'une exécution.
   *
   * ⚠️ Un identifiant tiré par appel (UUID, horodatage) détruirait d'un coup
   * l'idempotence, l'unicité des lignes et le test « réévaluer trois fois ne
   * crée aucun doublon » : chaque évaluation produirait une recommandation
   * neuve, indéfiniment.
   */
  contextId: string
  /** PROVENANCE. N'entre pas dans l'identité — même doctrine que ruleVersion. */
  contextVersion: string

  role: string
  scope: BusinessScope
  authorizedMotions: Readonly<Partial<Record<AuthorizedMotion, MotionControl>>>

  lensId: LensId
  lensVersion: string
}

export type ContextRejection =
  | 'context_missing'
  | 'context_id_missing'
  | 'context_version_missing'
  | 'role_missing'
  | 'scope_invalid'
  | 'lens_unknown'
  | 'lens_version_mismatch'
  | 'motions_invalid'

export type ContextValidation =
  | { ok: true; context: BusinessContextV0 }
  | { ok: false; reason: ContextRejection }

const MOTION_CONTROLS: readonly string[] = ['allowed', 'approval_required', 'forbidden']

function scopeValide(scope: any): scope is BusinessScope {
  if (!scope || typeof scope !== 'object') return false
  if (scope.mode === 'workspace') return true
  if (scope.mode === 'accounts') {
    return (
      Array.isArray(scope.accountIds) &&
      scope.accountIds.every((id: any) => typeof id === 'string' && id.trim().length > 0)
    )
  }
  return false // mode inconnu ou absent — jamais élargi
}

/**
 * Valide un Business Context. FAIL CLOSED de bout en bout.
 *
 * Un contexte absent, incomplet ou incohérent ne se répare pas et ne se
 * complète pas : il se refuse. Synthétiser un contexte « par défaut » parce
 * qu'un appelant a oublié le sien reviendrait à décider à sa place quelles
 * capacités il possède.
 *
 * ⚠️ La version de lens est vérifiée. Utiliser silencieusement une version plus
 * récente attribuerait des situations à une politique qui ne les a pas
 * produites — l'inverse exact de la reproductibilité recherchée.
 */
export function validateBusinessContext(
  input: unknown,
  lensVersionOf: (id: LensId) => string,
): ContextValidation {
  const c = input as BusinessContextV0

  if (!c || typeof c !== 'object') return { ok: false, reason: 'context_missing' }
  if (typeof c.contextId !== 'string' || !c.contextId.trim()) {
    return { ok: false, reason: 'context_id_missing' }
  }
  if (typeof c.contextVersion !== 'string' || !c.contextVersion.trim()) {
    return { ok: false, reason: 'context_version_missing' }
  }
  if (typeof c.role !== 'string' || !c.role.trim()) {
    return { ok: false, reason: 'role_missing' }
  }
  if (!scopeValide(c.scope)) return { ok: false, reason: 'scope_invalid' }

  if (typeof c.lensId !== 'string' || !isLensId(c.lensId)) {
    return { ok: false, reason: 'lens_unknown' }
  }
  if (c.lensVersion !== lensVersionOf(c.lensId)) {
    return { ok: false, reason: 'lens_version_mismatch' }
  }

  if (!c.authorizedMotions || typeof c.authorizedMotions !== 'object') {
    return { ok: false, reason: 'motions_invalid' }
  }
  for (const niveau of Object.values(c.authorizedMotions)) {
    if (typeof niveau !== 'string' || !MOTION_CONTROLS.includes(niveau)) {
      return { ok: false, reason: 'motions_invalid' }
    }
  }

  return { ok: true, context: c }
}

/**
 * Périmètre EFFECTIF — point d'accueil de l'autorité, pas un faux contrôle.
 *
 * ⚠️ AUCUNE AUTORITÉ ACCOUNT-LEVEL N'EXISTE ENCORE dans le dépôt. Il serait
 * malhonnête de faire croire le contraire en fabriquant ici un mécanisme qui
 * ne contrôlerait rien. Cette fonction se contente donc de poser la forme :
 *
 *     effectiveScope = resolvedAuthority ∩ businessScope
 *
 * `resolvedAuthority` absente ⇒ le périmètre métier s'applique tel quel, et
 * l'isolation continue de reposer sur `ws`, exigé par la persistance à chaque
 * appel. Quand l'autorité existera, l'intersection deviendra réelle sans que
 * la signature bouge.
 */
export function effectiveScope(
  businessScope: BusinessScope,
  resolvedAuthority?: BusinessScope,
): BusinessScope {
  if (!resolvedAuthority) return businessScope

  if (resolvedAuthority.mode === 'workspace') return businessScope
  if (businessScope.mode === 'workspace') return resolvedAuthority

  const autorises = new Set(resolvedAuthority.accountIds)
  return {
    mode: 'accounts',
    // INTERSECTION, jamais union : le contexte ne peut que retrancher.
    accountIds: businessScope.accountIds.filter((id) => autorises.has(id)),
  }
}

/** Le compte est-il dans le périmètre ? */
export function scopeIncludes(scope: BusinessScope, accountId: string): boolean {
  if (scope.mode === 'workspace') return true
  return scope.accountIds.includes(accountId)
}
