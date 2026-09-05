import type { NextApiRequest } from 'next'
import { readSession, SESSION_COOKIE } from './session'

/**
 * Vrai UNIQUEMENT si la requête porte une session dont le rôle est
 * explicitement `admin`.
 *
 * ── LE DÉFAUT FERMÉ (lot SEC-AUTH-0) ────────────────────────────────────────
 * La version précédente rendait `claims.role === 'admin' || !claims.role` :
 * une session SANS RÔLE était promue administrateur, au nom des jetons émis
 * avant l'introduction des rôles. Or `/api/auth/setup` en émettait encore, et
 * n'importe quel jeton signé dont le rôle manquait — y compris forgé avec le
 * secret public par défaut — devenait administrateur.
 *
 * `readSession` refuse désormais les jetons sans rôle en amont ; ce test
 * explicite reste par ceinture et bretelles.
 */
export async function isAdminRequest(req: NextApiRequest): Promise<boolean> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  return claims?.role === 'admin'
}
