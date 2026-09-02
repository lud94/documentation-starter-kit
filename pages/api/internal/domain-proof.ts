// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — CAPTURE DE PREUVE, CADRÉE CANDIDAT.
//
// ⚠️ CE N'EST PAS UN « POST fetch-any-url ». Le navigateur ne DÉSIGNE que
// (candidateId, proofUrl). Le serveur dérive TOUT le reste : acteur/espace de
// la session, candidat relu du registre, SIREN via le résolveur d'entité
// autoritatif (resolution === resolved exigée), hôte de preuve == hôte de la
// source du candidat (modulo `www.` seul), capture SSRF-sûre exécutée par le
// serveur. Le navigateur ne fournit JAMAIS : siren, domainHost,
// proofObservedAt, proofContentHash, sirensFound, targetSirenFound,
// proofAnchor, legalNameObserved — ni le CONTENU de la page.
//
// Conséquence assumée : une source EU-Startups ne devient pas « première
// partie » en pointant vers le site de l'entreprise — il faudrait un candidat
// dont la SOURCE est ce site. Et une entité non résolue (Shiplog/Mio) ne peut
// rien capturer : la liaison de domaine ne contourne jamais la résolution
// d'entité.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { readCandidate } from '../../../lib/prospector/proactive/signalCandidates'
import { resolveEntityForCandidate } from '../../../lib/prospector/proactive/entityResolution'
import { hostOf } from '../../../lib/prospector/proactive/signalBridge'
import { captureLegalProof, normalizeHost } from '../../../lib/prospector/proactive/legalProofFetch'
import { recordDomainProofObservation } from '../../../lib/prospector/proactive/domainBinding'
import { logSafeError } from '../../../lib/observability/safeError'

export type DomainProofState =
  | 'UNAUTHENTICATED'
  | 'INVALID_REQUEST'
  | 'CANDIDATE_UNKNOWN'
  | 'CANDIDATE_STORE_UNAVAILABLE'
  | 'ENTITY_NOT_RESOLVED'
  | 'ENTITY_IDENTITY_CONFLICT'
  | 'ENTITY_RESOLUTION_HISTORY_TAMPERED'
  | 'ENTITY_REGISTRY_UNAVAILABLE'
  | 'PROOF_HOST_MISMATCH'
  | 'CAPTURE_FAILED'
  | 'WRITE_FAILED'
  | 'OBSERVATION_RECORDED'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ state: 'INVALID_REQUEST' })

  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id

  try {
    const corps: any = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const candidateId = corps?.candidateId
    const proofUrl = corps?.proofUrl
    if (typeof candidateId !== 'string' || typeof proofUrl !== 'string' || proofUrl.trim() === '') {
      return res.status(400).json({ state: 'INVALID_REQUEST' })
    }

    // ── CANDIDAT RELU DU REGISTRE — jamais de la requête ──────────────────
    const lecture = await readCandidate(candidateId, ws)
    if (lecture.ok === false) {
      return lecture.state === 'CANDIDATE_STORE_UNAVAILABLE'
        ? res.status(503).json({ state: 'CANDIDATE_STORE_UNAVAILABLE' })
        : res.status(404).json({ state: 'CANDIDATE_UNKNOWN' })
    }
    const candidate = lecture.candidate

    // ── ENTITÉ RÉSOLUE PAR LE RÉSOLVEUR COMPOSITE CADRÉ CANDIDAT ──────────
    // (auto exact prioritaire, sinon adjudication humaine de CE candidat,
    // revalidée). La preuve de domaine CONSOMME la résolution — elle ne la
    // crée ni ne la modifie jamais : ENTITÉ ↓ DOMAINE ↓ SOURCE.
    const entite = await resolveEntityForCandidate(candidate, ws)
    if (entite.state === 'REGISTRY_UNAVAILABLE') {
      return res.status(503).json({ state: 'ENTITY_REGISTRY_UNAVAILABLE' })
    }
    if (entite.state === 'STORE_UNAVAILABLE') {
      return res.status(503).json({ state: 'CANDIDATE_STORE_UNAVAILABLE' })
    }
    if (entite.state === 'IDENTITY_CONFLICT') {
      return res.status(409).json({ state: 'ENTITY_IDENTITY_CONFLICT' })
    }
    if (entite.state === 'HISTORY_TAMPERED') {
      return res.status(409).json({ state: 'ENTITY_RESOLUTION_HISTORY_TAMPERED' })
    }
    if (entite.state !== 'RESOLVED') {
      return res.status(409).json({ state: 'ENTITY_NOT_RESOLVED' })
    }
    const siren = entite.siren

    // ── L'HÔTE DE PREUVE EST CELUI DE LA SOURCE DU CANDIDAT — exactement ──
    const hoteSource = normalizeHost(hostOf(candidate.claim.sourceUrl))
    const hoteBrutPreuve = hostOf(proofUrl)
    const hotePreuve = normalizeHost(hoteBrutPreuve)
    if (!hoteSource || !hotePreuve || hotePreuve !== hoteSource) {
      return res.status(409).json({ state: 'PROOF_HOST_MISMATCH' })
    }

    // ── CAPTURE SSRF-SÛRE, PAR LE SERVEUR ─────────────────────────────────
    const capture = await captureLegalProof(hoteSource, proofUrl.trim())
    if (capture.ok === false) {
      // Raison CLOSE — jamais un octet du corps distant.
      return res.status(502).json({ state: 'CAPTURE_FAILED', reason: capture.reason })
    }

    const enregistree = await recordDomainProofObservation(
      {
        siren,
        domainHost: hoteSource,
        proofUrl: proofUrl.trim(),
        finalUrl: capture.finalUrl,
        body: capture.body,
        registryLegalName: typeof entite.name === 'string' ? entite.name : undefined,
      },
      ws,
    )
    if (enregistree.ok === false) return res.status(503).json({ state: 'WRITE_FAILED' })

    const o = enregistree.observation
    return res.status(200).json({
      state: 'OBSERVATION_RECORDED',
      observation: {
        id: o.id, siren: o.siren, domainHost: o.domainHost, finalUrl: o.finalUrl,
        proofObservedAt: o.proofObservedAt, proofContentHash: o.proofContentHash,
        sirensFound: o.sirensFound, targetSirenFound: o.targetSirenFound,
        ...(o.legalNameObserved !== undefined ? { legalNameObserved: o.legalNameObserved } : {}),
        proofAnchor: o.proofAnchor,
      },
    })
  } catch (e) {
    logSafeError('domain-proof', e)
    return res.status(500).json({ state: 'INVALID_REQUEST' })
  }
}
