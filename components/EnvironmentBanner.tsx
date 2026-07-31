import { BUILD } from '../lib/version'

// Bandeau d'environnement — mutualisé entre l'interface admin et le portail client.
// Il répond à une question qu'on s'est posée trop souvent : « est-ce que je regarde
// la production ou une préversion ? ». Absent en production, permanent ailleurs.
//
// Les valeurs proviennent de variables NEXT_PUBLIC_* inlinées au build : ce composant
// est rendu côté navigateur et ne peut donc pas lire les variables serveur.
export default function EnvironmentBanner() {
  const env = (process.env.NEXT_PUBLIC_APP_ENV || '').trim()
  const role = (process.env.NEXT_PUBLIC_APP_PROJECT_ROLE || '').trim()
  const vercel = (process.env.NEXT_PUBLIC_VERCEL_ENV || '').trim()

  // Production correctement déclarée → aucun bandeau.
  if (env === 'production' && role === 'production' && vercel === 'production') return null

  const unconfigured = env === '' || !['development', 'staging', 'production'].includes(env)
  // Une incohérence visible depuis le navigateur : l'environnement se déclare
  // production alors que le déploiement n'en est pas un.
  const mismatch = !unconfigured && ((env === 'production' && vercel && vercel !== 'production') || (role && role !== env))

  const label = unconfigured
    ? 'Environnement non déclaré'
    : mismatch
      ? 'Configuration incohérente'
      : env === 'staging' ? 'Préproduction' : 'Développement'

  const tone = unconfigured || mismatch
    ? 'bg-red-600 text-white'
    : env === 'staging' ? 'bg-amber-500 text-white' : 'bg-gray-700 text-white'

  const detail = unconfigured
    ? 'APP_ENV absent — aucun repli sur « production ». Écritures autorisées tant que le mode strict est inactif.'
    : mismatch
      ? `APP_ENV=${env} · rôle=${role || '—'} · Vercel=${vercel || '—'}`
      : `${env}${role ? ` · projet ${role}` : ''}${vercel ? ` · ${vercel}` : ''}`

  return (
    <div className={`${tone} px-4 py-1.5 text-[11px] font-semibold flex items-center gap-3 flex-wrap`}>
      <span className="uppercase tracking-wide">{label}</span>
      <span className="font-normal opacity-90">{detail}</span>
      <span className="ml-auto font-mono opacity-75 select-all">
        {BUILD.branch}@{BUILD.short}
      </span>
    </div>
  )
}
