// SIGNAL-PRODUCT-REACHABILITY-001 — SOURCE AUTORITAIRE DU CONTEXTE MÉTIER.
//
// ── LE BLOCAGE QUE CE MODULE LÈVE ───────────────────────────────────────────
// `BusinessContextV0` existait comme CONTRAT sans aucune source de production :
// il n'était construit nulle part hors tests, et `orchestrator.evaluate()`
// l'exige sans valeur par défaut. Le Decision Kernel était donc inatteignable
// depuis le produit, quelle que soit la qualité des faits en amont.
//
// ── CE MODULE NE CRÉE AUCUNE AUTORITÉ ───────────────────────────────────────
// ⚠️ INVARIANT CENTRAL : un contexte métier peut RESTREINDRE une capacité, il
// n'en accorde JAMAIS une que l'authentification et le tenant ne donnent pas.
// C'est une configuration de LECTURE, cloisonnée par espace, et le périmètre
// `workspace` qu'elle peut porter désigne l'espace DÉJÀ résolu par
// `resolveTenantFromRequest` — jamais un autre.
//
// ── AUCUN DÉFAUT SILENCIEUX ─────────────────────────────────────────────────
// Un espace sans configuration ne reçoit PAS un contexte fabriqué : il reçoit
// un état produit explicite, `BUSINESS_CONTEXT_REQUIRED`. Synthétiser un
// `contextId: 'default'` reviendrait à décider à la place de l'utilisateur
// quelles capacités il détient — exactement ce que `recommendationEngine.ts:95`
// interdit nommément.
//
// ── PAS DE SOUS-SYSTÈME RELATIONNEL ─────────────────────────────────────────
// Le magasin générique `prospector_store (kind, id, workspace_id, data jsonb)`
// existe, porte déjà RLS et le cloisonnement par espace. Créer des tables pour
// une configuration par espace serait une migration sans bénéfice.
import { getItemStrict, upsertItem } from '../../../supabase/store'
// ⚠️ On réutilise la validation DU KERNEL, jamais une seconde application de la
// règle : `resolveBusinessContext` est exactement ce que `evaluate()` applique.
// Valider ici avec une variante ferait accepter une configuration que le moteur
// refuserait ensuite en silence, en rendant une évaluation vide.
import { resolveBusinessContext } from '../decisionKernel'
import { SALES_DEFAULT_LENS } from './registry'
import type { BusinessContextV0 } from './context'

/**
 * `kind` du magasin.
 *
 * ⚠️ DISTINCT des quatre `PROACTIVE_KINDS`. Ceux-ci rangent des FAITS, des
 * interprétations et des décisions ; celui-ci range une CONFIGURATION. Les
 * mélanger sous un même `kind` ferait relire une configuration comme une
 * evidence — un mélange que `persistence.ts` documente déjà comme interdit.
 */
export const BUSINESS_CONTEXT_KIND = 'proactive_business_context'

/** Un seul contexte actif par espace en V0. L'identité est donc constante. */
export const ACTIVE_CONTEXT_ID = 'active'

export type ContextLoad =
  | { ok: true; context: BusinessContextV0 }
  | { ok: false; state: 'BUSINESS_CONTEXT_REQUIRED' }
  | { ok: false; state: 'BUSINESS_CONTEXT_INVALID'; reason: string }
  | { ok: false; state: 'BUSINESS_CONTEXT_UNAVAILABLE' }

/**
 * Charge le contexte métier D'UN ESPACE.
 *
 * ⚠️ REVALIDÉ À LA LECTURE. Ce qui remonte du magasin est du `jsonb` que rien ne
 * contraint côté base : une ligne écrite par une version antérieure, ou
 * corrompue, ne doit pas devenir l'autorité d'une évaluation. La règle de
 * validation n'est pas réécrite ici — c'est `validateBusinessContext`, celle-là
 * même que le kernel applique.
 *
 * QUATRE états DISTINCTS, jamais confondus : configuré et valide · absent ·
 * présent mais invalide · base muette. Chacun appelle un geste différent —
 * configurer, réparer, ou réessayer.
 *
 * ⚠️ `getItemStrict`, ET NON `getItem`. Ce dernier est indulgent : il rend
 * `null` aussi bien pour « il n'y a pas de ligne » que pour « la base n'a pas
 * répondu ». Confondre les deux dirait à un utilisateur de configurer son
 * contexte métier pendant une panne de base — il corrigerait ce qui n'est pas
 * cassé, et la configuration existante resterait ignorée.
 */
