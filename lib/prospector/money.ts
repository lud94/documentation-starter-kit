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

// ── Lecture d'ANTHROPIC_BUDGET — TROIS ÉTATS, jamais deux ────────────────────
//
// DÉFAUT CORRIGÉ (P0 de configuration). La version précédente rendait `null`
// pour trois situations qui n'ont rien à voir :
//   * la variable est absente        → aucun plafond demandé
//   * la variable vaut « 0 »         → ZÉRO dépense autorisée
//   * la variable vaut « 20abc »     → configuration cassée
// Les confondre revenait à ce qu'un « 0 » saisi volontairement, ou une saisie
// fautive, DÉSACTIVENT le garde-fou au lieu de le fermer. C'est exactement
// l'inverse du comportement attendu d'un plafond de dépense.
//
// Format accepté : entier optionnellement suivi d'une partie décimale, séparateur
// « . » ou « , ». Au-delà de 6 décimales, la partie excédentaire est TRONQUÉE —
// tronquer diminue le plafond, ce qui est le sens conservateur.
//
// Cas particulier volontairement classé INVALIDE : une valeur strictement
// positive mais trop fine pour le µUSD (« 0.0000001 »). L'utilisateur a demandé
// un plafond non nul que notre unité ne sait pas représenter. Le tronquer à zéro
// changerait silencieusement le sens de sa saisie ; l'arrondir au µUSD
// inventerait un montant. On refuse et on le dit.
export type BudgetConfig =
  | { kind: 'absent' }
  | { kind: 'valid'; micros: bigint }          // micros >= 0 ; 0 est légitime
  | { kind: 'invalid'; raw: string; reason: string }

