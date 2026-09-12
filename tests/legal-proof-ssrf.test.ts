// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — LA PRIMITIVE DE CAPTURE EST SSRF-SÛRE.
//
// ⚠️ AUCUN RÉSEAU : DNS et transport sont ENTIÈREMENT injectés. Les tests
// prouvent que l'IP validée est celle réellement connectée, que chaque saut
// repasse toutes les gardes, et qu'aucun octet distant ne fuit en erreur.
import { describe, expect, it } from 'vitest'

import {
  captureLegalProof, isProhibitedIp, normalizeHost,
  PROOF_MAX_BYTES, type ProofDeps,
} from '../lib/prospector/proactive/legalProofFetch'

const PAGE = { status: 200, contentType: 'text/html; charset=utf-8', body: '<html>SIREN 989 284 955</html>', truncated: false }

/** Transport factice : hôtes → IPs, URLs → réponses ; journalise les connexions. */
function deps(config: {
  dns?: Record<string, string[]>
  reponses?: Record<string, any>
  connexions?: Array<{ hostname: string; ip: string; path: string }>
}): ProofDeps {
  return {
    async resolve(hostname) { return config.dns?.[hostname] ?? [] },
    async request(opts) {
      config.connexions?.push({ hostname: opts.hostname, ip: opts.ip, path: opts.path })
      const rep = config.reponses?.[`${opts.hostname}${opts.path}`]
      if (!rep) throw new Error('PROOF_REQUEST')
      if (rep === 'TIMEOUT') throw new Error('PROOF_TIMEOUT')
      return rep
    },
  }
}

