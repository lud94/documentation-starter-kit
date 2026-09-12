// JARVIS-TIME-01 — résolution temporelle déterministe.
//
// Le LLM comprend l'intention, mais il ne décide jamais seul de la date réelle.
// Les expressions temporelles sont résolues côté serveur dans le fuseau métier.
//
// V1 :
// - aujourd'hui
// - demain
// - après-demain
// - dans X jours / semaines
// - lundi ... dimanche
// - lundi prochain ... dimanche prochain
// - heures : 14h, 14h30, 14:30
//
// On conserve une date structurée YYYY-MM-DD + une heure optionnelle afin de ne
// pas dépendre d'un simple libellé d'interface pour les futurs rappels réels.

export const DEFAULT_TIME_ZONE = 'Europe/Paris'

export interface TimeResolution {
  /** Libellé destiné à l'interface. */
  due: string

  /** Date civile dans le fuseau métier. */
  dueDate: string

  /** Heure locale HH:mm, ou null si aucune heure n'a été demandée. */
  dueTime: string | null

  timeZone: string

  /** Une expression temporelle a réellement été trouvée dans la directive. */
  matched: boolean
}

interface CalendarDate {
  year: number
  month: number
  day: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
}

const WEEKDAY_LABEL = [
  'Dim.',
  'Lun.',
  'Mar.',
  'Mer.',
  'Jeu.',
  'Ven.',
  'Sam.',
]

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
}

function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/’/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function toIsoDate(date: CalendarDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`
}

function toUtcCalendarDate(date: CalendarDate): Date {
  return new Date(
    Date.UTC(
      date.year,
      date.month - 1,
      date.day,
      12,
      0,
      0,
    ),
  )
}

function shiftCalendarDate(
  date: CalendarDate,
  days: number,
): CalendarDate {
  const d = toUtcCalendarDate(date)
  d.setUTCDate(d.getUTCDate() + days)

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  }
}

function weekdayOf(date: CalendarDate): number {
  return toUtcCalendarDate(date).getUTCDay()
}

function dateDiffDays(
  from: CalendarDate,
  to: CalendarDate,
): number {
  const ms =
    toUtcCalendarDate(to).getTime() -
    toUtcCalendarDate(from).getTime()

  return Math.round(ms / 86_400_000)
}

function calendarDateInTimeZone(
  now: Date,
  timeZone: string,
): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(
      parts.find((part) => part.type === type)?.value || 0,
    )

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
  }
}

function parseQuantity(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  return NUMBER_WORDS[value] ?? null
}

function extractTime(text: string): string | null {
  const match = text.match(
    /\b(?:a\s+)?([01]?\d|2[0-3])(?:h([0-5]\d)?|:([0-5]\d))\b/,
  )

  if (!match) return null

  const hour = Number(match[1])
  const minute = Number(match[2] ?? match[3] ?? 0)

  return `${pad2(hour)}:${pad2(minute)}`
}

function formatDueLabel(
  base: CalendarDate,
  target: CalendarDate,
  dueTime: string | null,
): string {
  const delta = dateDiffDays(base, target)

  let label: string

  if (delta === 0) {
    label = "Aujourd'hui"
  } else if (delta === 1) {
    label = 'Demain'
  } else {
    label =
      `${WEEKDAY_LABEL[weekdayOf(target)]} ` +
      `${pad2(target.day)}/${pad2(target.month)}`
  }

  if (!dueTime) return label

  const [hour, minute] = dueTime.split(':')

  return `${label} · ${hour}h${minute}`
}

export function resolveTimeExpression(
  directive: string,
  options: {
    now?: Date
    timeZone?: string
  } = {},
): TimeResolution {
  const now = options.now ?? new Date()
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  const text = normalizeText(directive)

  const base = calendarDateInTimeZone(now, timeZone)

  let target = base
  let dateMatched = false

  if (/\bapres[- ]demain\b/.test(text)) {
    target = shiftCalendarDate(base, 2)
    dateMatched = true
  } else if (/\bdemain\b/.test(text)) {
    target = shiftCalendarDate(base, 1)
    dateMatched = true
  } else if (/\baujourd[' ]?hui\b/.test(text)) {
    target = base
    dateMatched = true
  } else {
    const relative = text.match(
      /\bdans\s+(\d{1,3}|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(jour|jours|semaine|semaines)\b/,
    )

    if (relative) {
      const quantity = parseQuantity(relative[1])

      if (quantity !== null) {
        const multiplier =
          relative[2].startsWith('semaine') ? 7 : 1

        target = shiftCalendarDate(
          base,
          quantity * multiplier,
        )

        dateMatched = true
      }
    }
  }

  if (!dateMatched) {
    const weekday = text.match(
      /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+(prochain|prochaine))?\b/,
    )

    if (weekday) {
      const wanted = WEEKDAY_INDEX[weekday[1]]
      const current = weekdayOf(base)

      let delta = (wanted - current + 7) % 7

      // "lundi" un lundi peut signifier aujourd'hui.
      // "lundi prochain" un lundi signifie explicitement J+7.
      if (weekday[2] && delta === 0) {
        delta = 7
      }

      target = shiftCalendarDate(base, delta)
      dateMatched = true
    }
  }

  const dueTime = extractTime(text)

  return {
    due: formatDueLabel(
      base,
      target,
      dueTime,
    ),
    dueDate: toIsoDate(target),
    dueTime,
    timeZone,
    matched: dateMatched || dueTime !== null,
  }
}