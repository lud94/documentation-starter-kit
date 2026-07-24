// Protocole multi-LLM — routing par PHASE. Un seul endroit pour décider quel
// modèle sert quelle tâche, avec la raison (business intelligence) et la clé requise.
// Le modèle par défaut est surchargeable par clé (keystore/env) sans toucher au code.
import { getKey } from './keystore'

export type Provider = 'anthropic' | 'exa' | 'perplexity' | 'openai' | 'gemini'

export interface ModelRoute {
  phase: string           // nom de la phase métier
  provider: Provider
  model: string           // modèle par défaut
  envOverride?: string    // clé keystore/env qui surcharge le modèle
  requires: string        // clé API nécessaire
  why: string             // pourquoi CE modèle sur CETTE phase
  fallback?: string       // repli si indisponible
}

export const MODEL_ROUTES: ModelRoute[] = [
  {
    phase: 'Recherche de signaux', provider: 'exa', model: 'exa-search', requires: 'EXA_API_KEY',
    why: "Recherche neuronale + contenu de page, scope par domaine (jobboards/presse). Trouve l'entreprise ET le contexte, là où un LLM seul devine.",
    fallback: 'Claude web search',
  },
  {
    phase: 'Q&A web synthétique', provider: 'perplexity', model: 'sonar', requires: 'PERPLEXITY_API_KEY',
    why: 'Synthèse sourcée en temps réel — idéal pour « que se passe-t-il sur X » avec citations.',
    fallback: 'Exa answer',
  },
  {
    phase: 'Extraction structurée', provider: 'anthropic', model: 'claude-opus-4-8', envOverride: 'SIGNALS_MODEL', requires: 'ANTHROPIC_API_KEY',
    why: "Rigueur JSON, suit les consignes, peu d'hallucination — fiabilise le passage page → données.",
  },
  {
    phase: 'Rédaction messages / icebreaker', provider: 'anthropic', model: 'claude-opus-4-8', requires: 'ANTHROPIC_API_KEY',
    why: 'Meilleur en style FR nuancé et respect du référentiel Smart.AI (deal-killers). Qualité perçue côté prospect.',
  },
  {
    phase: 'Réflexion stratégique / scoring', provider: 'anthropic', model: 'claude-opus-4-8', requires: 'ANTHROPIC_API_KEY',
    why: 'Raisonnement long et cohérent sur séquences, priorisation, arbitrages.',
  },
  {
    phase: 'Classification de masse (persona, dédup)', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', requires: 'ANTHROPIC_API_KEY',
    why: 'Rapide et bon marché pour du tri en volume où la finesse n\'est pas critique.',
    fallback: 'gpt-4.1-mini',
  },
  {
    phase: "Génération d'images", provider: 'gemini', model: 'imagen-3', requires: 'GEMINI_API_KEY',
    why: 'Claude ne génère pas d\'images ; Imagen/GPT-Image couvrent visuels et vignettes.',
    fallback: 'gpt-image-1 (OpenAI)',
  },
  {
    phase: 'OCR / parsing de documents', provider: 'gemini', model: 'gemini-2.5-pro', requires: 'GEMINI_API_KEY',
    why: 'Contexte long + multimodal — avale de gros PDF/exports.',
    fallback: 'gpt-4o (OpenAI)',
  },
]

// Résout le modèle effectif d'une phase (override keystore/env si présent).
export function resolveModel(route: ModelRoute): string {
  return (route.envOverride && getKey(route.envOverride)) || route.model
}

export function routesWithStatus() {
  return MODEL_ROUTES.map((r) => ({
    ...r,
    model: resolveModel(r),
    ready: !!getKey(r.requires),
  }))
}
