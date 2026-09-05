// Intégration API Recherche d'entreprises (data.gouv / SIRENE-INSEE)
// https://recherche-entreprises.api.gouv.fr — publique, gratuite, sans clé.
// Renvoie des ENTREPRISES (pas des contacts) : SIREN, NAF, effectif, ville, dirigeant.
// Le persona/contact et le scoring signal se font en aval (LinkedIn/Unipile + gate).
import { ProviderError } from '../observability/safeError'

import type { SourcedCompany } from '../../types/prospector'

// Code tranche d'effectif INSEE → libellé
const TRANCHE: Record<string, string> = {
  '00': '0 salarié', '01': '1-2', '02': '3-5', '03': '6-9', '11': '10-19', '12': '20-49',
  '21': '50-99', '22': '100-199', '31': '200-249', '32': '250-499', '41': '500-999',
  '42': '1000-1999', '51': '2000-4999', '52': '5000-9999', '53': '10000+',
}

// Secteur (UI) → code NAF principal (best-effort)
// NB : l'API exige le NAF AVEC le point (ex. 62.01Z, pas 6201Z).
const SECTOR_TO_NAF: Record<string, string> = {
  'technology': '62.01Z', 'saas b2b': '62.01Z', 'ia / ml': '62.01Z', 'martech': '62.01Z',
  'cybersécurité': '62.02A', 'fintech': '64.19Z', 'finance': '64.19Z', 'consulting': '70.22Z',
  'real estate': '68.31Z', 'healthcare': '86.10Z', 'marketing': '73.11Z', 'media': '58.14Z',
  'logistics': '52.29B', 'construction': '41.20A', 'education': '85.59A', 'manufacturing': '25.99B',
  'retail': '47.11D', 'hospitality': '55.10Z', 'energy': '35.14Z', 'legal': '69.10Z',
}

// Taille (UI) → code(s) tranche effectif
const SIZE_TO_TRANCHE: Record<string, string> = {
  '1-10': '01,02,03', '11-20': '11', '21-50': '12', '51-100': '21',
  '101-250': '22,31', '251-500': '32', '501-1000': '41', '1000+': '42,51,52,53',
}

const CITY_TO_DEP: Record<string, string> = {
  'paris': '75', 'lyon': '69', 'marseille': '13', 'bordeaux': '33', 'lille': '59',
  'nantes': '44', 'toulouse': '31', 'nice': '06', 'strasbourg': '67', 'montpellier': '34', 'rennes': '35',
  'grenoble': '38', 'angers': '49', 'reims': '51', 'saint-étienne': '42', 'saint-etienne': '42',
  'toulon': '83', 'le havre': '76', 'dijon': '21', 'brest': '29', 'clermont-ferrand': '63',
  'aix-en-provence': '13', 'tours': '37', 'amiens': '80', 'metz': '57', 'nancy': '54',
  'orléans': '45', 'orleans': '45', 'rouen': '76', 'caen': '14', 'nîmes': '30', 'nimes': '30',
  'annecy': '74', 'versailles': '78', 'boulogne-billancourt': '92', 'nanterre': '92',
  'ile-de-france': '75', 'île-de-france': '75', 'idf': '75',
}

// Résout une localisation (ville, département, code postal) en code département.
// Renvoie null si non résolu → on retombera sur une recherche texte floue.
export function resolveDepartement(loc: string): string | null {
  const s = (loc || '').trim().toLowerCase()
  if (!s) return null
  if (/^\d{5}$/.test(s)) return s.slice(0, 2)   // code postal → département
  if (/^\d{2,3}$/.test(s)) return s             // département déjà saisi
  if (/^\d{2}[ab]$/i.test(s)) return s.toUpperCase() // Corse 2A/2B
  if (CITY_TO_DEP[s]) return CITY_TO_DEP[s]
  // Saisie mixte, ex. « Paris 75 », « 75 Paris », « Lyon 69 » → on extrait
  // d'abord un token département, sinon une ville connue.
  const tokens = s.split(/[\s,]+/).filter(Boolean)
  const depTok = tokens.find((t) => /^\d{2,3}$/.test(t) || /^\d{5}$/.test(t))
  if (depTok) return depTok.length === 5 ? depTok.slice(0, 2) : depTok
  for (const t of tokens) { if (CITY_TO_DEP[t]) return CITY_TO_DEP[t] }
  // dernier essai : la chaîne entière moins les chiffres (« paris 75 » → « paris »)
  const cityOnly = s.replace(/[\d]+/g, '').trim()
  return CITY_TO_DEP[cityOnly] || null
}

