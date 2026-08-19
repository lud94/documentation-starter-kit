// SEC-LOG-01 — DESCRIPTION SÛRE DES ERREURS.
//
// ── LE DÉFAUT FERMÉ ICI ─────────────────────────────────────────────────────
// Les modules d'accès aux fournisseurs construisaient leurs erreurs ainsi :
//
//     throw new Error(`Anthropic ${status} — ${body.slice(0, 150)}`)
//
// et les routes journalisaient ensuite `e.message`. La chaîne complète était
// donc : réponse du fournisseur → Error.message → console.error → journaux
// serveur, et dans un cas → corps d'une réponse HTTP publique.
//
// Or le corps d'erreur d'une API N'EST PAS un diagnostic neutre. Une API qui
// rejette une requête cite volontiers le champ fautif ET sa valeur : un chemin
// `messages.1.content.0.text` suivi de son contenu, un nom d'outil, un extrait
// de prompt. Ce qui part en journal, ce n'est alors plus une erreur — c'est un
// fragment de la donnée métier qu'on croyait n'avoir jamais journalisée.
//
// ── ALLOW-LIST, JAMAIS BLACKLIST ────────────────────────────────────────────
// On ne cherche PAS à retirer d'un texte libre ce qui « ressemble » à un secret.
// Une liste de motifs interdits est toujours en retard d'un format : elle laisse
// passer ce qu'elle n'a pas prévu, et donne l'assurance trompeuse d'un filtrage.
//
// Ici, RIEN n'est journalisé qui n'ait été explicitement autorisé. Le texte libre
// n'entre jamais : il n'existe aucun champ pour l'accueillir. Ce module ne lit
// JAMAIS `message` d'une erreur qu'il n'a pas lui-même construite.
//
// ── CE QUI RESTE POSSIBLE ───────────────────────────────────────────────────
// Assainir n'est pas aveugler. Un exploitant garde le fournisseur, l'opération,
// le statut HTTP, le caractère rejouable, la classe de l'exception et un
// identifiant de corrélation généré localement. C'est suffisant pour diagnostiquer
// une panne ; ça ne l'est pas pour reconstituer une donnée client.

/**
 * MESSAGE PUBLIC UNIQUE ET DÉTERMINISTE.
 *
 * Une réponse d'erreur destinée au navigateur ne doit rien apprendre de plus que
 * « ça a échoué ». Varier le texte selon la cause donnerait un oracle : deux
 * messages différents distinguent une clef absente d'un quota dépassé, donc
 * renseignent sur l'infrastructure sans qu'aucun secret n'ait fuité.
 */
export const PUBLIC_ERROR = 'Opération indisponible pour le moment.'

/** Fournisseurs connus. Un identifiant hors liste est refusé, pas journalisé. */
export const KNOWN_PROVIDERS = [
  'anthropic',
  'exa',
  'datagouv',
  'pappers',
  'unipile',
  'telegram',
  'supabase',
  'internal',
] as const

export type ProviderId = typeof KNOWN_PROVIDERS[number]

export function isKnownProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(v)
}

/** Codes internes stables. Ils décrivent une CLASSE de panne, jamais son contenu. */
export const SAFE_ERROR_CODES = [
  'provider_http',      // le fournisseur a répondu, avec un statut d'échec
  'provider_network',   // la requête n'a pas abouti (DNS, TLS, connexion)
  'provider_timeout',   // délai dépassé
  'provider_response',  // réponse reçue mais inexploitable
  'internal_error',     // panne de notre côté
] as const

export type SafeErrorCode = typeof SAFE_ERROR_CODES[number]

/**
 * LA TOTALITÉ de ce qui peut être journalisé. Aucun champ libre.
 *
 * ⚠️ Ajouter un champ ici est une décision de revue, jamais une commodité de
 * débogage. Tout champ ajouté deviendra un canal potentiel : la question à se
 * poser n'est pas « est-ce utile ? » mais « cette valeur peut-elle, un jour,
 * contenir une donnée métier ? ».
 */
