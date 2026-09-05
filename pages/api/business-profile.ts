// JS-012_BUSINESS_CONTEXT_V0_002 — PROFIL D'ENTREPRISE : LECTURE ET REMPLACEMENT.
//
// ── CE QUE CETTE ROUTE N'EST PAS ────────────────────────────────────────────
// ⚠️ CE N'EST PAS UN ÉDITEUR D'AUTORITÉ. Aucun rôle, aucune capacité, aucun
// périmètre, aucune politique d'interprétation ne transite par ici — ces
// concepts n'existent pas dans le contrat du profil, et la validation refuse
// toute clé étrangère. Le profil DÉCRIT l'entreprise ; il n'accorde rien.
//
// Elle est DISTINCTE de la route d'activation runtime proactive existante :
// là-bas, le serveur construit tout et le client ne choisit que d'activer ;
// ici, le CONTENU DESCRIPTIF vient du client et le serveur ne construit que
// les métadonnées (version de schéma, identifiant de révision, horodatage).
// Fusionner les deux inverserait la garantie la plus forte de chacune.
//
// ── GET / PUT, PAS DE PATCH ─────────────────────────────────────────────────
// Une seule ressource active par espace, remplacée EN ENTIER : PUT. Pas de
// fusion partielle en V0 — une fusion silencieuse déciderait quels champs
// survivent à la place de l'utilisateur.
//
// ── LECTURE ≠ REVALIDATION ──────────────────────────────────────────────────
// GET effectue : résolution de session, UNE lecture cloisonnée du magasin,
// validation de contrat locale et déterministe. RIEN d'autre : aucune
// écriture, aucun LLM, aucun réseau externe, aucune recapture, aucune Mission.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../lib/prospector/tenant'
import {
  loadCompanyProfile,
  saveCompanyProfile,
} from '../../lib/prospector/proactive/profile/companyProfileStore'
import { logSafeError, PUBLIC_ERROR } from '../../lib/observability/safeError'

export type ProfileState =
  | 'UNAUTHENTICATED'
  | 'PROFILE_NOT_CONFIGURED'
  | 'PROFILE_CONFIGURED'
  | 'PROFILE_INVALID'
  | 'PROFILE_UNAVAILABLE'
  | 'PROFILE_REJECTED'
  | 'SAVE_FAILED'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ state: 'PROFILE_NOT_CONFIGURED', reason: 'method' })
  }

  // ⚠️ ESPACE ET ACTEUR VIENNENT DE LA SESSION. Jamais du corps ni de la
  // requête : un espace fourni par l'appelant écrirait le profil d'un autre
  // client. Aucune clé `workspace`/`workspaceId` n'est lue — et si le corps en
  // portait une, la validation du contenu la refuserait comme clé inconnue.
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id
  if (!ws) return res.status(403).json({ state: 'UNAUTHENTICATED' })

  try {
    if (req.method === 'PUT') {
      // ⚠️ SEUL LE CONTENU DESCRIPTIF est accepté. schemaVersion, revisionId,
      // updatedAt, workspace — toute clé hors des 8 champs du contrat — sont
      // refusées par la validation (unknown_key), jamais ignorées en silence.
      const ecrit = await saveCompanyProfile(req.body, ws)
      if (ecrit.ok === false) {
        const code = ecrit.reason === 'store_write_failed' ? 503 : 422
        return res.status(code).json({
          state: ecrit.reason === 'store_write_failed' ? 'SAVE_FAILED' : 'PROFILE_REJECTED',
          reason: ecrit.reason,
        })
      }
    }

    // ── ÉTAT RELU, JAMAIS DÉDUIT DE L'ÉCRITURE ────────────────────────────
    // Après un PUT, on RELIT le magasin plutôt que d'affirmer le succès : une
    // écriture acceptée puis relue invalide doit se voir au moment du geste.
    const charge = await loadCompanyProfile(ws)
    if (charge.ok === false) {
      const code = charge.state === 'PROFILE_UNAVAILABLE' ? 503 : 200
      return res.status(code).json({
        state: charge.state,
        reason: charge.state === 'PROFILE_INVALID' ? charge.reason : undefined,
      })
    }

    // PROFILE_CONFIGURED signifie UNIQUEMENT « un profil stocké valide
    // existe » — pas « assez complet pour raisonner » : un profil dont tous
    // les champs sont UNKNOWN est configuré, et c'est dit tel quel.
    return res.status(200).json({
      state: 'PROFILE_CONFIGURED',
      profile: charge.profile,
    })
  } catch (e) {
    logSafeError('business_profile.failed', e, { operation: 'business_profile' })
    return res.status(502).json({ state: 'SAVE_FAILED', reason: PUBLIC_ERROR })
  }
}
