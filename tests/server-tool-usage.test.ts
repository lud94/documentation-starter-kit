import { describe, it, expect } from 'vitest'
import { readServerToolUsage, readToolShape } from '../lib/prospector/llm'
import {
  estimateBreakdown,
  INCOMPLETE_WEB_FETCH_CONTENT,
  INCOMPLETE_WEB_FETCH_BINARY_CONTENT,
  INCOMPLETE_WEB_SEARCH_RESULT_TOKENS,
  INCOMPLETE_UNKNOWN_SERVER_TOOL,
} from '../lib/prospector/money'

// Lot C2a-2c — quatre faits distincts sur les outils serveur, et deux listes
// distinctes sur l'estimabilité.
//
// Le cas qui justifie tout ce fichier, mesuré sur staging : `web_fetch` déclaré,
// coût réel 12× l'estimation, et AUCUNE page récupérée. Déclarer un outil coûte
// des tokens même s'il ne s'exécute jamais.

const BASE = { model: 'claude-sonnet-5', maxTokens: 0, bodyBytes: 0 }

describe('DÉCLARÉ — lecture de la requête', () => {
  it('recense les types d\'outils serveur, dédupliqués', () => {
    const s = readToolShape({ tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    ] })
    expect(s.serverToolTypes).toEqual(['web_search_20250305', 'web_fetch_20260209'])
    expect(s.webSearchDeclared).toBe(true)
    expect(s.webFetchDeclared).toBe(true)
  })

  it('un outil client n\'est pas un outil serveur', () => {
    const s = readToolShape({ tools: [{ name: 'mon_outil', input_schema: {} }] })
    expect(s.serverToolTypes).toEqual([])
    expect(s.webSearchDeclared).toBe(false)
  })
})

describe('RAPPORTÉ PAR LE FOURNISSEUR — usage.server_tool_use', () => {
  it('lit web_search_requests ET web_fetch_requests', () => {
    const u = readServerToolUsage({
      usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 3 } },
    })
    expect(u.webSearchRequests).toBe(2)
    expect(u.webFetchRequests).toBe(3)
  })

  it('champ absent → null, JAMAIS 0', () => {
    // Un compteur absent et un compteur à zéro ne disent pas la même chose :
    // le premier est une ignorance, le second une mesure.
    const u = readServerToolUsage({ usage: { server_tool_use: { web_search_requests: 0 } } })
    expect(u.webSearchRequests).toBe(0)
    expect(u.webFetchRequests).toBeNull()
  })

  it('bloc usage absent → les deux compteurs à null', () => {
    const u = readServerToolUsage({ content: [] })
    expect(u.webSearchRequests).toBeNull()
    expect(u.webFetchRequests).toBeNull()
  })
})

describe('OBSERVÉ — succès et erreurs distingués', () => {
  it('résultat de recherche réussi', () => {
    const u = readServerToolUsage({ content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search' },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'x' }] },
    ] })
    expect(u.invocations).toBe(1)
    expect(u.webSearchResults).toBe(1)
    expect(u.webSearchErrors).toBe(0)
  })

  it('résultat de recherche en ERREUR — content est un objet, pas une liste', () => {
    const u = readServerToolUsage({ content: [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ] })
    expect(u.webSearchResults).toBe(0)
    expect(u.webSearchErrors).toBe(1)
    expect(u.errorCodes).toEqual(['max_uses_exceeded'])
  })

  it('résultat de fetch en erreur', () => {
    const u = readServerToolUsage({ content: [
      { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_in_prior_context' } },
    ] })
    expect(u.webFetchErrors).toBe(1)
    expect(u.errorCodes).toEqual(['url_not_in_prior_context'])
  })

  it('codes d\'erreur dédupliqués', () => {
    const err = { type: 'web_search_tool_result', content: { error_code: 'too_many_requests' } }
    const u = readServerToolUsage({ content: [err, err, err] })
    expect(u.webSearchErrors).toBe(3)
    expect(u.errorCodes).toEqual(['too_many_requests'])
  })

  it('recherche sans résultat = succès à contenu vide, pas une erreur', () => {
    const u = readServerToolUsage({ content: [{ type: 'web_search_tool_result', content: [] }] })
    expect(u.webSearchResults).toBe(1)
    expect(u.webSearchErrors).toBe(0)
  })
})

describe('CONTENU BINAIRE — l\'exposition que max_content_tokens ne borne pas', () => {
  it('un PDF fetché est détecté', () => {
    const u = readServerToolUsage({ content: [{
      type: 'web_fetch_tool_result',
      content: { type: 'web_fetch_result', url: 'x',
        content: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } } },
    }] })
    expect(u.webFetchResults).toBe(1)
    expect(u.webFetchBinaryResults).toBe(1)
  })

  it('un contenu texte n\'est pas compté comme binaire', () => {
    const u = readServerToolUsage({ content: [{
      type: 'web_fetch_tool_result',
      content: { type: 'web_fetch_result', url: 'x',
        content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '...' } } },
    }] })
    expect(u.webFetchResults).toBe(1)
    expect(u.webFetchBinaryResults).toBe(0)
  })
})

