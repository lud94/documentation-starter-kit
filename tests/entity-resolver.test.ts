import { describe, expect, it } from 'vitest'

import {
  compactEntityText,
  entityLabel,
  entitySimilarity,
  normalizeEntityText,
  resolveLeadEntity,
} from '../lib/prospector/entityResolver'

import type { Lead } from '../types/prospector'

function contact(
  id: string,
  firstName: string,
  lastName: string,
  company: string,
): Lead {
  return {
    id,
    kind: 'contact',
    firstName,
    lastName,
    company,
    title: 'À qualifier',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: null,
    phone: null,
  }
}

function account(
  id: string,
  company: string,
): Lead {
  return {
    id,
    kind: 'account',
    firstName: '',
    lastName: '',
    company,
    title: '',
    score: 0,
    temperature: 'warm',
    status: 'froid',
    stage: 'to_invite',
    email: null,
    phone: null,
  }
}

const severine = contact(
  'ld_g1z77zvy',
  'Severine',
  'GABAY',
  'REDSEN FRANCE',
)

// ═════════════════════════════════════════════════════════════════════════════
// Normalisation
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01A — normalisation', () => {
  it('ignore les accents et la casse', () => {
    expect(
      normalizeEntityText('Séverine GABAY'),
    ).toBe('severine gabay')

    expect(
      normalizeEntityText('SEVERINE gabay'),
    ).toBe('severine gabay')
  })

  it('normalise espaces, tirets et ponctuation', () => {
    expect(
      normalizeEntityText('  Severine---GABAY  '),
    ).toBe('severine gabay')
  })

  it('la forme compacte ignore les séparateurs', () => {
    expect(
      compactEntityText('Séverine GABAY'),
    ).toBe('severinegabay')

    expect(
      compactEntityText('SeverineGABAY'),
    ).toBe('severinegabay')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Correspondances exactes
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01A — correspondances exactes', () => {
  it('retrouve Severine GABAY exactement', () => {
    const result = resolveLeadEntity(
      [severine],
      'Severine GABAY',
      'contact',
    )

    expect(result.kind).toBe('exact')

    if (result.kind === 'exact') {
      expect(result.candidate.lead.id).toBe('ld_g1z77zvy')
      expect(result.candidate.score).toBe(1)
    }
  })

  it('Séverine avec accent reste une correspondance exacte', () => {
    const result = resolveLeadEntity(
      [severine],
      'Séverine GABAY',
      'contact',
    )

    expect(result.kind).toBe('exact')

    if (result.kind === 'exact') {
      expect(result.candidate.lead.id).toBe('ld_g1z77zvy')
    }
  })

  it('SeverineGABAY sans espace reste une correspondance exacte', () => {
    const result = resolveLeadEntity(
      [severine],
      'SeverineGABAY',
      'contact',
    )

    expect(result.kind).toBe('exact')

    if (result.kind === 'exact') {
      expect(result.candidate.lead.id).toBe('ld_g1z77zvy')
    }
  })

  it('nom + prénom inversés restent une correspondance exacte', () => {
    const result = resolveLeadEntity(
      [severine],
      'GABAY Severine',
      'contact',
    )

    expect(result.kind).toBe('exact')

    if (result.kind === 'exact') {
      expect(result.candidate.lead.id).toBe('ld_g1z77zvy')
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Fuzzy matching contrôlé
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01A — fuzzy matching contrôlé', () => {
  it('Severine Gabet devient PROBABLE, jamais exact', () => {
    const result = resolveLeadEntity(
      [severine],
      'Severine Gabet',
      'contact',
    )

    expect(result.kind).toBe('probable')

    if (result.kind === 'probable') {
      expect(result.candidate.lead.id).toBe('ld_g1z77zvy')
      expect(result.candidate.score).toBeGreaterThanOrEqual(0.84)
      expect(result.candidate.score).toBeLessThan(1)
    }
  })

  it('une saisie très éloignée est NOT_FOUND', () => {
    const result = resolveLeadEntity(
      [severine],
      'Marie Dupont',
      'contact',
    )

    expect(result.kind).toBe('not_found')
  })

  it('deux homonymes exacts produisent une ambiguïté', () => {
    const other = contact(
      'ld_other',
      'Severine',
      'GABAY',
      'AUTRE SOCIETE',
    )

    const result = resolveLeadEntity(
      [severine, other],
      'Séverine Gabay',
      'contact',
    )

    expect(result.kind).toBe('ambiguous')

    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)

      expect(
        result.candidates.map((candidate) => candidate.lead.id),
      ).toEqual(
        expect.arrayContaining([
          'ld_g1z77zvy',
          'ld_other',
        ]),
      )
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Entreprises
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01A — comptes / entreprises', () => {
  it('REDSEN FRANCE est retrouvé exactement comme compte', () => {
    const redsen = account(
      'ld_redsen',
      'REDSEN FRANCE',
    )

    const result = resolveLeadEntity(
      [redsen],
      'Redsen France',
      'account',
    )

    expect(result.kind).toBe('exact')

    if (result.kind === 'exact') {
      expect(result.candidate.lead.id).toBe('ld_redsen')
    }
  })

  it('Redsen seul est une correspondance probable avec REDSEN FRANCE', () => {
    const redsen = account(
      'ld_redsen',
      'REDSEN FRANCE',
    )

    const result = resolveLeadEntity(
      [redsen],
      'Redsen',
      'account',
    )

    expect(result.kind).toBe('probable')

    if (result.kind === 'probable') {
      expect(result.candidate.lead.id).toBe('ld_redsen')
      expect(result.candidate.score).toBe(0.93)
    }
  })

  it('la préférence contact empêche de sélectionner un compte', () => {
    const redsen = account(
      'ld_redsen',
      'REDSEN FRANCE',
    )

    const result = resolveLeadEntity(
      [redsen],
      'Redsen France',
      'contact',
    )

    expect(result.kind).toBe('not_found')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Présentation utilisateur
// ═════════════════════════════════════════════════════════════════════════════

describe('JARVIS-ENTITY-01A — libellé utilisateur', () => {
  it('présente personne + entreprise pour lever les ambiguïtés', () => {
    expect(
      entityLabel(severine),
    ).toBe('Severine GABAY — REDSEN FRANCE')
  })

  it('le score direct confirme le cas réel Severine Gabet / Severine GABAY', () => {
    const score = entitySimilarity(
      'Severine Gabet',
      'Severine GABAY',
    )

    expect(score).toBeGreaterThanOrEqual(0.84)
    expect(score).toBeLessThan(1)
  })
})