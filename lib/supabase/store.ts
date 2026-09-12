// Magasin générique cloisonné par espace : séquences, tâches, conversations…
// Table `prospector_store (kind text, id text, workspace_id text, data jsonb, updated_at)`
// clé primaire (kind, id, workspace_id). Repli mémoire (globalThis) sans Supabase.
import { supabase } from './client'
import { writeAllowed } from '../env'

const TABLE = 'prospector_store'
const g = globalThis as any
// mem: `${kind}|${ws}|${id}` -> data
const mem: Map<string, any> = g.__prospectorStore || (g.__prospectorStore = new Map())
const key = (kind: string, ws: string, id: string) => `${kind}|${ws}|${id}`

export async function listItems<T = any>(kind: string, ws: string): Promise<T[]> {
  const sb = supabase()
  if (!sb) {
    const out: T[] = []
    Array.from(mem.entries()).forEach(([k, v]) => { if (k.startsWith(`${kind}|${ws}|`)) out.push(v) })
    return out
  }
  try {
    const { data, error } = await sb.from(TABLE).select('data').eq('kind', kind).eq('workspace_id', ws).order('updated_at', { ascending: false })
    if (error || !data) return []
    return data.map((r: any) => r.data as T)
  } catch { return [] }
}

/**
 * Lecture STRICTE d'une collection : « vide » et « injoignable » restent DEUX
 * réponses distinctes.
 *
 * ⚠️ POURQUOI `listItems` NE SUFFIT PAS. Il rend `[]` aussi bien pour une
 * collection réellement vide que pour une panne — `if (error || !data) return []`.
 * Un appelant qui RAISONNE sur l'absence conclut alors « il n'y a rien » là où
 * la vérité est « je ne sais pas ». Tant que l'absence ne fait que retirer des
 * résultats, l'indulgence est tolérable ; dès qu'elle CHANGE une décision, elle
 * fabrique une conclusion à partir d'une panne.
 *
 * Même contrat que `getItemStrict`, à la collection près — y compris le repli
 * mémoire, où l'absence est certaine parce que la structure est en main.
 */
export async function listItemsStrict<T = any>(
  kind: string, ws: string,
): Promise<{ ok: true; values: T[] } | { ok: false }> {
  const sb = supabase()
  if (!sb) {
    const out: T[] = []
    Array.from(mem.entries()).forEach(([k, v]) => { if (k.startsWith(`${kind}|${ws}|`)) out.push(v) })
    return { ok: true, values: out }
  }
  try {
    const { data, error } = await sb.from(TABLE).select('data')
      .eq('kind', kind).eq('workspace_id', ws).order('updated_at', { ascending: false })
    if (error || !data) return { ok: false }
    return { ok: true, values: data.map((r: any) => r.data as T) }
  } catch {
    return { ok: false }
  }
}

// Lecture CIBLÉE d'un élément par sa clé primaire (kind, id, workspace_id).
//
// POURQUOI (lot MT-0b). `listItems()` charge toute la collection puis
// l'appelant filtre en mémoire — acceptable pour quelques dizaines de lignes,
// pas pour un cache de résultats IA à mesure que les clients se multiplient.
// La clé primaire de `prospector_store` est exactement (kind, id,
// workspace_id) : cette lecture est un accès par index, pas un balayage.
export async function getItem<T = any>(kind: string, id: string, ws: string): Promise<T | null> {
  const sb = supabase()
  if (!sb) return (mem.get(key(kind, ws, id)) as T) ?? null
  try {
    const { data, error } = await sb.from(TABLE).select('data')
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws).maybeSingle()
    if (error || !data) return null
    return (data as any).data as T
  } catch { return null }
}

/**
 * LECTURE STRICTE — distingue « absent » de « illisible ».
 *
 * ── LE DÉFAUT QUE CECI FERME (lot SEC-EXT-0.1) ──────────────────────────────
 * `listItems` et `getItem` absorbent les erreurs : `if (error || !data) return
 * []` puis `catch { return [] }`. Pour lire des séquences ou des missions, ce
 * silence est raisonnable — une liste vide dégrade l'affichage, rien de plus.
 *
 * Il devient FAUX dès que l'absence a un sens de sécurité. `getTokenVersion`
 * lisait la version d'un jeton avec `listItems` : une panne rendait `[]`, donc
 * « aucune ligne », donc la version initiale 1 — et un ancien jeton de première
 * génération, pourtant révoqué, redevenait valide. J'avais écrit que ce chemin
 * fermait ; il ne fermait pas, parce que la primitive sous-jacente ment.
 *
 * Ici, les trois issues restent distinctes :
 *   { ok: true,  value: T    }   la ligne existe
 *   { ok: true,  value: null }   la base a répondu, il n'y a pas de ligne
 *   { ok: false }                la base n'a pas répondu — on ne sait pas
 *
 * ⚠️ `getItem` et `listItems` ne changent PAS de contrat : leurs appelants
 * historiques comptent sur leur indulgence. On ajoute une primitive, on ne
 * réécrit pas celle de tout le monde.
 */