export function readBudgetConfig(raw: string | undefined | null): BudgetConfig {
  if (raw === undefined || raw === null || raw.trim() === '') return { kind: 'absent' }

  const s = raw.trim()
  const m = /^(\d+)(?:[.,](\d*))?$/.exec(s)
  if (!m) {
    return { kind: 'invalid', raw: s,
      reason: 'Montant illisible. Attendu : un nombre positif, par exemple « 20 » ou « 20,50 ».' }
  }

  const fracRaw = m[2] || ''
  const micros = BigInt(m[1]) * MICROS_PER_USD + BigInt(fracRaw.slice(0, 6).padEnd(6, '0'))

  // Saisie positive mais inférieure au micro-dollar : on ne devine pas.
  if (micros === 0n && /[1-9]/.test(fracRaw)) {
    return { kind: 'invalid', raw: s,
      reason: 'Montant positif mais inférieur au micro-dollar : trop fin pour être représenté. Saisir au moins 0,000001.' }
  }

  return { kind: 'valid', micros }
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

// ⚠️ CORRECTION C2a-2 — `web_search` et `web_fetch` ne se facturent PAS pareil.
//
// Jusqu'ici l'estimation prenait une somme AGRÉGÉE de `max_uses` et la
// multipliait par le tarif de la recherche web. Sur `signals.ts`
// (`web_search: 10` + `web_fetch: 6`) cela donnait 16 × 0,01 $ = 0,16 $ de part
// outil, alors que le modèle de coût réel est :
//   • `web_search` — facturé PAR RECHERCHE, plus les tokens injectés ;
//   • `web_fetch`  — AUCUN coût d'outil, uniquement les tokens du contenu
//     récupéré, facturés en ENTRÉE au tarif du modèle.
// Le montant correct pour ce site est donc 0,10 $, pas 0,16 $ : l'ancienne
// formule sur-provisionnait cette part de 60 %. Ce n'était pas une prudence
// assumée, c'était une erreur de modèle.
//
// CONSÉQUENCE QU'ON NE MASQUE PAS. Borner `web_fetch` suppose de connaître
// `max_content_tokens`. Quand il n'est pas déclaré — c'est le cas AUJOURD'HUI
// sur les deux seuls sites qui utilisent l'outil — le volume d'entrée injecté
// est NON BORNÉ, donc non estimable. Le contrat retenu est alors :
// `complete = false` et la composante nommée dans `incomplete`. La valeur
// numérique correspondante reste 0, mais elle ne doit JAMAIS être lue comme
// « coût nul » : c'est `complete` qui porte la vérité, pas le montant.

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

// ── ESTIMATION (avant l'appel) ────────────────────────────────────────────────
//
// ⚠️ CE N'EST PAS UN MAJORANT. Le lot C2a-2c a retiré cette affirmation, qui
// était fausse et mesurée comme telle sur staging.
//
// Sortie : `max_tokens` est un plafond DUR côté Anthropic — cette composante-là
//   est bien bornée.
//
// Entrée : `bodyBytes / 3` est une HEURISTIQUE LOCALE INDICATIVE, rien de plus.
//   Mesure staging (Sonnet, sans outil) : corps de 2 400 octets → 800 tokens
//   estimés contre **945 réels**. Sous-estimation de 18 %. Le ratio 3 octets par
//   token est une moyenne de prose anglaise ; notre corps est du JSON structuré
//   contenant du français accentué, qui tokenise plus dense.
//   Le précomptage fournisseur (`lib/prospector/tokenCount.ts`,
//   `POST /v1/messages/count_tokens`) est l'instrument correct — lui-même donné
//   pour une ESTIMATION par Anthropic, pas pour une borne.
//   Aucun coefficient n'est réajusté ici : corriger « /3 » en « /2 » sur cinq
//   observations remplacerait une erreur mesurée par une autre, non mesurée.
//
// Outils serveur : voir les constantes INCOMPLETE_* ci-dessus. Le frais de
//   recherche web est borné par `max_uses` ; les TOKENS que les outils injectent
//   ne le sont pas, et aucun paramètre de l'API ne les borne.
//
// ── Deux listes, volontairement distinctes ───────────────────────────────────
//   `unbounded`  — la vérité complète : toute composante que rien ne borne.
//   `incomplete` — le sous-ensemble sur lequel la porte ENFORCE refuse
//                  AUJOURD'HUI (contrat C2a-2b, inchangé par ce lot).
// L'écart entre les deux est exactement la décision différée : ENFORCE doit-il
// devenir un plafond dur strict, un garde opérationnel tolérant, ou deux
// niveaux distincts ? C2a-2c fournit l'instrument de mesure, pas l'arbitrage.
export interface EstimateInput {
  model: string
  maxTokens: number
  bodyBytes: number
  /**
   * @deprecated C2a-2 — remplacé par `webSearchMaxUses`. Conservé et traité
   * comme tel : il est couvert par les tests C2a-1, et le retirer dans le même
   * lot mélangerait une correction de modèle et une rupture d'interface.
   */
  serverToolMaxUses?: number
  /** Somme des `max_uses` des outils facturés à l'usage (recherche web). */
  webSearchMaxUses?: number
  /**
   * `web_search` figure-t-il dans la requête ? Décide de la présence de la
   * composante NON BORNABLE `web_search_result_tokens`. Par défaut : déduit de
   * `webSearchMaxUses > 0`.
   */
  webSearchDeclared?: boolean
  /** `web_fetch` figure-t-il dans la requête ? Décide de l'estimabilité. */
  webFetchDeclared?: boolean
  /**
   * Borne TOTALE de contenu récupérable par `web_fetch`, en tokens
   * (`max_content_tokens` × `max_uses`). `undefined` alors que
   * `webFetchDeclared` est vrai ⇒ composante NON ESTIMABLE, jamais zéro.
   */
  webFetchMaxContentTokens?: number
  /**
   * Types d'outils serveur rencontrés dont le modèle de coût n'est pas supporté.
   * Non vide ⇒ estimation INCOMPLÈTE, quelle que soit la valeur calculée.
   */
  unknownServerToolTypes?: string[]
  webSearchMicrosPerUse?: bigint
}

/** Identifiants de composantes non bornables — stables, exploités en télémétrie. */
export const INCOMPLETE_WEB_FETCH_CONTENT = 'web_fetch_content'
export const INCOMPLETE_UNKNOWN_SERVER_TOOL = 'unknown_server_tool'
/**
 * `max_content_tokens` borne le contenu TEXTE de `web_fetch`, pas le binaire :
 * « The limit applies to text content, not to binary content such as PDFs »
 * (documentation web fetch). Un PDF fetché échappe donc à la borne — la même
 * documentation chiffre l'ordre de grandeur à ~125 000 tokens pour 500 kB.
 * Aucun paramètre de l'API ne permet d'interdire le binaire.
 */
export const INCOMPLETE_WEB_FETCH_BINARY_CONTENT = 'web_fetch_binary_content'
/**
 * `max_uses` borne le NOMBRE de recherches et donc le frais, jamais le volume
 * de tokens que leurs résultats injectent en entrée. Il n'existe aucun
 * équivalent de `max_content_tokens` pour la recherche web, et la documentation
 * précise que ces résultats sont comptés en entrée « in search iterations
 * executed during a single turn and in subsequent conversation turns ».
 */
export const INCOMPLETE_WEB_SEARCH_RESULT_TOKENS = 'web_search_result_tokens'

/**
 * Types d'outils serveur dont le modèle de coût est EXPLICITEMENT supporté.
 * Tout autre type est facturé à titre indicatif au tarif de la recherche web,
 * mais rend l'estimation INCOMPLÈTE : un outil inconnu peut se facturer d'une
 * façon que ce fichier ne modélise pas (au token, à la seconde, au Go). Le
 * traiter comme une recherche web et déclarer l'estimation complète reviendrait
 * à présenter une supposition comme un majorant.
 */
export const SUPPORTED_SERVER_TOOL_PREFIXES = ['web_search', 'web_fetch']

export interface EstimateBreakdown {
  /** ⚠️ INDICATIF — `bodyBytes / 3`, ni borne ni majorant. Voir l'en-tête. */
  inputMicros: bigint
  /** BORNÉ — `max_tokens` est un plafond dur côté Anthropic. */
  outputMicros: bigint
  /** BORNÉ pour `web_search` (`max_uses` × tarif) ; indicatif pour un type inconnu. */
  toolMicros: bigint
  /** BORNÉ si `max_content_tokens` est posé — pour le TEXTE seulement. */
  fetchContentMicros: bigint
  /** Somme des quatre. Ce n'est pas un majorant du coût réel. */
  totalMicros: bigint

  /**
   * VÉRITÉ COMPLÈTE : toute composante que rien ne borne, nommée.
   * Purement descriptif — n'entre dans AUCUNE décision dans ce lot.
   */
  unbounded: string[]

  /**
   * Sous-ensemble de `unbounded` sur lequel la porte ENFORCE refuse AUJOURD'HUI.
   * Contrat C2a-2b conservé à l'identique : `web_fetch` sans
   * `max_content_tokens`, et outil serveur non modélisé.
   * ⚠️ `incomplete ⊆ unbounded`, et l'inclusion est STRICTE en présence de
   * `web_search` ou d'un `web_fetch` borné en texte. Cet écart est la décision
   * différée, pas une incohérence.
   */
  incomplete: string[]

  /** `incomplete` est vide. NE signifie PAS « tout est borné » — voir ci-dessus. */
  complete: boolean
}

export function estimateBreakdown(o: EstimateInput): EstimateBreakdown {
  const p = priceFor(o.model)
  const n = (v: number | undefined) => BigInt(Math.max(0, Math.trunc(v || 0)))

  const inTokens = ceilDiv(BigInt(Math.max(0, Math.trunc(o.bodyBytes))), 3n)
  const outTokens = BigInt(Math.max(0, Math.trunc(o.maxTokens)))

  // `serverToolMaxUses` (hérité) et `webSearchMaxUses` désignent la même chose ;
  // on additionne plutôt que d'en privilégier un, pour qu'un appelant de
  // transition qui renseignerait les deux ne voie pas une part disparaître.
  const searchUses = n(o.serverToolMaxUses) + n(o.webSearchMaxUses)
  const perUse = o.webSearchMicrosPerUse ?? DEFAULT_WEB_SEARCH_MICROS_PER_USE

  const incomplete: string[] = []
  const unbounded: string[] = []

  // `web_search` : le FRAIS est borné par `max_uses`, les TOKENS de résultats
  // ne le sont pas. Non bloquant — le contrat ENFORCE actuel n'en tient pas
  // compte, et ce lot ne le change pas.
  const searchDeclared = o.webSearchDeclared ?? searchUses > 0n
  if (searchDeclared) unbounded.push(INCOMPLETE_WEB_SEARCH_RESULT_TOKENS)

  let fetchContentMicros = 0n
  if (o.webFetchDeclared) {
    if (o.webFetchMaxContentTokens === undefined) {
      // NON BORNABLE. On ne fabrique pas de borne : inventer un
      // `max_content_tokens` produirait un chiffre faux présenté comme exact.
      unbounded.push(INCOMPLETE_WEB_FETCH_CONTENT)
      incomplete.push(INCOMPLETE_WEB_FETCH_CONTENT)
    } else {
      // Le TEXTE est borné. Le BINAIRE ne l'est pas : `max_content_tokens` ne
      // s'y applique pas. Non bloquant — poser la borne texte est déjà ce que
      // le contrat C2a-2b considère comme suffisant, et ce lot le conserve.
      fetchContentMicros = tokenCostMicros(n(o.webFetchMaxContentTokens), p.inPerM)
      unbounded.push(INCOMPLETE_WEB_FETCH_BINARY_CONTENT)
    }
  }
  // Outil serveur non modélisé : la part calculée reste dans `toolMicros` à
  // titre indicatif, mais elle ne prétend plus majorer quoi que ce soit.
  if (o.unknownServerToolTypes && o.unknownServerToolTypes.length) {
    unbounded.push(INCOMPLETE_UNKNOWN_SERVER_TOOL)
    incomplete.push(INCOMPLETE_UNKNOWN_SERVER_TOOL)
  }

  const inputMicros = tokenCostMicros(inTokens, p.inPerM)
  const outputMicros = tokenCostMicros(outTokens, p.outPerM)
  const toolMicros = searchUses * perUse

  return {
    inputMicros, outputMicros, toolMicros, fetchContentMicros,
    totalMicros: inputMicros + outputMicros + toolMicros + fetchContentMicros,
    unbounded,
    incomplete,
    complete: incomplete.length === 0,
  }
}

/**
 * Total seul. ⚠️ Ce n'est PAS un majorant, dans aucun cas de figure — même sans
 * outil, la part d'entrée est une heuristique indicative mesurée à −18 % sur
 * staging. Toute décision d'arbitrage doit passer par `estimateBreakdown()` et
 * lire `incomplete` / `unbounded`.
 */
export function estimateMicros(o: EstimateInput): bigint {
  return estimateBreakdown(o).totalMicros
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
