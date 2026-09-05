import { defineConfig } from 'vitest/config'

// Tests d'INTÉGRATION — Supabase local (PostgreSQL 15 + PostgREST + clé de service).
// Volontairement exclus de `npm test` et de la CI : ils exigent Docker et une
// instance locale démarrée (`npm run db:test:up`).
//
// Ils sont OBLIGATOIRES avant toute promotion en production : les tests mémoire
// ne peuvent produire ni contrainte d'unicité, ni code 23505, ni concurrence réelle.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Une seule exécution à la fois : les cas partagent une base et se
    // coordonnent par nettoyage explicite.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
