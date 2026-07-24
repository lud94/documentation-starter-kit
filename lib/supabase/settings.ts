// Persistance clé/valeur des réglages (clés API, hash mot de passe, secret MFA…).
// Table `prospector_settings (key text primary key, value text, updated_at timestamptz)`.
// Repli silencieux si Supabase non configuré ou en erreur → le keystore mémoire prend le relais.
import { supabase, supabaseConfigured } from './client'

const TABLE = 'prospector_settings'

export async function loadAllSettings(): Promise<Record<string, string>> {
  const sb = supabase()
  if (!sb) return {}
  try {
    const { data, error } = await sb.from(TABLE).select('key, value')
    if (error || !data) return {}
    const out: Record<string, string> = {}
    for (const row of data) if (row.key) out[row.key] = row.value ?? ''
    return out
  } catch {
    return {}
  }
}

export async function saveSetting(key: string, value: string): Promise<boolean> {
  const sb = supabase()
  if (!sb) return false
  try {
    const { error } = await sb.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    return !error
  } catch {
    return false
  }
}

export { supabaseConfigured }
