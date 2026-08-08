#!/usr/bin/env node
// Empreinte bcrypt d'un mot de passe administrateur — OUTIL LOCAL (SEC-AUTH-0).
//
// POURQUOI. `APP_PASSWORD` en clair n'est plus accepté (lib/prospector/auth.ts) :
// un mot de passe en variable d'environnement est lisible depuis le tableau de
// bord de l'hébergeur, les journaux de construction, ou un `printenv` dans une
// fonction. On y pose désormais une EMPREINTE, et c'est cet outil qui la produit.
//
// ⚠️ CONTRAT DE CET OUTIL :
//   • le mot de passe est lu sur l'ENTRÉE STANDARD, jamais en argument de ligne
//     de commande — un argument atterrit dans l'historique du shell et dans la
//     table des processus, où n'importe quel utilisateur de la machine le voit ;
//   • il n'est ni affiché, ni journalisé, ni écrit sur disque ;
//   • seule l'empreinte est imprimée.
//
// Usage :   printf '%s' 'le-mot-de-passe' | node scripts/hash-password.mjs
// Puis poser la sortie dans APP_PASSWORD (et l'email dans APP_EMAIL).

import bcrypt from 'bcryptjs'

const chunks = []
for await (const c of process.stdin) chunks.push(c)
// Un saut de ligne final (celui d'un `echo`) ne fait pas partie du mot de passe.
const pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')

if (pw.length < 8) {
  console.error('Mot de passe : 8 caractères minimum. Rien n\'a été produit.')
  process.exit(1)
}
if (pw.length > 200) {
  console.error('Mot de passe trop long (200 caractères maximum).')
  process.exit(1)
}

// Seule l'empreinte sort d'ici.
process.stdout.write(bcrypt.hashSync(pw, 12) + '\n')
