// Client Supabase côté serveur (service role — jamais exposé au navigateur).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY se posent en variables Vercel :
// ce sont les clés qui persistent tout le reste, elles ne peuvent pas vivre
// dans la base qu'elles servent à joindre (poule/œuf) → env uniquement.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

export function supabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function supabase(): SupabaseClient | null {
  if (!supabaseConfigured()) return null
  if (cached) return cached
  cached = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