// Extrait un site web SEULEMENT s'il est réellement fourni par l'API (jamais deviné).
function extractWebsite(r: any): string | undefined {
  const raw = r?.complements?.site_web || r?.site_web || ''
  const s = String(raw).trim()
  if (!s || !/\./.test(s)) return undefined
  return s.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

export interface SourcingQuery { sector?: string; location?: string; size?: string; page?: number; activeOnly?: boolean }

// L'API plafonne per_page à 25 ; on pagine pour aller au-delà.
const PER_PAGE = 25

export function buildSearchUrl(q: SourcingQuery): string {
  const params = new URLSearchParams()

  const naf = SECTOR_TO_NAF[(q.sector || '').toLowerCase()]
  if (naf) params.set('activite_principale', naf)

  const loc = (q.location || '').trim()
  if (loc) {
    const dep = resolveDepartement(loc)
    if (dep) params.set('departement', dep)
    else params.set('q', loc) // ville inconnue → recherche texte (best-effort, post-filtrée en aval)
  }

  const tr = q.size ? SIZE_TO_TRANCHE[q.size] : undefined
  if (tr) params.set('tranche_effectif_salarie', tr)

  // Un filtre NAF/dep/effectif suffit. On n'ajoute `q` (texte, sémantique ET)
  // que si AUCUN autre critère n'est présent, sinon il sur-filtre → 0 résultat.
  if (Array.from(params.keys()).length === 0) params.set('q', q.sector || 'entreprise')

  // Société active seulement (exclut radiées/cessées) — ajouté après le check `q`.
  if (q.activeOnly !== false) params.set('etat_administratif', 'A')

  params.set('page', String(Math.max(1, q.page || 1)))
  params.set('per_page', String(PER_PAGE))

  return `https://recherche-entreprises.api.gouv.fr/search?${params.toString()}`
}

/**
 * Résultat d'une vérification par nom.
 *
 * RÉTROCOMPATIBLE : `found` garde exactement le sens qu'il avait — « j'ai UNE
 * entreprise, et c'est celle-là ». Les appelants existants qui testent
 * `if (v.found)` restent corrects sans modification, et deviennent même plus
 * sûrs : une ambiguïté rend désormais `found: false`.
 */
/**
 * ─── PANNE FOURNISSEUR ≠ ABSENCE DE RÉSULTAT (OBS-DATAGOUV-001) ─────────────
 *
 * Toutes les fonctions de ce module convertissaient un 429, un 500, une coupure
 * réseau ou un JSON illisible en `[]`, `null` ou `{found:false}` — exactement la
 * même valeur qu'une réponse valide ne contenant aucune entreprise.
 *
 * L'utilisateur lisait donc « entreprise introuvable » alors que Prospector
 * n'avait tout simplement pas pu interroger data.gouv. Les deux situations
 * appellent des gestes opposés : sur « introuvable » on corrige la saisie, sur
 * « indisponible » on réessaie. Confondre les deux fait corriger ce qui n'est
 * pas faux, et abandonner ce qui aurait abouti.
 *
 * Pire : une panne pouvait faire écrire un compte SANS métadonnées comme si
 * data.gouv avait répondu « je ne connais pas cette entreprise ».
 */
export type Resolution = 'resolved' | 'ambiguous' | 'not_found' | 'provider_error'

/**
 * Appel HTTP data.gouv. Rend le JSON, ou LÈVE une `ProviderError`.
 *
 * ⚠️ NE REND JAMAIS UNE VALEUR VIDE POUR SIGNALER UNE PANNE. C'est tout l'objet
 * du lot : la seule façon de ne pas confondre les deux cas est que l'un soit une
 * valeur et l'autre une exception.
 *
 * Aucun corps fournisseur, aucune URL, aucun message tiers ne franchit cette
 * frontière — `ProviderError` ne transporte qu'une classe de panne, un statut et
 * un identifiant de corrélation généré localement (SEC-LOG-01).
 */
async function appelDataGouv(url: string, operation: string): Promise<any> {
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Prospector/1.0' } })
  } catch (e: any) {
    // Requête non aboutie : DNS, TLS, connexion coupée, avortement.
    throw new ProviderError({
      code: 'provider_network', provider: 'datagouv', operation, errorName: e?.name,
    })
  }

  if (!res.ok) {
    throw new ProviderError({
      code: 'provider_http', provider: 'datagouv', operation, status: res.status,
    })
  }

  try {
    const data = await res.json()
    // Une réponse 200 dont le corps n'est pas exploitable n'est pas un « zéro
    // résultat » : c'est un fournisseur qui ne répond pas selon son contrat.
    if (!data || typeof data !== 'object') {
      throw new ProviderError({ code: 'provider_response', provider: 'datagouv', operation })
    }
    return data
  } catch (e: any) {
    if (e instanceof ProviderError) throw e
    throw new ProviderError({
      code: 'provider_response', provider: 'datagouv', operation, errorName: e?.name,
    })
  }
}

