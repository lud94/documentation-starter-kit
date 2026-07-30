import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'
import { getWorkspaceById } from '../../../lib/supabase/workspaces'
import { DEFAULT_PERMISSIONS } from '../../../types/prospector'

// Politique d'usage des IA externes (Claude/ChatGPT/Perplexity depuis la fiche).
// - allowed : autorisé pour cet espace (permission workspace)
// - maskPii : si l'anonymisation est active, les noms de personnes sont masqués
//   dans le prompt pré-rempli avant de partir chez un tiers.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const maskPii = getKey('PII_MASKING') === '1' || getKey('PII_MASKING') === 'true'
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])

  if (claims?.role === 'client' && claims.ws) {
    const ws = await getWorkspaceById(claims.ws)
    const perms = ws?.permissions || DEFAULT_PERMISSIONS
    return res.status(200).json({ allowed: perms.externalAI !== false, maskPii })
  }
  // Admin : toujours autorisé (c'est lui qui décide pour ses clients).
  res.status(200).json({ allowed: true, maskPii })
}
