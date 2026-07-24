// Coffre de clés côté serveur. Priorité : clé saisie dans l'app (runtime) >
// variable d'environnement Vercel. Permet de coller les clés depuis l'Admin
// sans redéployer. ⚠️ Stockage EN MÉMOIRE : réinitialisé à chaque cold start /
// redeploy, non partagé entre instances. Pour du durable → Vercel env ou Supabase.

export const MANAGED_KEYS = [
  'ANTHROPIC_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'PAPPERS_API_KEY', 'UNIPILE_DSN', 'UNIPILE_API_KEY', 'UNIPILE_ACCOUNT_ID', 'SIGNALS_MODEL',
  'APP_PASSWORD', 'APP_TOTP_SECRET', 'APP_MFA_ENABLED', 'PII_MASKING',
] as const
export type ManagedKey = typeof MANAGED_KEYS[number]

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
      for (const [k, v] of Object.entries(rows)) if (v) store.set(k, v)
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

export function setKeys(patch: Record<string, string>) {
  for (const [k, v] of Object.entries(patch)) {
    if (!MANAGED_KEYS.includes(k as ManagedKey)) continue
    const val = (v || '').trim()
    if (val) store.set(k, val)
    else store.delete(k) // valeur vide → efface la clé saisie (retombe sur l'env)
    // write-through vers Supabase (best-effort, non bloquant)
    void persist(k, val)
  }
}

async function persist(key: string, value: string) {
  try {
    const { saveSetting } = await import('../supabase/settings')
    await saveSetting(key, value)
  } catch { /* pas de Supabase → mémoire seulement */ }
}
