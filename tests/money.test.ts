import { describe, it, expect } from 'vitest'
import {
  readBudgetConfig, ceilDiv, tokenCostMicros, cachedTokenCostMicros,
  estimateMicros, settleMicros, priceFor, microsToUsdString, legacyCentsToMicros,
  MICROS_PER_USD,
} from '../lib/prospector/money'
import { requestFingerprint } from '../lib/prospector/fingerprint'
import { ANTHROPIC_ENDPOINT } from '../lib/prospector/llm'

// Lot C2a-1 — l'arithmétique d'autorité doit être ENTIÈRE et CONSERVATRICE.
//
// Le défaut mesuré qui motive tout ce module : `Math.round(usd * 100)` rendait 0
// pour un appel Haiku typique. Ces cas verrouillent la correction et la direction
// d'arrondi — sur-estimer refuse un appel de trop (visible), sous-estimer laisse
// filer une dépense (invisible).

describe('lecture d’ANTHROPIC_BUDGET — trois états, jamais deux', () => {
  const micros = (raw: string) => {
    const c = readBudgetConfig(raw)
    if (c.kind !== 'valid') throw new Error(`attendu valid, reçu ${c.kind}`)
    return c.micros
  }

  it('entier simple', () => { expect(micros('20')).toBe(20_000_000n) })
  it('décimale avec point', () => { expect(micros('20.5')).toBe(20_500_000n) })
  it('décimale avec virgule (saisie française)', () => { expect(micros('20,5')).toBe(20_500_000n) })
  it('espaces tolérés', () => { expect(micros('  7.25 ')).toBe(7_250_000n) })

  it('au-delà de 6 décimales : TRONQUE, jamais arrondi au supérieur', () => {
    expect(micros('1.9999999')).toBe(1_999_999n) // tronquer diminue le plafond
  })

  it('ABSENT — variable non posée', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(readBudgetConfig(v as any).kind).toBe('absent')
    }
  })

  it('DÉFAUT P0 — « 0 » est un budget VALIDE de zéro, pas une absence', () => {
    // Zéro dépense autorisée. L'ancienne version rendait null, donc « pas de
    // plafond », donc dépense ILLIMITÉE — l'inverse exact de la saisie.
    const c = readBudgetConfig('0')
    expect(c.kind).toBe('valid')
    expect(c.kind === 'valid' && c.micros).toBe(0n)
    expect(readBudgetConfig('0,00').kind).toBe('valid')
  })

  it('DÉFAUT P0 — une saisie fautive est INVALIDE, jamais une absence', () => {
    // L'ancienne version les confondait avec « pas de budget » : une faute de
    // frappe désactivait le garde-fou.
    for (const bad of ['abc', '20abc', '-5', '1e3', '20 $', '20.5.1', ' 2 0 ']) {
      const c = readBudgetConfig(bad)
      expect(c.kind).toBe('invalid')
      expect(c.kind === 'invalid' && c.reason.length).toBeGreaterThan(0)
    }
  })

  it('positif mais trop fin pour le µUSD : INVALIDE, pas zéro', () => {
    // Tronquer à zéro changerait le sens de la saisie ; arrondir inventerait un
    // montant. On refuse et on le dit.
    expect(readBudgetConfig('0.0000001').kind).toBe('invalid')
    expect(readBudgetConfig('0.000001').kind).toBe('valid')
  })

  it('parseFloat aurait accepté « 20abc » — pas nous', () => {
    expect(parseFloat('20abc')).toBe(20)      // le piège
    expect(readBudgetConfig('20abc').kind).toBe('invalid')
  })
})

describe('division par excès', () => {
  it('arrondit toujours au supérieur', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n)
    expect(ceilDiv(9n, 3n)).toBe(3n)
    expect(ceilDiv(1n, 1_000_000n)).toBe(1n) // jamais zéro sur une valeur positive
  })
  it('zéro et négatif rendent zéro', () => {
    expect(ceilDiv(0n, 3n)).toBe(0n)
    expect(ceilDiv(-5n, 3n)).toBe(0n)
  })
  it('un diviseur nul lève plutôt que de rendre un résultat faux', () => {
    expect(() => ceilDiv(1n, 0n)).toThrow()
  })
})

describe('tarifs produisant des fractions de µUSD par token', () => {
  // Le cas que l'arithmétique en cents ratait : 0,8 $/M = 0,8 µUSD par token.
  // Non représentable par token, exact par million.
  it('un tarif fractionnaire par token reste exact au million', () => {
    const perM = 800_000n // 0,80 $/M
    expect(tokenCostMicros(1_000_000n, perM)).toBe(800_000n)
    expect(tokenCostMicros(1n, perM)).toBe(1n)      // 0,8 → 1 par excès, jamais 0
    expect(tokenCostMicros(10n, perM)).toBe(8n)     // exact
  })

  it('un seul token n’est jamais gratuit', () => {
    expect(tokenCostMicros(1n, 1_000_000n)).toBe(1n)
    expect(cachedTokenCostMicros(1n, 1_000_000n)).toBe(1n)
  })

  it('les tokens relus au cache coûtent ~10 %, en une seule division', () => {
    // 1M tokens à 3 $/M relus au cache → 0,30 $ = 300 000 µUSD.
    expect(cachedTokenCostMicros(1_000_000n, 3_000_000n)).toBe(300_000n)
  })

  it('un modèle inconnu est facturé au tarif le PLUS CHER', () => {
    const p = priceFor('modele-inconnu-2027')
    expect(p.inPerM).toBe(5_000_000n)
    expect(p.outPerM).toBe(25_000_000n)
  })
})

