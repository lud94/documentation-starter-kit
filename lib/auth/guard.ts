import type { NextApiRequest } from 'next'
import { readSession, SESSION_COOKIE } from './session'

// Vrai si la requête porte une session admin. Les anciens jetons sans rôle
// (émis avant l'ajout des rôles) sont considérés admin (compte unique existant).
export async function isAdminRequest(req: NextApiRequest): Promise<boolean> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  if (!claims) return false
  return claims.role === 'admin' || !claims.role
}
