// SEC-AUTH-0 — les deux verrous de CONFIGURATION, testés directement.
//
// Ce fichier exerce des modules créés par ce lot (`localSetupAllowed`,
// `appBaseUrl`, `sessionSecretConfigured`). Il ne peut donc pas, par
// construction, mordre le SHA d'avant : ces symboles n'y existent pas. Les
// contrôles négatifs qui comptent vivent dans `auth-identity.test.ts`, qui
// n'exerce que des surfaces communes aux deux versions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sessionSecretConfigured, MIN_SESSION_SECRET_BYTES } from '../lib/auth/session'
import { appBaseUrl } from '../lib/auth/baseUrl'
import { localSetupAllowed } from '../lib/prospector/auth'

const KEYS = ['APP_SESSION_SECRET', 'APP_BASE_URL', 'ALLOW_LOCAL_AUTH_SETUP', 'APP_ENV', 'NEXT_PUBLIC_APP_ENV', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV']
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
