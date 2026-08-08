import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot MT-0 — le contexte tenant est la racine de confiance des appels LLM.
//
// Ce que ces cas verrouillent, dans l'ordre d'importance :
//   1. aucune session valide ⇒ AUCUN tenant — jamais « admin par défaut » ;
//   2. un client ne peut pas se faire passer pour un autre espace ;
//   3. un espace inexistant ou suspendu n'est pas un tenant ;
//   4. le contexte système ne s'obtient jamais par accident.

const getWorkspaceById = vi.fn()
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => getWorkspaceById(...a),
}))

import {
  resolveTenantFromRequest, systemTenant, tenantFromVerifiedWorkspace,
  SYSTEM_TENANT_ID, ADMIN_TENANT_ID, ACTIVE_WS_COOKIE, isBillableTenant,
} from '../lib/prospector/tenant'
import { createSessionToken, SESSION_COOKIE } from '../lib/auth/session'
import { useTestSessionSecret, forgeSession, futureExp } from './helpers/session'

const req = (cookies: Record<string, string> = {}, body?: any, query?: any) =>
  ({ cookies, body, query } as any)

async function clientSession(ws: string) {
  return createSessionToken('client@x.fr', 3600, { role: 'client', ws })
}
async function adminSession() {
  return createSessionToken('admin@x.fr', 3600, { role: 'admin' })
}

// SEC-AUTH-0 : plus aucun secret par défaut — la suite doit poser le sien.
useTestSessionSecret()

beforeEach(() => {
  useTestSessionSecret()
  getWorkspaceById.mockReset().mockResolvedValue({ id: 'ws_fabel', name: 'Fabel', status: 'active' })
})

describe('A/B — session client : le tenant est IMPOSÉ', () => {
  it('session ws_fabel → tenant ws_fabel', async () => {
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession('ws_fabel') }))
    expect(t).toEqual({ id: 'ws_fabel', kind: 'client' })
  })

  it('le body et la query ne peuvent PAS substituer un autre espace', async () => {
    const token = await clientSession('ws_fabel')
    const t = await resolveTenantFromRequest(req(
      { [SESSION_COOKIE]: token },
      { tenant: 'ws_client_b', workspace: 'ws_client_b', ws: 'ws_client_b' },
      { tenant: 'ws_client_b' },
    ))
    expect(t!.id).toBe('ws_fabel')
  })

  it('le cookie d\'espace actif est IGNORÉ pour un client', async () => {
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await clientSession('ws_fabel'),
      [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }))
    expect(t!.id).toBe('ws_fabel')
  })

  it('session client sans espace → refus, jamais un repli sur « admin »', async () => {
    // `activeWs()` retombait ici sur l'espace de l'ADMIN — donc un client mal
    // provisionné lisait et dépensait dans l'espace administrateur.
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession('') }))
    expect(t).toBeNull()
  })

  it('un client ne peut pas revendiquer le tenant système', async () => {
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession(SYSTEM_TENANT_ID) }))
    expect(t).toBeNull()
  })
})

describe('C — absence de session : JAMAIS admin', () => {
  it('aucun cookie → null', async () => {
    expect(await resolveTenantFromRequest(req({}))).toBeNull()
  })

  it('jeton invalide → null', async () => {
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: 'nimportequoi.signature' }))).toBeNull()
  })

  it('jeton expiré → null', async () => {
    const expired = await createSessionToken('a@b.c', -10, { role: 'admin' })
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: expired }))).toBeNull()
  })

  it('DÉFAUT CORRIGÉ : sans session, un cookie d\'espace actif ne suffit pas', async () => {
    // `activeWs()` traitait `!claims` comme un admin et rendait le cookie tel
    // quel — une route publique oubliée devenait un administrateur anonyme.
    const t = await resolveTenantFromRequest(req({ [ACTIVE_WS_COOKIE]: 'ws_fabel' }))
    expect(t).toBeNull()
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })
})

describe('D/E — admin : l\'espace actif doit EXISTER', () => {
  it('espace valide → accepté', async () => {
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_fabel',
    }))
    expect(t).toEqual({ id: 'ws_fabel', kind: 'admin' })
  })

  it('espace INEXISTANT → refus', async () => {
    getWorkspaceById.mockResolvedValue(null)
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_inexistant',
    }))
    expect(t).toBeNull()
  })

  it('espace SUSPENDU → refus', async () => {
    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_fabel',
    }))
    expect(t).toBeNull()
  })

  it('base indisponible → refus (fail closed), pas un tenant deviné', async () => {
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_fabel',
    }))
    expect(t).toBeNull()
  })

  it('sans cookie → espace propre de l\'admin, sans requête base', async () => {
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await adminSession() }))
    expect(t).toEqual({ id: ADMIN_TENANT_ID, kind: 'admin' })
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  it('un admin ne peut pas revendiquer le tenant système', async () => {
    const t = await resolveTenantFromRequest(req({
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: SYSTEM_TENANT_ID,
    }))
    expect(t).toBeNull()
  })

  // ⚠️ RUPTURE VOULUE (SEC-AUTH-0). Ce test affirmait l'inverse : une session
  // SANS RÔLE devenait administrateur, « mais seulement signature vérifiée ».
  // Or la signature ne prouve que l'intégrité — et avec le secret public qui
  // régnait par défaut, n'importe qui pouvait la produire. Les sessions
  // historiques sans rôle sont désormais invalidées, délibérément.
  it('session sans rôle → DENY, la signature ne remplace pas une affirmation', async () => {
    const sansRole = await forgeSession({ sub: 'admin@x.fr', exp: futureExp() })
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: sansRole }))).toBeNull()
  })

  it('rôle inconnu → DENY, jamais interprété', async () => {
    const bidon = await forgeSession({ sub: 'x@y.z', role: 'superadmin', exp: futureExp() })
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: bidon }))).toBeNull()
  })
})

