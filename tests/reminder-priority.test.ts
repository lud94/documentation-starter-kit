import { describe, expect, it } from 'vitest'

import { resolveReminderPriority } from '../lib/prospector/reminderPriority'

describe('resolveReminderPriority', () => {
  it('defaults to normal', () => {
    expect(resolveReminderPriority('Rappelle-moi demain de relancer Severine')).toBe('normal')
  })

  it('detects explicit important reminder', () => {
    expect(resolveReminderPriority('Mets-moi un rappel important demain à 14h')).toBe('important')
  })

  it('detects imperative wording', () => {
    expect(resolveReminderPriority('Rappelle-moi impérativement demain de rappeler Severine')).toBe('important')
  })

  it('detects sans faute', () => {
    expect(resolveReminderPriority('Rappelle-moi sans faute lundi de relancer ce prospect')).toBe('important')
  })

  it('detects urgent', () => {
    expect(resolveReminderPriority('Rappel urgent demain à 9h pour rappeler le client')).toBe('important')
  })

  it('detects prioritaire and critique', () => {
    expect(resolveReminderPriority('Cette tâche est prioritaire')).toBe('important')
    expect(resolveReminderPriority('Notification critique demain matin')).toBe('important')
  })

  it('is accent insensitive', () => {
    expect(resolveReminderPriority('Rappelle moi IMPÉRATIVEMENT demain')).toBe('important')
  })

  it('does not confuse an important client with an important reminder', () => {
    expect(resolveReminderPriority('Rappelle-moi demain de contacter ce client important')).toBe('normal')
  })

  it('does not infer importance from ordinary reminder wording', () => {
    expect(resolveReminderPriority('Rappelle-moi demain à 14h de relancer Severine GABAY')).toBe('normal')
  })
})
