// SIGNAL-PRODUCT-REACHABILITY-001-R1c — ACTIVATION EXPLICITE DU CONTEXTE MÉTIER.
//
// ── LE BLOCAGE PRODUIT QUE CETTE ROUTE LÈVE ─────────────────────────────────
// En R1b, `saveBusinessContext()` n'avait AUCUN appelant de production : seuls
// les tests l'invoquaient. Un espace réel atteignait donc `BUSINESS_CONTEXT_REQUIRED`
// et ne pouvait plus en sortir PAR LE PRODUIT. Tout le chantier amont — Bridge,
// registre de candidats, accumulation stricte — restait injoignable en pratique.
//
// ── CE QUE CETTE ROUTE N'EST PAS ────────────────────────────────────────────
// ⚠️ CE N'EST PAS UN PLAN DE CONTRÔLE. Pas d'administration d'espaces, pas de
// gestion de rôles, pas d'éditeur de capacités, pas de configuration d'autrui.
// Deux gestes, et rien de plus : LIRE l'état de son propre espace, et ACTIVER
// le modèle Sales V0 pour cet espace.
//
// ⚠️ AUCUN CONTEXTE N'EST CRÉÉ SILENCIEUSEMENT. `GET` ne configure rien ; seul un
// `POST` — donc un geste délibéré d'une personne authentifiée — écrit. Un espace
// non configuré le reste tant que personne ne l'active.
//
// ⚠️ AUCUNE AUTORITÉ NOUVELLE N'EST ACCORDÉE. Le contexte est construit par le
// SERVEUR (`salesV0Context`) à partir du registre de lens ; le corps de la
// requête ne porte aucune capacité, aucun `lensVersion`, aucun périmètre. Le
// navigateur choisit d'activer, il ne choisit pas ce qui est activé.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import {
  loadBusinessContext,
  salesV0Context,
  saveBusinessContext,
} from '../../../lib/prospector/proactive/lens/contextStore'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

export type ContextState =
  | 'UNAUTHENTICATED'
  | 'BUSINESS_CONTEXT_REQUIRED'
  | 'BUSINESS_CONTEXT_INVALID'
  | 'BUSINESS_CONTEXT_UNAVAILABLE'
  | 'BUSINESS_CONTEXT_ACTIVE'
  | 'ACTIVATION_FAILED'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ state: 'BUSINESS_CONTEXT_REQUIRED', reason: 'method' })
  }

  // ⚠️ ESPACE ET ACTEUR VIENNENT DE LA SESSION. Jamais du corps : un espace
  // fourni par l'appelant configurerait l'espace d'un autre client.
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id
  if (!ws) return res.status(403).json({ state: 'UNAUTHENTICATED' })

  try {
    if (req.method === 'POST') {
      // ⚠️ LE MODÈLE EST CONSTRUIT ICI, PAS REÇU. Rien du corps n'entre dans le
      // contexte écrit — ni capacités, ni périmètre, ni version de lens.
      const ecrit = await saveBusinessContext(salesV0Context(), ws)
      if (ecrit.ok === false) {
        // On n'annonce pas une activation qui n'a pas survécu à l'écriture.
        return res.status(503).json({ state: 'ACTIVATION_FAILED', reason: ecrit.reason })
      }
    }

    // ── ÉTAT RELU, JAMAIS DÉDUIT DE L'ÉCRITURE ────────────────────────────
    // ⚠️ Après un POST, on RELIT plutôt que d'affirmer « actif ». Une écriture
    // acceptée puis relue invalide — ligne tronquée, version de contrat
    // divergente — doit se voir ici, au moment du geste, et non à la prochaine
    // évaluation.
    const charge = await loadBusinessContext(ws)
    if (charge.ok === false) {
      const code = charge.state === 'BUSINESS_CONTEXT_UNAVAILABLE' ? 503 : 200
      return res.status(code).json({
        state: charge.state,
        reason: charge.state === 'BUSINESS_CONTEXT_INVALID' ? charge.reason : undefined,
      })
    }

    // ⚠️ On rend l'identité et les capacités RÉELLEMENT enregistrées, pour que
    // l'écran montre ce qui est en vigueur — jamais ce qu'il a demandé.
    return res.status(200).json({
      state: 'BUSINESS_CONTEXT_ACTIVE',
      contextId: charge.context.contextId,
      lensId: charge.context.lensId,
      lensVersion: charge.context.lensVersion,
      authorizedMotions: charge.context.authorizedMotions,
    })
  } catch (e) {
    logSafeError('proactive.context_failed', e, { operation: 'proactive_context' })
    return res.status(502).json({ state: 'ACTIVATION_FAILED', reason: PUBLIC_ERROR })
  }
}
