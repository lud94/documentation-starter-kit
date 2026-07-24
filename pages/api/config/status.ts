import type { NextApiRequest, NextApiResponse } from 'next'

// Renvoie UNIQUEMENT des booléens : quelles clés sont configurées côté serveur.
// Ne renvoie JAMAIS la valeur d'un secret. Les clés se posent dans Vercel (env),
// jamais saisies dans le navigateur.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const has = (k: string) => !!process.env[k]
  res.status(200).json({
    keys: [
      { key: 'ANTHROPIC_API_KEY', label: 'Claude (cerveau : extraction + icebreaker)', set: has('ANTHROPIC_API_KEY') },
      { key: 'EXA_API_KEY', label: 'Exa (capteur : recherche de signaux)', set: has('EXA_API_KEY') },
      { key: 'PAPPERS_API_KEY', label: 'Pappers (dirigeants / fondateurs)', set: has('PAPPERS_API_KEY') },
      { key: 'UNIPILE_DSN', label: 'Unipile DSN', set: has('UNIPILE_DSN') },
      { key: 'UNIPILE_API_KEY', label: 'Unipile API key', set: has('UNIPILE_API_KEY') },
      { key: 'UNIPILE_ACCOUNT_ID', label: 'Unipile compte LinkedIn lié', set: has('UNIPILE_ACCOUNT_ID') },
    ],
    signalsMode: has('ANTHROPIC_API_KEY') && has('EXA_API_KEY') ? 'exa+claude'
      : has('ANTHROPIC_API_KEY') ? 'claude-web' : 'mock',
  })
}
