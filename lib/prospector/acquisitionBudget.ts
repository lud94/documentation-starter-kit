// QUICK-SIGNAL-SEARCH-BOUNDED-001 — LE BUDGET DE TEMPS D'UNE ACQUISITION.
//
// ── LE DÉFAUT QUE CE MODULE FERME ───────────────────────────────────────────
// `/api/signals/search` déclare `maxDuration: 60`, mais RIEN dans le code ne
// mesurait le temps écoulé. La boucle `pause_turn` pouvait rejouer quatre
// transports de 50 s (200 s), et deux chemins de transport — `rawPost` et
// `searchExa` — partaient sans `AbortSignal`, donc sans borne du tout.
//
// Résultat observé en staging : 504 sur « Série A / Paris », à 3 mois COMME à
// 1 mois. Réduire la période ne changeait rien, parce que la durée n'était
// bornée nulle part.
//
// ── POURQUOI UN SEUL OBJET, ET PAS DEUX MÉCANISMES ──────────────────────────
// ⚠️ UNE ÉCHÉANCE ET DES TIMEOUTS DE TRANSPORT INDÉPENDANTS NE SE COMPOSENT
// PAS. Deux bornes qui s'ignorent produisent la somme de leurs pires cas : une
// échéance globale de 45 s plus un transport qui s'autorise 50 s dépasse encore.
// Il n'y a donc ici qu'UNE source de vérité — un instant limite ABSOLU — dont
// chaque opération coûteuse dérive son propre plafond.
//
// L'instant limite est absolu, jamais une durée relative recalculée à chaque
// étape : une durée relative se « recharge » silencieusement à chaque appel et
// laisse le total dériver, ce qui est exactement le défaut d'origine.
//
// ── CE MODULE NE DÉCIDE D'AUCUNE POLITIQUE PRODUIT ──────────────────────────
// Il ne connaît ni Claude, ni Exa, ni la recherche de signaux. Il répond à deux
// questions : « combien de temps reste-t-il ? » et « puis-je encore me
// permettre une opération de ce coût ? ». Tout le reste appartient aux
// appelants.

/**
 * Budget total d'UNE acquisition Quick Search.
 *
 * ⚠️ 45 s SOUS UNE LIMITE DE 60 s, ET LA MARGE EST LE POINT. Les 15 s restantes
 * ne sont pas du gaspillage : elles couvrent tout ce que la route fait AUTOUR de
 * l'acquisition — `hydrateKeystore`, résolution du tenant, post-traitement,
 * `registerCandidates` sur jusqu'à dix candidats, sérialisation — plus la marge
 * de démarrage à froid de la fonction. Sans elles, une acquisition « dans les
 * temps » ferait quand même expirer la requête pendant la persistance, et
 * l'utilisateur perdrait un travail réellement terminé.
 */
export const QUICK_SEARCH_BUDGET_MS = 45_000

/**
 * Coût présumé d'un transport fournisseur, quand on doit décider AVANT de
 * l'engager si on peut se le permettre.
 *
 * ⚠️ CE N'EST PAS UN TIMEOUT, c'est un SEUIL D'ENGAGEMENT. Démarrer un appel
 * qu'on sait ne pas pouvoir terminer consomme le budget restant pour rien, puis
 * échoue : on aurait dépensé le temps ET perdu le résultat. Mieux vaut ne pas
 * commencer et le dire.
 */
export const MIN_TRANSPORT_MS = 8_000

// ── PLAFONDS D'EXÉCUTION AGRÉGÉS — LE TEMPS NE BORNE PAS LA DÉPENSE ─────────
//
// ⚠️ LEÇON DU SMOKE STAGING. L'échéance de 45 s a parfaitement tenu — 42,45 s,
// aucun 504 — et la requête a pourtant coûté cher : le fournisseur facture à
// l'USAGE D'OUTIL et au TOKEN D'ENTRÉE, pas à la seconde. Une requête peut
// épuiser dix recherches web et six pages entières en quarante secondes.
//
// Ces plafonds sont donc TOTAUX pour UNE action utilisateur. Ils ne se
// réinitialisent ni à un nouveau tour, ni sur `pause_turn`, ni sur une
// continuation, ni sur une dégradation HTTP 400 — c'est précisément par ces
// chemins que la dépense échappait au compte.

/** Requêtes fournisseur pour UNE Quick Search. Couvre tours + dégradations. */
export const QUICK_SEARCH_MAX_PROVIDER_CALLS = 4

