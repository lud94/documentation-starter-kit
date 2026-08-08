// SEC-SECRETS-0C.1 — LE COFFRE DES SECRETS DE PLATEFORME.
//
// ── CE QUE CES TESTS ÉPROUVENT, ET CE QU'ILS N'ÉPROUVENT PAS ────────────────
// Ici, la CRYPTOGRAPHIE EST RÉELLE : `sealSecret` / `openSecret` de SEC-SECRETS-0B,
// avec un vrai trousseau AES-256-GCM (clefs de test, jamais une clef réelle).
// C'est la seule façon de prouver la propriété qui compte vraiment : une
// enveloppe déplacée d'une ligne à une autre, ou rejouée sur une autre version,
// NE S'OUVRE PAS. Un chiffrement simulé rendrait cette preuve vide.
//
// En revanche la BASE est simulée — par une machine à états qui reproduit
// fidèlement les contraintes et les RPC de la migration. Elle prouve que la
// couche applicative respecte le contrat ; elle ne prouve pas que PostgreSQL
// l'impose. Cette seconde preuve est ailleurs, et elle est indispensable :
// `tests/integration/platform-vault-pg.test.ts`, exécuté contre une vraie base.
// Un test unitaire ne peut produire ni violation de CHECK, ni refus de privilège,
// ni concurrence réelle.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// ── Trousseau de TEST ───────────────────────────────────────────────────────
// Deux clefs, générées à l'exécution : aucune valeur n'est écrite dans le dépôt,
// et aucun secret réel n'existe dans ce fichier.
const b64url = (b: Buffer) => b.toString('base64url')
const TROUSSEAU = JSON.stringify({
  currentKid: 'k1',
  keys: { k1: b64url(randomBytes(32)), k2: b64url(randomBytes(32)) },
})
// ── La base simulée ─────────────────────────────────────────────────────────
type Row = { secret_name: string; envelope: string | null; kid: string | null; secret_version: number; status: string }
let DB: Map<string, Row>
/** Permet de simuler « la RPC réussit mais la relecture ne rend rien ». */
let RELECTURE_MUETTE = false
/** Permet de simuler une base injoignable en lecture. */
let LECTURE_CASSEE = false

const ETAT_INITIAL: Record<string, string> = {
  admin_totp_secret: 'staged',
  telegram_webhook_secret: 'pending_provider',
  telegram_bot_token: 'active',
}
const PROMOTION_DEPUIS: Record<string, string> = {
  admin_totp_secret: 'staged',
  telegram_webhook_secret: 'pending_provider',
}

function kidDe(envelope: string): string | null {
  try {
    const k = JSON.parse(envelope)?.kid
    return typeof k === 'string' ? k : null
  } catch { return null }
}
/** Reproduit la CHECK de la migration, `kid is not null` compris. */
function contrainte(r: Row) {
  if (r.status === 'revoked') {
    if (r.envelope !== null || r.kid !== null) throw new Error('check')
  } else {
    if (!r.envelope || !r.kid || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(r.kid)) throw new Error('check')
  }
  const legaux: Record<string, string[]> = {
    admin_totp_secret: ['staged', 'active', 'revoked'],
    telegram_webhook_secret: ['pending_provider', 'active', 'revoked'],
    telegram_bot_token: ['active', 'revoked'],
  }
  if (!legaux[r.secret_name]?.includes(r.status)) throw new Error('check')
}
function poser(r: Row) { contrainte(r); DB.set(r.secret_name, r) }

