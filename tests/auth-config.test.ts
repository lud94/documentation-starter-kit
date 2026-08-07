// SEC-AUTH-0 — les deux verrous de CONFIGURATION, testés directement.
//
// Ce fichier exerce des modules créés par ce lot (`localSetupAllowed`,
// `appBaseUrl`, `sessionSecretConfigured`). Il ne peut donc pas, par
// construction, mordre le SHA d'avant : ces symboles n'y existent pas. Les
// contrôles négatifs qui comptent vivent dans `auth-identity.test.ts`, qui
// n'exerce que des surfaces communes aux deux versions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sessionSecretConfigured, MIN_SESSION_SECRET_BYTES } from '../lib/auth/session'
import { appBaseUrl } from '../lib/auth/baseUrl'
import { localSetupAllowed, resetPassword } from '../lib/prospector/auth'
import { resetStoreAuthoritative, createResetAuthority, claimResetAuthority } from '../lib/auth/resetAuthority'

const KEYS = ['APP_SESSION_SECRET', 'APP_BASE_URL', 'ALLOW_LOCAL_AUTH_SETUP', 'APP_ENV', 'NEXT_PUBLIC_APP_ENV', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL']
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe('le secret de session : présent ET assez long, ou rien', () => {
  it('absent, vide, ou uniquement des espaces → non configuré', () => {
    expect(sessionSecretConfigured()).toBe(false)
    for (const v of ['', '   ', '\n']) {
      process.env.APP_SESSION_SECRET = v
      expect(sessionSecretConfigured()).toBe(false)
    }
  })

  it('le seuil est une LONGUEUR, mesurée en octets UTF-8', () => {
    process.env.APP_SESSION_SECRET = 'a'.repeat(MIN_SESSION_SECRET_BYTES - 1)
    expect(sessionSecretConfigured()).toBe(false)
    process.env.APP_SESSION_SECRET = 'a'.repeat(MIN_SESSION_SECRET_BYTES)
    expect(sessionSecretConfigured()).toBe(true)
    // 16 caractères accentués = 32 octets : on compte les octets, pas les points
    // de code. Aucune « analyse d'entropie » — elle se truque, une longueur non.
    process.env.APP_SESSION_SECRET = 'é'.repeat(16)
    expect(sessionSecretConfigured()).toBe(true)
  })

  it('l\'ancien littéral public du dépôt est trop court pour être un secret', () => {
    process.env.APP_SESSION_SECRET = 'prospector-dev-secret-change-me'
    expect('prospector-dev-secret-change-me'.length).toBeLessThan(MIN_SESSION_SECRET_BYTES)
    expect(sessionSecretConfigured()).toBe(false)
  })
})

describe('APP_BASE_URL : déclarée, validée, ou aucune capacité', () => {
  it('absente ou syntaxiquement fausse → null', () => {
    expect(appBaseUrl()).toBeNull()
    for (const v of ['', '   ', 'pas-une-url', '//evil.example', 'app.prospector.fr']) {
      process.env.APP_BASE_URL = v
      expect(appBaseUrl()).toBeNull()
    }
  })

  it('HTTPS accepté ; le chemin et la requête sont écartés', () => {
    process.env.APP_BASE_URL = 'https://app.prospector-test.invalid/sous/chemin?x=1#y'
    expect(appBaseUrl()).toBe('https://app.prospector-test.invalid')
  })

  it('les schémas non http(s) sont refusés, y compris `javascript:`', () => {
    for (const v of ['javascript:alert(1)', 'ftp://x.fr', 'data:text/html,x', 'file:///etc/passwd']) {
      process.env.APP_BASE_URL = v
      expect(appBaseUrl()).toBeNull()
    }
  })

  it('HTTP n\'est toléré que sur localhost, et jamais sur un déploiement', () => {
    process.env.APP_BASE_URL = 'http://localhost:3000'
    expect(appBaseUrl()).toBe('http://localhost:3000')
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000'
    expect(appBaseUrl()).toBe('http://127.0.0.1:3000')
    // Un hôte distant en clair : refusé. Le lien de réinitialisation voyagerait
    // en clair, avec le jeton dedans.
    process.env.APP_BASE_URL = 'http://app.prospector-test.invalid'
    expect(appBaseUrl()).toBeNull()
    // Et sur Vercel, même localhost ne passe pas.
    process.env.APP_BASE_URL = 'http://localhost:3000'
    process.env.VERCEL_ENV = 'preview'
    expect(appBaseUrl()).toBeNull()
  })
})

describe('le setup local : trois conditions, toutes nécessaires', () => {
  it('par défaut → fermé', () => {
    expect(localSetupAllowed()).toBe(false)
  })

  it('l\'opt-in seul ne suffit pas sur un déploiement', () => {
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
    expect(localSetupAllowed()).toBe(true)          // local, opt-in explicite
    for (const v of ['production', 'preview', 'development']) {
      process.env.VERCEL_ENV = v
      expect(localSetupAllowed()).toBe(false)       // sur Vercel : jamais
    }
  })

  it('staging et production déclarés ferment le setup, opt-in ou pas', () => {
    process.env.ALLOW_LOCAL_AUTH_SETUP = '1'
    for (const env of ['staging', 'production']) {
      process.env.APP_ENV = env
      expect(localSetupAllowed()).toBe(false)
    }
    process.env.APP_ENV = 'development'
    expect(localSetupAllowed()).toBe(true)
  })

  it('l\'opt-in doit valoir exactement « 1 » — pas « true », pas « oui »', () => {
    for (const v of ['0', 'true', 'yes', 'oui', '', 'ALLOW']) {
      process.env.ALLOW_LOCAL_AUTH_SETUP = v
      expect(localSetupAllowed()).toBe(false)
    }
  })
})

// ── SEC-AUTH-0.2 — l'autorité de reset ne nomme plus un HÉBERGEUR ───────────
//
// ⚠️ LE DÉFAUT, ET C'ÉTAIT LE MIEN. SEC-AUTH-0.1 écrivait :
//
//     return supabaseConfigured() || !onVercel()
//
// « Tout ce qui n'est pas Vercel peut se contenter de sa mémoire. » J'avais
// nommé un FOURNISSEUR au lieu de nommer la PROPRIÉTÉ que je voulais : un
// magasin partagé. La même application sur Azure, AWS, une VM, un conteneur ou
// Kubernetes n'expose aucun `VERCEL_ENV` — sa production, sans Supabase,
// s'autorisait donc une autorité en mémoire, c'est-à-dire un lien de
// réinitialisation réutilisable une fois par processus.
describe('SEC-AUTH-0.2 — le repli mémoire de l\'autorité reset est explicite', () => {
  const cas = (env: string | undefined, vercel: string | undefined, supabase: boolean) => {
    if (env === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = env
    if (vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercel
    if (supabase) {
      process.env.SUPABASE_URL = 'https://projet-de-test.supabase.co'
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'clef-de-service-de-test-non-reelle'
    } else {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    }
    return resetStoreAuthoritative()
  }

  it('A — development, hors Vercel, sans Supabase → repli mémoire AUTORISÉ', () => {
    expect(cas('development', undefined, false)).toBe(true)
  })

  it('B/C — staging et production HORS VERCEL, sans Supabase → REFUSÉ', () => {
    // Le cœur du microfix : ces deux cas étaient `true` auparavant, au seul
    // motif que `VERCEL_ENV` était absent.
    expect(cas('staging', undefined, false)).toBe(false)
    expect(cas('production', undefined, false)).toBe(false)
  })

  it('D/E — APP_ENV absent ou invalide, sans Supabase → REFUSÉ', () => {
    // `appEnv()` rend `null` dans les deux cas, et `null` n'est pas
    // « development » : le repli d'un mécanisme de sécurité s'active sur une
    // décision, jamais sur un silence.
    expect(cas(undefined, undefined, false)).toBe(false)
    for (const invalide of ['foobar', 'dev', 'DEVELOPMENT', 'prod', '']) {
      expect(cas(invalide, undefined, false)).toBe(false)
    }
  })

  it('F — development sur Vercel, sans Supabase → REFUSÉ', () => {
    for (const v of ['preview', 'production', 'development']) {
      expect(cas('development', v, false)).toBe(false)
    }
  })

  it('G/H — avec Supabase, tout environnement et tout hébergeur → AUTORISÉ', () => {
    // Le but n'est pas d'interdire les autres clouds : c'est de cesser d'en
    // nommer un. Avec une base partagée, l'autorité tient, où qu'on tourne.
    for (const env of ['development', 'staging', 'production', undefined, 'foobar']) {
      for (const v of [undefined, 'preview', 'production']) {
        expect(cas(env, v, true)).toBe(true)
      }
    }
  })

  it('NODE_ENV n\'entre pas dans la décision', () => {
    // `NODE_ENV !== 'production'` était la tentation évidente. Elle ne
    // distingue ni une préversion, ni une préproduction, ni un vrai déploiement.
    try {
      for (const n of ['production', 'test', 'development']) {
        vi.stubEnv('NODE_ENV', n)
        expect(cas('staging', undefined, false)).toBe(false)
        expect(cas('development', undefined, false)).toBe(true)
      }
    } finally { vi.unstubAllEnvs() }
  })

  // ── §7 — le CHEMIN RÉEL, pas seulement le prédicat ───────────────────────
  it('production hors Vercel sans Supabase → aucune autorité créée, aucune consommée', async () => {
    cas('development', undefined, false)
    const a = await createResetAuthority()
    expect(a).not.toBeNull()

    // Le même processus se découvre « production » : plus rien ne passe, y
    // compris sur un bearer qui existait déjà.
    cas('production', undefined, false)
    expect(await createResetAuthority()).toBeNull()
    expect(await claimResetAuthority(a!.token)).toBe(false)
    expect(await resetPassword(a!.token, 'nouveau-mot-de-passe')).toBe(false)
  })

  it('development hors Vercel → création et consommation restent fonctionnelles', async () => {
    cas('development', undefined, false)
    const a = await createResetAuthority()
    expect(a).not.toBeNull()
    expect(await claimResetAuthority(a!.token)).toBe(true)
    expect(await claimResetAuthority(a!.token)).toBe(false)   // usage unique intact
  })
})