export type StrictRead<T> = { ok: true; value: T | null } | { ok: false }

export async function getItemStrict<T = any>(
  kind: string, id: string, ws: string,
): Promise<StrictRead<T>> {
  const sb = supabase()
  if (!sb) {
    // Repli mémoire : la structure est en main, l'absence est certaine.
    return { ok: true, value: (mem.get(key(kind, ws, id)) as T) ?? null }
  }
  try {
    const { data, error } = await sb.from(TABLE).select('data')
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws).maybeSingle()
    // `maybeSingle` rend `data: null` sans erreur quand il n'y a pas de ligne :
    // c'est exactement la distinction qu'on veut conserver.
    if (error) return { ok: false }
    return { ok: true, value: data ? ((data as any).data as T) : null }
  } catch {
    return { ok: false }
  }
}

export async function upsertItem(kind: string, id: string, data: any, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) { mem.set(key(kind, ws, id), data); return true }
  try {
    const { error } = await sb.from(TABLE).upsert({ kind, id, workspace_id: ws, data, updated_at: new Date().toISOString() }, { onConflict: 'kind,id,workspace_id' })
    return !error
  } catch { return false }
}

/**
 * RÉCLAMATION ATOMIQUE — supprime et REND la ligne supprimée, ou `null`.
 *
 * ── POURQUOI (lot SEC-0d) ────────────────────────────────────────────────────
 * `listItems` → `find` → `deleteItem` est un check-then-act : deux requêtes
 * concurrentes lisent la même ligne avant que l'une ne la supprime, et toutes
 * deux croient l'avoir obtenue. Sur du serverless multi-instance, ce n'est pas
 * une hypothèse d'école : les instances sont réellement parallèles.
 *
 * Ici, un SEUL `DELETE … RETURNING` : PostgreSQL verrouille la ligne pour la
 * durée de l'instruction, la première transaction l'emporte, et la seconde ne
 * trouve plus rien à supprimer. Le gagnant est celui qui reçoit une ligne —
 * pas celui qui l'a lue. C'est la primitive « au plus un » qu'exige un secret à
 * usage unique, et elle ne demande AUCUNE migration : la table et sa clé
 * primaire `(kind, id, workspace_id)` existent déjà.
 */
export async function claimItem<T = any>(kind: string, id: string, ws: string): Promise<T | null> {
  if (!writeAllowed('prospector_store')) return null
  const sb = supabase()
  if (!sb) {
    // Repli mémoire : `Map.delete` rend `true` une seule fois, et JavaScript
    // n'interrompt pas entre la lecture et la suppression. Même garantie.
    const k = key(kind, ws, id)
    const v = mem.get(k)
    return mem.delete(k) ? ((v as T) ?? null) : null
  }
  try {
    const { data, error } = await sb.from(TABLE).delete()
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws).select('data')
    if (error || !data || data.length === 0) return null
    return (data[0] as any).data as T
  } catch { return null }
}

/**
 * RÉCLAMATION CONDITIONNELLE — supprime la ligne SEULEMENT si l'un de ses
 * champs porte encore la valeur attendue, et rend la donnée supprimée.
 *
 * ── LE DÉFAUT QUE CECI FERME (lot SEC-0f.1) ──────────────────────────────────
 * `claimItem` supprime inconditionnellement. Un appelant qui veut « consommer
 * la ligne SI elle vaut encore X » doit donc lire d'abord — et c'est un
 * check-then-act, avec toute sa fenêtre :
 *
 *     R1  claimItem(paircode, OLD)            → obtient le pointeur
 *     R1  getItem(pairactive, ws)             → lit { code: OLD }   ✔ concorde
 *     R2  rotation : supprime OLD, pose NEW
 *     R1  claimItem(pairactive, ws)           → supprime NEW !
 *
 * Deux dégâts, pas un seul : le code OLD, pourtant RÉVOQUÉ, aboutit à un
 * appairage ; et le titulaire NEW est détruit, donc le code fraîchement émis
 * devient irrachetable pour son destinataire légitime.
 *
 * Ici, la comparaison ET la suppression sont la MÊME instruction :
 * `DELETE … WHERE … AND data->>champ = attendu RETURNING data`. Si le titulaire
 * a changé entre-temps, zéro ligne revient — et surtout, rien n'est supprimé.
 *
 * `field` est validé : il est interpolé dans le chemin de filtre PostgREST, et
 * un identifiant libre y serait une surface d'injection. Les appelants ne
 * passent que des constantes de module, mais on ne s'en remet pas à cela.
 */
