#!/usr/bin/env node
// Garde-fou CI — l'origine de l'extension est déclarée DEUX fois (lot SEC-EXT-0.1).
//
// POURQUOI. `extension/config.js` décide où le service worker envoie le
// credential ; `extension/manifest.json` décide où Chrome l'AUTORISE à l'envoyer.
// Deux déclarations manuelles indépendantes divergent tôt ou tard — et une
// divergence donne soit une extension muette, soit une permission plus large que
// l'origine réellement utilisée. Ce script les tient synchronisées, sans
// introduire de système de build.
//
// Il signale aussi le PLACEHOLDER : aucune origine Prospector canonique n'existe
// dans ce dépôt, et une build cliente ne doit pas partir avec `.example`.
//
// Usage : node scripts/check-extension-origin.mjs   (sortie 1 si divergence)

import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
const config = readFileSync('extension/config.js', 'utf8')

const m = config.match(/const PROSPECTOR_ORIGIN = '([^']+)'/)
if (!m) {
  console.error('extension/config.js : PROSPECTOR_ORIGIN introuvable.')
  process.exit(1)
}
const origin = m[1]
const hosts = manifest.host_permissions || []
const attendu = `${origin}/*`
const erreurs = []

if (hosts.length !== 1 || hosts[0] !== attendu) {
  erreurs.push(`host_permissions vaut ${JSON.stringify(hosts)}, attendu ["${attendu}"]`)
}
for (const h of hosts) {
  if (h.includes('*://') || h.includes('*/*')) erreurs.push(`motif trop large : ${h}`)
}
if (manifest.content_scripts) erreurs.push('content_scripts déclaré : Jarvis doit être injecté à la demande')

if (erreurs.length) {
  console.error("Extension — origine incohérente :\n")
  for (const e of erreurs) console.error(`  ${e}`)
  console.error('\nUne seule source fait foi : PROSPECTOR_ORIGIN dans extension/config.js.')
  process.exit(1)
}

if (origin.endsWith('.example')) {
  console.log(`OK — manifeste et config concordent (${origin}).`)
  console.log('⚠️  PLACEHOLDER : aucune origine Prospector réelle n\'est configurée.')
  console.log('    Une build cliente doit remplacer PROSPECTOR_ORIGIN avant publication.')
  process.exit(0)
}
console.log(`OK — manifeste et config concordent (${origin}).`)