describe('le défaut historique : l’appel Haiku compté zéro', () => {
  it('l’ancien calcul en cents rendait 0', () => {
    const usd = (1500 / 1e6) * 0.8 + (400 / 1e6) * 4
    expect(Math.round(usd * 100)).toBe(0)   // ← le défaut, reproduit
  })

  it('en µUSD le même appel est compté', () => {
    const micros = settleMicros({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1500, cachedInputTokens: 0, outputTokens: 400,
    })
    expect(micros).toBeGreaterThan(0n)
    // 1500 × 1 + 400 × 5 = 3500 µUSD au tarif courant Haiku (1 $/M et 5 $/M).
    expect(micros).toBe(3_500n)
  })
})

describe('estimation — majorant volontaire', () => {
  it('la sortie est bornée par max_tokens, l’entrée sur-estimée', () => {
    const e = estimateMicros({ model: 'claude-sonnet-5', maxTokens: 1000, bodyBytes: 3000 })
    // entrée : 3000/3 = 1000 tokens × 3 µUSD ; sortie : 1000 × 15 µUSD
    expect(e).toBe(1_000n * 3n + 1_000n * 15n)
  })

  it('l’estimation dépasse le règlement quand la réponse est plus courte', () => {
    const est = estimateMicros({ model: 'claude-sonnet-5', maxTokens: 8000, bodyBytes: 3000 })
    const set = settleMicros({ model: 'claude-sonnet-5', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 })
    expect(est).toBeGreaterThan(set)
  })

  it('le coût des outils serveur est intégré à l’estimation', () => {
    const sans = estimateMicros({ model: 'claude-sonnet-5', maxTokens: 100, bodyBytes: 300 })
    const avec = estimateMicros({ model: 'claude-sonnet-5', maxTokens: 100, bodyBytes: 300, serverToolMaxUses: 6 })
    expect(avec - sans).toBe(6n * 10_000n)
  })

  it('les recherches réellement effectuées sont facturées au règlement', () => {
    const a = settleMicros({ model: 'claude-sonnet-5', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
    const b = settleMicros({ model: 'claude-sonnet-5', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, webSearches: 3 })
    expect(b - a).toBe(3n * 10_000n)
  })

  it('aucun flottant ne subsiste : tout est bigint', () => {
    const e = estimateMicros({ model: 'claude-opus-5', maxTokens: 64000, bodyBytes: 900000 })
    expect(typeof e).toBe('bigint')
  })
})

describe('affichage et conversion héritée', () => {
  it('rend une chaîne exacte, sans passer par un flottant', () => {
    expect(microsToUsdString(20_000_000n)).toBe('20.00')
    expect(microsToUsdString(3_500n)).toBe('0.00')
    expect(microsToUsdString(3_500n, 6)).toBe('0.003500')
  })
  it('le seed hérité est une simple conversion d’unité', () => {
    expect(legacyCentsToMicros(1234n)).toBe(12_340_000n)
    expect(legacyCentsToMicros(1n)).toBe(10_000n)
  })
  it('un budget de 3000 $ dépasserait un integer en µUSD', () => {
    const c = readBudgetConfig('3000')
    expect(c.kind === 'valid' && c.micros).toBe(3_000n * MICROS_PER_USD)
    expect(c.kind === 'valid' && c.micros > 2_147_483_647n).toBe(true) // d'où bigint en base
  })
})

describe('empreinte de l’intention facturable', () => {
  const body = { model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'a' }] }
  // Importé plutôt que recopié : un littéral d'URL hors passerelle serait
  // refusé par scripts/check-anthropic-gateway.mjs, et à juste titre.
  const EP = ANTHROPIC_ENDPOINT

  it('stable pour un corps identique', () => {
    expect(requestFingerprint(EP, body)).toBe(requestFingerprint(EP, { ...body }))
  })

  it('insensible à l’ordre des CLÉS — sinon faux integrity_error', () => {
    const permuted = { messages: body.messages, max_tokens: 100, model: 'claude-sonnet-5' }
    expect(requestFingerprint(EP, permuted)).toBe(requestFingerprint(EP, body))
  })

  it('sensible à l’ordre des TABLEAUX — il porte du sens', () => {
    const a = { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }
    const b = { messages: [{ role: 'assistant', content: 'y' }, { role: 'user', content: 'x' }] }
    expect(requestFingerprint(EP, a)).not.toBe(requestFingerprint(EP, b))
  })

  it('DÉFAUT CORRIGÉ — deux requêtes de même modèle/max_tokens/agent diffèrent', () => {
    // hash(model + estimation + agent) les aurait confondues, et un rejeu aurait
    // fait partir la seconde dépense sans réservation.
    const q1 = { ...body, messages: [{ role: 'user', content: 'question 1' }] }
    const q2 = { ...body, messages: [{ role: 'user', content: 'question 2' }] }
    expect(requestFingerprint(EP, q1)).not.toBe(requestFingerprint(EP, q2))
  })

  it('le point de terminaison fait partie de l’empreinte', () => {
    expect(requestFingerprint(EP, body)).not.toBe(requestFingerprint(EP + '/v2', body))
  })

  it('une option retirée par l’échelle de dégradation change l’empreinte', () => {
    // Comportement voulu : chaque requête HTTP est une dépense distincte, donc
    // porte son propre identifiant de réservation et sa propre empreinte.
    const withOpt = { ...body, output_config: { effort: 'low' } }
    expect(requestFingerprint(EP, withOpt)).not.toBe(requestFingerprint(EP, body))
  })
})
