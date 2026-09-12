import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appEnv, projectRole, validateConfig, resetConfigCache,
  canRead, canWrite, canRunJobs, connectorStatus, envSummary, writeAllowed,
} from '../lib/env'

// Le contrat d'environnement décide si l'application a le droit d'écrire.
// Une erreur ici se traduit soit par une écriture dans la mauvaise base, soit
// par un blocage injustifié : les deux sont graves, d'où la couverture serrée.

const KEYS = ['APP_ENV', 'NEXT_PUBLIC_APP_ENV', 'APP_PROJECT_ROLE', 'NEXT_PUBLIC_APP_PROJECT_ROLE',
  'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV', 'APP_SUPABASE_REF', 'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'APP_ENV_STRICT', 'APP_TELEGRAM_BOT_USERNAME']

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  resetConfigCache()
})
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  resetConfigCache()
})

function set(vals: Record<string, string>) {
  Object.entries(vals).forEach(([k, v]) => { process.env[k] = v })
  resetConfigCache()
}

describe('APP_ENV — aucun repli implicite', () => {
  it('absent → null, JAMAIS « production »', () => {
    expect(appEnv()).toBeNull()
    expect(validateConfig().configured).toBe(false)
    expect(validateConfig().appEnv).not.toBe('production')
  })

  it('valeur inconnue → rejetée, et signalée comme erreur', () => {
    set({ APP_ENV: 'prod' })
    expect(appEnv()).toBeNull()
    expect(validateConfig().issues.some((i) => i.code === 'app_env_invalid')).toBe(true)
  })

  it('valeurs acceptées', () => {
    for (const v of ['development', 'staging', 'production']) {
      set({ APP_ENV: v })
      expect(appEnv()).toBe(v)
    }
  })
})

describe('matrice APP_ENV × rôle de projet × VERCEL_ENV', () => {
  it('production sur projet de production en production : autorisé', () => {
    set({ APP_ENV: 'production', APP_PROJECT_ROLE: 'production', VERCEL_ENV: 'production' })
    expect(validateConfig().matrixOk).toBe(true)
    expect(canWrite().allowed).toBe(true)
  })

  it('staging sur projet de staging en VERCEL_ENV=production : AUTORISÉ', () => {
    // Cas réel : la préproduction a son propre projet Vercel et sa branche
    // principale, donc VERCEL_ENV vaut « production » alors que ce n'est pas
    // la production métier.
    set({ APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'production' })
    expect(validateConfig().matrixOk).toBe(true)
    expect(canWrite().allowed).toBe(true)
  })

  it('staging sur projet de staging en préversion : autorisé', () => {
    set({ APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'preview' })
    expect(validateConfig().matrixOk).toBe(true)
  })

  it('production sur une préversion : refusé', () => {
    set({ APP_ENV: 'production', APP_PROJECT_ROLE: 'production', VERCEL_ENV: 'preview' })
    const v = validateConfig()
    expect(v.matrixOk).toBe(false)
    expect(v.issues.some((i) => i.code === 'production_on_preview')).toBe(true)
    expect(canWrite().allowed).toBe(false)
  })

  it('APP_ENV ne correspond pas au rôle du projet : refusé', () => {
    set({ APP_ENV: 'production', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'production' })
    expect(validateConfig().issues.some((i) => i.code === 'env_role_mismatch')).toBe(true)
    expect(canWrite().allowed).toBe(false)
  })

  it('rôle de projet non déclaré sur Vercel : refusé', () => {
    set({ APP_ENV: 'staging', VERCEL_ENV: 'preview' })
    expect(validateConfig().issues.some((i) => i.code === 'role_missing')).toBe(true)
  })

  it('development sur un déploiement Vercel : refusé', () => {
    set({ APP_ENV: 'development', VERCEL_ENV: 'preview' })
    expect(validateConfig().issues.some((i) => i.code === 'dev_on_vercel')).toBe(true)
  })

  it('development en local : autorisé', () => {
    set({ APP_ENV: 'development' })
    expect(validateConfig().matrixOk).toBe(true)
    expect(canWrite().allowed).toBe(true)
  })
})

