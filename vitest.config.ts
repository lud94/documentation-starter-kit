import { defineConfig } from 'vitest/config'

// Tests unitaires uniquement : aucun réseau, aucune base, aucun rendu React.
// Les tests d'intégration (PostgreSQL réel) auront leur propre configuration et
// ne sont volontairement pas inclus ici — ils ne doivent pas s'exécuter par défaut.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    // Pas de `globals` : les imports sont explicites, ce qui évite toute magie
    // et garde les fichiers de test lisibles sans configuration TypeScript dédiée.
    globals: false,
    clearMocks: true,
  },
})
