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
import { isStrictInstant } from './types'
import type { EvidenceAcceptance, EvidenceProvenance, EvidenceTemporality } from './types'
import type { SourceEvidence } from './signalBridge'
import type { AcquisitionFactV2 } from '../../../types/prospector'
import { assertedFactHash, isAcquisitionFactV2 } from './acquisitionV2'

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

  /**
   * Instant d'ADJUDICATION — inchangé, et NON RESÉMANTISÉ.
   *
   * ⚠️ IL N'ENTRE DANS AUCUNE IDENTITÉ. Ni celle d'un événement, ni celle d'un
   * état. C'est une donnée d'audit : quand ce fait est-il né dans le moteur.
   */
  observedAt: string

  /**
   * Nature temporelle de la revendication — SÉLECTIONNE la fonction d'identité.
   *
   * ⚠️ TRANSPORTÉE, JAMAIS REDEVINÉE. L'alternative serait de renifler
   * `canonicalClaimKey.endsWith('|STATE')` : une seconde implémentation de la
   * règle de `canonicalClaimKey`, dans un module qui ne la possède pas. Deux
   * algorithmes pour une même distinction divergent toujours.
   *
   * ⚠️ AUCUN VOCABULAIRE NOUVEAU : c'est `EvidenceTemporality` de `types.ts`,
   * portée telle quelle depuis l'evidence promue.
   */
  assertionTemporality: EvidenceTemporality

  /**
   * Jour UTC où la SOURCE a été observée — présent SI ET SEULEMENT SI l'état.
   *
   * ⚠️ DÉRIVÉ DE `retrievedAt`, JAMAIS DE `observedAt`. Voir `sourceObservedDay`.
   * Persisté parce qu'il entre dans l'identité : un champ d'identité doit être
   * lisible pour que l'identité reste auditable et recalculable.
   */
  sourceObservedDay?: string

  acceptance?: EvidenceAcceptance

  /**
   * INSTANTANÉ SÉMANTIQUE affirmé par CETTE source (contrat V2) — PERSISTÉ EN
   * ENTIER, jamais réduit à son condensat : le condensat vérifie, l'instantané
   * reconstruit. Présents ENSEMBLE ou absents ENSEMBLE (assertion V1 héritée).
   *
   * ⚠️ SÉMANTIQUE ÉLARGIE (E2E_BRIDGE_001_R1, arbitrage A) : une assertion V2
   * signifie « CETTE source a affirmé CETTE VERSION SÉMANTIQUE de cette
   * revendication ». Même URL + même revendication n'est PLUS automatiquement
   * un rejeu : une correction éditoriale (10 M€ → 12 M€) est une NOUVELLE
   * assertion immuable, pas un rejeu écarté. Le rejeu n'existe que quand le
   * fait sémantique est identique lui aussi.
   */
  structuredFact?: AcquisitionFactV2
  /** Condensat de la PROJECTION SÉMANTIQUE fermée — entre dans l'identité V2. */
  assertedFactHash?: string
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
 *
 * ⚠️ QUATRIÈME SEGMENT POUR LES ÉTATS SEULEMENT — voir `sourceObservedDay`.
 * Un événement daté en a TROIS, un état en a QUATRE. L'identité d'un événement
 * déjà écrit reste donc OCTET POUR OCTET la même : ce paramètre est absent sur
 * ce chemin, et la charge condensée est inchangée. Aucune migration.
 */