vi.mock('../lib/supabase/platformSecrets', async (orig) => {
  const reel = await (orig() as Promise<any>)
  return {
    ...reel,
    readPlatformSecretRow: async (name: string) => {
      if (LECTURE_CASSEE || RELECTURE_MUETTE) return null
      const r = DB.get(name)
      if (!r) return null
      return { secretName: r.secret_name, envelope: r.envelope, kid: r.kid, secretVersion: r.secret_version, status: r.status }
    },
    referencedPlatformKidsRaw: async () => {
      if (LECTURE_CASSEE) return { complete: false }
      const kids: string[] = []
      for (const r of DB.values()) if (r.kid && !kids.includes(r.kid)) kids.push(r.kid)
      return { complete: true, kids }
    },
    createPlatformSecret: async (name: string, envelope: string) => {
      if (DB.has(name)) return 'exists'
      poser({ secret_name: name, envelope, kid: kidDe(envelope), secret_version: 1, status: ETAT_INITIAL[name] })
      return 'created'
    },
    replacePlatformSecret: async (name: string, envelope: string, v: number) => {
      const r = DB.get(name)
      if (!r || r.secret_version !== v) return 'stale'
      poser({ secret_name: name, envelope, kid: kidDe(envelope), secret_version: v + 1, status: ETAT_INITIAL[name] })
      return 'replaced'
    },
    promotePlatformSecret: async (name: string, v: number) => {
      const depuis = PROMOTION_DEPUIS[name]
      if (!depuis) throw new Error('promotion inexistante pour ce secret')
      const r = DB.get(name)
      if (!r || r.secret_version !== v || r.status !== depuis) return 'stale'
      poser({ ...r, status: 'active' })
      return 'promoted'
    },
    revokePlatformSecret: async (name: string, v: number) => {
      const r = DB.get(name)
      if (!r || r.secret_version !== v || r.status === 'revoked') return 'stale'
      poser({ secret_name: name, envelope: null, kid: null, secret_version: v + 1, status: 'revoked' })
      return 'revoked'
    },
    rewrapPlatformSecret: async (name: string, v: number, oldKid: string, envelope: string) => {
      const r = DB.get(name)
      if (!r || r.secret_version !== v || r.kid !== oldKid || r.status === 'revoked') return 'stale'
      poser({ ...r, envelope, kid: kidDe(envelope) })
      return 'rewrapped'
    },
    adoptLegacyTotpEnvelope: async (envelope: string) => {
      if (DB.has('admin_totp_secret')) return 'exists'
      poser({ secret_name: 'admin_totp_secret', envelope, kid: kidDe(envelope), secret_version: 1, status: 'active' })
      return 'adopted'
    },
  }
})

import {
  platformSecretContext, platformSecretStatus, referencedPlatformKids,
  stageAdminTotpSecret, promoteAdminTotpSecret, revokeAdminTotpSecret, readAdminTotpSecret,
  putTelegramWebhookPending, confirmTelegramWebhookActive, revokeTelegramWebhook, readTelegramWebhookSecret,
  putTelegramBotToken, revokeTelegramBotToken, readTelegramBotToken,
  replacePlatformSecretValue, rewrapPlatformSecretValue, adoptLegacyAdminTotpSecret,
  PLATFORM_SECRET_NAMES, isPlatformSecretName,
} from '../lib/secrets/platformVault'
import { openSecret, sealSecret } from '../lib/secrets/crypto'
import { loadKeyringFromEnv } from '../lib/secrets/keyring'

// Valeurs de TEST. Aucune n'est un secret réel : ni graine TOTP en service, ni
// jeton BotFather, ni secret de webhook déployé.
const GRAINE_TOTP = 'JBSWY3DPEHPK3PXP-TEST-SEED-NON-REELLE'
const SECRET_WEBHOOK = 'webhook-secret-de-test-0000000000'
const JETON_BOT = '000000000:TEST-TOKEN-JAMAIS-EMIS-PAR-BOTFATHER'

beforeEach(() => {
  DB = new Map()
  RELECTURE_MUETTE = false
  LECTURE_CASSEE = false
  process.env.PROSPECTOR_SECRET_KEYRING = TROUSSEAU
  process.env.APP_ENV = 'development'
  delete process.env.VERCEL_ENV
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Contexte AAD — la portée est forcée, pas laissée vide', () => {
  it('impose scope=platform et annule toute dimension de portée', () => {
    const c = platformSecretContext('admin_totp_secret', 3)
    expect(c).toEqual({
      scope: 'platform', secretName: 'admin_totp_secret', secretVersion: 3,
      workspaceId: null, provider: null, credentialId: null,
    })
  })

  it('refuse un nom hors des trois, et une version absurde', () => {
    expect(() => platformSecretContext('anthropic_api_key' as any, 1)).toThrow()
    expect(() => platformSecretContext('admin_totp_secret', 0)).toThrow()
    expect(() => platformSecretContext('admin_totp_secret', 1.5)).toThrow()
  })

  it('n\'expose que trois noms', () => {
    expect([...PLATFORM_SECRET_NAMES].sort())
      .toEqual(['admin_totp_secret', 'telegram_bot_token', 'telegram_webhook_secret'])
    expect(isPlatformSecretName('APP_TOTP_SECRET')).toBe(false)
  })
})

