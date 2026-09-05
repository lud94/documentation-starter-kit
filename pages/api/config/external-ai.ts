import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { resolveTenantFromRequest, ADMIN_TENANT_ID } from '../../../lib/prospector/tenant'
import { getWorkspaceById } from '../../../lib/supabase/workspaces'
import { DEFAULT_PERMISSIONS } from '../../../types/prospector'

// Politique d'usage des IA externes (Claude/ChatGPT/Perplexity depuis la fiche).
// - allowed : autorisé pour cet espace (permission workspace)
// - maskPii : si l'anonymisation est active, les noms de personnes sont masqués
//   dans le prompt pré-rempli avant de partir chez un tiers.
//
// ── DÉFAUT CORRIGÉ (lot SEC-0c) ──────────────────────────────────────────────
// La condition d'entrée était `claims?.role === 'client' && claims.ws`. Tout ce
// qui n'y répondait pas — AUCUNE session, session client SANS espace, jeton au
// rôle vide — tombait dans la branche « Admin : toujours autorisé » et
// recevait `allowed: true`. Un repli permissif, exactement dans une route dont
// la seule fonction est de dire si l'on a le droit d'envoyer des données
// prospect vers un tiers.
//
// Le contrat est désormais : autorité d'abord, réponse ensuite. Aucun repli.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // L'autorité est établie AVANT toute lecture de réglages : sans espace
  // valide, un appelant n'apprend même pas si l'anonymisation est active.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })

  await hydrateKeystore()
  const maskPii = getKey('PII_MASKING') === '1' || getKey('PII_MASKING') === 'true'

  // L'espace propre de l'administrateur n'a pas de ligne en base et ne porte
  // aucune permission client : c'est le sien, il l'utilise sans restriction.
  if (tenant.id === ADMIN_TENANT_ID) return res.status(200).json({ allowed: true, maskPii })

  // Tout autre espace répond de SA permission — y compris quand un admin y
  // travaille via le sélecteur. Un administrateur qui consulte l'espace d'un
  // client voit alors exactement ce que ce client voit, ce qui est la seule
  // lecture cohérente d'une permission posée « pour cet espace ».
  //
  // Base indisponible ⇒ refus. Une permission non vérifiable n'autorise rien :
  // le trafic concerné part chez un tiers.
  try {
    const ws = await getWorkspaceById(tenant.id)
    if (!ws) return res.status(403).json({ error: 'forbidden' })
    const perms = ws.permissions || DEFAULT_PERMISSIONS
    return res.status(200).json({ allowed: perms.externalAI !== false, maskPii })
  } catch {
    return res.status(503).json({ error: 'policy_unavailable' })
  }
}
