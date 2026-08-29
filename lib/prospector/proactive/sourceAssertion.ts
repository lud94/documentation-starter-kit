// SIGNAL_ARCHITECTURE_V1 — REGISTRE IMMUABLE DES ASSERTIONS DE SOURCE.
//
// ── CE QU'UNE ASSERTION SIGNIFIE, EXACTEMENT ────────────────────────────────
//
//   « CE document-ci a soutenu CETTE revendication canonique, et voici la
//     qualification que Prospector lui a donnée AU MOMENT de la décision. »
//
// Ce n'est PAS un CanonicalEvent, PAS l'agrégat Evidence, PAS un candidat, PAS
// une Situation, et surtout PAS un objet Source réutilisable globalement.
//
// ── LE DÉFAUT QUE CE REGISTRE EXISTE POUR ARRÊTER ───────────────────────────
// `Evidence.id` vaut `sha256(type|accountId|occurredAt)` : deux articles sur la
// même levée du 12 août rendent LE MÊME identifiant. C'est voulu — le Kernel
// doit voir UN fait. Mais `save()` écrit par `upsertItem`, qui REMPLACE le
// document entier. Donc :
//
//   requête 1 : source A adjugée → document { provenance A, corroboration [A] }
//   requête 2 : source B adjugée → document { provenance B, corroboration [B] }
//                                  ⇒ A N'EST PLUS RECONSTRUCTIBLE
//
// Ce n'est pas une course : deux requêtes strictement séquentielles suffisent.
// Le registre ne CORRIGE pas cet écrasement — il est suivi séparément sous
// `EVIDENCE_PROVENANCE_OVERWRITE_001`. Il en préserve la matière, pour qu'une
// perte de projection cesse d'être une perte d'histoire.
//
// ── POURQUOI L'AJOUT SEUL, ET JAMAIS LA FUSION ─────────────────────────────
// `prospector_store` n'offre ni fusion atomique, ni verrou optimiste, ni union
// JSONB. Tout objet qui AGRÈGE plusieurs sources dans un même document exige un
// lire-modifier-écrire, donc perd une écriture concurrente en silence. Ici,
// chaque assertion a sa PROPRE clé : il n'y a rien à fusionner, donc rien à
// perdre. La sûreté vient de la FORME du modèle, pas d'une garde qu'on pourrait
// oublier.
import { createHash } from 'node:crypto'

import { getItemStrict, insertItemIfAbsent } from '../../supabase/store'
import type { KnownEvidenceEvent } from './catalog'
import type { EvidenceAcceptance, EvidenceProvenance } from './types'
import type { SourceEvidence } from './signalBridge'

/**
 * `kind` du magasin.
 *
 * ⚠️ VOLONTAIREMENT ABSENT DE `PROACTIVE_KIND_LIST`, et ce n'est pas un oubli.
 * `pages/api/store/index.ts` construit sa liste blanche à partir de cette
 * constante-là, et cette route accepte du NAVIGATEUR un `POST` (`upsertItem`)
 * et un `DELETE` sur tout `kind` autorisé. Y inscrire le registre le rendrait
 * inscriptible et effaçable par le client — un journal d'audit que son sujet
 * peut réécrire ne prouve rien.
 *
 * Même doctrine que `SIGNAL_CANDIDATE_KIND`, pour la même raison.
 */
export const SOURCE_ASSERTION_KIND = 'proactive_source_assertion'

/**
 * Drapeau d'activation — ENV UNIQUEMENT.
 *
 * ⚠️ PAS `getKey`. `getKey` consulte d'abord le magasin hydraté depuis
 * `prospector_settings` : une ligne en base pourrait alors activer ou éteindre
 * une couche d'audit depuis la surface qu'elle observe.
 *
 * Absent, vide ou illisible ⇒ ÉTEINT. On n'active pas un chemin d'écriture sur
 * une valeur qu'on n'a pas su lire.
 */
export function sourceAssertionsEnabled(): boolean {
  const brut = (process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS || '').trim().toLowerCase()
  return brut === '1' || brut === 'true'
}

/**
 * UNE assertion de source. Immuable une fois écrite.
 *
 * ⚠️ AUCUN VOCABULAIRE NOUVEAU. `EvidenceProvenance` et `EvidenceAcceptance`
 * viennent de `types.ts` : le registre décrit la MÊME qualification et la MÊME
 * adjudication que l'evidence, vues source par source. En redéclarer des
 * variantes créerait deux définitions du grade, et elles divergeraient.
 */
