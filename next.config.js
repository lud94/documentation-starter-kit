/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Empreinte de build exposée au navigateur ET au serveur (voir lib/version.ts).
  // Vercel fournit VERCEL_GIT_* côté build ; on les recopie sous un nom NEXT_PUBLIC_
  // pour qu'elles soient inlinées dans le bundle client.
  env: {
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    NEXT_PUBLIC_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || 'local',
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || '',
    // Contrat d'environnement (lib/env.ts). Identifiants NON SECRETS uniquement :
    // aucun repli sur 'production', l'absence reste l'absence.
    NEXT_PUBLIC_APP_ENV: process.env.APP_ENV || '',
    NEXT_PUBLIC_APP_PROJECT_ROLE: process.env.APP_PROJECT_ROLE || '',
  },
}

module.exports = nextConfig