describe('B. ANTI-PERMUTATION — cryptographie réelle', () => {
  it('une enveloppe de webhook ne s\'ouvre PAS sur la ligne du jeton de bot', () => {
    const kr = loadKeyringFromEnv()
    const e = sealSecret(SECRET_WEBHOOK, platformSecretContext('telegram_webhook_secret', 1), kr)
    expect(openSecret(e, platformSecretContext('telegram_webhook_secret', 1), kr)).toBe(SECRET_WEBHOOK)
    // Quelqu'un capable d'écrire dans la base peut recopier ces octets ailleurs.
    // Il n'en tire rien : l'AAD lie le chiffré à son nom.
    expect(() => openSecret(e, platformSecretContext('telegram_bot_token', 1), kr)).toThrow()
  })

  it('une enveloppe de version N ne s\'ouvre PAS sous la version N+1 (anti-rejeu)', () => {
    const kr = loadKeyringFromEnv()
    const e = sealSecret(GRAINE_TOTP, platformSecretContext('admin_totp_secret', 1), kr)
    expect(() => openSecret(e, platformSecretContext('admin_totp_secret', 2), kr)).toThrow()
  })

  it('l\'enveloppe remise à la base ne contient AUCUN clair', async () => {
    expect((await stageAdminTotpSecret(GRAINE_TOTP)).ok).toBe(true)
    const brut = JSON.stringify([...DB.values()])
    expect(brut).not.toContain(GRAINE_TOTP)
    expect(brut).not.toContain('JBSWY3DPEHPK3PXP')
    // ... et l'enveloppe déclare bien la clef courante.
    expect(DB.get('admin_totp_secret')!.kid).toBe('k1')
  })
})

describe('C. Sceau TOTP — staged n\'authentifie personne', () => {
  it('un sceau seulement posé n\'est PAS lisible comme autorité', async () => {
    const w = await stageAdminTotpSecret(GRAINE_TOTP)
    expect(w).toMatchObject({ ok: true, outcome: 'created', version: 1 })
    expect(await platformSecretStatus('admin_totp_secret')).toBe('staged')
    expect(await readAdminTotpSecret()).toEqual({ ok: false, reason: 'wrong_state' })
  })

  it('une fois prouvé, il devient l\'autorité — SANS changer de version', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    expect(await promoteAdminTotpSecret(1)).toMatchObject({ ok: true, version: 1 })
    expect(await readAdminTotpSecret()).toMatchObject({ ok: true, value: GRAINE_TOTP, version: 1 })
  })

  it('poser deux fois n\'écrase jamais le premier sceau', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    const deux = await stageAdminTotpSecret('AUTRE-GRAINE-DE-TEST')
    expect(deux).toEqual({ ok: false, outcome: 'exists' })
    await promoteAdminTotpSecret(1)
    expect(await readAdminTotpSecret()).toMatchObject({ value: GRAINE_TOTP })
  })

  it('promouvoir avec la mauvaise version, ou deux fois, échoue', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    expect(await promoteAdminTotpSecret(7)).toEqual({ ok: false, outcome: 'stale' })
    expect(await promoteAdminTotpSecret(1)).toMatchObject({ ok: true })
    expect(await promoteAdminTotpSecret(1)).toEqual({ ok: false, outcome: 'stale' })
  })
})

describe('D. Webhook Telegram — le fournisseur détient la vérité', () => {
  it('naît pending_provider, JAMAIS active', async () => {
    expect((await putTelegramWebhookPending(SECRET_WEBHOOK)).ok).toBe(true)
    expect(await platformSecretStatus('telegram_webhook_secret')).toBe('pending_provider')
  })

  it('est lisible DÈS pending_provider — un entrant authentique ne doit pas être rejeté', async () => {
    await putTelegramWebhookPending(SECRET_WEBHOOK)
    expect(await readTelegramWebhookSecret()).toMatchObject({ ok: true, value: SECRET_WEBHOOK, status: 'pending_provider' })
    expect(await confirmTelegramWebhookActive(1)).toMatchObject({ ok: true, version: 1 })
    expect(await readTelegramWebhookSecret()).toMatchObject({ ok: true, value: SECRET_WEBHOOK, status: 'active' })
  })

  it('cesse d\'être lisible une fois révoqué', async () => {
    await putTelegramWebhookPending(SECRET_WEBHOOK)
    expect(await revokeTelegramWebhook(1)).toMatchObject({ ok: true, outcome: 'revoked', version: 2 })
    expect(await readTelegramWebhookSecret()).toEqual({ ok: false, reason: 'revoked' })
  })
})