describe('adresses interdites', () => {
  it('toutes les familles privées/réservées sont refusées ; le public passe', () => {
    for (const ip of [
      '127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '169.254.0.9', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.1.1.1',
      '255.255.255.255', '192.0.0.8', '192.0.2.10', '198.18.0.1', '198.51.100.7', '203.0.113.9',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::8', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.8', '::ffff:192.168.0.4', // mappé IPv4
      'pas-une-ip', '',
    ]) expect(isProhibitedIp(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8']) {
      expect(isProhibitedIp(ip), ip).toBe(false)
    }
  })

  it('normalizeHost : minuscules + UN www. de tête, rien d’autre', () => {
    expect(normalizeHost('WWW.Company.FR')).toBe('company.fr')
    expect(normalizeHost('app.company.fr')).toBe('app.company.fr')
    expect(normalizeHost('www.www.company.fr')).toBe('www.company.fr')
    expect(normalizeHost('  ')).toBeNull()
  })
})

describe('gardes d’URL et de saut', () => {
  const D = { dns: { 'company.fr': ['93.184.216.34'] }, reponses: { 'company.fr/mentions-legales': PAGE } }

  it('capture nominale : 200, type admis, corps rendu, hôte final = hôte lié', async () => {
    const r = await captureLegalProof('company.fr', 'https://company.fr/mentions-legales', deps(D))
    if (r.ok === false) throw new Error(r.reason)
    expect(r.body).toContain('989 284 955')
    expect(r.finalUrl).toBe('https://company.fr/mentions-legales')
  })

  it('schémas interdits : http, file, ftp, data, javascript, gopher', async () => {
    for (const url of [
      'http://company.fr/mentions-legales', 'file:///etc/passwd', 'ftp://company.fr/x',
      'data:text/html,x', 'javascript:alert(1)', 'gopher://company.fr/',
    ]) {
      expect(await captureLegalProof('company.fr', url, deps(D)), url).toEqual({ ok: false, reason: 'INVALID_URL' })
    }
  })

  it('port alternatif explicite, identifiants dans l’URL, hôte non-FQDN : refusés', async () => {
    for (const url of [
      'https://company.fr:8443/legal', 'https://user:pass@company.fr/legal',
      'https://localhost/legal', 'https://interne/legal', 'https://127.0.0.1/legal',
      'https://[::1]/legal', 'https://10.0.0.1/legal',
    ]) {
      expect(await captureLegalProof('company.fr', url, deps(D)), url).toEqual({ ok: false, reason: 'INVALID_URL' })
    }
  })

  it('hôte de preuve ≠ hôte lié : refusé — y compris les sous-domaines (politique V0 exacte)', async () => {
    for (const url of [
      'https://app.company.fr/legal', 'https://blog.company.fr/legal',
      'https://careers.company.fr/legal', 'https://company.teamtailor.com/legal',
      'https://autre.fr/legal',
    ]) {
      expect(await captureLegalProof('company.fr', url, deps(D)), url).toEqual({ ok: false, reason: 'INVALID_URL' })
    }
    // `www.` est la SEULE normalisation admise.
    const ok = await captureLegalProof('company.fr', 'https://www.company.fr/mentions-legales', deps({
      dns: { 'www.company.fr': ['93.184.216.34'] },
      reponses: { 'www.company.fr/mentions-legales': PAGE },
    }))
    expect(ok.ok).toBe(true)
  })
})

describe('DNS et épinglage', () => {
  it('résolution vide ou en échec : PROHIBITED_TARGET, aucune connexion', async () => {
    const connexions: any[] = []
    const r = await captureLegalProof('company.fr', 'https://company.fr/legal', deps({ dns: {}, connexions }))
    expect(r).toEqual({ ok: false, reason: 'PROHIBITED_TARGET' })
    expect(connexions).toEqual([])
  })

  it('UNE adresse interdite dans l’ensemble DNS suffit à tout refuser — pas de sélection optimiste', async () => {
    const connexions: any[] = []
    const r = await captureLegalProof('company.fr', 'https://company.fr/legal', deps({
      dns: { 'company.fr': ['93.184.216.34', '10.0.0.5'] }, connexions,
    }))
    expect(r).toEqual({ ok: false, reason: 'PROHIBITED_TARGET' })
    expect(connexions).toEqual([])
  })

  it('l’IP CONNECTÉE est exactement l’IP validée (épinglage), avec le nom d’origine pour Host/SNI', async () => {
    const connexions: any[] = []
    await captureLegalProof('company.fr', 'https://company.fr/mentions-legales', deps({
      dns: { 'company.fr': ['93.184.216.34'] },
      reponses: { 'company.fr/mentions-legales': PAGE },
      connexions,
    }))
    expect(connexions).toEqual([{ hostname: 'company.fr', ip: '93.184.216.34', path: '/mentions-legales' }])
  })
})

describe('redirections', () => {
  const REDIR = (location: string) => ({ status: 301, location, body: '', truncated: false })

  it('redirection interne au domaine : suivie, gardes DNS/IP répétées, IP revalidée à chaque saut', async () => {
    const connexions: any[] = []
    const r = await captureLegalProof('company.fr', 'https://company.fr/legal', deps({
      dns: { 'company.fr': ['93.184.216.34'] },
      reponses: {
        'company.fr/legal': REDIR('/mentions-legales'),
        'company.fr/mentions-legales': PAGE,
      },
      connexions,
    }))
    expect(r.ok).toBe(true)
    expect(connexions.length).toBe(2)
    expect(connexions.every((c) => c.ip === '93.184.216.34')).toBe(true)
  })

  it('redirection hors domaine, vers privé, vers localhost, vers http : refusées', async () => {
    for (const cible of [
      'https://autre.fr/legal', 'https://10.0.0.1/legal', 'https://localhost/legal',
      'http://company.fr/legal', 'https://app.company.fr/legal',
    ]) {
      const r = await captureLegalProof('company.fr', 'https://company.fr/legal', deps({
        dns: { 'company.fr': ['93.184.216.34'] },
        reponses: { 'company.fr/legal': REDIR(cible) },
      }))
      expect(r, cible).toEqual({ ok: false, reason: 'REDIRECT_POLICY' })
    }
  })

  it('plus de 3 redirections : TOO_MANY_REDIRECTS', async () => {
    const r = await captureLegalProof('company.fr', 'https://company.fr/a', deps({
      dns: { 'company.fr': ['93.184.216.34'] },
      reponses: {
        'company.fr/a': REDIR('/b'), 'company.fr/b': REDIR('/c'),
        'company.fr/c': REDIR('/d'), 'company.fr/d': REDIR('/e'),
      },
    }))
    expect(r).toEqual({ ok: false, reason: 'TOO_MANY_REDIRECTS' })
  })
})

describe('réponse', () => {
  const D = (rep: any) => deps({ dns: { 'company.fr': ['93.184.216.34'] }, reponses: { 'company.fr/legal': rep } })

  it('timeout, corps trop grand, type interdit, statut non-200 : raisons closes, jamais le corps distant', async () => {
    expect(await captureLegalProof('company.fr', 'https://company.fr/legal', D('TIMEOUT')))
      .toEqual({ ok: false, reason: 'TIMEOUT' })
    expect(await captureLegalProof('company.fr', 'https://company.fr/legal', D({ ...PAGE, truncated: true })))
      .toEqual({ ok: false, reason: 'BODY_TOO_LARGE' })
    expect(await captureLegalProof('company.fr', 'https://company.fr/legal', D({ ...PAGE, contentType: 'application/json' })))
      .toEqual({ ok: false, reason: 'BAD_CONTENT_TYPE' })
    expect(await captureLegalProof('company.fr', 'https://company.fr/legal', D({ ...PAGE, status: 500, body: 'SECRET DISTANT' })))
      .toEqual({ ok: false, reason: 'FETCH_FAILED' }) // aucun champ ne porte le corps
    expect(PROOF_MAX_BYTES).toBeGreaterThan(0)
  })

  it('le module n’expose AUCUN fetcher générique et n’utilise jamais fetch()', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/prospector/proactive/legalProofFetch.ts', 'utf8')
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/followRedirects|maxRedirects:\s*[1-9]\d/) // redirections manuelles seulement
  })
})