describe('DÉCLARÉ ≠ EXÉCUTÉ — le cas staging', () => {
  it('outil déclaré, aucune exécution : compteur à 0, aucun bloc de résultat', () => {
    // Reproduit la sonde : web_fetch déclaré, prompt sans URL, output_tokens = 4.
    const u = readServerToolUsage({
      usage: { input_tokens: 4619, output_tokens: 4, server_tool_use: { web_fetch_requests: 0 } },
      content: [{ type: 'text', text: 'OK' }],
    })
    expect(u.webFetchRequests).toBe(0)
    expect(u.webFetchResults).toBe(0)
    expect(u.webFetchErrors).toBe(0)
    expect(u.invocations).toBe(0)
  })

  it('réponse vide → tout à zéro, aucune exception', () => {
    expect(readServerToolUsage(null).webSearchResults).toBe(0)
    expect(readServerToolUsage({}).invocations).toBe(0)
    expect(readServerToolUsage({ content: 'pas un tableau' }).webFetchResults).toBe(0)
  })
})

describe('deux listes : unbounded (vérité) et incomplete (porte ENFORCE actuelle)', () => {
  it('sans outil → les deux listes vides', () => {
    const e = estimateBreakdown({ ...BASE, maxTokens: 100, bodyBytes: 300 })
    expect(e.unbounded).toEqual([])
    expect(e.incomplete).toEqual([])
    expect(e.complete).toBe(true)
  })

  it('web_search borné par max_uses → NON BORNÉ (résultats), mais NON BLOQUANT', () => {
    // Le frais est borné ; les tokens de résultats ne le sont pas. Le contrat
    // ENFORCE actuel n'en tient pas compte, et ce lot ne le change pas.
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 10 })
    expect(e.unbounded).toEqual([INCOMPLETE_WEB_SEARCH_RESULT_TOKENS])
    expect(e.incomplete).toEqual([])
    expect(e.complete).toBe(true)
    expect(e.toolMicros).toBe(100_000n)  // le frais, lui, est exact
  })

  it('web_fetch SANS max_content_tokens → non borné ET bloquant (inchangé)', () => {
    const e = estimateBreakdown({ ...BASE, webFetchDeclared: true })
    expect(e.unbounded).toEqual([INCOMPLETE_WEB_FETCH_CONTENT])
    expect(e.incomplete).toEqual([INCOMPLETE_WEB_FETCH_CONTENT])
    expect(e.complete).toBe(false)
  })

  it('web_fetch AVEC max_content_tokens → binaire non borné, mais NON BLOQUANT', () => {
    const e = estimateBreakdown({ ...BASE, webFetchDeclared: true, webFetchMaxContentTokens: 30_000 })
    expect(e.unbounded).toEqual([INCOMPLETE_WEB_FETCH_BINARY_CONTENT])
    expect(e.incomplete).toEqual([])
    expect(e.complete).toBe(true)   // ← comportement C2a-2b conservé
    expect(e.fetchContentMicros).toBe(90_000n)
  })

  it('outil serveur inconnu → non borné ET bloquant (inchangé)', () => {
    const e = estimateBreakdown({ ...BASE, unknownServerToolTypes: ['code_execution_x'] })
    expect(e.unbounded).toEqual([INCOMPLETE_UNKNOWN_SERVER_TOOL])
    expect(e.incomplete).toEqual([INCOMPLETE_UNKNOWN_SERVER_TOOL])
    expect(e.complete).toBe(false)
  })

  it('INVARIANT : incomplete est toujours un sous-ensemble de unbounded', () => {
    const cases = [
      { ...BASE },
      { ...BASE, webSearchMaxUses: 3 },
      { ...BASE, webFetchDeclared: true },
      { ...BASE, webFetchDeclared: true, webFetchMaxContentTokens: 100 },
      { ...BASE, unknownServerToolTypes: ['x'] },
      { ...BASE, webSearchMaxUses: 3, webFetchDeclared: true, unknownServerToolTypes: ['x'] },
    ]
    for (const c of cases) {
      const e = estimateBreakdown(c)
      for (const item of e.incomplete) expect(e.unbounded).toContain(item)
    }
  })

  it('le profil signals.ts : inclusion STRICTE — c\'est la décision différée', () => {
    // web_search 10 + web_fetch 6 sans max_content_tokens, tel que déclaré
    // aujourd'hui par lib/prospector/signals.ts (non modifié par ce lot).
    const e = estimateBreakdown({
      ...BASE, webSearchMaxUses: 10, webFetchDeclared: true,
    })
    expect(e.unbounded).toEqual([
      INCOMPLETE_WEB_SEARCH_RESULT_TOKENS,
      INCOMPLETE_WEB_FETCH_CONTENT,
    ])
    expect(e.incomplete).toEqual([INCOMPLETE_WEB_FETCH_CONTENT])
    expect(e.unbounded.length).toBeGreaterThan(e.incomplete.length)
  })
})