describe('E. Jeton de bot — aucune promotion n\'existe', () => {
  it('est actif dès sa pose et lisible immédiatement', async () => {
    expect((await putTelegramBotToken(JETON_BOT)).ok).toBe(true)
    expect(await platformSecretStatus('telegram_bot_token')).toBe('active')
    expect(await readTelegramBotToken()).toMatchObject({ ok: true, value: JETON_BOT })
  })

  it('le module n\'expose AUCUNE capacité de promotion pour ce secret', async () => {
    const mod: any = await import('../lib/secrets/platformVault')
    const noms = Object.keys(mod).filter((n) => /promote|confirm/i.test(n))
    expect(noms.sort()).toEqual(['confirmTelegramWebhookActive', 'promoteAdminTotpSecret'])
  })
})

describe('F. Révocation — une pierre tombale, pas une absence', () => {
  it('efface l\'enveloppe, le kid, et incrémente la version', async () => {
    await putTelegramBotToken(JETON_BOT)
    expect(await revokeTelegramBotToken(1)).toMatchObject({ ok: true, version: 2 })
    const r = DB.get('telegram_bot_token')!
    expect(r).toMatchObject({ envelope: null, kid: null, secret_version: 2, status: 'revoked' })
    expect(await readTelegramBotToken()).toEqual({ ok: false, reason: 'revoked' })
  })

  it('révoquer deux fois, ou sur une mauvaise version, ne fait rien', async () => {
    await putTelegramBotToken(JETON_BOT)
    expect(await revokeTelegramBotToken(9)).toEqual({ ok: false, outcome: 'stale' })
    await revokeTelegramBotToken(1)
    expect(await revokeTelegramBotToken(2)).toEqual({ ok: false, outcome: 'stale' })
  })

  it('une pierre tombale n\'épingle plus aucune clef dans l\'inventaire', async () => {
    await putTelegramBotToken(JETON_BOT)
    expect(await referencedPlatformKids()).toEqual({ complete: true, referencedKids: ['k1'] })
    await revokeTelegramBotToken(1)
    expect(await referencedPlatformKids()).toEqual({ complete: true, referencedKids: [] })
  })
})

describe('G. Remplacement — la version ne redescend jamais à 1', () => {
  it('repart d\'une pierre tombale sans réutiliser une version déjà vue', async () => {
    await putTelegramBotToken(JETON_BOT)
    await revokeTelegramBotToken(1)               // version 2, tombstone
    const w = await replacePlatformSecretValue('telegram_bot_token', 'NOUVEAU-JETON-DE-TEST', 2)
    expect(w).toMatchObject({ ok: true, outcome: 'replaced', version: 3 })
    expect(await readTelegramBotToken()).toMatchObject({ ok: true, value: 'NOUVEAU-JETON-DE-TEST' })
  })

  it('les trois secrets peuvent ressusciter depuis leur pierre tombale', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    await revokeAdminTotpSecret(1)
    expect((await replacePlatformSecretValue('admin_totp_secret', 'GRAINE-2', 2)).ok).toBe(true)
    expect(await platformSecretStatus('admin_totp_secret')).toBe('staged')  // repasse par la preuve

    await putTelegramWebhookPending(SECRET_WEBHOOK)
    await revokeTelegramWebhook(1)
    expect((await replacePlatformSecretValue('telegram_webhook_secret', 'W2', 2)).ok).toBe(true)
    expect(await platformSecretStatus('telegram_webhook_secret')).toBe('pending_provider')

    await putTelegramBotToken(JETON_BOT)
    await revokeTelegramBotToken(1)
    expect((await replacePlatformSecretValue('telegram_bot_token', 'B2', 2)).ok).toBe(true)
  })

  it('refuse un compare-and-swap périmé', async () => {
    await putTelegramBotToken(JETON_BOT)
    expect(await replacePlatformSecretValue('telegram_bot_token', 'X', 5)).toEqual({ ok: false, outcome: 'stale' })
    expect(await replacePlatformSecretValue('telegram_bot_token', 'X', 0)).toEqual({ ok: false, outcome: 'denied' })
  })
})

