// Garde-fou CI — l'origine de l'extension est déclarée DEUX fois (lots SEC-EXT-0.1 / 0.1b).
//
// POURQUOI. `extension/config.js` décide où le service worker envoie le
// credential ; `extension/manifest.json` décide où Chrome l'AUTORISE à l'envoyer.
// Deux déclarations manuelles indépendantes divergent tôt ou tard — et une
// divergence donne soit une extension muette, soit une permission plus large que
// l'origine réellement utilisée.
//
// ── DEUX MODES, ET C'EST LE POINT DU LOT 0.1b ───────────────────────────────
//   défaut       développement : le placeholder `.example` est TOLÉRÉ, signalé.
//   --release    publication  : le placeholder est un ÉCHEC.
//
// Le mode par défaut ne doit pas rougir tant que l'origine réelle de Prospector
// est inconnue — mais une build cliente ne doit jamais partir avec `.example`.
// Le pipeline de publication Chrome devra appeler `--release`.
//
// Usage : node scripts/check-extension-origin.mjs [--release] [--dir <chemin>]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const release = args.includes('--release')
const dirFlag = args.indexOf('--dir')
const dir = dirFlag >= 0 ? args[dirFlag + 1] : 'extension'

/** Analyse un répertoire d'extension. Rend la liste des erreurs bloquantes. */
export function auditExtension(dir, { release = false } = {}) {
  const erreurs = []
  let manifest
  let config
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    config = readFileSync(join(dir, 'config.js'), 'utf8')
  } catch (e) {
    return { erreurs: [`lecture impossible : ${e.message}`], origin: null }
  }

  const m = config.match(/const PROSPECTOR_ORIGIN = '([^']+)'/)
  if (!m) return { erreurs: ['config.js : PROSPECTOR_ORIGIN introuvable.'], origin: null }
  const origin = m[1]

  const hosts = manifest.host_permissions || []
  const attendu = `${origin}/*`
  if (hosts.length !== 1 || hosts[0] !== attendu) {
    erreurs.push(`host_permissions vaut ${JSON.stringify(hosts)}, attendu ["${attendu}"]`)
  }
  for (const h of hosts) {
    // Un motif large réintroduirait l'accès permanent à tout Internet.
    if (h.includes('*://') || h.includes('*/*') || /^https:\/\/\*/.test(h)) {
      erreurs.push(`motif trop large : ${h}`)
    }
  }
  if (manifest.content_scripts) {
    erreurs.push('content_scripts déclaré : Jarvis doit être injecté à la demande')
  }

  if (release) {
    // Une build cliente doit désigner une origine RÉELLE et chiffrée.
    if (/\.example($|\/)/.test(origin) || origin.includes('example.')) {
      erreurs.push(`origine PLACEHOLDER en mode release : ${origin}`)
    }
    if (!origin.startsWith('https://')) {
      erreurs.push(`origine non HTTPS en mode release : ${origin}`)
    }
    if (!manifest.minimum_chrome_version) {
      erreurs.push('minimum_chrome_version absent : un navigateur incapable de cloisonner le stockage ne doit pas installer cette build')
    }
  }
  return { erreurs, origin }
}

// Exécution directe uniquement (le module est aussi importé par les tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { erreurs, origin } = auditExtension(dir, { release })
  if (erreurs.length) {
    console.error(`Extension — ${release ? 'build RELEASE refusée' : 'origine incohérente'} :\n`)
    for (const e of erreurs) console.error(`  ${e}`)
    console.error('\nUne seule source fait foi : PROSPECTOR_ORIGIN dans extension/config.js.')
    process.exit(1)
  }
  if (!release && /\.example($|\/)/.test(origin || '')) {
    console.log(`OK — manifeste et config concordent (${origin}).`)
    console.log('⚠️  PLACEHOLDER : aucune origine Prospector réelle n\'est configurée.')
    console.log('    `npm run check:extension:release` refusera cette build.')
    process.exit(0)
  }
  console.log(`OK${release ? ' (release)' : ''} — manifeste et config concordent (${origin}).`)
}
