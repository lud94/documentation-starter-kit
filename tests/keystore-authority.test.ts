// SEC-SECRETS-0C.0.3 — LA BASE NE DÉCIDE PAS DE CE QUI FAIT AUTORITÉ.
//
// `MANAGED_KEYS` ne filtrait que l'ÉCRITURE. `hydrateKeystore()` chargeait
// TOUTES les lignes de `prospector_settings` dans le magasin mémoire, et
// `getKey` sert ce magasin AVANT `process.env`. L'application refusait donc
// d'ÉCRIRE un nom non géré, mais acceptait de le LIRE s'il apparaissait en base.
//
// Insérer une ligne suffisait à créer une autorité que le code n'avait jamais
// prévue. Trois valeurs critiques en INTÉGRITÉ, toutes supposées venir de
// l'environnement seul, étaient atteignables ainsi :
//
//   • EXTENSION_ORIGINS      → l'allowlist CORS de l'extension ;
//   • AI_BUDGET_RESERVATION  → le mode du garde budgétaire ;
//   • AI_BUDGET_OBSERVE_LIMIT→ son plafond.
//
// Ce fichier éprouve la frontière : DB-capable = nomenclature du CODE ; tout le
// reste est ENV-only, quoi que contienne la base.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** Contenu simulé de `prospector_settings`. Le test le pilote ligne à ligne. */
let LIGNES_DB: Record<string, string> = {}
const saveSetting = vi.fn(async () => true)
vi.mock('../lib/supabase/settings', () => ({
  loadAllSettings: async () => LIGNES_DB,
  saveSetting: (...a: any[]) => (saveSetting as any)(...a),
}))

import { getKey, setKeys, hasKey, keySource, hydrateKeystore, isManagedKey, MANAGED_KEYS } from '../lib/prospector/keystore'
import { allowedOrigins } from '../lib/prospector/extensionGate'
import { tokenForWorkspace } from '../lib/prospector/wstoken'

// Valeurs de TEST, sans aucune valeur ailleurs.
const ORIGINE_LEGITIME = 'chrome-extension://legitimeaaaaaaaaaaaaaaaaaaaaaaaa'
const ORIGINE_HOSTILE = 'chrome-extension://hostilebbbbbbbbbbbbbbbbbbbbbbbb'

const ENV = [
  'EXTENSION_ORIGINS', 'AI_BUDGET_RESERVATION', 'AI_BUDGET_OBSERVE_LIMIT',
  'APP_SESSION_SECRET', 'PII_MASKING', 'JARVIS_MODEL', 'TOTALLY_UNKNOWN_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'PROSPECTOR_SECRET_KEYRING', 'APP_BASE_URL',
]
let saved: Record<string, string | undefined> = {}

/** Repart d'un magasin vide et d'une hydratation non faite. */
async function hydraterAvec(lignes: Record<string, string>) {
  const g = globalThis as any
  g.__prospectorKeys?.clear?.()
  g.__prospectorHydrated = undefined
  LIGNES_DB = lignes
  await hydrateKeystore()
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  LIGNES_DB = {}
  vi.clearAllMocks()
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await hydraterAvec({})
})