describe('H. Re-scellement — même clair, même version, autre clef', () => {
  it('change le kid sans changer la version ni la valeur', async () => {
    await putTelegramBotToken(JETON_BOT)
    expect(DB.get('telegram_bot_token')!.kid).toBe('k1')

    // Rotation du trousseau : k2 devient courante, k1 reste lisible.
    const kr = JSON.parse(TROUSSEAU)
    process.env.PROSPECTOR_SECRET_KEYRING = JSON.stringify({ currentKid: 'k2', keys: kr.keys })

    const w = await rewrapPlatformSecretValue('telegram_bot_token')
    expect(w).toMatchObject({ ok: true, outcome: 'rewrapped', version: 1 })
    expect(DB.get('telegram_bot_token')!.kid).toBe('k2')
    expect(await readTelegramBotToken()).toMatchObject({ ok: true, value: JETON_BOT, version: 1 })
  })

  it('ne re-scelle pas une pierre tombale, ni un secret absent', async () => {
    expect(await rewrapPlatformSecretValue('telegram_bot_token')).toEqual({ ok: false, outcome: 'denied' })
    await putTelegramBotToken(JETON_BOT)
    await revokeTelegramBotToken(1)
    expect(await rewrapPlatformSecretValue('telegram_bot_token')).toEqual({ ok: false, outcome: 'denied' })
  })

  it('ne re-scelle pas ce qu\'il ne sait pas ouvrir', async () => {
    await putTelegramBotToken(JETON_BOT)
    // Trousseau entièrement différent : l'enveloppe existante devient illisible.
    process.env.PROSPECTOR_SECRET_KEYRING = JSON.stringify({
      currentKid: 'k9', keys: { k9: b64url(randomBytes(32)) },
    })
    expect(await rewrapPlatformSecretValue('telegram_bot_token')).toEqual({ ok: false, outcome: 'denied' })
    // Et surtout : la ligne N'A PAS été écrasée.
    expect(DB.get('telegram_bot_token')!.kid).toBe('k1')
  })
})

describe('I. Une RPC réussie n\'est PAS un succès', () => {
  it('échec de relecture ⇒ verify_failed, jamais ok', async () => {
    RELECTURE_MUETTE = true
    const w = await stageAdminTotpSecret(GRAINE_TOTP)
    expect(w).toEqual({ ok: false, outcome: 'verify_failed', version: undefined })
    // La RPC, elle, a bien écrit : l'état est laissé tel quel, PAS défait.
    expect(DB.get('admin_totp_secret')).toBeTruthy()
  })

  it('promotion non confirmée par relecture ⇒ verify_failed', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    RELECTURE_MUETTE = true
    expect(await promoteAdminTotpSecret(1)).toMatchObject({ ok: false, outcome: 'verify_failed' })
  })

  it('révocation non confirmée par relecture ⇒ verify_failed', async () => {
    await putTelegramBotToken(JETON_BOT)
    RELECTURE_MUETTE = true
    expect(await revokeTelegramBotToken(1)).toMatchObject({ ok: false, outcome: 'verify_failed' })
  })
})

describe('J. Fail-closed sur la configuration', () => {
  it('sans trousseau, rien n\'est écrit — et surtout pas en clair', async () => {
    delete process.env.PROSPECTOR_SECRET_KEYRING
    expect(await stageAdminTotpSecret(GRAINE_TOTP)).toEqual({ ok: false, outcome: 'denied' })
    expect(DB.size).toBe(0)
  })

  it('sans trousseau, une ligne existante devient illisible — pas « vide »', async () => {
    await putTelegramBotToken(JETON_BOT)
    delete process.env.PROSPECTOR_SECRET_KEYRING
    expect(await readTelegramBotToken()).toEqual({ ok: false, reason: 'unreadable' })
    // L'état, lui, reste consultable sans déchiffrer.
    expect(await platformSecretStatus('telegram_bot_token')).toBe('active')
  })

  it('un clair vide n\'est pas un secret', async () => {
    expect(await stageAdminTotpSecret('')).toEqual({ ok: false, outcome: 'denied' })
  })

  it('inventaire NON établi ⇒ complete:false, jamais une liste vide', async () => {
    LECTURE_CASSEE = true
    expect(await referencedPlatformKids()).toEqual({ complete: false })
  })

  it('un secret absent est absent — aucun repli sur l\'ancien emplacement', async () => {
    process.env.APP_TOTP_SECRET = 'valeur-heritee-qui-ne-doit-pas-servir'
    process.env.TELEGRAM_BOT_TOKEN = 'jeton-herite-qui-ne-doit-pas-servir'
    expect(await readAdminTotpSecret()).toEqual({ ok: false, reason: 'absent' })
    expect(await readTelegramBotToken()).toEqual({ ok: false, reason: 'absent' })
    delete process.env.APP_TOTP_SECRET
    delete process.env.TELEGRAM_BOT_TOKEN
  })
})