describe('cohérence de la base', () => {
  it('base inattendue → écritures ET tâches bloquées, lecture préservée', () => {
    set({
      APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'preview',
      APP_SUPABASE_REF: 'refstaging', SUPABASE_URL: 'https://refproduction.supabase.co',
    })
    const v = validateConfig()
    expect(v.supabaseOk).toBe(false)
    expect(canWrite().allowed).toBe(false)
    expect(canWrite().code).toBe('supabase_mismatch')
    expect(canRunJobs().allowed).toBe(false)
    expect(canRead()).toBe(true) // la lecture reste possible : on doit pouvoir diagnostiquer
  })

  it('base attendue → écritures autorisées', () => {
    set({
      APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'preview',
      APP_SUPABASE_REF: 'refstaging', SUPABASE_URL: 'https://refstaging.supabase.co',
    })
    expect(validateConfig().supabaseOk).toBe(true)
    expect(canWrite().allowed).toBe(true)
  })

  it('référence attendue non déclarée → avertissement, pas blocage', () => {
    set({ APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'preview' })
    expect(validateConfig().issues.some((i) => i.code === 'supabase_ref_undeclared')).toBe(true)
    expect(canWrite().allowed).toBe(true)
  })
})

describe('déploiement non configuré', () => {
  it('sans APP_ENV : écritures autorisées, mais signalées', () => {
    // Compromis assumé : une incohérence CONSTATÉE bloque, une configuration
    // ABSENTE ne bloque pas encore — sinon la fusion de ce lot interromprait la
    // production tant que les variables ne sont pas posées.
    expect(canWrite().allowed).toBe(true)
    expect(validateConfig().issues.some((i) => i.code === 'app_env_missing')).toBe(true)
  })

  it('mode strict : l’absence devient bloquante', () => {
    set({ APP_ENV_STRICT: '1' })
    expect(canWrite().allowed).toBe(false)
    expect(canWrite().code).toBe('app_env_missing')
  })
})

describe('connecteurs optionnels', () => {
  it('un bot Telegram divergent désactive le canal, rien d’autre', () => {
    set({ APP_ENV: 'staging', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'preview', APP_TELEGRAM_BOT_USERNAME: 'prospector_staging_bot' })
    expect(connectorStatus('telegram', 'prospector_prod_bot').allowed).toBe(false)
    expect(connectorStatus('telegram', 'prospector_staging_bot').allowed).toBe(true)
    // L'application, elle, écrit toujours.
    expect(canWrite().allowed).toBe(true)
  })

  it('un connecteur sans identité déclarée reste actif', () => {
    expect(connectorStatus('anthropic').allowed).toBe(true)
    expect(connectorStatus('exa').allowed).toBe(true)
  })
})

describe('surface exposée', () => {
  it('envSummary() ne contient aucune valeur de secret', () => {
    set({
      APP_ENV: 'production', APP_PROJECT_ROLE: 'production', VERCEL_ENV: 'production',
      SUPABASE_URL: 'https://refprod.supabase.co', APP_SUPABASE_REF: 'refprod',
    })
    const json = JSON.stringify(envSummary())
    expect(json).not.toContain('supabase.co')   // l'URL complète n'est pas exposée
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{5}/) // aucun JWT
    expect(json).toContain('refprod')            // seule la référence publique
    expect(envSummary().verification).toBe('ENVIRONMENT_VARIABLE_ONLY')
  })

  it('writeAllowed() suit canWrite()', () => {
    set({ APP_ENV: 'production', APP_PROJECT_ROLE: 'staging', VERCEL_ENV: 'production' })
    expect(writeAllowed('prospector_leads')).toBe(false)
    set({ APP_ENV: 'production', APP_PROJECT_ROLE: 'production', VERCEL_ENV: 'production' })
    expect(writeAllowed('prospector_leads')).toBe(true)
  })
})

describe('rôle du projet', () => {
  it('valeur inconnue rejetée', () => {
    set({ APP_PROJECT_ROLE: 'preprod' })
    expect(projectRole()).toBeNull()
  })
})
