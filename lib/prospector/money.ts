// Arithmétique monétaire du garde-fou budgétaire — ENTIÈREMENT EN ENTIERS.
//
// UNITÉ : le micro-dollar (µUSD), 1e-6 USD. 1 cent = 10 000 µUSD.
// Toutes les valeurs d'autorité sont des `bigint`. Aucun `number`, aucun flottant
// ne participe à une décision d'autoriser ou de refuser une dépense. Les seules
// conversions vers `number` sont l'affichage.
//
// POURQUOI PAS LES CENTS. `recordAiUsage` calculait `Math.round(usd * 100)` :
// mesuré, un appel Jarvis typique sur Haiku (1500 tokens d'entrée, 400 de sortie)
// coûte 0,28 cent et était donc arrondi à ZÉRO. Les appels les plus nombreux de
// la plateforme n'étaient pas comptés du tout. Le µUSD supprime le problème :
// le même appel vaut 2 800 µUSD, exactement représentable.
//
// POURQUOI PAS `integer` EN BASE. 2 147 483 647 µUSD = 2 147 $. Le compteur
// déborderait. D'où `bigint` dans prospector_ai_ledger — et c'est aussi pourquoi
// le compteur ne réutilise PAS prospector_usage.count, qui est `integer` dans la
// baseline de production.

export const MICROS_PER_USD = 1_000_000n
export const MICROS_PER_CENT = 10_000n

// ── Division entière par excès ────────────────────────────────────────────────
// TOUTE division arrondit au SUPÉRIEUR. Direction choisie délibérément : une
// estimation trop haute refuse un appel de trop (visible, corrigible en relevant
// le budget) ; une estimation trop basse laisse passer une dépense (invisible).
// L'erreur maximale introduite est de 1 µUSD par terme, soit 0,000001 $.
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: diviseur non positif')
  if (a <= 0n) return 0n
  return (a + b - 1n) / b
}

// ── Lecture d'ANTHROPIC_BUDGET ────────────────────────────────────────────────
// Saisi à la main dans l'Admin, donc à traiter comme une entrée non fiable.
// `parseFloat` est proscrit : il accepte « 20abc », rend NaN silencieusement, et
// perd de la précision au-delà du dixième de cent.
//
// Format accepté : entier optionnellement suivi d'une partie décimale, séparateur
// « . » ou « , ». Au-delà de 6 décimales, la partie excédentaire est TRONQUÉE —
// tronquer diminue le plafond, ce qui est le sens conservateur.
//
// Toute autre forme rend `null` = budget non configuré. On ne devine pas un
// plafond à partir d'une saisie qu'on ne comprend pas.
export function parseBudgetMicros(raw: string | undefined | null): bigint | null {
  if (!raw) return null
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(raw)
  if (!m) return null
  const frac = (m[2] || '').slice(0, 6).padEnd(6, '0')
  const micros = BigInt(m[1]) * MICROS_PER_USD + BigInt(frac)
  return micros > 0n ? micros : null
}

// ── Tarifs ────────────────────────────────────────────────────────────────────
// Exprimés en µUSD par MILLION de tokens, donc en entiers exacts : un tarif de
// 0,80 $/M devient 800 000 µUSD/M. C'est le point que l'arithmétique en cents
// ratait — 0,8 µUSD par token n'est pas représentable, 800 000 µUSD par million
// l'est exactement, et la division finale est faite une seule fois, par excès.
export interface TokenPrice { inPerM: bigint; outPerM: bigint }

const PRICES: Record<string, TokenPrice> = {
  'claude-opus-5':               { inPerM:  5_000_000n, outPerM: 25_000_000n },
  'claude-opus-4-8':             { inPerM:  5_000_000n, outPerM: 25_000_000n },
  'claude-sonnet-5':             { inPerM:  3_000_000n, outPerM: 15_000_000n },
  'claude-haiku-4-5-20251001':   { inPerM:  1_000_000n, outPerM:  5_000_000n },
}

// Défaut VOLONTAIREMENT le plus cher : un modèle inconnu doit coûter cher à
// l'estimation, pas être bradé. Un tarif sous-estimé sur un modèle non répertorié
// autoriserait des appels que le plafond aurait dû refuser.
const FALLBACK_PRICE: TokenPrice = { inPerM: 5_000_000n, outPerM: 25_000_000n }

export function priceFor(model: string): TokenPrice {
  if (PRICES[model]) return PRICES[model]
  if (/haiku/i.test(model))  return PRICES['claude-haiku-4-5-20251001']
  if (/sonnet/i.test(model)) return PRICES['claude-sonnet-5']
  return FALLBACK_PRICE
}

