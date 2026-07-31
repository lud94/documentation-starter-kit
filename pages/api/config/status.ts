import type { NextApiRequest, NextApiResponse } from 'next'
import { hasKey, keySource, hydrateKeystore } from '../../../lib/prospector/keystore'
import { supabaseConfigured } from '../../../lib/supabase/client'
import { envSummary } from '../../../lib/env'
import { readSession, SESSION_COOKIE } from '../../../lib/auth/session'

// Renvoie UNIQUEMENT des booléens/source : quelles clés sont configurées.
// Ne renvoie JAMAIS la valeur d'un secret.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Réservé aux administrateurs : la liste des connecteurs configurés et l'état
  // d'environnement renseignent sur l'infrastructure. Aucune valeur de secret
  // n'est renvoyée — uniquement des booléens et des identifiants publics.
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])
  if (claims && claims.role && claims.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs.' })
  await hydrateKeystore()
  const row = (key: string, label: string) => ({ key, label, set: hasKey(key), source: keySource(key) })
  res.status(200).json({
    keys: [
      row('ANTHROPIC_API_KEY', 'Claude (cerveau : extraction + icebreaker)'),
      row('EXA_API_KEY', 'Exa (capteur : recherche de signaux)'),
      row('PERPLEXITY_API_KEY', 'Perplexity (Q&A web — optionnel)'),
      row('OPENAI_API_KEY', 'OpenAI / ChatGPT (fallback + images)'),
      row('GEMINI_API_KEY', 'Gemini (images + OCR docs)'),
      row('PAPPERS_API_KEY', 'Pappers (dirigeants / fondateurs)'),
      row('UNIPILE_DSN', 'Unipile DSN'),
      row('UNIPILE_API_KEY', 'Unipile API key'),
      row('UNIPILE_ACCOUNT_ID', 'Unipile compte LinkedIn lié'),
      row('INGEST_TOKEN', 'Extension Jarvis (jeton d\'ingestion)'),
    ],
    signalsMode: hasKey('ANTHROPIC_API_KEY') && hasKey('EXA_API_KEY') ? 'exa+claude'
      : hasKey('ANTHROPIC_API_KEY') ? 'claude-web' : 'mock',
    persistence: supabaseConfigured() ? 'supabase' : 'memory',
    environment: envSummary(),
  })
}
