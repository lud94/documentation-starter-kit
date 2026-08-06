// Politique d'EGRESS vers une IA externe — décision pure (lot SEC-0d).
//
// ── POURQUOI CE MODULE EXISTE ────────────────────────────────────────────────
// La décision « ai-je le droit de faire sortir ces données ? » vivait dans une
// chaîne de promesses au milieu d'un composant, et elle contenait deux
// fail-open :
//
//   .then((r) => r.json()).then(setPolicy)
//     → un 403 ou un 503 dont le corps est `{ error: … }` devenait un objet de
//       politique ; seule la chance faisait que `allowed` y était `undefined` ;
//   .catch(() => setPolicy({ allowed: true, maskPii: false }))
//     → une erreur réseau AUTORISAIT l'egress, et retirait le masquage.
//
// Sortie ici, la décision devient énumérable et testable exhaustivement. C'est
// la seule partie de ce composant qui a une conséquence de sécurité : la suite
// n'est que du rendu.
//
// ── L'INVARIANT ──────────────────────────────────────────────────────────────
//   `granted` EXIGE une réponse 2xx, un corps objet, et `allowed === true`.
//   Tout le reste refuse : chargement, 403, 503, réseau coupé, JSON illisible,
//   corps nul, `allowed: 'yes'`, `allowed: 1`.
//
//   `maskPii` INCONNU vaut MASQUER. Un nom de personne ne sort jamais parce
//   qu'un champ manquait.

export type ExternalAiPolicy =
  | { state: 'loading' }
  | { state: 'denied' }
  | { state: 'granted'; maskPii: boolean }

export const DENIED: ExternalAiPolicy = { state: 'denied' }
export const LOADING: ExternalAiPolicy = { state: 'loading' }

/**
 * Décide à partir d'un statut HTTP et d'un corps déjà désérialisé.
 * `ok` faux, corps non-objet ou `allowed` non STRICTEMENT `true` ⇒ refus.
 */
export function decideExternalAiPolicy(ok: boolean, body: unknown): ExternalAiPolicy {
  if (!ok) return DENIED
  if (!body || typeof body !== 'object') return DENIED
  const b = body as Record<string, unknown>
  // `=== true` et non `!!` : `'yes'`, `1` et `'false'` sont tous véridiques.
  if (b.allowed !== true) return DENIED
  // Seul `false` explicite désactive le masquage. Absent, nul, illisible ⇒ on
  // masque : c'est le sens le moins coûteux de l'erreur.
  return { state: 'granted', maskPii: b.maskPii !== false }
}

/**
 * Charge la politique. NE LÈVE JAMAIS — toute issue anormale est un refus,
 * jamais une exception qu'un appelant pourrait oublier d'attraper.
 */
export async function loadExternalAiPolicy(
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalAiPolicy> {
  try {
    const r = await fetchImpl('/api/config/external-ai')
    // Le corps est lu DANS le `try` : un JSON malformé sur une réponse 200
    // doit refuser, pas propager.
    const body = await r.json()
    return decideExternalAiPolicy(!!r.ok, body)
  } catch {
    return DENIED
  }
}
