import { useState } from 'react'
import Head from 'next/head'

import {
  supportingAssertions,
  type FactualMemoryView,
} from '../../lib/prospector/proactive/inspectorView'
import type { SourceAssertion } from '../../lib/prospector/proactive/sourceAssertion'

// FACTUAL_MEMORY_INSPECTOR_V0_001 — PAGE INTERNE, LECTURE SEULE.
//
// « Montrer exactement ce que Prospector sait factuellement d'un compte,
//   sous quelle représentation, et quelles assertions de source le soutiennent. »
//
// ⚠️ AUCUNE SÉMANTIQUE PRODUIT : pas de score, pas de « pourquoi maintenant »,
// pas de priorité, pas de recommandation, pas de tendance. Les quatre horloges
// restent nommées et distinctes — jamais une « date » générique.
//
// ⚠️ Ce fichier n'importe QUE le modèle de vue pur (`inspectorView`, sans I/O)
// et des types : aucune primitive de persistance n'entre dans le bundle client.

// ⚠️ CINQ HORLOGES, AUCUN REPLI DE L'UNE VERS L'AUTRE (TRACEABILITY_FIX_001).
// « EVIDENCE OBSERVED » (naissance dans le moteur) et « HUMAN CONFIRMED »
// (adjudication) sont DEUX instants : les fondre ferait passer une naissance
// d'evidence pour une confirmation humaine. Une valeur absente s'affiche
// « — », jamais remplacée par une autre horloge.
const CLOCHES: Array<[string, (a: SourceAssertion) => string | undefined]> = [
  ['SOURCE PUBLISHED', (a) => a.provenance?.sourcePublishedAt],
  ['SOURCE RETRIEVED', (a) => a.provenance?.retrievedAt],
  ['EVIDENCE OBSERVED', (a) => a.observedAt],
  ['HUMAN CONFIRMED', (a) => a.acceptance?.confirmedAt],
  ['STATE OBSERVED DAY', (a) => a.sourceObservedDay],
]

