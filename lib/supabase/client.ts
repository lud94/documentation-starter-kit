// Client Supabase côté serveur (service role — jamais exposé au navigateur).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY se posent en variables Vercel :
// ce sont les clés qui persistent tout le reste, elles ne peuvent pas vivre
// dans la base qu'elles servent à joindre (poule/œuf) → env uniquement.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

// Tolérant sur les noms de variables (selon comment elles ont été saisies dans Vercel).
function url(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_PROJECT_URL
}
function serviceKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY || process.env.SERVICE_ROLE_KEY
    || process.env.service_role || process.env.SERVICE_ROLE
}

export function supabaseConfigured(): boolean {
  return !!(url() && serviceKey())
}

export function supabase(): SupabaseClient | null {
  if (!supabaseConfigured()) return null
  if (cached) return cached
  cached = createClient(url()!, serviceKey()!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
