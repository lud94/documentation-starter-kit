import type { NextApiRequest, NextApiResponse } from 'next'
import { hasKey, keySource } from '../../../lib/prospector/keystore'

// Renvoie UNIQUEMENT des booléens/source : quelles clés sont configurées.
// Ne renvoie JAMAIS la valeur d'un secret.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
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
    ],
    signalsMode: hasKey('ANTHROPIC_API_KEY') && hasKey('EXA_API_KEY') ? 'exa+claude'
      : hasKey('ANTHROPIC_API_KEY') ? 'claude-web' : 'mock',
  })
}
