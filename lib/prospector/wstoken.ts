// Jetons d'extension PAR ESPACE et PAR CAPACITÉ — lot SEC-EXT-0.
//
// ── CE QUI A CHANGÉ, ET POURQUOI ────────────────────────────────────────────
// Le jeton était unique par espace et ouvrait TOUT : capture de lead ET pilotage
// de Jarvis. Un jeton volé — donc volé dans un navigateur, sur une machine que
// Prospector ne maîtrise pas — donnait le rayon d'explosion maximal.
//
// Quatre défauts corrigés ici :
//
//   1. SECRET PAR DÉFAUT. `… || 'prospector-dev-secret'` : sans configuration,
//      le dépôt signait avec un littéral PUBLIC. Quiconque lisait ce fichier
//      pouvait forger un jeton pour n'importe quel espace. Il n'y a plus de
//      valeur de repli : secret absent ⇒ ni génération, ni résolution.
//
//   2. VERSION EN REPLI SILENCIEUX. `getTokenVersion` rendait `1` quand la base
//      était injoignable. La version EST le mécanisme de révocation : rendre 1
//      ressuscitait tous les jetons de première génération — précisément ceux
//      qu'une régénération avait voulu tuer. Une révocation non vérifiable
//      ferme désormais le canal.
//
//   3. AUCUNE PORTÉE. Le même jeton servait les deux capacités. La portée entre
//      maintenant dans ce qui est SIGNÉ : un jeton de capture ne peut pas
//      piloter Jarvis, et réciproquement.
//
//   4. BALAYAGE DE TOUS LES ESPACES. Le repli comparait le jeton présenté à
//      celui de CHAQUE espace — un oracle O(n) sur la liste des clients. Le
//      format porte l'espace ; il n'y a plus rien à balayer.
//
// ⚠️ MIGRATION PRODUIT ASSUMÉE. L'ancien format `pk_<ws>_<hash>` n'est plus
// reconnu — il n'est pas dégradé en « capture », il est REFUSÉ. Un jeton dont on
// ignore la portée voulue ne doit pas s'en voir attribuer une par défaut. Chaque
// espace doit recopier ses deux nouveaux jetons dans l'extension.
import { getItemStrict, upsertItem } from '../supabase/store'
import { supabaseConfigured } from '../supabase/client'
import { sessionSecret } from '../auth/session'

const VER_NS = '_meta'
const VER_KIND = 'wsver'

/** Les deux capacités de l'extension. Rien d'autre n'est signable. */
export const EXTENSION_SCOPES = ['capture', 'jarvis'] as const
export type ExtensionScope = typeof EXTENSION_SCOPES[number]

/**
 * Secret de signature. `null` si absent — JAMAIS de valeur de repli.
 *
 * Un secret connu de tous n'est pas un secret : avec l'ancien littéral, forger
 * un jeton pour l'espace de son choix ne demandait que de lire ce fichier.
 *
 * ── LE DÉFAUT FERMÉ (lot SEC-SECRETS-0C.0.1) ────────────────────────────────
 * Ce module lisait :
 *
 *     process.env.APP_SESSION_SECRET || getKey('APP_SESSION_SECRET')
 *
 * Deux problèmes, et le second est le grave.
 *
 * 1. AUCUN PLANCHER DE LONGUEUR. `lib/auth/session.ts` exige 32 octets UTF-8
 *    depuis SEC-AUTH-0 ; ici, trois caractères suffisaient. La même racine
 *    d'identité était donc soumise à deux contrats différents selon qu'elle
 *    signait une session ou un jeton d'extension.
 *
 * 2. UN REPLI VERS LA BASE. `getKey` rend `store.get(name) || process.env[name]`,
 *    et `hydrateKeystore()` charge dans ce `store` TOUTES les lignes de
 *    `prospector_settings` — sans filtrer par `MANAGED_KEYS`, qui ne s'applique
 *    qu'à l'écriture. Une ligne `APP_SESSION_SECRET` posée en base — par une
 *    restauration, un import, ou quelqu'un ayant la clé de service — devenait
 *    donc la clé de signature des jetons d'extension, PRIORITAIRE sur
 *    l'environnement dès que celui-ci était absent. Une racine de signature
 *    d'identité ne doit jamais pouvoir revenir de la base qu'elle protège.
 *
 * La source est désormais UNIQUE et partagée avec `session.ts` : environnement
 * seul, plancher unique. Il n'y a plus de second contrat à faire diverger.
 */
const secret = sessionSecret