function FaitStructure({ fact }: { fact: any }) {
  if (!fact) return <span className="text-gray-400">(assertion héritée V1 — pas de fait structuré)</span>
  const p = fact.payload ?? {}
  const ligne = (k: string, v: unknown) =>
    v === undefined || v === null ? null : (
      <div key={k}><span className="text-gray-500">{k}</span> : <span>{String(v)}</span></div>
    )
  return (
    <div className="text-sm">
      {p.family === 'FUNDING' && (
        <>
          {ligne('amount', p.amount ? `${p.amount.amountMinor} (minor) ${p.amount.currency} — « ${p.amount.asPublished} »` : undefined)}
          {ligne('amountApprox', p.amountApprox ? `≈ ${p.amountApprox.magnitudeMinor} (minor) ${p.amountApprox.currency} — « ${p.amountApprox.asPublished} »` : undefined)}
          {ligne('roundStage', p.roundStage)}
          {Array.isArray(p.investors) && p.investors.length > 0 &&
            ligne('investors', p.investors.map((i: any) => `${i.nameRaw} (${i.role})`).join(', '))}
        </>
      )}
      {p.family === 'EXECUTIVE_CHANGE' && (
        <>
          {ligne('direction', p.direction)}
          {ligne('person', p.person?.fullNameRaw)}
          {ligne('verification', p.person?.verification)}
          {ligne('roleFunction', p.roleFunction)}
          {ligne('roleSeniority', p.roleSeniority)}
          {ligne('roleTitleRaw', p.roleTitleRaw)}
        </>
      )}
      {p.family === 'HIRING_SNAPSHOT' && (
        <>
          {ligne('roleFunction', p.roleFunction)}
          {ligne('roleStatus', p.roleStatus)}
          {ligne('openingsObserved.value', p.openingsObserved?.value)}
          {ligne('openingsObserved.method', p.openingsObserved?.method)}
        </>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-gray-500">JSON brut (débogage)</summary>
        <pre className="text-xs bg-gray-50 border rounded p-2 overflow-x-auto">{JSON.stringify(fact, null, 2)}</pre>
      </details>
    </div>
  )
}

function AssertionCard({ a }: { a: SourceAssertion }) {
  return (
    <div className="border rounded p-3 mb-2 bg-white">
      <div className="text-xs text-gray-500 break-all">{a.id}</div>
      <div className="text-sm break-all">
        <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
          {a.sourceUrl}
        </a>
      </div>
      <div className="text-xs text-gray-600 mt-1">
        {a.provenance?.publisher ? `éditeur : ${a.provenance.publisher} · ` : ''}
        grade {a.provenance?.grade ?? '—'} · lignée {a.provenance?.lineage ?? '—'} · ancrage {a.provenance?.grounding ?? '—'}
      </div>
      <div className="text-xs mt-1 grid grid-cols-2 gap-x-4">
        {CLOCHES.map(([nom, lire]) => (
          <div key={nom}><span className="text-gray-500">{nom}</span> : {lire(a) ?? '—'}</div>
        ))}
      </div>
      <div className="text-xs text-gray-500 mt-1 break-all">
        claim : {a.canonicalClaimKey} · evidence : {a.evidenceId} ({a.evidenceType}) · temporalité : {a.assertionTemporality}
        {a.assertedFactHash ? <> · version : {a.assertedFactHash}</> : null}
      </div>
      <div className="mt-2"><FaitStructure fact={a.structuredFact} /></div>
    </div>
  )
}

function GroupeSoutien({ liste }: { liste: SourceAssertion[] }) {
  const urls = new Set(liste.map((x) => x.sourceUrl)).size
  return (
    <div className="ml-4 mt-2">
      {/* ⚠️ N lignes ≠ N sources indépendantes : les deux compteurs restent distincts. */}
      <div className="text-xs text-gray-600 mb-1">
        Assertions : {liste.length} · URLs de source normalisées uniques : {urls}
        {liste.length > urls ? ' (plusieurs versions sémantiques d’une même URL — pas des confirmations indépendantes)' : ''}
      </div>
      {liste.map((x) => <AssertionCard key={x.id} a={x} />)}
    </div>
  )
}

export default function FactualMemoryInspector() {
  const [accountId, setAccountId] = useState('')
  const [harness, setHarness] = useState(false)
  const [view, setView] = useState<FactualMemoryView | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  async function charger() {
    setErreur(null); setView(null)
    const scope = harness ? '&scope=harness' : ''
    const r = await fetch(`/api/internal/factual-memory?accountId=${encodeURIComponent(accountId.trim())}${scope}`)
    const d = await r.json().catch(() => null)
    if (!r.ok) { setErreur(d?.error || `HTTP ${r.status}`); return }
    setView(d.view)
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <Head><title>Factual Memory Inspector — INTERNAL</title></Head>
      <div className="bg-amber-100 border border-amber-400 text-amber-900 text-sm font-semibold rounded px-3 py-2 mb-4">
        INTERNAL / READ ONLY — inspection de la mémoire factuelle. Aucune écriture, aucune interprétation.
      </div>
      <h1 className="text-xl font-bold mb-3">Factual Memory Inspector V0</h1>

      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="acc_siren_XXXXXXXXX"
          className="border rounded px-3 py-1.5 font-mono text-sm w-72"
        />
        <label className="text-xs text-gray-600 flex items-center gap-1">
          <input type="checkbox" checked={harness} onChange={(e) => setHarness(e.target.checked)} />
          espace du harnais (local/dev uniquement — refusé en production)
        </label>
        <button onClick={charger} className="bg-gray-900 text-white rounded px-4 py-1.5 text-sm">Inspecter</button>
      </div>

      {erreur && <div className="text-red-700 text-sm mb-4">{erreur}</div>}

      {view && (
        <div>
          <section className="mb-6">
            <h2 className="font-semibold text-lg">ACCOUNT</h2>
            <div className="text-sm">accountId : <span className="font-mono">{view.accountId}</span></div>
            <div className="text-sm">SIREN (dérivé du compte vérifié) : {view.siren}</div>
            <div className="text-sm">company : {view.company ?? '(non reconstructible depuis les données factuelles)'}</div>
          </section>

          <section className="mb-6">
            <h2 className="font-semibold text-lg">A. Canonical Events</h2>
            {view.events.length === 0 && <div className="text-sm text-gray-500">aucun événement canonique</div>}
            {view.events.map((e: any) => (
              <div key={e.id} className="border-l-4 border-gray-300 pl-3 mb-4">
                <div className="font-mono text-sm">{e.type}</div>
                <div className="text-xs text-gray-600 break-all">id : {e.id}</div>
                <div className="text-xs">occurredAt : {e.occurredAt} ({e.occurredAtPrecision})</div>
                {e.roleFunction && <div className="text-xs">roleFunction : {e.roleFunction}</div>}
                {e.personKey && <div className="text-xs break-all">personKey : {e.personKey}</div>}
                <div className="text-xs break-all">canonicalClaimKey : {e.canonicalClaimKey}</div>
                <GroupeSoutien liste={supportingAssertions(e, view)} />
              </div>
            ))}
          </section>

          <section className="mb-6">
            <h2 className="font-semibold text-lg">B. Canonical State Snapshots</h2>
            {view.snapshots.length === 0 && <div className="text-sm text-gray-500">aucun instantané d’état</div>}
            {view.snapshots.map((s) => (
              <div key={s.id} className="border-l-4 border-gray-300 pl-3 mb-4">
                <div className="font-mono text-sm">{s.type}</div>
                <div className="text-xs text-gray-600 break-all">id : {s.id}</div>
                <div className="text-xs">STATE OBSERVED DAY : {s.stateObservedDay}</div>
                <div className="text-xs break-all">canonicalClaimKey : {s.canonicalClaimKey}</div>
                <GroupeSoutien liste={supportingAssertions(s, view)} />
              </div>
            ))}
          </section>

          {view.rejected.length > 0 && (
            <section className="mb-6">
              <h2 className="font-semibold text-lg text-red-700">Lignes rejetées (malformées — non présentées comme des faits)</h2>
              {view.rejected.map((r, i) => (
                <div key={i} className="text-xs text-red-700 break-all">{r.kind} · {r.id} · {r.reason}</div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