export interface SafeErrorShape {
  code: SafeErrorCode
  provider?: ProviderId
  /** Opération technique, slug court et fixe (`messages`, `search`…). */
  operation?: string
  /** Statut HTTP tel que renvoyé, jamais un texte de statut. */
  status?: number
  retryable?: boolean
  /** Nom de CLASSE de l'exception (`TypeError`…). Une classe n'est pas une donnée. */
  errorName?: string
  /** Corrélation, générée LOCALEMENT. Ne vient jamais du fournisseur. */
  requestId?: string
}

const OPERATION_RE = /^[a-z][a-z0-9_]{0,31}$/

function safeOperation(v: unknown): string | undefined {
  return typeof v === 'string' && OPERATION_RE.test(v) ? v : undefined
}

function safeStatus(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000 ? v : undefined
}

/** Nom de classe : lettres seulement, borné. Un nom exotique est écarté. */
function safeErrorName(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(v) ? v : undefined
}

/**
 * Identifiant de corrélation, généré ICI.
 *
 * Il ne vient jamais d'un en-tête fournisseur : un `request-id` distant est une
 * valeur contrôlée par un tiers, donc une entrée non fiable dans nos journaux.
 */
export function newRequestId(): string {
  const c: any = (globalThis as any).crypto
  if (c?.randomUUID) return String(c.randomUUID()).replace(/-/g, '').slice(0, 12)
  // Repli sans dépendance : la corrélation est un confort, pas une garantie.
  return Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0')
}

/**
 * Statuts qu'il est raisonnable de rejouer.
 *
 * Renseigné pour l'exploitation ; ne pilote aucune décision comptable — la
 * passerelle a ses propres règles, autrement plus prudentes.
 */
function isRetryable(status?: number): boolean | undefined {
  if (status === undefined) return undefined
  if (status === 408 || status === 429) return true
  if (status >= 500) return true
  return false
}

/** Rend le message TEXTUEL d'une erreur assainie. Uniquement des jetons autorisés. */
export function safeErrorMessage(shape: SafeErrorShape): string {
  const parts: string[] = [shape.code]
  if (shape.provider) parts.push(`provider=${shape.provider}`)
  if (shape.operation) parts.push(`operation=${shape.operation}`)
  if (shape.status !== undefined) parts.push(`status=${shape.status}`)
  if (shape.retryable !== undefined) parts.push(`retryable=${shape.retryable}`)
  if (shape.errorName) parts.push(`error=${shape.errorName}`)
  if (shape.requestId) parts.push(`rid=${shape.requestId}`)
  return parts.join(' ')
}

/**
 * Erreur d'accès à un fournisseur.
 *
 * ⚠️ SON `message` EST CONSTRUIT, PAS RECOPIÉ. Le constructeur n'accepte aucun
 * texte libre : il n'existe pas de paramètre par lequel un corps de réponse
 * pourrait entrer. C'est ce qui rend la fuite impossible plutôt que déconseillée.
 *
 * Le corps réel peut être inspecté LOCALEMENT par l'appelant (la passerelle en a
 * besoin pour dégrader une requête sur 400) ; il ne doit simplement jamais être
 * confié à cet objet, ni à un journal.
 */
export class ProviderError extends Error {
  readonly safe: SafeErrorShape