/**
 * Recherches web TOTALES pour UNE Quick Search.
 *
 * ⚠️ CE N'EST PAS `max_uses`. `max_uses: 10` est un plafond PAR REQUÊTE : sur
 * quatre tours il autorise quarante recherches. Ce compteur-ci est le plafond
 * de l'action utilisateur entière. On ne touche pas à `max_uses` — c'est un
 * arbitrage de qualité qui appartient à un autre lot.
 */
export const QUICK_SEARCH_MAX_WEB_SEARCHES = 10

/** Récupérations de page TOTALES pour UNE Quick Search. Même raisonnement. */
export const QUICK_SEARCH_MAX_WEB_FETCHES = 6

/**
 * Plafond de contenu TEXTE par `web_fetch`, en tokens.
 *
 * ⚠️ LA SEULE COMPOSANTE QUE RIEN NE BORNAIT. `money.ts` le documente depuis
 * C2a-2 : sans `max_content_tokens`, le volume d'entrée injecté est NON BORNÉ
 * — donc non estimable, donc non plafonnable. Six pages web entières
 * réinjectées à chaque tour interne, facturées au tarif d'entrée du modèle,
 * étaient l'amplificateur de coût le plus puissant du chemin.
 *
 * Cette valeur est consommée par DEUX endroits qui doivent rester d'accord :
 * la déclaration de l'outil envoyée au fournisseur, et l'estimateur de coût.
 * Les laisser diverger rendrait l'estimation fausse dans le sens permissif.
 */
export const QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS = 20_000

/** Pourquoi une acquisition a été refusée AVANT d'engager une dépense. */
export type BudgetDenial =
  | 'deadline'          // plus assez de temps
  | 'provider_calls'    // plafond d'appels fournisseur atteint
  | 'web_searches'      // plafond de recherches web atteint
  | 'web_fetches'       // plafond de récupérations atteint
  | 'money'             // le coût estimé dépasserait le plafond de l'action
  | 'unestimable'       // coût non bornable ⇒ refus, jamais autorisation

export interface AcquisitionBudget {
  /** Instant limite ABSOLU, en millisecondes epoch. */
  readonly deadlineAt: number
  /** Temps restant, jamais négatif. */
  remainingMs(): number
  /** Le budget est-il déjà épuisé ? */
  expired(): boolean
  /**
   * Peut-on encore engager une opération dont on estime le coût minimal ?
   * Défaut : `MIN_TRANSPORT_MS`.
   */
  canAfford(costMs?: number): boolean
  /**
   * Plafond à donner à UN transport : le reste du budget, borné par un plafond
   * propre à l'appelant quand il en a un.
   */
  transportTimeoutMs(cap?: number): number

  // ── COMPTEURS AGRÉGÉS ────────────────────────────────────────────────────
  /**
   * Réserve une requête fournisseur ET les usages d'outils qu'elle autorise.
   *
   * ⚠️ RÉSERVE AVANT, PAS APRÈS. On décompte ce que la requête PEUT consommer,
   * pas ce qu'elle a consommé : le fournisseur ne nous dit pas combien de
   * recherches il fera, et l'apprendre après coup n'empêche aucune dépense.
   * La sécurité vient de la réservation, jamais de la comptabilité a posteriori.
   *
   * Rend `null` si tout tient, sinon le motif du refus. Idempotent en cas de
   * refus : rien n'est décompté quand la réponse est un refus.
   */
  reserveCall(o?: { webSearches?: number; webFetches?: number }): BudgetDenial | null
  /** Coût estimé déjà réservé, en µUSD. */
  spentMicros(): bigint
  /**
   * Le coût estimé de la PROCHAINE requête tient-il dans le plafond monétaire ?
   * Rend `null` si oui, sinon le motif.
   */
  reserveMicros(estimate: bigint): BudgetDenial | null
  /** Instantané lisible — télémétrie interne, jamais rendu au navigateur tel quel. */
  snapshot(): {
    providerCalls: number; webSearches: number; webFetches: number
    spentMicros: string; capMicros: string | null
  }
}

/** Plafonds agrégés d'UNE acquisition. */
export interface AcquisitionCaps {
  providerCalls?: number
  webSearches?: number
  webFetches?: number
  /**
   * Plafond monétaire de l'action, en µUSD.
   *
   * ⚠️ `null` N'EST PAS « ILLIMITÉ ». Il signifie « aucun plafond n'a été
   * fourni », et les appelants qui EXIGENT un plafond doivent refuser dans ce
   * cas. On ne fabrique pas ici une permission que personne n'a accordée.
   */
  maxMicros?: bigint | null
}