export async function loadBusinessContext(ws: string): Promise<ContextLoad> {
  if (typeof ws !== 'string' || ws.trim() === '') {
    return { ok: false, state: 'BUSINESS_CONTEXT_REQUIRED' }
  }

  const lu = await getItemStrict<BusinessContextV0>(BUSINESS_CONTEXT_KIND, ACTIVE_CONTEXT_ID, ws)
  if (lu.ok === false) return { ok: false, state: 'BUSINESS_CONTEXT_UNAVAILABLE' }

  const brut = lu.value
  if (!brut) return { ok: false, state: 'BUSINESS_CONTEXT_REQUIRED' }

  const validation = resolveBusinessContext(brut)
  if (validation.ok === false) {
    return { ok: false, state: 'BUSINESS_CONTEXT_INVALID', reason: validation.reason }
  }

  return { ok: true, context: brut }
}

/**
 * Modèle d'activation « Sales V0 » — CONSTRUIT PAR LE SERVEUR.
 *
 * ── LE BLOCAGE PRODUIT QUE CECI LÈVE (R1c·P1) ───────────────────────────────
 * `saveBusinessContext` existait sans AUCUN appelant de production : seuls les
 * tests l'invoquaient. Un espace réel atteignait donc `BUSINESS_CONTEXT_REQUIRED`
 * et ne pouvait plus en sortir par le produit — le Kernel restait inatteignable
 * malgré tout le reste du chantier.
 *
 * ── CE QUE CE MODÈLE N'EST PAS ──────────────────────────────────────────────
 * ⚠️ CE N'EST PAS UN CONTEXTE PAR DÉFAUT. Rien ne l'écrit tout seul : il faut un
 * geste explicite d'une personne authentifiée. Un espace non configuré le reste,
 * et continue de recevoir `BUSINESS_CONTEXT_REQUIRED`.
 *
 * ⚠️ AUCUNE AUTORITÉ NOUVELLE. `contact_prospect` — la seule capacité à effet
 * EXTERNE et irréversible — est `approval_required`, jamais `allowed` : activer
 * la lecture proactive ne doit pas accorder au passage le droit d'écrire à un
 * prospect. Les trois autres capacités sont internes et réversibles.
 *
 * ⚠️ `lensVersion` VIENT DU REGISTRE SERVEUR. L'accepter du client permettrait
 * d'épingler une version arbitraire et de contourner `lens_version_mismatch` —
 * la garde qui empêche une configuration écrite pour une lens d'être relue par
 * une autre.
 *
 * ⚠️ PORTÉE = L'ESPACE AUTHENTIFIÉ, et lui seul. `{ mode: 'workspace' }` ne
 * désigne jamais qu'un espace déjà résolu par la session.
 */
export function salesV0Context(): BusinessContextV0 {
  return {
    // Identité STABLE d'une configuration : deux activations successives
    // doivent produire la même, sans quoi chaque geste créerait une
    // recommandation neuve indéfiniment.
    contextId: 'sales-v0',
    contextVersion: 'v0.1',
    role: 'sales_rep',
    scope: { mode: 'workspace' },
    authorizedMotions: {
      prepare_outreach: 'allowed',
      enrich_data: 'allowed',
      schedule_reminder: 'allowed',
      contact_prospect: 'approval_required',
    },
    lensId: SALES_DEFAULT_LENS.lensId as 'sales-default',
    lensVersion: SALES_DEFAULT_LENS.lensVersion,
  }
}

/**
 * Enregistre le contexte métier d'un espace.
 *
 * ⚠️ VALIDÉ AVANT ÉCRITURE, avec la MÊME règle qu'à la lecture. Écrire une
 * configuration invalide reviendrait à différer la panne jusqu'à la prochaine
 * évaluation, loin du geste qui l'a causée.
 */
export async function saveBusinessContext(
  context: BusinessContextV0,
  ws: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'workspace_missing' }

  const validation = resolveBusinessContext(context)
  if (validation.ok === false) return { ok: false, reason: validation.reason }

  const ecrit = await upsertItem(BUSINESS_CONTEXT_KIND, ACTIVE_CONTEXT_ID, context, ws)
  return ecrit ? { ok: true } : { ok: false, reason: 'store_write_failed' }
}