const enc = new TextEncoder()
async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Version courante du jeton d'un espace. `null` si elle n'est pas vérifiable.
 *
 * ⚠️ PAS DE REPLI SUR 1. C'est une primitive de RÉVOCATION : un repli
 * ressusciterait les jetons de première génération dès que la base hoquette.
 *
 * ── DÉFAUT RÉEL CORRIGÉ (lot SEC-EXT-0.1) ───────────────────────────────────
 * La version précédente utilisait `listItems` dans un `try/catch`. Or
 * `listItems` ABSORBE les erreurs Supabase — `if (error || !data) return []` —
 * et ne rejette jamais : le `catch` ne se déclenchait pas, `[]` passait pour
 * « aucune ligne », et `it?.v || 1` rendait 1. Une panne de base revalidait
 * donc tous les jetons de première génération. J'avais affirmé que ce chemin
 * fermait ; il ne fermait pas, et seul un test qui simulait un `reject`
 * — ce que la vraie fonction ne fait jamais — le laissait croire.
 *
 * `getItemStrict` conserve la distinction entre « pas de ligne » et « pas de
 * réponse ». Lecture CIBLÉE au passage : on ne charge plus les versions de tous
 * les espaces pour en lire une.
 *
 * ── SECONDE PASSE (lot SEC-EXT-0.1b) ────────────────────────────────────────
 * Il restait un trou, et du même genre. Sans configuration Supabase,
 * `getItemStrict` bascule sur son repli MÉMOIRE et rend `{ok:true, value:null}`
 * — « la structure est en main, il n'y a pas de ligne ». C'est vrai d'un cache
 * local, et FAUX d'une révocation : une instance démarrée sans `SUPABASE_URL`
 * ou sans clé de service concluait « version 1 » et revalidait tous les jetons
 * de première génération. Une absence de configuration n'est pas une certitude.
 *
 * On vérifie donc explicitement la configuration AVANT de lire. Le repli
 * mémoire de `getItemStrict` reste utile à ses autres appelants — c'est ce
 * chemin de sécurité-ci qui refuse de s'en contenter.
 */
export async function getTokenVersion(wsId: string): Promise<number | null> {
  const id = (wsId || '').trim()
  if (!id) return null
  // Pas de base ⇒ aucune révocation vérifiable ⇒ aucun jeton valide.
  if (!supabaseConfigured()) return null
  const r = await getItemStrict<{ id: string; v: number }>(VER_KIND, id, VER_NS)
  if (!r.ok) return null                 // base muette ⇒ on ne sait pas ⇒ refus
  return r.value?.v || 1                 // absence de ligne ⇒ version initiale
}

/** Incrémente la version → révoque TOUS les jetons de cet espace, toutes portées. */
export async function bumpTokenVersion(wsId: string): Promise<number | null> {
  const cur = await getTokenVersion(wsId)
  if (cur === null) return null
  const v = cur + 1
  if (!(await upsertItem(VER_KIND, wsId, { id: wsId, v }, VER_NS))) return null
  return v
}

/**
 * Jeton d'un espace pour UNE capacité. `null` si le secret ou la version
 * manquent — on ne produit jamais un jeton qu'on ne saurait pas révoquer.
 *
 * La portée et l'espace entrent tous deux dans la donnée signée : en changer un
 * dans la chaîne rend l'empreinte invalide.
 */
export async function tokenForWorkspace(wsId: string, scope: ExtensionScope): Promise<string | null> {
  const key = secret()
  const id = (wsId || '').trim()
  if (!key || !id || !EXTENSION_SCOPES.includes(scope)) return null
  const v = await getTokenVersion(id)
  if (v === null) return null
  const h = await hmacHex(key, `ext:${scope}:${id}:${v}`)
  return `pk_${scope}_${id}_${h.slice(0, 40)}`
}

/**
 * Résout un jeton d'extension vers son espace, POUR LA CAPACITÉ DEMANDÉE.
 *
 * Rend `null` — et l'appelant doit refuser — dans tous les cas : format
 * inattendu, portée absente ou différente, secret absent, version non
 * vérifiable, empreinte fausse.
 *
 * ⚠️ AUCUN JETON GLOBAL D'ADMINISTRATION. `INGEST_TOKEN` ouvrait l'espace
 * `admin` sur ces mêmes routes : un jeton unique, partagé, jamais tourné,
 * donnant accès à l'espace de Smart AI depuis un navigateur client. Il n'est
 * plus reconnu ici. L'administration a ses propres canaux authentifiés.
 */
export async function resolveExtensionToken(
  token: string, required: ExtensionScope,
): Promise<string | null> {
  const key = secret()
  const t = (token || '').trim()
  if (!key || !t || !EXTENSION_SCOPES.includes(required)) return null

  // `pk_<portée>_<espace>_<40 hex>`. L'identifiant d'espace peut contenir des
  // `_`, mais l'empreinte est de longueur fixe : le découpage reste sans
  // ambiguïté, et rien n'est deviné.
  const m = t.match(/^pk_(capture|jarvis)_(.+)_([0-9a-f]{40})$/)
  if (!m) return null
  const [, scope, wsId, sig] = m
  if (scope !== required) return null   // portée signée ≠ portée exigée

  const v = await getTokenVersion(wsId)
  if (v === null) return null           // révocation non vérifiable ⇒ refus

  const expected = (await hmacHex(key, `ext:${scope}:${wsId}:${v}`)).slice(0, 40)
  return timingSafeEqual(sig, expected) ? wsId : null
}

/** Comparaison à temps constant : une empreinte se compare, elle ne se devine pas. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
