// JARVIS-ENTITY-01A — résolution déterministe des entités Prospector.
//
// Objectifs :
// - accents, casse, espaces, tirets et ponctuation ne doivent pas bloquer ;
// - une faute légère peut produire une correspondance PROBABLE ;
// - une correspondance probable n'autorise JAMAIS seule une mutation ;
// - plusieurs candidats proches => ambiguïté, jamais de choix arbitraire ;
// - aucune dépendance au LLM : le résultat est reproductible et testable.

import { isAccountLead } from './leadKind'
import type { Lead } from '../../types/prospector'

export const ENTITY_PROBABLE_MIN_SCORE = 0.84
export const ENTITY_AMBIGUOUS_GAP = 0.05

export type EntityPreference = 'any' | 'contact' | 'account'

export interface EntityCandidate {
  lead: Lead
  score: number
  matchedAlias: string
}

export type EntityResolution =
  | {
      kind: 'exact'
      candidate: EntityCandidate
    }
  | {
      kind: 'probable'
      candidate: EntityCandidate
    }
  | {
      kind: 'ambiguous'
      candidates: EntityCandidate[]
    }
  | {
      kind: 'not_found'
      candidates: EntityCandidate[]
    }

/**
 * Forme canonique destinée à la comparaison.
 *
 * Exemples :
 *   "Séverine GABAY"  -> "severine gabay"
 *   "Severine-Gabay"  -> "severine gabay"
 *   "  SÉVERINE   "   -> "severine"
 */
export function normalizeEntityText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Même forme, sans séparateur.
 *
 * Permet notamment :
 *   "SeverineGABAY" === "Severine GABAY"
 */
export function compactEntityText(value: unknown): string {
  return normalizeEntityText(value).replace(/\s+/g, '')
}

function tokens(value: unknown): string[] {
  return normalizeEntityText(value)
    .split(' ')
    .filter(Boolean)
}

/**
 * Libellé lisible par l'utilisateur.
 */
export function entityLabel(lead: Lead): string {
  const person = `${lead.firstName || ''} ${lead.lastName || ''}`.trim()

  if (person && lead.company) {
    return `${person} — ${lead.company}`
  }

  return person || lead.company || lead.id
}

/**
 * Alias déterministes d'un lead.
 *
 * Un contact peut être retrouvé par :
 * - prénom + nom ;
 * - nom + prénom ;
 * - nom seul ;
 * - prénom seul.
 *
 * L'entreprise reste aussi un alias, mais plusieurs contacts d'une même
 * société produiront naturellement une ambiguïté au lieu d'un choix arbitraire.
 */
export function entityAliases(lead: Lead): string[] {
  const first = String(lead.firstName || '').trim()
  const last = String(lead.lastName || '').trim()
  const company = String(lead.company || '').trim()

  const values = new Set<string>()

  if (first && last) {
    values.add(`${first} ${last}`)
    values.add(`${last} ${first}`)
  }

  if (first) values.add(first)
  if (last) values.add(last)
  if (company && company !== '—') values.add(company)

  const full = `${first} ${last}`.trim()

  if (full && company && company !== '—') {
    values.add(`${full} ${company}`)
  }

  return Array.from(values)
}

/**
 * Distance de Levenshtein classique.
 *
 * Elle mesure le nombre minimum d'insertions, suppressions ou substitutions
 * nécessaires pour passer d'une chaîne à l'autre.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let previous = Array.from(
    { length: b.length + 1 },
    (_, i) => i,
  )

  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1)
    current[0] = i

    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1

      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      )
    }

    previous = current
  }

  return previous[b.length]
}

export function levenshteinSimilarity(a: string, b: string): number {
  const left = normalizeEntityText(a)
  const right = normalizeEntityText(b)

  if (!left || !right) return 0
  if (left === right) return 1

  const longest = Math.max(left.length, right.length)

  return 1 - levenshteinDistance(left, right) / longest
}

/**
 * Similarité Dice sur les bigrammes.
 *
 * Complète Levenshtein sur certaines petites fautes / inversions sans appeler
 * de modèle externe.
 */
