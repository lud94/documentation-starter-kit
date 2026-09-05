export type ReminderPriority = 'normal' | 'important'

function normalizePriorityText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const IMPORTANT_PATTERNS: RegExp[] = [
  /\b(?:urgent|urgente|urgemment|prioritaire|critique|imperativement)\b/,
  /\bsans faute\b/,
  /\b(?:rappel|tache|notification)\s+(?:tres\s+)?important(?:e)?\b/,
  /\b(?:ce|cet|cette)\s+(?:rappel|tache|notification)\s+est\s+(?:tres\s+)?important(?:e)?\b/,
  /\b(?:c est|cela est|ca est)\s+(?:tres\s+)?important(?:e)?\b/,
]

export function resolveReminderPriority(message: string): ReminderPriority {
  const normalized = normalizePriorityText(message)

  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(normalized))
    ? 'important'
    : 'normal'
}
