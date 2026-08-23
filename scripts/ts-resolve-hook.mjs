// EVAL-RUNNER-001a — RÉSOLUTION DES IMPORTS TYPESCRIPT SANS EXTENSION.
//
// ── POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST SI COURT ─────────────────
// Node 22 sait exécuter du TypeScript nativement (`--experimental-strip-types`)
// mais NE fait aucune résolution : il efface les types, il ne remplace pas le
// résolveur de modules. Or le dépôt écrit `from './types'` sans extension —
// obligatoire, puisque `moduleResolution: node` de TypeScript REFUSE un chemin
// terminé par `.ts`. Sans ce pont, `node` échoue en ERR_MODULE_NOT_FOUND.
//
// ── CE QU'IL ÉVITE ──────────────────────────────────────────────────────────
// Une dépendance npm supplémentaire (`tsx`, `ts-node`). Le dépôt ne déclare
// aucun exécuteur TypeScript, et `esbuild` n'est présent que comme dépendance
// TRANSITIVE de Vitest : s'en servir reviendrait à dépendre d'un paquet que
// personne n'a déclaré et que la prochaine mise à jour de Vitest peut retirer.
// Ici, tout vient de Node lui-même.
//
// ⚠️ RÉSERVÉ AUX OUTILS LOCAUX. Ce hook ne s'applique qu'aux processus qui le
// chargent explicitement via `--import`. Ni Next.js, ni Vitest, ni le code de
// production ne le voient : il ne modifie le comportement d'aucun build.
//
// Il ne résout QUE des spécificateurs relatifs. Un paquet npm reste résolu par
// Node, sans interférence.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relatif = specifier.startsWith('./') || specifier.startsWith('../')
    const dejaSuffixe = /\.[mc]?[jt]s$/.test(specifier)

    if (relatif && !dejaSuffixe && context.parentURL) {
      const base = new URL(specifier, context.parentURL).href

      // Ordre volontaire : `x.ts` avant `x/index.ts`, comme TypeScript.
      for (const candidat of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(fileURLToPath(candidat))) {
          return nextResolve(candidat, context)
        }
      }
    }

    return nextResolve(specifier, context)
  },
})