/**
 * Crée un budget à partir de MAINTENANT.
 *
 * `now` est injectable pour que les tests soient déterministes — jamais pour
 * qu'un appelant de production choisisse son propre temps.
 */
export function startAcquisitionBudget(
  totalMs: number = QUICK_SEARCH_BUDGET_MS,
  now: () => number = Date.now,
  caps: AcquisitionCaps = {},
): AcquisitionBudget {
  // Un budget négatif ou absurde est ramené à zéro : il ferme, il n'ouvre pas.
  const duree = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0
  const deadlineAt = now() + duree

  const remainingMs = () => Math.max(0, deadlineAt - now())

  // ⚠️ ÉTAT MUTABLE, PORTÉ PAR L'OBJET ET PAR LUI SEUL. C'est ce qui fait que
  // les compteurs SURVIVENT aux tours, aux continuations `pause_turn` et aux
  // dégradations HTTP 400 : tous reçoivent LE MÊME budget, jamais une copie.
  let callsUsed = 0
  let searchesUsed = 0
  let fetchesUsed = 0
  let spent = 0n

  const maxCalls = capEntier(caps.providerCalls)
  const maxSearches = capEntier(caps.webSearches)
  const maxFetches = capEntier(caps.webFetches)
  const maxMicros = typeof caps.maxMicros === 'bigint' && caps.maxMicros >= 0n ? caps.maxMicros : null

  return {
    deadlineAt,
    remainingMs,

    reserveCall: (o = {}) => {
      const s = Math.max(0, Math.trunc(o.webSearches || 0))
      const f = Math.max(0, Math.trunc(o.webFetches || 0))

      // Vérifier TOUT avant de décompter QUOI QUE CE SOIT : un refus ne doit
      // pas laisser un compteur à moitié consommé.
      if (maxCalls !== null && callsUsed + 1 > maxCalls) return 'provider_calls'
      if (maxSearches !== null && searchesUsed + s > maxSearches) return 'web_searches'
      if (maxFetches !== null && fetchesUsed + f > maxFetches) return 'web_fetches'

      callsUsed += 1
      searchesUsed += s
      fetchesUsed += f
      return null
    },

    spentMicros: () => spent,

    reserveMicros: (estimate) => {
      // ⚠️ AUCUN PLAFOND FOURNI ⇒ REFUS. « je ne sais pas combien je peux
      // dépenser » ne vaut pas « je peux dépenser autant que je veux ».
      if (maxMicros === null) return 'money'
      const e = typeof estimate === 'bigint' && estimate >= 0n ? estimate : 0n
      if (spent + e > maxMicros) return 'money'
      spent += e
      return null
    },

    snapshot: () => ({
      providerCalls: callsUsed,
      webSearches: searchesUsed,
      webFetches: fetchesUsed,
      spentMicros: spent.toString(),
      capMicros: maxMicros === null ? null : maxMicros.toString(),
    }),

    expired: () => remainingMs() <= 0,
    canAfford: (costMs = MIN_TRANSPORT_MS) => remainingMs() >= costMs,
    transportTimeoutMs: (cap?: number) => {
      const reste = remainingMs()
      // ⚠️ LE PLAFOND DE L'APPELANT NE PEUT QUE RÉDUIRE. Un transport ne
      // s'accorde jamais plus que le budget restant, quel que soit son propre
      // réglage historique : c'est précisément ce qui empêchait les 50 s de
      // `REQUEST_TIMEOUT_MS` de tenir dans une fenêtre de 45 s.
      return typeof cap === 'number' && cap > 0 ? Math.min(reste, cap) : reste
    },
  }
}

/**
 * Budget déjà épuisé — utile aux tests et aux chemins qui doivent refuser.
 *
 * ⚠️ PAS UN « BUDGET INFINI » PAR DÉFAUT. L'absence de budget ne doit jamais se
 * lire comme une autorisation illimitée : les appelants qui n'en fournissent pas
 * conservent leur comportement historique explicitement, ils n'héritent pas
 * d'une permission fabriquée ici.
 */
export function expiredBudget(): AcquisitionBudget {
  return startAcquisitionBudget(0)
}

/** Plafond entier exploitable, ou `null` — jamais une valeur devinée. */
function capEntier(v: number | undefined): number | null {
  return Number.isFinite(v) && (v as number) >= 0 ? Math.trunc(v as number) : null
}
