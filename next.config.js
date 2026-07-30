/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Empreinte de build exposée au navigateur ET au serveur (voir lib/version.ts).
  // Vercel fournit VERCEL_GIT_* côté build ; on les recopie sous un nom NEXT_PUBLIC_
  // pour qu'elles soient inlinées dans le bundle client.
  env: {
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    NEXT_PUBLIC_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || 'local',
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || 'dev',
  },
}

module.exports = nextConfig