// ══ 1 — EXTENSION_ORIGINS : le cœur du lot ═════════════════════════════════
describe('1 — EXTENSION_ORIGINS : la base n\'élargit pas l\'allowlist CORS', () => {
  it('env légitime + ligne HOSTILE en base → seule l\'origine légitime subsiste', async () => {
    // ⚠️ LE SCÉNARIO RÉEL. Quelqu'un qui peut écrire dans `prospector_settings`
    // — restauration, import, clé de service — ajoute une ligne
    // `EXTENSION_ORIGINS`. Hier, elle PRIMAIT sur l'environnement (le magasin
    // est lu en premier) et l'extension acceptait alors les requêtes de cette
    // origine.
    process.env.EXTENSION_ORIGINS = ORIGINE_LEGITIME
    await hydraterAvec({ EXTENSION_ORIGINS: ORIGINE_HOSTILE })

    const origines = allowedOrigins()
    expect(origines).toEqual([ORIGINE_LEGITIME])
    expect(origines).not.toContain(ORIGINE_HOSTILE)
  })

  it('la base ne peut pas non plus AJOUTER une origine à côté de la légitime', async () => {
    process.env.EXTENSION_ORIGINS = ORIGINE_LEGITIME
    await hydraterAvec({ EXTENSION_ORIGINS: `${ORIGINE_LEGITIME},${ORIGINE_HOSTILE}` })
    expect(allowedOrigins()).toEqual([ORIGINE_LEGITIME])
  })

  it('env ABSENT + ligne en base → l\'allowlist reste VIDE', async () => {
    // Sans environnement, aucune origine n'est autorisée. La base ne doit pas
    // pouvoir en créer une à partir de rien.
    await hydraterAvec({ EXTENSION_ORIGINS: ORIGINE_HOSTILE })
    expect(allowedOrigins()).toEqual([])
  })

  it('EXTENSION_ORIGINS n\'est pas DB-capable, et ne doit pas le devenir par commodité', () => {
    expect(isManagedKey('EXTENSION_ORIGINS')).toBe(false)
    expect([...MANAGED_KEYS]).not.toContain('EXTENSION_ORIGINS')
  })
})

// ══ 2 — APP_SESSION_SECRET : non-régression du lot 0C.0.1 ══════════════════
describe('2 — APP_SESSION_SECRET : doublement hors de portée de la base', () => {
  it('une ligne en base n\'entre plus dans le magasin, et ne signe rien', async () => {
    const ENV_SECRET = 'secret-de-test-environnement-0123456789012'
    const DB_SECRET = 'secret-de-test-pose-en-base-0123456789012'
    process.env.APP_SESSION_SECRET = ENV_SECRET
    await hydraterAvec({ APP_SESSION_SECRET: DB_SECRET })

    // Barrière 1 (0C.0.3) : la ligne n'est PAS hydratée du tout — le magasin
    // ignore le nom, et `getKey` retombe sur l'environnement.
    expect(getKey('APP_SESSION_SECRET')).toBe(ENV_SECRET)
    expect(keySource('APP_SESSION_SECRET')).toBe('env')
    expect(isManagedKey('APP_SESSION_SECRET')).toBe(false)

    // Barrière 2 (0C.0.1) : sans environnement, plus AUCUN jeton n'est émis,
    // quoi que porte la base.
    delete process.env.APP_SESSION_SECRET
    expect(await tokenForWorkspace('ws_fabel', 'jarvis')).toBeNull()
    expect(getKey('APP_SESSION_SECRET')).toBeUndefined()
  })

  // ⚠️ Le CHEMIN NOMINAL de `wstoken` n'est volontairement pas rejoué ici :
  // `getTokenVersion` exige une base CONFIGURÉE (SEC-EXT-0.1b), absente de
  // cette suite. Il est couvert par `tests/extension-boundary.test.ts`, qui
  // simule Supabase. Affirmer ici qu'un jeton « est émis » aurait demandé de
  // relâcher l'assertion jusqu'à ne plus rien prouver.
})

