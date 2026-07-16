import { useState, useEffect, useCallback } from 'react'
import type { Lead } from '../types/lead'

// Simple in-memory store with localStorage persistence
interface LeadStore {
  leads: Lead[]
  sentEmails: Set<string>
  setLeads: (leads: Lead[]) => void
  markSent: (email: string) => void
}

let globalLeads: Lead[] = []
let globalSent: Set<string> = new Set()
const listeners: Set<() => void> = new Set()

function notify() {
  listeners.forEach(fn => fn())
}

function loadFromStorage() {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem('leadflow_leads')
    if (raw) globalLeads = JSON.parse(raw)
    const sentRaw = localStorage.getItem('leadflow_sent')
    if (sentRaw) globalSent = new Set(JSON.parse(sentRaw))
  } catch {}
}

function saveToStorage() {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem('leadflow_leads', JSON.stringify(globalLeads))
    localStorage.setItem('leadflow_sent', JSON.stringify(Array.from(globalSent)))
  } catch {}
}

export function useLeadStore(): LeadStore {
  const [, rerender] = useState(0)

  useEffect(() => {
    loadFromStorage()
    const fn = () => rerender(n => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])

  const setLeads = useCallback((leads: Lead[]) => {
    globalLeads = leads
    saveToStorage()
    notify()
  }, [])

  const markSent = useCallback((email: string) => {
    globalSent = new Set(Array.from(globalSent).concat(email))
    saveToStorage()
    notify()
  }, [])

  return {
    leads: globalLeads,
    sentEmails: globalSent,
    setLeads,
    markSent,
  }
}