describe('G/H — contexte système explicite', () => {
  it('étiquette listée → contexte système', () => {
    expect(systemTenant('diagnose')).toEqual({ id: SYSTEM_TENANT_ID, kind: 'system', systemTag: 'diagnose' })
  })

  it('étiquette non listée → refus, jamais un contexte système accidentel', () => {
    expect(() => systemTenant('jarvis' as any)).toThrow()
    expect(() => systemTenant('' as any)).toThrow()
  })

  it('le tenant système est DISTINCT de l\'espace admin', () => {
    expect(SYSTEM_TENANT_ID).not.toBe(ADMIN_TENANT_ID)
  })

  it('un endpoint public mal authentifié n\'obtient AUCUN contexte système', async () => {
    // Les routes publiques dérivent leur espace de leur propre garde ; un jeton
    // absent ou invalide rend `null` en amont, et `null` n'est pas un tenant.
    expect(await tenantFromVerifiedWorkspace(null)).toBeNull()
    expect(await tenantFromVerifiedWorkspace('')).toBeNull()
    expect(await tenantFromVerifiedWorkspace('   ')).toBeNull()
    // Refus PUREMENT syntaxique : la base n'est pas interrogée pour rien.
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  it('le tenant système n\'est pas usurpable depuis un jeton externe', async () => {
    expect(await tenantFromVerifiedWorkspace(SYSTEM_TENANT_ID)).toBeNull()
  })
})

describe('espaces résolus hors session (jeton d\'ingestion, appairage)', () => {
  it('espace client vérifié → tenant client', async () => {
    expect(await tenantFromVerifiedWorkspace('ws_fabel')).toEqual({ id: 'ws_fabel', kind: 'client' })
  })

  it('jeton global → espace admin, sans requête base', async () => {
    expect(await tenantFromVerifiedWorkspace(ADMIN_TENANT_ID)).toEqual({ id: 'admin', kind: 'admin' })
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  // ── SEC-0c : la révocation atteint AUSSI les racines hors session ──────────
  // Un jeton d'ingestion est dérivé par HMAC de l'identifiant d'espace, et un
  // lien de canal Telegram est durable : tous deux restaient valides après une
  // suspension ou une suppression. L'authenticité n'est pas la validité.
  it('espace SUPPRIMÉ → plus aucun tenant, jeton pourtant authentique', async () => {
    getWorkspaceById.mockResolvedValue(null)
    expect(await tenantFromVerifiedWorkspace('ws_fabel')).toBeNull()
  })

  it('espace SUSPENDU → plus aucun tenant', async () => {
    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    expect(await tenantFromVerifiedWorkspace('ws_fabel')).toBeNull()
  })

  it('base indisponible → refus, pas un tenant supposé', async () => {
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    expect(await tenantFromVerifiedWorkspace('ws_fabel')).toBeNull()
  })
})

// ── SEC-0c — révocation d'une session client ────────────────────────────────
describe('révocation : une session valide ne suffit plus', () => {
  it('DÉFAUT CORRIGÉ : suspendre un espace coupe l\'accès IMMÉDIATEMENT', async () => {
    // La session est un HMAC apatride de 12 h, sans révocation, et
    // `authClient()` ne teste `suspended` qu'à la CONNEXION. Suspendre un
    // espace le laissait donc travailler jusqu'à douze heures.
    const token = await clientSession('ws_fabel')
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: token }))).toEqual({ id: 'ws_fabel', kind: 'client' })

    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    expect(await resolveTenantFromRequest(req({ [SESSION_COOKIE]: token }))).toBeNull()
  })

  it('espace SUPPRIMÉ → la session ne vaut plus rien', async () => {
    getWorkspaceById.mockResolvedValue(null)
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession('ws_fabel') }))
    expect(t).toBeNull()
  })

  it('base indisponible → fail closed', async () => {
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession('ws_fabel') }))
    expect(t).toBeNull()
  })

  it('un jeton client portant « admin » est refusé', async () => {
    // `authClient()` n'émet jamais un tel jeton : sa présence est anormale.
    const t = await resolveTenantFromRequest(req({ [SESSION_COOKIE]: await clientSession(ADMIN_TENANT_ID) }))
    expect(t).toBeNull()
  })
})

describe('imputabilité', () => {
  it('null n\'est jamais imputable', () => {
    expect(isBillableTenant(null)).toBe(false)
    expect(isBillableTenant({ id: '', kind: 'client' })).toBe(false)
  })
  it('les trois natures le sont', () => {
    for (const kind of ['client', 'admin', 'system'] as const) {
      expect(isBillableTenant({ id: 'x', kind })).toBe(true)
    }
  })
})
