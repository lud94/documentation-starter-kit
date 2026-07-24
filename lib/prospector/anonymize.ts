// Couche DLP — anonymisation des PII avant envoi à un LLM.
// Remplace emails / téléphones / IBAN / SIREN-SIRET (+ termes fournis, ex. noms)
// par des jetons réversibles ([EMAIL_1]…). On envoie le texte masqué au LLM,
// puis on ré-injecte les vraies valeurs dans la réponse via unmask().
//
// ⚠️ À activer par CONTEXTE : utile pour extraire/résumer des docs sensibles,
// à désactiver pour la rédaction d'accroche (qui a besoin du vrai nom).

export interface MaskResult { masked: string; map: Record<string, string> }

interface Rule { label: string; re: RegExp }

// Ordre important : IBAN avant les nombres, email avant tout.
const RULES: Rule[] = [
  { label: 'EMAIL', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g },
  { label: 'TEL', re: /(?:\+33|0)\s*[1-9](?:[\s.\-]*\d{2}){4}/g },
  { label: 'SIRET', re: /\b\d{14}\b/g },
  { label: 'SIREN', re: /\b\d{9}\b/g },
]

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// termes : valeurs exactes à masquer en priorité (noms de personnes connus, etc.)
export function maskPII(text: string, terms: string[] = []): MaskResult {
  const map: Record<string, string> = {}
  const counters: Record<string, number> = {}
  let out = text || ''

  const put = (label: string, value: string): string => {
    // réutilise le même jeton pour une même valeur
    const existing = Object.entries(map).find(([, v]) => v === value)
    if (existing) return existing[0]
    counters[label] = (counters[label] || 0) + 1
    const token = `[${label}_${counters[label]}]`
    map[token] = value
    return token
  }

  // 1) termes explicites (noms) — les plus longs d'abord pour éviter les sous-chaînes
  for (const term of [...terms].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(term), 'g'), (m) => put('NOM', m))
  }

  // 2) motifs structurés
  for (const { label, re } of RULES) {
    out = out.replace(re, (m) => put(label, m))
  }

  return { masked: out, map }
}

// Ré-injecte les valeurs réelles dans un texte (réponse du LLM).
export function unmaskPII(text: string, map: Record<string, string>): string {
  let out = text || ''
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value)
  }
  return out
}

// Compte les PII détectées (pour l'affichage / audit).
export function countPII(map: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const token of Object.keys(map)) {
    const label = token.replace(/^\[|_\d+\]$/g, '')
    counts[label] = (counts[label] || 0) + 1
  }
  return counts
}
