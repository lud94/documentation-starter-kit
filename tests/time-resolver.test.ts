import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIME_ZONE,
  resolveTimeExpression,
} from '../lib/prospector/timeResolver'

const MONDAY =
  new Date('2026-08-17T08:00:00.000Z')
// 10:00 à Paris, lundi 17 août 2026.

describe('JARVIS-TIME-01 — time resolver', () => {
  it("résout aujourd'hui", () => {
    const r = resolveTimeExpression(
      "Rappelle-moi aujourd'hui",
      { now: MONDAY },
    )

    expect(r).toEqual({
      due: "Aujourd'hui",
      dueDate: '2026-08-17',
      dueTime: null,
      timeZone: DEFAULT_TIME_ZONE,
      matched: true,
    })
  })

  it('résout demain', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi demain',
      { now: MONDAY },
    )

    expect(r.due).toBe('Demain')
    expect(r.dueDate).toBe('2026-08-18')
    expect(r.matched).toBe(true)
  })

  it('résout après-demain', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi après-demain',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-19')
  })

  it('résout dans 3 jours', () => {
    const r = resolveTimeExpression(
      'Relance-la dans 3 jours',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-20')
    expect(r.due).toBe('Jeu. 20/08')
  })

  it('résout les nombres écrits en lettres', () => {
    const r = resolveTimeExpression(
      'Relance-la dans deux semaines',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-31')
  })

  it('résout un jour de semaine', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi vendredi',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-21')
    expect(r.due).toBe('Ven. 21/08')
  })

  it('lundi prochain depuis un lundi signifie J+7', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi lundi prochain',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-24')
    expect(r.due).toBe('Lun. 24/08')
  })

  it('comprend une heure française', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi demain à 14h30',
      { now: MONDAY },
    )

    expect(r.dueDate).toBe('2026-08-18')
    expect(r.dueTime).toBe('14:30')
    expect(r.due).toBe('Demain · 14h30')
  })

  it('comprend le format 14:30', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi vendredi 14:30',
      { now: MONDAY },
    )

    expect(r.dueTime).toBe('14:30')
    expect(r.due).toBe('Ven. 21/08 · 14h30')
  })

  it('gère le changement de mois', () => {
    const r = resolveTimeExpression(
      'Rappelle-moi demain',
      {
        now: new Date(
          '2026-08-31T08:00:00.000Z',
        ),
      },
    )

    expect(r.dueDate).toBe('2026-09-01')
  })

  it("gère le changement d'année", () => {
    const r = resolveTimeExpression(
      'Rappelle-moi demain',
      {
        now: new Date(
          '2026-12-31T10:00:00.000Z',
        ),
      },
    )

    expect(r.dueDate).toBe('2027-01-01')
  })

  it('respecte Europe/Paris autour de minuit UTC', () => {
    const r = resolveTimeExpression(
      "Rappelle-moi aujourd'hui",
      {
        // 22:30 UTC le 16 août =
        // 00:30 le 17 août à Paris.
        now: new Date(
          '2026-08-16T22:30:00.000Z',
        ),
      },
    )

    expect(r.dueDate).toBe('2026-08-17')
  })

  it("signale l'absence d'expression temporelle", () => {
    const r = resolveTimeExpression(
      'Ajoute une note pour Severine',
      { now: MONDAY },
    )

    expect(r.matched).toBe(false)
    expect(r.dueDate).toBe('2026-08-17')
    expect(r.dueTime).toBeNull()
  })
})