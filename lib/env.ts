// Contrat d'environnement — répond à « où suis-je, et ai-je le droit d'écrire ici ? »
//
// Né d'un besoin concret : la préproduction et la production partagent aujourd'hui
// la même base et le même bot. Rien n'empêche un déploiement de test d'écrire dans
// les données réelles. Ce module rend cette situation visible et, quand la
// configuration est posée, l'empêche.
//
// ── Cinq responsabilités SÉPARÉES, jamais fondues ──────────────────────────────
//   1. validateConfig()     — la configuration est-elle cohérente ?
//   2. canRead()            — la lecture est-elle autorisée ?      (toujours oui)
//   3. canWrite()           — l'écriture est-elle autorisée ?
//   4. canRunJobs()         — les tâches planifiées peuvent-elles tourner ?
//   5. connectorStatus()    — un connecteur optionnel est-il utilisable ?
//
// ⚠️ AUCUN `throw` à l'import. Ce module est importé par les couches de persistance :
// lever une exception au chargement rendrait l'application non démarrable et
// impossible à diagnostiquer. Tout est évalué paresseusement, à la demande.

export type AppEnv = 'development' | 'staging' | 'production'
export type ProjectRole = 'production' | 'staging'

// Comment l'identité de l'environnement a été établie.
// ENVIRONMENT_VARIABLE_ONLY : par comparaison de variables déclarées (phase 1).
// DATABASE_VERIFIED         : la base elle-même déclare son environnement (phase 2,
//                             via prospector_env_identity — table NON créée dans ce
//                             lot, voir readDatabaseIdentity()).
export type VerificationMode = 'ENVIRONMENT_VARIABLE_ONLY' | 'DATABASE_VERIFIED'

const VALID_ENVS: AppEnv[] = ['development', 'staging', 'production']
const VALID_ROLES: ProjectRole[] = ['production', 'staging']