export function sourceAssertionId(
  workspaceId: string,
  canonicalClaimKey: string,
  normalizedUrl: string,
  sourceObservedDay?: string,
): string {
  const base = `source-assertion:v1:${workspaceId}\n${canonicalClaimKey}\n${normalizedUrl}`
  const charge = sourceObservedDay ? `${base}\n${sourceObservedDay}` : base
  return `sa_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * Identité V2 — VERSIONNÉE PAR LE CONTENU SÉMANTIQUE (arbitrage A).
 *
 * ⚠️ ESPACE DE NOMS DISTINCT (`source-assertion:v2:`) : l'algorithme V1 et ses
 * identités déjà écrites restent octet pour octet inchangés. Aucune migration,
 * aucun backfill.
 *
 *   ÉVÉNEMENT : ws \n claimKey \n url \n factHash
 *   ÉTAT      : ws \n claimKey \n url \n jourObservé \n factHash
 *
 * ⚠️ NI `retrievedAt` NI `observedAt` dans l'identité d'un événement. Rejouer
 * la même page inchangée un autre jour EST un rejeu ; seul un fait sémantique
 * différent fait une assertion nouvelle. Pour un ÉTAT, le jour d'observation
 * reste souverain (doctrine temporelle inchangée) : même jour + même fait ⇒
 * rejeu ; même jour + fait changé ⇒ nouvelle assertion ; autre jour ⇒ nouvelle
 * assertion même à fait identique — c'est l'historique d'observation.
 */
export function sourceAssertionIdV2(
  workspaceId: string,
  canonicalClaimKey: string,
  normalizedUrl: string,
  factHash: string,
  sourceObservedDay?: string,
): string {
  const base = `source-assertion:v2:${workspaceId}\n${canonicalClaimKey}\n${normalizedUrl}`
  const charge = sourceObservedDay
    ? `${base}\n${sourceObservedDay}\n${factHash}`
    : `${base}\n${factHash}`
  return `sa_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * JOUR UTC D'OBSERVATION DE LA SOURCE — dérivé de `retrievedAt`, et de lui seul.
 *
 * ── LA HORLOGE QU'IL FAUT, ET CELLE QU'IL NE FAUT PAS ──────────────────────
 * Quatre instants distincts cohabitent, et les confondre falsifie l'histoire :
 *
 *   `sourcePublishedAt`      quand la source a été publiée
 *   `retrievedAt`            quand PROSPECTOR a récupéré le document   ← CELUI-CI
 *   `Evidence.observedAt`    quand l'evidence est née dans le moteur
 *   `acceptance.confirmedAt` quand une personne a adjugé
 *
 * ⚠️ POURQUOI PAS `Evidence.observedAt`. En production, `promote.ts` l'écrit
 * avec `new Date().toISOString()` : c'est l'instant de l'ADJUDICATION. Une page
 * carrière récupérée le 1er septembre et confirmée le 5 serait alors versionnée
 * au 5 — l'état du monde du 1er serait enregistré sous une date à laquelle
 * personne ne l'a observé. Sur une source MUTABLE, c'est une falsification
 * d'historique, pas un décalage.
 *
 * ⚠️ STRICT, PAS `validDate`. `Date.parse` NORMALISE : `2026-09-01T24:00:00Z` y
 * devient le 2 septembre. Un jour dérivé d'une lecture permissive déplacerait
 * donc l'identité en silence. `isStrictInstant` refuse la forme, et le refus
 * vaut ABSENCE D'ASSERTION — jamais un jour deviné.
 *
 * ⚠️ JOUR UTC, JAMAIS LOCAL. Aucun fuseau n'est connu de l'espace client ; en
 * inventer un serait pire que d'assumer UTC. Conséquence dite : une observation
 * à 01 h 30 à Paris le 2 septembre est enregistrée au 1er.
 */
export function sourceObservedDay(retrievedAt: unknown): string | null {
  if (!isStrictInstant(retrievedAt)) return null
  const ms = Date.parse(retrievedAt as string)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
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

    // ── UN ÉTAT EST VERSIONNÉ PAR JOUR D'OBSERVATION, UN ÉVÉNEMENT NON ────
    // ⚠️ LA COLLISION QUE CECI FERME. `canonicalClaimKey` d'un état vaut
    // `sales_hiring|<compte>|STATE` — constante dans le temps. Même URL + même
    // compte rendaient donc LE MÊME identifiant à jamais, et comme l'écriture
    // est une INSERTION, la seconde observation n'était pas écrasée : elle
    // n'était SILENCIEUSEMENT PAS ENREGISTRÉE, avec un retour
    // `{ ok: true, created: false }` indiscernable d'un rejeu légitime.
    //
    // ⚠️ L'ÉVÉNEMENT NE CHANGE PAS. Ajouter un jour à son identité ferait de
    // deux découvertes du même fait daté deux assertions — exactement la fausse
    // nouveauté que ce registre existe pour empêcher.
    const etat = input.evidence.temporality === 'undated_state'
    let jour: string | undefined
    if (etat) {
      const derive = sourceObservedDay(s.retrievedAt)
      // ⚠️ SANS INSTANT DE RÉCUPÉRATION STRICT, AUCUNE ASSERTION D'ÉTAT. On ne
      // sait pas QUAND cet état a été observé ; le dater d'autre chose
      // inventerait la seule information qui fait l'identité. L'adjudication,
      // elle, reste parfaitement valide.
      if (!derive) continue
      jour = derive
    }

    // ── FAIT STRUCTURÉ V2 : PAR SOURCE, JAMAIS RECOPIÉ DE LA PRINCIPALE ────
    // ⚠️ CHAQUE SOURCE AFFIRME SON PROPRE FAIT. Source A dit 10 M€, source B
    // dit 12 M€ : recopier le fait de la principale attribuerait à B un montant
    // qu'elle n'a jamais publié. Présent mais malformé ⇒ AUCUNE assertion pour
    // cette source (fail closed), jamais un repli V1 silencieux.
    const v2 = s.hit?.v2
    let empreinte: string | undefined
    if (v2 !== undefined) {
      if (!isAcquisitionFactV2(v2)) continue
      const h = assertedFactHash(v2, input.accountId)
      if (h === null) continue
      empreinte = h
    }

    const id = empreinte
      ? sourceAssertionIdV2(ws, input.canonicalClaimKey, url, empreinte, jour)
      : sourceAssertionId(ws, input.canonicalClaimKey, url, jour)
    if (vus.has(id)) continue // même document, même jour, même fait, dans un même lot
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
      assertionTemporality: input.evidence.temporality,
      ...(jour ? { sourceObservedDay: jour } : {}),
      ...(input.evidence.acceptance ? { acceptance: input.evidence.acceptance } : {}),
      // ⚠️ L'INSTANTANÉ ENTIER, PAS SEULEMENT SON CONDENSAT. Le condensat
      // vérifie l'identité ; l'instantané permet la reconstruction et l'audit.
      ...(empreinte ? { structuredFact: v2, assertedFactHash: empreinte } : {}),
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

  // ⚠️ LE JOUR EST PRÉSENT SI ET SEULEMENT SI L'ASSERTION EST UN ÉTAT. Un
  // événement qui en porterait un, ou un état qui n'en porterait pas, décrit
  // une identité que ce module n'a pas pu produire.
  if (v.assertionTemporality === 'undated_state') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.sourceObservedDay)) return false
  } else if (v.assertionTemporality === 'dated_event') {
    if (v.sourceObservedDay !== undefined) return false
  } else {
    return false
  }

  // ── V2 : L'INSTANTANÉ ET SON CONDENSAT VONT ENSEMBLE, OU PAS DU TOUT ─────
  // ⚠️ Un condensat sans instantané ne reconstruit rien ; un instantané sans
  // condensat n'est pas vérifiable. Et le condensat est RECALCULÉ depuis
  // l'instantané : un fait substitué sous une identité existante ne peut pas
  // se faire passer pour elle.
  const aFait = v.structuredFact !== undefined
  const aHash = v.assertedFactHash !== undefined
  if (aFait !== aHash) return false
  if (aFait) {
    if (!isAcquisitionFactV2(v.structuredFact)) return false
    const recalcule = assertedFactHash(v.structuredFact, v.accountId)
    if (recalcule === null || recalcule !== v.assertedFactHash) return false
    return v.id === sourceAssertionIdV2(
      v.workspaceId, v.canonicalClaimKey, v.sourceUrl, recalcule, v.sourceObservedDay,
    )
  }

  // L'identité doit être RECALCULABLE depuis le contenu : une assertion dont
  // l'identifiant ne correspond plus à ses champs a été déplacée d'une
  // revendication vers une autre — ou d'un jour d'observation vers un autre.
  return v.id === sourceAssertionId(
    v.workspaceId, v.canonicalClaimKey, v.sourceUrl, v.sourceObservedDay,
  )
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

  /**
   * Identifiants des assertions DURABLEMENT présentes en base.
   *
   * ⚠️ « DURABLE » NE VEUT PAS DIRE « CONSTRUIT ». Une assertion rendue par
   * `buildSourceAssertions` n'est qu'un objet en mémoire ; seule une écriture
   * confirmée — créée, ou relue avec succès — atteste qu'elle survivra à la
   * requête. Une projection dérivée qui se fierait à l'objet en mémoire
   * pourrait exister sans le moindre appui persistant.
   *
   * ⚠️ UN `write_failed` N'Y ENTRE JAMAIS. `insertItemIfAbsent` rend `false`
   * pour « existe déjà » ET pour « base muette » ; `saveSourceAssertion`
   * tranche par une relecture, et une relecture qui échoue reste un ÉCHEC.
   * Un faux ambigu n'est pas un succès durable.
   */
  durableIds: string[]
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
  const bilan: LedgerReport = { created: 0, existing: 0, failed: 0, durableIds: [] }
  try {
    for (const p of promotions) {
      for (const a of buildSourceAssertions({ ...p, workspaceId: ws })) {
        try {
          const r = await saveSourceAssertion(a, ws)
          if (r.ok === false) bilan.failed++
          else {
            // Créée OU relue : dans les deux cas la ligne EST en base.
            if (r.created) bilan.created++
            else bilan.existing++
            bilan.durableIds.push(a.id)
          }
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
