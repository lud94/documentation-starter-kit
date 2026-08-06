import { defineConfig } from 'vitest/config'

// Tests unitaires uniquement : aucun réseau, aucune base.
// Les tests d'intégration (PostgreSQL réel) auront leur propre configuration et
// ne sont volontairement pas inclus ici — ils ne doivent pas s'exécuter par défaut.
//
// ⚠️ Le rendu React est désormais possible, et volontairement (lot SEC-0d).
// `AskExternalAI` décide d'un EGRESS de données vers un tiers : son premier
// rendu — celui qui existe avant tout effet, pendant le chargement de la
// politique — est une surface de sécurité, pas un détail d'affichage. On le
// vérifie par `renderToStaticMarkup`, sans DOM ni dépendance nouvelle.
// `jsx: 'automatic'` est nécessaire parce que Next injecte `React` de lui-même
// en compilation, ce que vitest ne fait pas.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
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