export interface CompanyLookup {
  found: boolean
  siren?: string
  name?: string
  dirigeant?: string
  active?: boolean
  city?: string
  naf?: string
  effectif?: string
  website?: string
  /**
   * Issue de la résolution. `found:true` implique toujours `'resolved'`.
   * Ce champ est ADDITIF : les appelants qui testent `found` restent corrects.
   */
  resolution?: Resolution
  /** Plusieurs entreprises portent ce nom : AUCUNE n'a été choisie. */
  ambiguous?: boolean
  /** Les candidates, pour que l'appelant fasse trancher l'utilisateur. */
  candidates?: CompanyMatch[]
}

/**
 * Normalisation SIMPLE pour comparer deux raisons sociales.
 *
 * Accents, casse, ponctuation et espaces — rien d'autre. Aucun rapprochement
 * approximatif : pas de distance d'édition, pas de préfixe, pas de retrait de
 * forme juridique. Un rapprochement agressif rendrait la résolution automatique
 * plus fréquente, donc les collisions silencieuses plus fréquentes — l'inverse
 * du but.
 */
// Exportée pour ENTITY_RESOLUTION_ADJUDICATION_001 : l'observation d'entité
// réutilise EXACTEMENT cette normalisation — jamais une seconde implémentation.
export function normaliserRaisonSociale(v: string): string {
  return (v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Vérifie une entreprise par son NOM → SIREN + statut actif + DIRIGEANT.
 * Source officielle gratuite (data.gouv) : ni token Pappers, ni scraping.
 *
 * ── LE DÉFAUT FERMÉ (ENTITY-RESOLUTION-001, P0) ─────────────────────────────
 * Cette fonction interrogeait l'API avec `per_page=1` et prenait `results[0]`
 * pour vérité. Or l'API rend un CLASSEMENT de pertinence, pas une réponse
 * unique : « OVHcloud » remonte plusieurs sociétés, et le premier résultat
 * était `OVHCLOUD OCT1`. Le SIREN, le NAF, le dirigeant et l'effectif d'une
 * entité sans rapport étaient alors écrits sur le lead — silencieusement, et
 * avec l'autorité d'une « vérification data.gouv ».
 *
 * Une donnée fausse portant un tampon officiel est pire qu'une donnée absente :
 * elle contamine l'ingestion, les fiches, les listes et tout ce qui s'appuiera
 * plus tard sur ce SIREN.
 *
 * ⚠️ ON NE DEVINE PLUS. Une résolution automatique n'a lieu que si UNE SEULE
 * candidate porte exactement le nom demandé, après normalisation simple. Dans
 * tous les autres cas : `found: false`, `ambiguous: true`, et les candidates
 * sont rendues pour que l'UTILISATEUR tranche.
 */
export async function lookupByName(name: string): Promise<CompanyLookup> {
  const n = (name || '').trim()
  if (n.length < 2) return { found: false, resolution: 'not_found' }

  // Une fenêtre de 10 : voir les homonymes est la condition même pour les
  // détecter. `per_page=1` rendait l'ambiguïté structurellement invisible.
  const candidates = await searchCandidates(n, 10)

  // Réponse VALIDE et vide : l'entreprise n'existe pas. Une panne, elle, a déjà
  // levé dans `searchCandidates` et n'arrive jamais ici.
  if (candidates.length === 0) return { found: false, resolution: 'not_found' }

  // ── UN SEUL RÉSULTAT N'EST PAS UNE RÉSOLUTION (R1e·P0-1) ──────────────────
  // ⚠️ LE RACCOURCI SUPPRIMÉ ICI CONTREDISAIT LA DOCTRINE ÉCRITE JUSTE AU-DESSUS.
  // La ligne était :
  //
  //     if (candidates.length === 1) return { found: true, resolution: 'resolved', … }
  //
  // Or l'API rend un CLASSEMENT DE PERTINENCE, jamais une réponse unique : elle
  // peut parfaitement ne renvoyer QU'UNE société, et que celle-ci ne porte pas
  // le nom demandé. Interroger « Acme » et recevoir la seule « Acme Services »
  // suffisait à décerner l'autorité — sans aucune égalité de raison sociale.
  // C'est exactement le défaut ENTITY-RESOLUTION-001, rouvert par le bas :
  // `results[0]` refusé quand il y en a plusieurs, accepté quand il est seul.
  //
  // Le cardinal du classement ne prouve rien. Seule l'égalité stricte du nom
  // normalisé prouve quelque chose, et elle doit s'appliquer UNIFORMÉMENT.
  //
  // Ce défaut préexistait ; il devient P0 parce que ce SIREN devient désormais
  // l'identité de compte d'un fait du Kernel.
  const cible = normaliserRaisonSociale(n)
  const exacts = candidates.filter((c) => normaliserRaisonSociale(c.name) === cible)

  // Exactement UNE correspondance stricte : le nom désigne sans équivoque.
  // ⚠️ ADDITIF (ENTITY_RESOLUTION_ADJUDICATION_001 durcissement) : la fenêtre
  // COMPLÈTE de la MÊME recherche accompagne la résolution exacte — la voie de
  // remédiation d'un conflit d'identité persiste cette fenêtre-là, jamais une
  // seconde interrogation incohérente (TOCTOU). Sémantique inchangée pour
  // tous les appelants existants.
  if (exacts.length === 1) return { found: true, resolution: 'resolved', ...exacts[0], candidates }

  // Zéro correspondance stricte (que des approchants) OU plusieurs entités
  // portant le même nom : dans les deux cas, choisir serait deviner.
  return { found: false, resolution: 'ambiguous', ambiguous: true, candidates }
}

export interface CompanyMatch { siren: string; name: string; dirigeant?: string; active?: boolean; city: string; naf: string; effectif?: string; website?: string }

// Renvoie plusieurs entreprises candidates pour un nom → l'utilisateur choisit.
export async function searchCandidates(name: string, n = 10): Promise<CompanyMatch[]> {
  const q = (name || '').trim()
  if (q.length < 2) return []
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&page=1&per_page=${n}`
  // ⚠️ LÈVE sur panne fournisseur (OBS-DATAGOUV-001). Un `[]` ne signifie plus
  // que « aucune entreprise ne porte ce nom » — jamais « je n'ai pas pu demander ».
  const data = await appelDataGouv(url, 'search')
  {
    return (data.results || []).map((r: any): CompanyMatch => {
      const dir = (r.dirigeants || []).find((d: any) => d && d.nom)
      return {
        siren: String(r.siren),
        name: r.nom_complet || r.nom_raison_sociale || q,
        dirigeant: dir ? `${String(dir.prenoms || '').split(' ')[0]} ${dir.nom}`.trim() : undefined,
        active: r.etat_administratif ? r.etat_administratif === 'A' : undefined,
        city: r.siege?.libelle_commune || '',
        naf: r.activite_principale || '',
        effectif: TRANCHE[r.tranche_effectif_salarie] || undefined,
        website: extractWebsite(r),
      }
    })
  }
}

// Réconcilie un nom d'entreprise (issu d'un signal) sur un SIREN réel.
// Sert à vérifier qu'une entreprise citée par l'agent existe vraiment.
//
// ── LE DERNIER `results[0]` (OBS-DATAGOUV-001) ──────────────────────────────
// Cette fonction interrogeait data.gouv avec `per_page=1` et prenait
// `results[0]` pour vérité — le défaut même qu'ENTITY-RESOLUTION-001 a fermé
// dans `lookupByName`, resté ouvert ici. Elle rendait donc un SIREN arbitraire
// pour tout nom ambigu, et ce SIREN servait à ÉLEVER la confiance d'une
// identification : une collision homonyme se transformait en `confidence:'high'`.
//
// Elle s'appuie désormais sur le résolveur sûr, et ne rend un SIREN QUE si la
// résolution est `resolved`. `ambiguous`, `not_found` et `provider_error` ne
// produisent jamais d'identité — la panne se propage à l'appelant.
export async function reconcileByName(
  name: string,
): Promise<{ siren: string; sector: string; city: string } | null> {
  if (!name || name.length < 2) return null

  const v = await lookupByName(name)
  if (v.resolution !== 'resolved' || !v.siren) return null

  return { siren: v.siren, sector: v.naf || '', city: v.city || '' }
}

// Vérifie un SIREN et renvoie les infos entreprise (anti-faux positifs à la saisie).
export async function lookupBySiren(
  siren: string,
): Promise<{ found: boolean; resolution?: Resolution; siren?: string; name?: string; naf?: string; city?: string; dirigeant?: string; active?: boolean; effectif?: string; website?: string }> {
  const clean = (siren || '').replace(/\s/g, '')
  if (!/^\d{9}$/.test(clean)) return { found: false, resolution: 'not_found' }
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${clean}&page=1&per_page=1`
  {
    // Panne fournisseur ⇒ exception, jamais `found:false` : un SIREN qui existe
    // ne doit pas être déclaré inexistant parce que data.gouv était indisponible.
    const data = await appelDataGouv(url, 'siren')
    const r = (data.results || []).find((x: any) => String(x.siren) === clean)
    // Réponse VALIDE ne contenant pas ce SIREN : il n'existe pas.
    if (!r) return { found: false, resolution: 'not_found' }
    const dir = (r.dirigeants || []).find((d: any) => d && d.nom)
    return {
      found: true,
      resolution: 'resolved',
      // ADDITIF (ENTITY_RESOLUTION_ADJUDICATION_001) : le SIREN exact vérifié
      // est rendu pour que la revalidation aval le compare strictement.
      siren: clean,
      name: r.nom_complet || r.nom_raison_sociale || '',
      naf: r.activite_principale || '',
      city: r.siege?.libelle_commune || '',
      dirigeant: dir ? `${String(dir.prenoms || '').split(' ')[0]} ${dir.nom}`.trim() : undefined,
      active: r.etat_administratif ? r.etat_administratif === 'A' : undefined,
      effectif: TRANCHE[r.tranche_effectif_salarie] || undefined,
      website: extractWebsite(r),
    }
  }
}

export async function debugSearch(q: SourcingQuery) {
  const url = buildSearchUrl(q)
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Prospector/1.0' } })
  const body = await res.text()
  return { url, status: res.status, body: body.slice(0, 500) }
}

export async function fetchCompanies(
  q: SourcingQuery,
): Promise<{ total: number; page: number; totalPages: number; results: SourcedCompany[] }> {
  const url = buildSearchUrl(q)
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Prospector/1.0 (+https://smartagency-ai.com)' },
  })
  if (!res.ok) {
    // SEC-LOG-01 — le corps de réponse ne franchit pas l'erreur : cette erreur
    // remonte jusqu'à une réponse HTTP publique (`/api/sourcing/search`).
    throw new ProviderError({
      code: 'provider_http', provider: 'datagouv', operation: 'search', status: res.status,
    })
  }
  const data = await res.json()

  // Cible département (ville/CP/dep) → on post-filtre pour éviter les faux positifs
  // (ex: recherche « Paris » qui remonterait des sociétés d'un autre département).
  const depTarget = resolveDepartement(q.location || '')

  const mapped: SourcedCompany[] = (data.results || []).map((r: any) => {
    const dir = (r.dirigeants || []).find((d: any) => d && d.nom)
    const eff = TRANCHE[r.tranche_effectif_salarie] || ''
    const city = r.siege?.libelle_commune || ''
    const dep = r.siege?.departement || ''
    const dateCreation = r.date_creation || r.siege?.date_creation || ''
    const year = dateCreation ? parseInt(String(dateCreation).slice(0, 4), 10) : 0
    const young = year > 0 && new Date().getFullYear() - year < 3
    const signals: string[] = []
    if (eff) signals.push(`${eff} sal.`)
    if (city) signals.push(city)
    if (young) signals.push('récente')
    return {
      id: String(r.siren),
      name: r.nom_complet || r.nom_raison_sociale || 'Entreprise',
      naf: r.activite_principale || '',
      sector: q.sector || r.activite_principale || '',
      effectif: eff,
      city,
      dep,
      dirigeant: dir ? `${String(dir.prenoms || '').split(' ')[0]} ${dir.nom}`.trim() : undefined,
      website: extractWebsite(r),
      dateCreation: dateCreation || undefined,
      young,
      signals,
    }
  })

  const results = depTarget ? mapped.filter((c) => c.dep === depTarget) : mapped

  return {
    total: data.total_results ?? results.length,
    page: data.page ?? (q.page || 1),
    totalPages: data.total_pages ?? 1,
    results,
  }
}

// Fiche COMPTE détaillée (data.gouv, gratuit) : tous les dirigeants + CA/résultat
// (finances) + effectif + adresse. Site web/email NE sont PAS exposés par SIRENE.
export interface CompanyDetail {
  found: boolean
  /** `found:true` implique `'resolved'`. Champ ADDITIF, appelants inchangés. */
  resolution?: Resolution
  siren?: string
  name?: string
  active?: boolean
  naf?: string
  effectif?: string
  city?: string
  address?: string
  website?: string
  dirigeants: { name: string; role?: string; type: 'physique' | 'morale' }[]
  finances?: { year: string; ca?: number; resultat?: number }
}

export async function fetchCompanyDetail(siren: string): Promise<CompanyDetail> {
  const clean = (siren || '').replace(/\s/g, '')
  if (!/^\d{9}$/.test(clean)) return { found: false, resolution: 'not_found', dirigeants: [] }
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${clean}&page=1&per_page=1`
  {
    // Panne fournisseur ⇒ exception. Une fiche momentanément injoignable n'est
    // pas une fiche inexistante : l'écran doit proposer de réessayer, pas
    // afficher un compte vide comme si data.gouv ne connaissait rien.
    const data = await appelDataGouv(url, 'detail')
    const r = (data.results || []).find((x: any) => String(x.siren) === clean)
    if (!r) return { found: false, resolution: 'not_found', dirigeants: [] }

    const dirigeants = (r.dirigeants || []).map((d: any) => {
      if (d?.nom || d?.prenoms) {
        const name = `${String(d.prenoms || '').split(' ')[0]} ${d.nom || ''}`.trim()
        return { name, role: d.qualite || undefined, type: 'physique' as const }
      }
      return { name: d?.denomination || d?.sigle || 'Personne morale', role: d?.qualite || undefined, type: 'morale' as const }
    }).filter((d: any) => d.name)

    // finances : { "2023": { ca, resultat_net }, ... } → on prend l'année la plus récente.
    let finances: CompanyDetail['finances'] | undefined
    const fin = r.finances || {}
    const years = Object.keys(fin).sort().reverse()
    if (years.length) {
      const y = years[0]
      finances = { year: y, ca: fin[y]?.ca ?? undefined, resultat: fin[y]?.resultat_net ?? undefined }
    }

    return {
      found: true,
      resolution: 'resolved',
      siren: clean,
      name: r.nom_complet || r.nom_raison_sociale || '',
      active: r.etat_administratif ? r.etat_administratif === 'A' : undefined,
      naf: r.activite_principale || '',
      effectif: TRANCHE[r.tranche_effectif_salarie] || undefined,
      city: r.siege?.libelle_commune || '',
      address: r.siege?.adresse || r.siege?.geo_adresse || '',
      website: extractWebsite(r),
      dirigeants,
      finances,
    }
  }
}
