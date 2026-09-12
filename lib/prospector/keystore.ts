// Coffre de clés côté serveur. Priorité : clé saisie dans l'app (runtime) >
// variable d'environnement Vercel. Permet de coller les clés depuis l'Admin
// sans redéployer. ⚠️ Stockage EN MÉMOIRE : réinitialisé à chaque cold start /
// redeploy, non partagé entre instances. Pour du durable → Vercel env ou Supabase.

export const MANAGED_KEYS = [
  'ANTHROPIC_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'PAPPERS_API_KEY', 'UNIPILE_DSN', 'UNIPILE_API_KEY', 'UNIPILE_ACCOUNT_ID', 'SIGNALS_MODEL',
  'APP_EMAIL', 'APP_PASSWORD', 'APP_TOTP_SECRET', 'APP_MFA_ENABLED', 'PII_MASKING',
  // `APP_RESET_TOKEN` (jeton PORTEUR en clair) n'est plus jamais écrit ni lu
  // pour valider — voir lib/prospector/auth.ts. Il reste déclaré ici pour une
  // seule raison : `setKeys` ignore les clés non gérées, et il faut pouvoir
  // ÉCRASER l'ancien artefact là où il traîne encore.
  'APP_RESET_TOKEN', 'APP_RESET_TOKEN_HASH', 'APP_RESET_EXP', 'INGEST_TOKEN', 'ANTHROPIC_BUDGET',
  // Modèles par tâche (surcharge des défauts économiques) — maîtrise des coûts.
  'JARVIS_MODEL', 'PLAN_MODEL', 'ENRICH_MODEL', 'WRITE_MODEL',
  // Canal mobile Telegram (Jarvis nomade).
  'TELEGRAM_BOT_NAME',
] as const
export type ManagedKey = typeof MANAGED_KEYS[number]

/**
 * CE NOM PEUT-IL VENIR DE LA BASE ? — frontière d'autorité (lot 0C.0.3).
 *
 * ── LE DÉFAUT FERMÉ ─────────────────────────────────────────────────────────
 * `MANAGED_KEYS` ne filtrait que l'ÉCRITURE. `hydrateKeystore()` chargeait
 * TOUTES les lignes de `prospector_settings` dans le magasin mémoire, sans
 * regarder cette liste — et `getKey` sert ensuite ce magasin AVANT
 * `process.env`. Autrement dit : l'application refusait d'écrire un nom non
 * géré, mais acceptait de le LIRE s'il apparaissait en base.
 *
 * Insérer une ligne suffisait donc à créer une autorité que le code n'avait
 * jamais prévue. Trois valeurs étaient concernées, toutes critiques en
 * INTÉGRITÉ et toutes supposées venir de l'environnement seul :
 *
 *   • `EXTENSION_ORIGINS`   — l'allowlist CORS de l'extension. Une ligne en
 *                             base élargissait les origines autorisées ;
 *   • `AI_BUDGET_RESERVATION` et `AI_BUDGET_OBSERVE_LIMIT` — le mode et le
 *                             plafond du garde budgétaire.
 *
 * (`APP_SESSION_SECRET` relevait de la même classe ; il a été traité à la
 * source en 0C.0.1 — `wstoken.ts` ne consulte plus ce magasin du tout.)
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────
 * DB-CAPABLE = présent dans `MANAGED_KEYS`. Tout le reste est ENV-ONLY : une
 * ligne de base portant ce nom est IGNORÉE, silencieusement et par principe.
 * « Ajouter une ligne en base » n'est pas « ajouter une configuration
 * autorisée » — et c'est le code, pas la base, qui décide ce qui fait autorité.
 *
 * ⚠️ UNE SEULE NOMENCLATURE, utilisée par la LECTURE comme par l'ÉCRITURE.
 * Deux listes finiraient par diverger, et la divergence rouvrirait exactement
 * ce trou. Ajouter un nom ici, c'est ouvrir un chemin depuis la base : cela se
 * décide en revue, jamais pour faire passer un test.
 */
export function isManagedKey(name: string): name is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(name)
}

// Persiste sur le globalThis pour survivre au hot-reload de Next en dev.
const g = globalThis as any
const store: Map<string, string> = g.__prospectorKeys || (g.__prospectorKeys = new Map())

export function getKey(name: string): string | undefined {
  return store.get(name) || process.env[name] || undefined
}

// Hydrate le store mémoire depuis Supabase (une seule fois par instance).
// À `await` en tête des routes API qui lisent des clés, pour la durabilité.
export async function hydrateKeystore(): Promise<void> {
  if (g.__prospectorHydrated) return g.__prospectorHydrated
  g.__prospectorHydrated = (async () => {
    try {
      const { loadAllSettings } = await import('../supabase/settings')
      const rows = await loadAllSettings()
      // ⚠️ FILTRE D'AUTORITÉ (lot 0C.0.3) : seuls les noms DB-capables entrent
      // en mémoire. Une ligne hors nomenclature est ignorée — ni chargée, ni
      // signalée, ni journalisée : sa valeur ne doit apparaître nulle part.
      for (const [k, v] of Object.entries(rows)) if (v && isManagedKey(k)) store.set(k, v)
    } catch { /* Supabase absent → on garde la mémoire */ }
  })()
  return g.__prospectorHydrated
}

export function hasKey(name: string): boolean {
  return !!getKey(name)
}

// 'app' = saisie dans la plateforme · 'env' = variable Vercel · null = absente.
export function keySource(name: string): 'app' | 'env' | null {
  if (store.has(name)) return 'app'
  if (process.env[name]) return 'env'
  return null
}

// ⚠️ ASYNC : on ATTEND l'écriture Supabase avant de rendre la main. Sur Vercel
// (serverless), la fonction est gelée après la réponse → un write non attendu
// serait tué avant de finir. Les appelants (routes API) doivent `await`.
export async function setKeys(patch: Record<string, string>): Promise<void> {
  const writes: Promise<void>[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (!isManagedKey(k)) continue        // même nomenclature qu'à l'hydratation
    const val = (v || '').trim()
    if (val) store.set(k, val)
    else store.delete(k) // valeur vide → efface la clé saisie (retombe sur l'env)
    writes.push(persist(k, val))
  }
  await Promise.all(writes)
}

async function persist(key: string, value: string) {
  try {
    const { saveSetting } = await import('../supabase/settings')
    await saveSetting(key, value)
  } catch { /* pas de Supabase → mémoire seulement */ }
}