export interface SourceAssertion {
  id: string
  workspaceId: string
  accountId: string

  /** La revendication du monde que cette source soutient. */
  canonicalClaimKey: string

  /**
   * L'agrégat Evidence produit par cette promotion — RÉFÉRENCE, jamais identité.
   *
   * ⚠️ PLUSIEURS ASSERTIONS PARTAGENT DÉLIBÉRÉMENT LE MÊME `evidenceId`. C'est
   * la conséquence directe de la convergence canonique : deux sources du même
   * fait produisent un seul `Evidence.id`. Le faire entrer dans l'identité de
   * l'assertion les ferait se confondre — et rendrait ce registre inutile.
   */
  evidenceId: string
  evidenceType: string

  /** URL NORMALISÉE. C'est elle qui distingue une assertion d'une autre. */
  sourceUrl: string

  /** Qualification de CETTE source-ci, au moment de la décision. */
  provenance: EvidenceProvenance

  /** Instant d'adjudication. N'est NI une date de publication NI une date de survenue. */
  observedAt: string

  acceptance?: EvidenceAcceptance
}

// ── NORMALISATION D'URL — CONSERVATRICE, ET C'EST TOUT L'ENJEU ──────────────
//
// ⚠️ AUCUN NORMALISEUR DE DOCUMENT N'EXISTAIT. `hostOf` réduit à l'HÔTE : s'en
// servir ici ferait de tous les articles d'un même éditeur UNE seule source.
// `extractWebsite` (datagouv) concerne le site d'une entreprise, pas un
// document. Celui-ci est donc le plus petit possible, et il est délibérément
// TIMIDE : chaque équivalence qu'il déclare est une fusion qu'on ne pourra plus
// défaire.
//
// CE QU'IL FAIT — transformations purement syntaxiques :
//   • rejette tout ce qui n'est pas http(s) — `mailto:`, `javascript:`, relatif
//   • minuscule le schéma et l'hôte (insensibles à la casse par la RFC)
//   • retire `www.` — même équivalence que `hostOf`, déjà employée par toute la
//     politique de grade et d'éditeur ; en diverger ici serait pire
//   • retire le FRAGMENT (`#…`) — il n'atteint jamais le serveur, deux ancres
//     d'une même page sont le même document
//   • conserve le PORT non par défaut — deux serveurs distincts le restent
//
// CE QU'IL NE FAIT PAS, ET POURQUOI :
//   • la QUERY est conservée TELLE QUELLE, non triée, non filtrée. Un document
//     adressé par `?id=42` n'est pas celui adressé par `?id=43`, et trier les
//     paramètres serait déjà une affirmation d'équivalence.
//   • la barre finale est conservée : `/a` et `/a/` PEUVENT être deux documents.
//   • aucun retrait d'`utm_*`, aucune résolution de redirection, aucun
//     dépliage de raccourcisseur. Toute forme d'équivalence agressive ferait
//     de DEUX assertions UNE seule, silencieusement.
//
// ⚠️ CONSÉQUENCE ASSUMÉE ET DITE : la même page atteinte par deux URL
// différentes (avec et sans `utm_source`) produit DEUX assertions. C'est un
// dédoublement VISIBLE. L'inverse serait une fusion INVISIBLE, et la doctrine
// du dépôt est qu'un doublon vaut mieux qu'un fait fabriqué.

/**
 * URL de document normalisée, ou `null` si elle est inexploitable.
 *
 * `null` ⇒ AUCUNE assertion. On n'invente pas une identité pour une source
 * qu'on n'a pas su lire.
 */
export function normalizeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t === '') return null

  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  // `u.host` porte l'hôte ET le port non par défaut — `hostname` perdrait le
  // port, donc fusionnerait deux serveurs distincts.
  const host = u.host.toLowerCase().replace(/^www\./, '')
  if (host === '') return null

  return `${u.protocol}//${host}${u.pathname}${u.search}`
}