export function diceSimilarity(a: string, b: string): number {
  const left = compactEntityText(a)
  const right = compactEntityText(b)

  if (!left || !right) return 0
  if (left === right) return 1

  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0
  }

  const leftPairs = new Map<string, number>()

  for (let i = 0; i < left.length - 1; i++) {
    const pair = left.slice(i, i + 2)
    leftPairs.set(pair, (leftPairs.get(pair) || 0) + 1)
  }

  let intersection = 0

  for (let i = 0; i < right.length - 1; i++) {
    const pair = right.slice(i, i + 2)
    const count = leftPairs.get(pair) || 0

    if (count > 0) {
      intersection++
      leftPairs.set(pair, count - 1)
    }
  }

  return (
    (2 * intersection) /
    ((left.length - 1) + (right.length - 1))
  )
}

/**
 * Score d'un texte utilisateur contre un alias.
 *
 * 1.00 :
 *   égalité après normalisation, ou après retrait des espaces.
 *
 * 0.93 :
 *   tous les mots saisis sont présents comme mots entiers dans l'alias.
 *   Exemple "Redsen" contre "REDSEN FRANCE".
 *
 * Sinon :
 *   meilleur score entre Levenshtein et Dice.
 */
export function entitySimilarity(query: string, alias: string): number {
  const q = normalizeEntityText(query)
  const a = normalizeEntityText(alias)

  if (!q || !a) return 0

  if (q === a || compactEntityText(q) === compactEntityText(a)) {
    return 1
  }

  const qTokens = tokens(q)
  const aTokens = new Set(tokens(a))

  if (
    qTokens.length > 0 &&
    qTokens.every((token) => token.length >= 2 && aTokens.has(token))
  ) {
    return 0.93
  }

  return Math.max(
    levenshteinSimilarity(q, a),
    diceSimilarity(q, a),
  )
}

function candidateFor(
  lead: Lead,
  query: string,
): EntityCandidate {
  let score = 0
  let matchedAlias = ''

  for (const alias of entityAliases(lead)) {
    const current = entitySimilarity(query, alias)

    if (current > score) {
      score = current
      matchedAlias = alias
    }
  }

  return {
    lead,
    score,
    matchedAlias,
  }
}

/**
 * Résout une saisie utilisateur contre les leads déjà présents dans le
 * workspace fourni par l'appelant.
 *
 * IMPORTANT :
 * ce module ne charge PAS lui-même la base et ne mute RIEN.
 * Le workspace reste donc contrôlé par la couche serveur existante.
 */
export function resolveLeadEntity(
  leads: Lead[],
  query: string,
  preference: EntityPreference = 'any',
): EntityResolution {
  const normalizedQuery = normalizeEntityText(query)

  if (!normalizedQuery) {
    return {
      kind: 'not_found',
      candidates: [],
    }
  }

  const eligible = leads.filter((lead) => {
    if (preference === 'any') return true
    // ⚠️ CLASSIFICATION CANONIQUE, JAMAIS LOCALE. Ce module possédait son propre
    // `isAccount(lead)` = `kind === 'account' || aucun nom`. Il OMETTAIT le
    // court-circuit `kind === 'contact'` — le défaut exact que `leadKind.ts` a
    // été écrit pour supprimer, et qui survivait ici. Conséquence réelle : un
    // lead DÉCLARÉ contact mais sans prénom ni nom — forme que
    // `addLeadsFromCsv` produit — était éligible sous `preference: 'account'`,
    // et exclu sous `preference: 'contact'`. La déclaration de l'utilisateur
    // était contredite sur les deux préférences à la fois.
    if (preference === 'account') return isAccountLead(lead)
    return !isAccountLead(lead)
  })

  const ranked = eligible
    .map((lead) => candidateFor(lead, query))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  const exact = ranked.filter(
    (candidate) => candidate.score === 1,
  )

  if (exact.length === 1) {
    return {
      kind: 'exact',
      candidate: exact[0],
    }
  }

  if (exact.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: exact.slice(0, 5),
    }
  }

  const best = ranked[0]

  if (!best || best.score < ENTITY_PROBABLE_MIN_SCORE) {
    return {
      kind: 'not_found',
      candidates: ranked.slice(0, 3),
    }
  }

  const second = ranked[1]

  if (
    second &&
    second.score >= ENTITY_PROBABLE_MIN_SCORE &&
    best.score - second.score < ENTITY_AMBIGUOUS_GAP
  ) {
    return {
      kind: 'ambiguous',
      candidates: ranked
        .filter(
          (candidate) =>
            candidate.score >= ENTITY_PROBABLE_MIN_SCORE &&
            best.score - candidate.score < ENTITY_AMBIGUOUS_GAP,
        )
        .slice(0, 5),
    }
  }

  return {
    kind: 'probable',
    candidate: best,
  }
}