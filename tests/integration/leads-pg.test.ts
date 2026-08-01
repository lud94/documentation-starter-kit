import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Lead } from '../../types/prospector'

// Tests d'INTÉGRATION — Supabase local : PostgreSQL 15, PostgREST, clé de service.
//
// Ils valident ce que les tests mémoire ne PEUVENT PAS valider :
//   • la contrainte d'unicité réelle sur prospector_leads.id ;
//   • le code d'erreur 23505 remonté par PostgREST ;
//   • le comportement sous concurrence réelle.
//
// ⚠️ Ils exercent le CODE LIVRÉ (lib/supabase/leads.ts via supabase-js), pas
// seulement le SQL. Un test branché directement sur PostgreSQL avec `pg`
// validerait le moteur mais pas notre implémentation : il peut servir au
// diagnostic, jamais de critère d'acceptation.
//
// Prérequis : `npm run db:test:up` (Docker requis). Nettoyage : `npm run db:test:down`.
//
// Le schema provient de la baseline A3b versionnee dans supabase/migrations/.
// npm run db:test:up reconstruit la base locale via supabase db reset --local.

const URL_ = process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let leads: typeof import('../../lib/supabase/leads')

function lead(id: string, company: string): Lead {
  return {
    id, kind: 'account', firstName: '', lastName: '', title: '', company,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
  } as Lead
}

beforeAll(async () => {
  if (!KEY) {
    throw new Error(
      'SUPABASE_TEST_SERVICE_KEY absente. Démarrer l\'instance locale avec `npm run db:test:up`, '
      + 'puis exporter la clé de service affichée par `supabase status`.',
    )
  }
  // Les modules lisent l'environnement à l'appel : on le pose AVANT l'import.
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
  process.env.APP_ENV = 'development'
  delete process.env.APP_ENV_STRICT
  delete process.env.VERCEL_ENV
  leads = await import('../../lib/supabase/leads')

  // Verifie que la baseline a bien ete appliquee : un echec ici signifie
  // `npm run db:test:up` non exécuté, pas un défaut du code testé.
  const probe = await createClient(URL_, KEY).from('prospector_leads').select('id').limit(1)
  if (probe.error) throw new Error(`Table prospector_leads inaccessible : ${probe.error.message}. Exécuter \`npm run db:test:up\`.`)
})

beforeEach(async () => {
  // Isolation entre les cas : table vidée, jamais de données partagées.
  await createClient(URL_, KEY).from('prospector_leads').delete().neq('id', '')
})

afterAll(async () => {
  await createClient(URL_, KEY).from('prospector_leads').delete().neq('id', '')
})

describe('contrainte d’unicité réelle', () => {
  it('l’insertion d’un identifiant existant lève bien 23505', async () => {
    const sb = createClient(URL_, KEY)
    await sb.from('prospector_leads').insert({ id: 'ld_dup', data: {}, workspace_id: 'ws_a' })
    const second = await sb.from('prospector_leads').insert({ id: 'ld_dup', data: {}, workspace_id: 'ws_b' })
    expect(second.error).toBeTruthy()
    expect((second.error as any).code).toBe('23505')
  })
})

describe('isolation contre PostgreSQL réel', () => {
  it('DÉFAUT P0 — écriture inter-espace refusée, ligne d’origine intacte', async () => {
    expect((await leads.upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')).ok).toBe(true)

    const r = await leads.upsertLeadChecked(lead('ld_1', 'Pirate'), 'ws_b')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('workspace_conflict')

    const a = await leads.listLeads('ws_a')
    expect(a).toHaveLength(1)
    expect(a[0].company).toBe('Acme')
    expect(await leads.listLeads('ws_b')).toHaveLength(0)
  })

  it('mise à jour dans le même espace : non-régression', async () => {
    await leads.upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    expect((await leads.upsertLeadChecked(lead('ld_1', 'Acme SAS'), 'ws_a')).ok).toBe(true)
    const a = await leads.listLeads('ws_a')
    expect(a).toHaveLength(1)
    expect(a[0].company).toBe('Acme SAS')
  })

  it('identifiant neuf dans un autre espace : accepté', async () => {
    await leads.upsertLeadChecked(lead('ld_1', 'Acme'), 'ws_a')
    expect((await leads.upsertLeadChecked(lead('ld_2', 'Beta'), 'ws_b')).ok).toBe(true)
  })
})

describe('concurrence', () => {
  it('deux écritures simultanées du même identifiant dans le MÊME espace convergent', async () => {
    // Course réelle : l'une insère, l'autre reçoit 23505, relit le propriétaire,
    // constate le même espace et rattrape par UNE mise à jour bornée.
    const [a, b] = await Promise.all([
      leads.upsertLeadChecked(lead('ld_race', 'Version A'), 'ws_a'),
      leads.upsertLeadChecked(lead('ld_race', 'Version B'), 'ws_a'),
    ])
    expect(a.ok && b.ok).toBe(true) // aucune des deux n'échoue
    const rows = await leads.listLeads('ws_a')
    expect(rows).toHaveLength(1)    // aucun doublon
    expect(['Version A', 'Version B']).toContain(rows[0].company)
  })

  it('écritures simultanées depuis DEUX espaces : une seule gagne, aucune n’écrase', async () => {
    const [a, b] = await Promise.all([
      leads.upsertLeadChecked(lead('ld_x', 'Depuis A'), 'ws_a'),
      leads.upsertLeadChecked(lead('ld_x', 'Depuis B'), 'ws_b'),
    ])
    const winners = [a, b].filter((r) => r.ok)
    const losers = [a, b].filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].reason).toBe('workspace_conflict')

    // Une seule ligne au total, dans un seul espace.
    const total = (await leads.listLeads('ws_a')).length + (await leads.listLeads('ws_b')).length
    expect(total).toBe(1)
  })
})