describe('K. Adoption du TOTP hérité — étroite par construction', () => {
  it('rend le sceau hérité ACTIF sans passer par une nouvelle preuve', async () => {
    expect(await adoptLegacyAdminTotpSecret(GRAINE_TOTP)).toMatchObject({ ok: true, outcome: 'adopted', version: 1 })
    expect(await platformSecretStatus('admin_totp_secret')).toBe('active')
    expect(await readAdminTotpSecret()).toMatchObject({ ok: true, value: GRAINE_TOTP })
  })

  it('n\'écrase jamais une génération existante', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    expect(await adoptLegacyAdminTotpSecret('AUTRE')).toEqual({ ok: false, outcome: 'exists' })
    expect(await platformSecretStatus('admin_totp_secret')).toBe('staged')
  })

  it('ne peut pas ressusciter une pierre tombale', async () => {
    await stageAdminTotpSecret(GRAINE_TOTP)
    await revokeAdminTotpSecret(1)
    expect(await adoptLegacyAdminTotpSecret(GRAINE_TOTP)).toEqual({ ok: false, outcome: 'exists' })
    expect(await platformSecretStatus('admin_totp_secret')).toBe('revoked')
  })

  it('n\'offre aucun chemin d\'adoption pour les secrets Telegram', async () => {
    const mod: any = await import('../lib/secrets/platformVault')
    const noms = Object.keys(mod).filter((n) => /adopt/i.test(n))
    expect(noms).toEqual(['adoptLegacyAdminTotpSecret'])
    // Et la fonction n'accepte aucun nom : il n'y a rien à choisir.
    expect(mod.adoptLegacyAdminTotpSecret.length).toBe(1)
  })
})

describe('L. Séparation des couches', () => {
  // ⚠️ On dépouille les COMMENTAIRES avant d'inspecter. Ces fichiers expliquent
  // longuement ce qu'ils s'interdisent : chercher « prospector_settings » dans
  // la prose ferait échouer un fichier précisément parce qu'il documente sa
  // propre frontière. Ce qui engage, c'est le CODE.
  const fs = require('node:fs') as typeof import('node:fs')
  const code = (p: string) => fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

  it('le module de persistance n\'importe RIEN de la cryptographie', () => {
    const src = code('lib/supabase/platformSecrets.ts')
    expect(src).not.toMatch(/from '\.\.\/secrets\//)
    expect(src).not.toMatch(/sealSecret|openSecret|loadKeyringFromEnv/)
  })

  it('le coffre n\'importe RIEN de Supabase directement', () => {
    const src = code('lib/secrets/platformVault.ts')
    expect(src).not.toMatch(/from '\.\.\/supabase\/client'/)
    expect(src).not.toMatch(/createClient|\.from\(|\.rpc\(/)
  })

  it('le coffre ne lit ni prospector_settings ni le keystore hérité', () => {
    const src = code('lib/secrets/platformVault.ts')
    expect(src).not.toMatch(/prospector_settings|getKey\(|hydrateKeystore\(/)
  })

  // Le dépouillement lui-même doit mordre, sinon il rendrait les trois tests
  // ci-dessus toujours verts : on vérifie qu'il conserve bien le code réel.
  it('le dépouillement conserve le code (il ne vide pas le fichier)', () => {
    const src = code('lib/secrets/platformVault.ts')
    expect(src).toMatch(/import \{ sealSecret, openSecret/)
    expect(src).toMatch(/export function platformSecretContext/)
  })
})
