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
): AcquisitionBudget {
  // Un budget négatif ou absurde est ramené à zéro : il ferme, il n'ouvre pas.
  const duree = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0
  const deadlineAt = now() + duree

  const remainingMs = () => Math.max(0, deadlineAt - now())

  return {
    deadlineAt,
    remainingMs,
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
