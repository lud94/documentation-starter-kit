// Empreinte de build — répond à UNE question : « quel code tourne réellement ? »
// Née d'un vrai incident : 4 commits de correction poussés sur une branche, une
// production restée en arrière, et un même message d'erreur retesté trois fois.
// Les variables VERCEL_* sont inlinées au build par next.config.js (elles doivent
// donc être lues comme des littéraux, jamais construites dynamiquement).
const SHA = process.env.NEXT_PUBLIC_COMMIT_SHA || 'local'
const REF = process.env.NEXT_PUBLIC_COMMIT_REF || 'local'
const ENV = process.env.NEXT_PUBLIC_VERCEL_ENV || 'dev'

export const BUILD = {
  sha: SHA,
  short: SHA.slice(0, 7),
  branch: REF,
  env: ENV,
}

// Étiquette courte, collée aux messages d'erreur et exposée en en-tête HTTP.
export function buildTag(): string {
  return `${BUILD.branch}@${BUILD.short}`
}

// Ajoute l'empreinte à un message d'erreur (idempotent : jamais deux fois).
export function withBuild(message: string): string {
  const tag = `[build ${buildTag()}]`
  return message.includes(tag) ? message : `${message} ${tag}`
}