// ══ 3 — les valeurs réellement DB-capables ne sont pas cassées ═════════════
describe('3 — non-régression : une valeur DB-capable est bien hydratée', () => {
  it('PII_MASKING, ANTHROPIC_BUDGET, JARVIS_MODEL et les secrets legacy passent', async () => {
    await hydraterAvec({
      PII_MASKING: '0',
      ANTHROPIC_BUDGET: '42',
      JARVIS_MODEL: 'claude-modele-de-test',
      TELEGRAM_BOT_TOKEN: 'jeton-telegram-de-test',
      APP_TOTP_SECRET: 'SEEDTOTPDETESTAAAAAAAAAAAAAAAAAA',
      APP_PASSWORD: '$2b$12$empreinte.de.test.non.reelle.aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(getKey('PII_MASKING')).toBe('0')
    expect(getKey('ANTHROPIC_BUDGET')).toBe('42')
    expect(getKey('JARVIS_MODEL')).toBe('claude-modele-de-test')
    expect(getKey('TELEGRAM_BOT_TOKEN')).toBe('jeton-telegram-de-test')
    expect(getKey('APP_TOTP_SECRET')).toBe('SEEDTOTPDETESTAAAAAAAAAAAAAAAAAA')
    expect(hasKey('APP_PASSWORD')).toBe(true)
    expect(keySource('PII_MASKING')).toBe('app')
  })

  it('la valeur de base PRIME sur l\'environnement pour une clé DB-capable', () => {
    // C'est le contrat historique de l'Admin : saisir une clé dans l'application
    // surcharge la variable de déploiement. Ce lot ne le change pas.
    process.env.PII_MASKING = '1'
    return hydraterAvec({ PII_MASKING: '0' }).then(() => {
      expect(getKey('PII_MASKING')).toBe('0')
    })
  })
})

// ══ 4 — un nom inconnu n'obtient jamais d'autorité ═════════════════════════
describe('4 — une clé hors nomenclature reste sans effet', () => {
  it('TOTALLY_UNKNOWN_SECRET en base → jamais rendu par getKey', async () => {
    await hydraterAvec({ TOTALLY_UNKNOWN_SECRET: 'valeur-hostile-de-test' })
    expect(getKey('TOTALLY_UNKNOWN_SECRET')).toBeUndefined()
    expect(hasKey('TOTALLY_UNKNOWN_SECRET')).toBe(false)
    expect(keySource('TOTALLY_UNKNOWN_SECRET')).toBeNull()
  })

  it('si l\'environnement porte le même nom, SEULE sa valeur est rendue', async () => {
    process.env.TOTALLY_UNKNOWN_SECRET = 'valeur-environnement-de-test'
    await hydraterAvec({ TOTALLY_UNKNOWN_SECRET: 'valeur-hostile-de-test' })
    expect(getKey('TOTALLY_UNKNOWN_SECRET')).toBe('valeur-environnement-de-test')
    expect(keySource('TOTALLY_UNKNOWN_SECRET')).toBe('env')
  })

  it('les valeurs critiques du garde budgétaire ne viennent pas de la base', async () => {
    // `AI_BUDGET_RESERVATION` décide du MODE d'application du plafond, et
    // `AI_BUDGET_OBSERVE_LIMIT` du plafond lui-même. Une ligne en base
    // reviendrait à laisser la base fixer la dépense autorisée.
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    await hydraterAvec({ AI_BUDGET_RESERVATION: 'OFF', AI_BUDGET_OBSERVE_LIMIT: '999999' })
    expect(getKey('AI_BUDGET_RESERVATION')).toBe('ENFORCE')
    expect(getKey('AI_BUDGET_OBSERVE_LIMIT')).toBeUndefined()
    for (const k of ['AI_BUDGET_RESERVATION', 'AI_BUDGET_OBSERVE_LIMIT']) {
      expect(isManagedKey(k)).toBe(false)
    }
  })

  it('les racines de déploiement restent hors de portée', async () => {
    for (const nom of ['SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'PROSPECTOR_SECRET_KEYRING', 'APP_BASE_URL']) {
      expect(isManagedKey(nom), nom).toBe(false)
    }
    await hydraterAvec({
      SUPABASE_SERVICE_ROLE_KEY: 'x', RESEND_API_KEY: 'x',
      PROSPECTOR_SECRET_KEYRING: 'x', APP_BASE_URL: 'https://hostile.invalid',
    })
    for (const nom of ['SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'PROSPECTOR_SECRET_KEYRING', 'APP_BASE_URL']) {
      expect(getKey(nom), nom).toBeUndefined()
    }
  })
})

// ══ 5 — SYMÉTRIE lecture / écriture ════════════════════════════════════════
describe('5 — une seule nomenclature gouverne la lecture ET l\'écriture', () => {
  it('DB-capable : `setKeys` écrit, `hydrateKeystore` relit', async () => {
    await hydraterAvec({})
    await setKeys({ PII_MASKING: '0' })
    expect(getKey('PII_MASKING')).toBe('0')
    expect(saveSetting).toHaveBeenCalledWith('PII_MASKING', '0')
    // Et une hydratation fraîche depuis la base rend la même valeur.
    await hydraterAvec({ PII_MASKING: '0' })
    expect(getKey('PII_MASKING')).toBe('0')
  })

  it('hors nomenclature : les DEUX chemins refusent, sans exception', async () => {
    await hydraterAvec({})
    for (const nom of ['EXTENSION_ORIGINS', 'AI_BUDGET_RESERVATION', 'TOTALLY_UNKNOWN_SECRET', 'APP_SESSION_SECRET']) {
      await setKeys({ [nom]: 'valeur-hostile-de-test' })
      expect(getKey(nom), `écriture ${nom}`).toBeUndefined()
      expect(saveSetting).not.toHaveBeenCalledWith(nom, expect.anything())
    }
    // Et la lecture les refuse tout autant.
    await hydraterAvec(Object.fromEntries(
      ['EXTENSION_ORIGINS', 'AI_BUDGET_RESERVATION', 'TOTALLY_UNKNOWN_SECRET', 'APP_SESSION_SECRET']
        .map((n) => [n, 'valeur-hostile-de-test'])))
    for (const nom of ['EXTENSION_ORIGINS', 'AI_BUDGET_RESERVATION', 'TOTALLY_UNKNOWN_SECRET', 'APP_SESSION_SECRET']) {
      expect(getKey(nom), `lecture ${nom}`).toBeUndefined()
    }
  })

  it('la symétrie est structurelle : tout nom accepté en écriture est acceptable en lecture', () => {
    // Il ne peut pas exister deux listes divergentes — c'est la même.
    for (const k of MANAGED_KEYS) expect(isManagedKey(k)).toBe(true)
  })

  it('valeur vide : sémantique inchangée, et documentée', async () => {
    // En base : une valeur vide n'est pas hydratée → on retombe sur l'env.
    process.env.PII_MASKING = '1'
    await hydraterAvec({ PII_MASKING: '' })
    expect(getKey('PII_MASKING')).toBe('1')
    // Par `setKeys` : une valeur vide EFFACE la saisie applicative, et l'env
    // reprend la main. C'est ainsi qu'on « retire » une clé depuis l'Admin.
    await setKeys({ PII_MASKING: '0' })
    expect(getKey('PII_MASKING')).toBe('0')
    await setKeys({ PII_MASKING: '' })
    expect(getKey('PII_MASKING')).toBe('1')
    expect(keySource('PII_MASKING')).toBe('env')
  })
})

// ══ 6 — aucune fuite ═══════════════════════════════════════════════════════
describe('6 — une ligne ignorée ne laisse aucune trace', () => {
  it('ni journal, ni erreur ne contient la valeur rejetée', async () => {
    const journal: string[] = []
    const espion = (...a: any[]) => { journal.push(a.map(String).join(' ')) }
    const spies = (['log', 'error', 'warn', 'info'] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation(espion as any))
    const HOSTILE = 'valeur-hostile-qui-ne-doit-jamais-apparaitre'
    try {
      await hydraterAvec({
        EXTENSION_ORIGINS: HOSTILE, TOTALLY_UNKNOWN_SECRET: HOSTILE,
        APP_SESSION_SECRET: HOSTILE, AI_BUDGET_RESERVATION: HOSTILE,
      })
      await setKeys({ EXTENSION_ORIGINS: HOSTILE, TOTALLY_UNKNOWN_SECRET: HOSTILE })
    } finally { for (const s of spies) s.mockRestore() }

    expect(journal.join('\n')).not.toContain(HOSTILE)
    expect(journal).toHaveLength(0)
    // Et rien n'a été persisté pour ces noms.
    expect(saveSetting).not.toHaveBeenCalled()
  })
})