function raw(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/** `APP_ENV` déclaré. `null` si absent — JAMAIS de repli sur 'production'. */
export function appEnv(): AppEnv | null {
  const v = raw('APP_ENV') || raw('NEXT_PUBLIC_APP_ENV')
  return v && (VALID_ENVS as string[]).includes(v) ? (v as AppEnv) : null
}

/** Rôle du projet Vercel, déclaré par le projet lui-même. Identifiant NON secret. */
export function projectRole(): ProjectRole | null {
  const v = raw('APP_PROJECT_ROLE') || raw('NEXT_PUBLIC_APP_PROJECT_ROLE')
  return v && (VALID_ROLES as string[]).includes(v) ? (v as ProjectRole) : null
}

/** `production` | `preview` | `development` côté Vercel. Absent en local. */
export function vercelEnv(): string | null {
  return raw('VERCEL_ENV') || raw('NEXT_PUBLIC_VERCEL_ENV') || null
}

/** Vrai lorsqu'on tourne sur Vercel (donc hors poste de développement). */
export function onVercel(): boolean {
  return !!vercelEnv()
}

// Référence du projet Supabase = premier segment du hôte de l'URL. NON secret :
// il figure déjà dans l'URL publique du projet. On ne dérive jamais un identifiant
// depuis une clé.
export function actualSupabaseRef(): string | null {
  const url = raw('SUPABASE_URL') || raw('NEXT_PUBLIC_SUPABASE_URL') || raw('SUPABASE_PROJECT_URL')
  if (!url) return null
  try { return new URL(url).hostname.split('.')[0] || null } catch { return null }
}

export function expectedSupabaseRef(): string | null {
  return raw('APP_SUPABASE_REF') || null
}

export function expectedTelegramBot(): string | null {
  return raw('APP_TELEGRAM_BOT_USERNAME') || null
}

// ── 1. VALIDATION DE CONFIGURATION ────────────────────────────────────────────

export interface ConfigIssue {
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface ConfigValidation {
  appEnv: AppEnv | null
  projectRole: ProjectRole | null
  vercelEnv: string | null
  /** L'environnement est-il déclaré ? Faux = déploiement hérité, non configuré. */
  configured: boolean
  /** Cohérence APP_ENV × rôle de projet × VERCEL_ENV. */
  matrixOk: boolean
  /** Cohérence de la base joignable avec celle attendue. */
  supabaseOk: boolean
  verification: VerificationMode
  issues: ConfigIssue[]
}

// Matrice à TROIS dimensions. Le rôle du projet est déclaré par le projet, car
// Vercel n'expose aucun nom de projet en variable système.
//
//  APP_ENV      | APP_PROJECT_ROLE | VERCEL_ENV  | verdict
//  production   | production       | production  | autorisé
//  staging      | staging          | production  | autorisé  (préprod sur sa branche principale)
//  staging      | staging          | preview     | autorisé
//  development  | (absent)         | (absent)    | autorisé  (local)
//  production   | production       | preview     | REFUSÉ    (une préversion n'est pas la production)
//  *            | rôle ≠ APP_ENV   | *           | REFUSÉ
function checkMatrix(env: AppEnv, role: ProjectRole | null, vEnv: string | null): ConfigIssue[] {
  const out: ConfigIssue[] = []

  if (env === 'development') {
    if (vEnv) out.push({ code: 'dev_on_vercel', severity: 'error',
      message: `APP_ENV=development sur un déploiement Vercel (VERCEL_ENV=${vEnv}) : impossible.` })
    return out
  }

  if (!role) {
    out.push({ code: 'role_missing', severity: 'error',
      message: 'APP_PROJECT_ROLE non déclaré : le projet Vercel ne dit pas s\'il est de production ou de préproduction.' })
    return out
  }

  if (role !== env) {
    out.push({ code: 'env_role_mismatch', severity: 'error',
      message: `APP_ENV=${env} sur un projet dont le rôle déclaré est « ${role} ».` })
  }

  // Sur le projet de production, seul un déploiement de production peut se
  // réclamer de la production. Les préversions doivent vivre sur le projet de
  // préproduction.
  if (env === 'production' && vEnv && vEnv !== 'production') {
    out.push({ code: 'production_on_preview', severity: 'error',
      message: `APP_ENV=production sur un déploiement VERCEL_ENV=${vEnv} : une préversion n'est pas la production.` })
  }

  return out
}

// Phase 2 — lecture de l'identité déclarée par la base (table prospector_env_identity).
// La table n'est PAS créée dans ce lot : sa création exige une migration, donc la
// baseline A3b. Le point d'accroche existe pour que la bascule vers DATABASE_VERIFIED
// ne demande pas de réécriture.
export async function readDatabaseIdentity(): Promise<AppEnv | null> {
  return null // à implémenter après A3b — voir supabase/README.md
}

let cached: ConfigValidation | null = null

export function validateConfig(force = false): ConfigValidation {
  if (cached && !force) return cached

  const env = appEnv()
  const role = projectRole()
  const vEnv = vercelEnv()
  const issues: ConfigIssue[] = []

  // Absence de configuration ≠ production. C'est un troisième état, explicite :
  // « déploiement hérité, non configuré ». Il est signalé, jamais deviné.
  const configured = env !== null
  if (!configured) {
    issues.push({ code: 'app_env_missing', severity: 'warning',
      message: 'APP_ENV non déclaré : environnement inconnu. Aucun repli sur « production ». '
             + 'Poser APP_ENV (development | staging | production) dans chaque environnement.' })
    if (raw('APP_ENV') || raw('NEXT_PUBLIC_APP_ENV')) {
      issues.push({ code: 'app_env_invalid', severity: 'error',
        message: 'APP_ENV présent mais invalide : valeurs acceptées development, staging, production.' })
    }
  }

  const matrixIssues = configured ? checkMatrix(env!, role, vEnv) : []
  issues.push(...matrixIssues)

  // Cohérence de la base : identifiants non secrets des deux côtés.
  const expectedRef = expectedSupabaseRef()
  const actualRef = actualSupabaseRef()
  let supabaseOk = true
  if (expectedRef && actualRef && expectedRef !== actualRef) {
    supabaseOk = false
    issues.push({ code: 'supabase_mismatch', severity: 'error',
      message: `Base Supabase inattendue : « ${actualRef} » joignable, « ${expectedRef} » attendue. `
             + 'Écritures et tâches bloquées.' })
  } else if (configured && !expectedRef) {
    issues.push({ code: 'supabase_ref_undeclared', severity: 'warning',
      message: 'APP_SUPABASE_REF non déclarée : impossible de vérifier que la base jointe est la bonne.' })
  }

  cached = {
    appEnv: env, projectRole: role, vercelEnv: vEnv,
    configured,
    matrixOk: matrixIssues.length === 0,
    supabaseOk,
    verification: 'ENVIRONMENT_VARIABLE_ONLY',
    issues,
  }
  return cached
}

/** Réinitialise le cache — réservé aux tests. */
export function resetConfigCache(): void { cached = null }

// ── 2. LECTURE ────────────────────────────────────────────────────────────────
// Toujours autorisée. Bloquer la lecture supprimerait la capacité de diagnostiquer
// la panne, ce qui est exactement l'inverse du but recherché.
export function canRead(): boolean { return true }

// ── 3. ÉCRITURE ───────────────────────────────────────────────────────────────

export interface Permission { allowed: boolean; code?: string; reason?: string }

// Stratégie de déploiement, assumée : une incohérence CONSTATÉE bloque ; une
// configuration ABSENTE ne bloque pas encore. Sans cela, la fusion de ce lot
// interromprait la production tant que les variables ne sont pas posées partout.
// Une fois posées, `APP_ENV_STRICT=1` rend l'absence bloquante à son tour.
export function strictMode(): boolean { return raw('APP_ENV_STRICT') === '1' }

export function canWrite(): Permission {
  const v = validateConfig()
  if (!v.supabaseOk) {
    return { allowed: false, code: 'supabase_mismatch',
      reason: 'La base jointe n\'est pas celle attendue pour cet environnement. Écritures bloquées.' }
  }
  if (!v.configured) {
    if (strictMode()) {
      return { allowed: false, code: 'app_env_missing',
        reason: 'APP_ENV non déclaré et mode strict actif. Écritures bloquées.' }
    }
    return { allowed: true }
  }
  if (!v.matrixOk) {
    return { allowed: false, code: 'env_matrix_invalid',
      reason: 'Incohérence entre APP_ENV, le rôle du projet et VERCEL_ENV. Écritures bloquées.' }
  }
  return { allowed: true }
}

// ── 4. TÂCHES PLANIFIÉES ──────────────────────────────────────────────────────
// Mêmes conditions que l'écriture : une tâche qui ne peut rien écrire n'a aucune
// raison de consommer des appels d'API payants.
export function canRunJobs(): Permission {
  const w = canWrite()
  return w.allowed ? { allowed: true } : { ...w, reason: `Tâches suspendues — ${w.reason}` }
}

// ── 5. CONNECTEURS OPTIONNELS ─────────────────────────────────────────────────
// Un connecteur absent ou divergent désactive SA capacité, jamais l'application.

export type ConnectorName = 'telegram' | 'anthropic' | 'exa' | 'unipile'

export function connectorStatus(name: ConnectorName, actualIdentity?: string | null): Permission {
  if (name === 'telegram') {
    const expected = expectedTelegramBot()
    if (expected && actualIdentity && expected !== actualIdentity) {
      return { allowed: false, code: 'telegram_mismatch',
        reason: `Bot Telegram inattendu (« ${actualIdentity} » au lieu de « ${expected} »). Canal désactivé.` }
    }
  }
  return { allowed: true }
}

// ── Garde-fou appelé par les couches de persistance ───────────────────────────
// Renvoie un booléen plutôt que de lever : les fonctions de persistance existantes
// renvoient déjà des booléens et enveloppent leurs appels dans des try/catch, où
// une exception serait avalée silencieusement.
let warned = false
export function writeAllowed(table: string): boolean {
  const p = canWrite()
  if (!p.allowed && !warned) {
    warned = true // une seule fois par instance : pas d'inondation des journaux
    console.error(`[env] Écriture refusée sur ${table} — ${p.code} : ${p.reason}`)
  }
  return p.allowed
}

// Vue destinée à l'affichage et au diagnostic. AUCUNE valeur de secret : seuls des
// identifiants publics (référence de projet, rôle) et des booléens.
export function envSummary() {
  const v = validateConfig()
  return {
    appEnv: v.appEnv,
    projectRole: v.projectRole,
    vercelEnv: v.vercelEnv,
    configured: v.configured,
    matrixOk: v.matrixOk,
    supabaseOk: v.supabaseOk,
    verification: v.verification,
    strict: strictMode(),
    supabase: { expected: expectedSupabaseRef(), actual: actualSupabaseRef() },
    writes: canWrite(),
    jobs: canRunJobs(),
    issues: v.issues,
  }
}