/**
 * Identité DÉTERMINISTE d'une assertion.
 *
 * ⚠️ `\n` COMME SÉPARATEUR, DÉLIBÉRÉMENT. Une URL normalisée ne peut pas en
 * contenir (`new URL` l'encoderait) et une clé canonique non plus. Un séparateur
 * qu'un champ pourrait contenir rendrait deux triplets distincts congruents.
 *
 * ⚠️ L'ESPACE ENTRE DANS LE CONDENSAT, EN DÉFENSE EN PROFONDEUR. Comme pour
 * `candidateId`, ce n'est PAS là que le cloisonnement se joue : la garde réelle
 * est la lecture cloisonnée par `(kind, id, workspace_id)` et la RLS. On le
 * garde pour qu'un identifiant ne voyage pas d'un espace à l'autre, sans le
 * présenter comme la garde.
 */
export function sourceAssertionId(
  workspaceId: string, canonicalClaimKey: string, normalizedUrl: string,
): string {
  const charge = `source-assertion:v1:${workspaceId}\n${canonicalClaimKey}\n${normalizedUrl}`
  return `sa_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

export interface AssertionBuildInput {
  workspaceId: string
  accountId: string
  canonicalClaimKey: string
  evidence: KnownEvidenceEvent
  /**
   * TOUTES les sources qualifiantes de cette promotion.
   *
   * ⚠️ PAS `evidence.source`. Celui-ci ne décrit QUE la source principale
   * (`urls[0]`) : construire le registre depuis lui perdrait le grade, la
   * lignée et l'ancrage de toutes les autres — c'est-à-dire exactement ce que
   * ce registre existe pour conserver.
   */
  qualifyingSources: readonly SourceEvidence[]
}

/**
 * UNE assertion PAR SOURCE QUALIFIANTE.
 *
 * ⚠️ CHAQUE ASSERTION PORTE SA PROPRE PROVENANCE. Recopier celle de la source
 * principale sur les autres attribuerait à un agrégateur le grade d'un registre
 * officiel — un mensonge d'audit, pas une approximation.
 *
 * Pure : aucune horloge, aucun aléa, aucune I/O. Deux exécutions rendent le
 * même tableau, dans le même ordre.
 */
export function buildSourceAssertions(input: AssertionBuildInput): SourceAssertion[] {
  const ws = typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (ws === '') return []
  if (!input?.evidence?.id || !input?.canonicalClaimKey || !input?.accountId) return []

  const out: SourceAssertion[] = []
  const vus = new Set<string>()

  for (const s of input.qualifyingSources ?? []) {
    const url = normalizeSourceUrl(s?.url)
    if (!url) continue // source illisible ⇒ aucune assertion, jamais une inventée

    const id = sourceAssertionId(ws, input.canonicalClaimKey, url)
    if (vus.has(id)) continue // même document deux fois dans un même lot
    vus.add(id)

    // ⚠️ CONSTRUITE DEPUIS `s`, ET DE `s` SEULEMENT.
    const provenance: EvidenceProvenance = {
      ...(s.publisher ? { publisher: s.publisher } : {}),
      grade: s.grade,
      lineage: s.lineage.kind,
      grounding: s.grounding.kind,
      // ⚠️ ABSENTE SI INCONNUE. Jamais `observedAt`, jamais `retrievedAt` : la
      // date de publication d'un document ne se déduit d'aucun instant que nous
      // connaissons, et la fabriquer serait le faux zéro qu'on s'interdit.
      ...(s.sourcePublishedAt ? { sourcePublishedAt: s.sourcePublishedAt } : {}),
      ...(s.retrievedAt ? { retrievedAt: s.retrievedAt } : {}),
    }

    out.push({
      id,
      workspaceId: ws,
      accountId: input.accountId,
      canonicalClaimKey: input.canonicalClaimKey,
      evidenceId: input.evidence.id,
      evidenceType: String(input.evidence.type),
      sourceUrl: url,
      provenance,
      observedAt: input.evidence.observedAt,
      ...(input.evidence.acceptance ? { acceptance: input.evidence.acceptance } : {}),
    })
  }

  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** Garde de forme, appliquée AVANT écriture et à la relecture. */
export function isSourceAssertion(v: any): v is SourceAssertion {
  const nonVide = (x: unknown) => typeof x === 'string' && x.trim() !== ''
  if (!v || typeof v !== 'object') return false
  if (!nonVide(v.id) || !nonVide(v.workspaceId) || !nonVide(v.accountId)) return false
  if (!nonVide(v.canonicalClaimKey) || !nonVide(v.evidenceId) || !nonVide(v.evidenceType)) return false
  if (!nonVide(v.sourceUrl)) return false
  if (!nonVide(v.observedAt)) return false
  if (!v.provenance || typeof v.provenance !== 'object' || Array.isArray(v.provenance)) return false
  // L'identité doit être RECALCULABLE depuis le contenu : une assertion dont
  // l'identifiant ne correspond plus à ses champs a été déplacée d'une
  // revendication vers une autre.
  return v.id === sourceAssertionId(v.workspaceId, v.canonicalClaimKey, v.sourceUrl)
}

export type AssertionWrite =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'invalid' | 'write_failed' }

/**
 * Écrit UNE assertion — INSERTION SEULE, jamais un `upsert`.
 *
 * ⚠️ `upsertItem` REMPLACERAIT l'instantané historique par la politique
 * d'aujourd'hui. Un registre qu'un rejeu réécrit ne conserve rien : il affirme
 * simplement que le passé ressemblait au présent.
 *
 * `insertItemIfAbsent` rend `false` aussi bien pour « la ligne existe déjà »
 * que pour « la base n'a pas répondu ». On RELIT donc pour trancher — cette
 * relecture ne modifie rien et ne sert qu'à distinguer l'idempotence d'une
 * panne. Sans elle, un échec d'écriture passerait pour un doublon paisible.
 */
export async function saveSourceAssertion(
  assertion: SourceAssertion, ws: string,
): Promise<AssertionWrite> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'invalid' }
  // ⚠️ L'ESPACE DE L'ASSERTION DOIT ÊTRE CELUI DE LA SESSION. Écrire dans `ws`
  // un document qui se déclare d'un autre espace créerait une ligne dont le
  // contenu contredit son cloisonnement.
  if (!isSourceAssertion(assertion) || assertion.workspaceId !== ws) {
    return { ok: false, reason: 'invalid' }
  }

  if (await insertItemIfAbsent(SOURCE_ASSERTION_KIND, assertion.id, assertion, ws)) {
    return { ok: true, created: true }
  }

  const relu = await getItemStrict<SourceAssertion>(SOURCE_ASSERTION_KIND, assertion.id, ws)
  if (relu.ok === true && relu.value) return { ok: true, created: false }
  return { ok: false, reason: 'write_failed' }
}

/** Ce qu'une session d'enregistrement a réellement produit. */
export interface LedgerReport {
  created: number
  existing: number
  failed: number
}

/**
 * Enregistre le registre d'UN lot de promotions — NE JETTE JAMAIS.
 *
 * ⚠️ CETTE GARANTIE VIT ICI, PAS DANS LA ROUTE. Écrite en ligne dans
 * `promote.ts`, elle n'était vérifiable par aucun test : il n'existe aucun moyen
 * d'observer qu'un `try` inline enveloppe bien tout le chemin. Ici, c'est une
 * propriété d'une unité testable, et un mutant qui retire la protection meurt.
 *
 * ⚠️ POURQUOI ELLE COMPTE. Une adjudication humaine ne doit jamais être annulée
 * parce qu'un journal d'audit est indisponible : l'utilisateur a confirmé un
 * fait, et l'indisponibilité du registre ne rend pas ce fait faux. Le registre
 * est SECONDAIRE — c'est ce mot qui décide du sens de la dépendance.
 *
 * Rend un compte-rendu que l'appelant journalise ; il n'entre dans aucune
 * réponse HTTP.
 */
export async function recordSourceAssertions(
  promotions: readonly AssertionBuildInput[], ws: string,
): Promise<LedgerReport> {
  const bilan: LedgerReport = { created: 0, existing: 0, failed: 0 }
  try {
    for (const p of promotions) {
      for (const a of buildSourceAssertions({ ...p, workspaceId: ws })) {
        try {
          const r = await saveSourceAssertion(a, ws)
          if (r.ok === false) bilan.failed++
          else if (r.created) bilan.created++
          else bilan.existing++
        } catch {
          // Une assertion en échec n'interrompt pas les suivantes : perdre le
          // reste du lot parce qu'une ligne a échoué aggraverait la perte que
          // ce registre existe pour éviter.
          bilan.failed++
        }
      }
    }
  } catch {
    bilan.failed++
  }
  return bilan
}

/** Relecture d'une assertion, DANS SON ESPACE. */
export function readSourceAssertion(id: string, ws: string) {
  return getItemStrict<SourceAssertion>(SOURCE_ASSERTION_KIND, id, ws)
}