// Coût des outils serveur. La recherche web est facturée à l'usage, EN PLUS des
// tokens qu'elle injecte. Valeur par défaut documentée et surchargeable par
// l'exploitant : le tarif fournisseur peut changer sans que ce code le sache.
export const DEFAULT_WEB_SEARCH_MICROS_PER_USE = 10_000n // 0,01 $ par recherche
export const DEFAULT_MAX_USES_WHEN_UNSET = 8n            // borne prudente si max_uses absent

// ── Coût d'un volume de tokens ────────────────────────────────────────────────
export function tokenCostMicros(tokens: bigint, perMillion: bigint): bigint {
  if (tokens <= 0n) return 0n
  return ceilDiv(tokens * perMillion, 1_000_000n)
}

// Tokens d'entrée relus depuis le cache Anthropic : facturés ~10 % du plein tarif.
// La division par 10 est intégrée à la division unique pour ne pas cumuler deux
// arrondis successifs.
export function cachedTokenCostMicros(tokens: bigint, perMillion: bigint): bigint {
  if (tokens <= 0n) return 0n
  return ceilDiv(tokens * perMillion, 10_000_000n)
}

// ── ESTIMATION (avant l'appel) — majorant volontaire ─────────────────────────
//
// Sortie : `max_tokens` est un plafond DUR côté Anthropic, donc un majorant exact.
// Entrée : estimée sur le corps réellement sérialisé. Le ratio retenu est
//   1 token ≈ 3 octets, plus prudent que le ~4 usuel — sur-estimer l'entrée est
//   sans danger, la sous-estimer ouvre une brèche.
// Outils : `max_uses` × tarif par usage.
//
// ⚠️ LIMITE STRUCTURELLE, à ne pas masquer : les outils serveur injectent des
// tokens d'ENTRÉE que nous n'avons pas émis (contenu des résultats de recherche).
// Ce volume est inconnaissable à l'avance. L'estimation reste donc un majorant
// pour un appel sans outil, et seulement une approximation prudente avec outils.
export interface EstimateInput {
  model: string
  maxTokens: number
  bodyBytes: number
  serverToolMaxUses?: number      // somme des max_uses des outils serveur déclarés
  webSearchMicrosPerUse?: bigint
}

export function estimateMicros(o: EstimateInput): bigint {
  const p = priceFor(o.model)
  const inTokens = ceilDiv(BigInt(Math.max(0, Math.trunc(o.bodyBytes))), 3n)
  const outTokens = BigInt(Math.max(0, Math.trunc(o.maxTokens)))
  const uses = o.serverToolMaxUses === undefined
    ? 0n
    : BigInt(Math.max(0, Math.trunc(o.serverToolMaxUses)))
  const perUse = o.webSearchMicrosPerUse ?? DEFAULT_WEB_SEARCH_MICROS_PER_USE
  return tokenCostMicros(inTokens, p.inPerM)
    + tokenCostMicros(outTokens, p.outPerM)
    + uses * perUse
}

// ── RÈGLEMENT (après l'appel) — coût CALCULÉ, pas facture ────────────────────
//
// Nom délibéré : `settled`, pas `actual`. Anthropic ne nous communique aucun
// montant facturé ; ceci est notre comptabilité, dérivée des tokens renvoyés et
// de tarifs saisis dans ce fichier. La réconciliation avec la facture réelle est
// le lot C2c, non implémenté.
export interface SettleInput {
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  webSearches?: number
  webSearchMicrosPerUse?: bigint
}

export function settleMicros(o: SettleInput): bigint {
  const p = priceFor(o.model)
  const n = (v: number) => BigInt(Math.max(0, Math.trunc(v || 0)))
  const perUse = o.webSearchMicrosPerUse ?? DEFAULT_WEB_SEARCH_MICROS_PER_USE
  return tokenCostMicros(n(o.inputTokens), p.inPerM)
    + cachedTokenCostMicros(n(o.cachedInputTokens), p.inPerM)
    + tokenCostMicros(n(o.outputTokens), p.outPerM)
    + n(o.webSearches ?? 0) * perUse
}

// ── Affichage uniquement ──────────────────────────────────────────────────────
// Seul endroit où un `number` apparaît. Ne jamais réinjecter le résultat dans
// une décision : la conversion perd de la précision au-delà de ~9e15 µUSD.
export function microsToUsdString(micros: bigint, decimals = 2): string {
  const neg = micros < 0n
  const v = neg ? -micros : micros
  const whole = v / MICROS_PER_USD
  const frac = (v % MICROS_PER_USD).toString().padStart(6, '0').slice(0, decimals)
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? '.' + frac : ''}`
}

// Conversion du compteur hérité `ai:cents` vers les µUSD.
// ⚠️ APPROXIMATIF PAR CONSTRUCTION — voir le commentaire de la migration :
// `ai:cents` sous-comptait (arrondi à l'entier de cent), donc la valeur obtenue
// est un MINORANT de la dépense réelle, pas une reconstruction.
export function legacyCentsToMicros(cents: bigint): bigint {
  return cents * MICROS_PER_CENT
}