  constructor(input: {
    code: SafeErrorCode
    provider: ProviderId
    operation?: string
    status?: number
    errorName?: string
    requestId?: string
  }) {
    const shape: SafeErrorShape = {
      code: input.code,
      provider: isKnownProvider(input.provider) ? input.provider : 'internal',
      operation: safeOperation(input.operation),
      status: safeStatus(input.status),
      retryable: isRetryable(safeStatus(input.status)),
      errorName: safeErrorName(input.errorName),
      requestId: input.requestId ?? newRequestId(),
    }
    super(safeErrorMessage(shape))
    this.name = 'ProviderError'
    this.safe = shape
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError
}

/**
 * Décrit N'IMPORTE QUELLE valeur jetée, sans jamais lire son texte.
 *
 * ⚠️ `e.message` N'EST PAS LU, même pour une erreur d'apparence anodine. Un
 * message interne peut avoir interpolé une valeur métier — c'est précisément ce
 * qui s'est produit ici — et il n'existe aucun moyen fiable de le savoir depuis
 * l'extérieur. Seule la CLASSE est retenue : elle nomme la nature du défaut sans
 * en transporter le contenu.
 *
 * Une valeur non-Error (une chaîne, un objet, `undefined`) est traitée comme une
 * panne interne anonyme : on ne tente pas de la sérialiser.
 */
export function describeError(
  e: unknown,
  contexte?: { provider?: ProviderId; operation?: string; requestId?: string },
): SafeErrorShape {
  if (isProviderError(e)) return e.safe

  const provider = isKnownProvider(contexte?.provider) ? contexte!.provider : undefined
  const operation = safeOperation(contexte?.operation)
  const requestId = contexte?.requestId

  // `AbortError` / `TimeoutError` sont produits par le runtime : leur NOM est une
  // information technique fiable, contrairement à leur message.
  const name = e instanceof Error ? safeErrorName(e.name) : undefined
  const code: SafeErrorCode =
    name === 'TimeoutError' || name === 'AbortError'
      ? 'provider_timeout'
      : provider
        ? 'provider_network'
        : 'internal_error'

  return { code, provider, operation, errorName: name, requestId }
}

/**
 * Journalise une erreur — le SEUL chemin autorisé vers `console.error`
 * pour une erreur applicative.
 *
 * `tag` est un identifiant d'emplacement fixe, écrit dans le code source. Il
 * n'est jamais construit à partir d'une donnée d'exécution.
 */
export function logSafeError(
  tag: string,
  e: unknown,
  contexte?: { provider?: ProviderId; operation?: string; requestId?: string },
): SafeErrorShape {
  const shape = describeError(e, contexte)
  console.error(tag, JSON.stringify(shape))
  return shape
}

// ─────────────────────────────────────────────────────────────────────────────
// PANNES DE STOCKAGE — vocabulaire FERMÉ pour la télémétrie.
//
// ⚠️ POURQUOI PAS LE MESSAGE POSTGRESQL. Une erreur PostgreSQL relayée par
// PostgREST porte volontiers un `DETAIL: Failing row contains (…)` : la LIGNE
// FAUTIVE, colonnes comprises. Recopier ce message dans une trace de télémétrie
// y déverse donc des données métier — c'est le même défaut que le corps
// fournisseur, par une autre porte.
//
// On classe par CODE (SQLSTATE), jamais par texte. Le vocabulaire est
// délibérément grossier : cinq valeurs. Un barème fin redeviendrait un oracle —
// distinguer « contrainte violée sur telle table » de « permission refusée »
// renseigne sur le schéma sans qu'aucun secret n'ait fuité.

export const STORAGE_FAILURES = [
  'timeout',
  'storage_unavailable',
  'constraint_error',
  'network_error',
  'unknown_error',
] as const

export type StorageFailure = typeof STORAGE_FAILURES[number]

/**
 * Classe une erreur de stockage à partir de son SQLSTATE, jamais de son texte.
 *
 * Accepte aussi bien un objet d'erreur PostgREST (`{ code }`) qu'une exception.
 * Tout ce qui n'est pas reconnu tombe en `unknown_error` — un défaut de
 * classification ne doit pas devenir un prétexte à journaliser le texte brut.
 */
export function storageFailure(e: unknown): StorageFailure {
  const code = typeof (e as any)?.code === 'string' ? String((e as any).code) : ''

  if (code === '57014') return 'timeout'                 // query_canceled
  if (code.startsWith('23')) return 'constraint_error'   // integrity_constraint_violation
  if (code.startsWith('08')) return 'network_error'      // connection_exception
  if (code.startsWith('53') || code.startsWith('57P')) return 'storage_unavailable'
  if (code === '42501') return 'storage_unavailable'     // privilège refusé

  const name = e instanceof Error ? e.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if (name === 'TypeError') return 'network_error'       // échec `fetch`

  return 'unknown_error'
}
