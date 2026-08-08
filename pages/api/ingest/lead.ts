import type { NextApiRequest, NextApiResponse } from 'next'
import { getKey, hydrateKeystore } from '../../../lib/prospector/keystore'
import { upsertLeadChecked } from '../../../lib/supabase/leads'
import { lookupByName } from '../../../lib/prospector/datagouv'
import { identifyLead } from '../../../lib/prospector/identify'
import { resolveExtensionToken } from '../../../lib/prospector/wstoken'
import { tenantFromVerifiedWorkspace } from '../../../lib/prospector/tenant'
import { decideCors, applyCors, readCredential, LIMITS, bounded, boundedOrReject } from '../../../lib/prospector/extensionGate'
import type { Lead } from '../../../types/prospector'

// Point d'entrée pour l'extension navigateur (Jarvis web).
// Protégé par un jeton (INGEST_TOKEN) — pas par la session, car appelé depuis
// une autre origine. Crée un lead à partir d'une URL LinkedIn + infos de base.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── CORS : allowlist, jamais `*` (lot SEC-EXT-0) ────────────────────────
  // CORS n'est pas l'autorité — le jeton et sa portée le sont — mais renvoyer
  // `*` sur une route qui accepte un credential invite toute page à tenter sa
  // chance, et rend l'exfiltration de la réponse triviale.
  await hydrateKeystore()
  const cors = decideCors(req.headers.origin as string | undefined)
  applyCors(res, cors)
  if (!cors.allowed) return res.status(403).json({ error: 'origin_not_allowed' })
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // ⚠️ CREDENTIAL DANS L'EN-TÊTE UNIQUEMENT. `body.token` n'est plus lu : deux
  // chemins d'entrée pour un même secret, c'est un de trop à surveiller, et un
  // corps JSON se retrouve bien plus facilement dans un journal.
  const token = readCredential(req)
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  // ⚠️ PORTÉE `capture` EXIGÉE, et AUCUN jeton global d'administration. Le
  // jeton `INGEST_TOKEN` ouvrait l'espace `admin` depuis un navigateur client.
  const ws = await resolveExtensionToken(token, 'capture')
  if (!ws) return res.status(401).json({ error: 'unauthorized' })
  // MT-0 — l'espace vient du jeton, déjà vérifié ; il doit ENCORE être utilisable.
  const tenant = await tenantFromVerifiedWorkspace(ws)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  // ── BORNES (lot SEC-EXT-0.1) ─────────────────────────────────────────────
  // Sans plafond, un corps de plusieurs mégaoctets traversait `identifyLead`,
  // l'appel LLM et la persistance : coût fournisseur à la main du porteur du
  // jeton. Les données métier sont TRONQUÉES — une saisie trop longue est une
  // erreur, pas une intention. L'URL est REFUSÉE : tronquée, elle désignerait
  // une autre ressource.
  const name = bounded(body?.name, LIMITS.name).trim()
  const company = bounded(body?.company, LIMITS.company).trim()
  const jobTitle = bounded(body?.title, LIMITS.title).trim()
  const email = boundedOrReject(body?.email, LIMITS.email)
  const url = boundedOrReject(body?.url, LIMITS.url)
  if (url === null || email === null) return res.status(413).json({ error: 'payload_too_large' })
  const isProfile = /linkedin\.com\/in\//i.test(url)

  // Classification personne (contact) vs entreprise (compte) : URL → agent web
  // (Exa→Claude si clés) → heuristique + data.gouv. Aucune donnée devinée.
  const id = await identifyLead(tenant, { name, title: jobTitle, company, url })
  const isPerson = id.kind === 'person'

  const lead: Lead = {
    id: `ld_${Math.random().toString(36).slice(2, 10)}`,
    kind: isPerson ? 'contact' : 'account',
    firstName: isPerson ? (id.firstName || name.split(' ')[0] || '') : '',
    lastName: isPerson ? (id.lastName || name.split(' ').slice(1).join(' ')) : '',
    title: isPerson ? (id.title || jobTitle || 'À qualifier') : '',
    company: (id.company || company || (isPerson ? '—' : name) || '—'),
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
    email: email || null, phone: null,
    website: id.website || undefined,
    // On ne renseigne linkedinUrl que si l'URL est vraiment un profil LinkedIn.
    linkedinUrl: isProfile ? url.trim() : undefined,
  }

  // Vérification entreprise via data.gouv (gratuit, officiel) AVANT enregistrement.
  const companyName = lead.company && lead.company !== '—' ? lead.company : ''
  if (companyName) {
    try {
      const v = await lookupByName(companyName)
      if (v.found) {
        lead.company = v.name || lead.company
        lead.siren = v.siren
        lead.active = v.active
        lead.naf = v.naf
        lead.city = v.city
        lead.dirigeant = v.dirigeant
        lead.effectif = v.effectif
        if (!lead.website && v.website) lead.website = v.website
        // On NE fabrique PAS de personne : le dirigeant reste une métadonnée du compte.
      }
    } catch { /* vérif best-effort */ }
  }

  const r = await upsertLeadChecked(lead, ws)
  if (r.ok) return res.status(200).json({ ok: true, id: lead.id })

  // Un conflit d'espace est un refus MÉTIER (409), pas une panne. La contention et
  // le blocage par le contrat d'environnement sont TRANSITOIRES (503). Le reste est
  // une erreur de notre persistance (500) — jamais 502, qui laisserait croire à une
  // défaillance d'un service amont.
  const status = r.reason === 'workspace_conflict' ? 409
    : r.reason === 'contention' || r.reason === 'env_blocked' ? 503
    : 500
  const message = r.reason === 'workspace_conflict'
    ? "Cet identifiant appartient déjà à un autre espace de travail : l'écriture est refusée."
    : r.reason === 'contention' ? 'Écriture concurrente en cours, réessayez.'
    : r.reason === 'env_blocked' ? "Écritures suspendues : incohérence de configuration d'environnement."
    : 'Échec de persistance.'
  res.status(status).json({ ok: false, id: lead.id, reason: r.reason, error: message })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