export async function claimItemIfField<T = any>(
  kind: string, id: string, ws: string, field: string, expected: string,
): Promise<T | null> {
  if (!writeAllowed('prospector_store')) return null
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return null
  const sb = supabase()
  if (!sb) {
    const k = key(kind, ws, id)
    const v = mem.get(k)
    // Comparaison et suppression sans await entre les deux : JavaScript
    // n'interrompt pas ici, la garantie est la même.
    if (!v || (v as any)?.[field] !== expected) return null
    return mem.delete(k) ? ((v as T) ?? null) : null
  }
  try {
    const { data, error } = await sb.from(TABLE).delete()
      .eq('kind', kind).eq('id', id).eq('workspace_id', ws)
      .eq(`data->>${field}`, expected)
      .select('data')
    if (error || !data || data.length === 0) return null
    return (data[0] as any).data as T
  } catch { return null }
}

/**
 * INSERTION EXCLUSIVE — rend `true` à UN SEUL appelant pour une clé donnée.
 *
 * ── POURQUOI (lot SEC-0e) ────────────────────────────────────────────────────
 * `upsertItem` porte `onConflict` : par construction, il n'échoue JAMAIS sur
 * une clé déjà prise, il écrase. C'est ce qu'on veut pour une donnée, et
 * exactement ce qu'on ne veut pas pour une RÉSERVATION.
 *
 * Ici, un `INSERT` nu. La clé primaire `(kind, id, workspace_id)` — qui existe
 * déjà — devient le mécanisme d'exclusion : PostgreSQL sérialise les insertions
 * concurrentes sur la même clé, la première réussit, les autres reçoivent
 * `23505 unique_violation`. Aucune fenêtre entre un test et une écriture,
 * puisqu'il n'y a pas de test.
 *
 * C'est le pendant de `claimItem` : l'un réclame une ligne existante, l'autre
 * réclame une clé libre. Ensemble ils couvrent « au plus un » dans les deux
 * sens, sans migration.
 *
 * ⚠️ Toute erreur autre qu'un conflit rend AUSSI `false` : un appelant qui
 * réserve un jeton d'autorisation doit échouer fermé quand la base ne répond
 * pas. Ne jamais interpréter une panne comme une réservation obtenue.
 */
export async function insertItemIfAbsent(kind: string, id: string, data: any, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) {
    // Repli mémoire : JavaScript n'interrompt pas entre le test et l'écriture.
    const k = key(kind, ws, id)
    if (mem.has(k)) return false
    mem.set(k, data)
    return true
  }
  try {
    const { error } = await sb.from(TABLE)
      .insert({ kind, id, workspace_id: ws, data, updated_at: new Date().toISOString() })
    return !error
  } catch { return false }
}

/**
 * PURGE PAR ÂGE — supprime les lignes d'un `kind` plus vieilles qu'un instant.
 *
 * ── POURQUOI (lot SEC-0f) ────────────────────────────────────────────────────
 * Les jetons de tentative d'appairage sont nommés par leur fenêtre. Le balayage
 * précédent ne nettoyait que la fenêtre `w-1` : un chat actif aux fenêtres 100,
 * 102, 104 laissait derrière lui celles de 100 et 102, définitivement. Le
 * contrat « au plus MAX_FAILURES lignes au repos par chat » était donc FAUX.
 *
 * Un balayage borné par identifiant est impossible ici : les fenêtres sautées
 * sont en nombre non borné, et l'identifiant ne permet pas de les énumérer.
 * D'où une purge par ÂGE, sur la colonne `updated_at` qui existe déjà. Aucun
 * changement de schéma : c'est une clause `WHERE`, pas une migration.
 *
 * ⚠️ COÛT ASSUMÉ. Sans index sur `updated_at`, PostgreSQL parcourt la table.
 * C'est acceptable parce que l'appel est RARE — déclenché par la création d'un
 * code d'appairage, une action d'administration — et jamais sur un chemin de
 * lecture. Le jour où `prospector_store` grossira, un index partiel sur
 * `(kind, workspace_id, updated_at)` sera le correctif, et il demandera une
 * migration.
 *
 * `ws` est TOUJOURS exigé : une purge qui traverserait les espaces serait une
 * suppression inter-tenants, c'est-à-dire exactement ce que ce lot combat.
 */
export async function deleteExpired(kind: string, ws: string, olderThanIso: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) {
    const cutoff = Date.parse(olderThanIso)
    for (const [k, v] of Array.from(mem.entries())) {
      if (!k.startsWith(`${kind}|${ws}|`)) continue
      const at = (v as any)?.at
      if (typeof at === 'number' && at < cutoff) mem.delete(k)
    }
    return true
  }
  try {
    const { error } = await sb.from(TABLE).delete()
      .eq('kind', kind).eq('workspace_id', ws).lt('updated_at', olderThanIso)
    return !error
  } catch { return false }
}

export async function deleteItem(kind: string, id: string, ws: string): Promise<boolean> {
  if (!writeAllowed('prospector_store')) return false
  const sb = supabase()
  if (!sb) { mem.delete(key(kind, ws, id)); return true }
  try {
    const { error } = await sb.from(TABLE).delete().eq('kind', kind).eq('id', id).eq('workspace_id', ws)
    return !error
  } catch { return false }
}
