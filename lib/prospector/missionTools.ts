// Outils exécutables par l'orchestrateur de missions — PÉRIMÈTRE FERMÉ.
// L'IA planifie, mais ne peut déclencher QUE ces fonctions, avec des paramètres
// validés. Tout s'exécute côté serveur, dans l'espace (workspace) de la mission,
// une étape à la fois (compatible serverless + reprise après interruption).
import type { Mission, MissionStep, Lead, SourcedCompany, Sequence } from '../../types/prospector'
import { fetchCompanies, fetchCompanyDetail } from './datagouv'
import { enrichCompanyWeb } from './identify'
import { upsertLead } from '../supabase/leads'
import { listItems, upsertItem } from '../supabase/store'

const newId = () => `ld_${Math.random().toString(36).slice(2, 10)}`
// Garde-fous : bornes dures que le planificateur ne peut pas dépasser.
export const MAX_COMPANIES = 50
export const MAX_ENRICH = 10

function accountFrom(c: SourcedCompany): Lead {
  return {
    id: newId(), kind: 'account', firstName: '', lastName: '', title: '', company: c.name,
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
    siren: /^\d{9}$/.test(c.id) ? c.id : undefined, active: true,
    naf: c.naf || undefined, city: c.city || undefined, dirigeant: c.dirigeant || undefined,
    effectif: c.effectif || undefined, website: c.website || undefined,
  }
}

// Exécute UNE étape et renvoie une preuve lisible + le contexte mis à jour.
export async function runStep(step: MissionStep, mission: Mission, ws: string): Promise<{ result: string; context: Record<string, any> }> {
  const ctx = { ...mission.context }
  const p = step.params || {}

  switch (step.tool) {
    case 'source_companies': {
      const limit = Math.min(Number(p.limit) || 20, MAX_COMPANIES)
      const found: SourcedCompany[] = []
      let page = 1
      while (found.length < limit && page <= 4) {
        const r = await fetchCompanies({ sector: p.sector, location: p.location, size: p.size, page, activeOnly: true })
        if (!r.results.length) break
        found.push(...r.results)
        if (page >= (r.totalPages || 1)) break
        page++
      }
      ctx.companies = found.slice(0, limit)
      return { result: `${ctx.companies.length} entreprise(s) trouvée(s) via data.gouv${p.sector ? ` · ${p.sector}` : ''}${p.location ? ` · ${p.location}` : ''}.`, context: ctx }
    }

    case 'import_companies': {
      const companies: SourcedCompany[] = ctx.companies || []
      if (!companies.length) return { result: 'Aucune entreprise à importer (étape de sourcing vide).', context: ctx }
      const accountIds: string[] = []
      const accounts: Record<string, string> = {} // siren/nom → id du compte
      for (const c of companies) {
        const lead = accountFrom(c)
        await upsertLead(lead, ws)
        accountIds.push(lead.id)
        accounts[lead.siren || lead.company] = lead.id
      }
      ctx.accountIds = accountIds
      ctx.accounts = accounts
      return { result: `${accountIds.length} compte(s) créé(s) dans le pipe.`, context: ctx }
    }

    case 'resolve_dirigeants': {
      const companies: SourcedCompany[] = ctx.companies || []
      const contactIds: string[] = ctx.contactIds || []
      let added = 0
      for (const c of companies) {
        if (!/^\d{9}$/.test(c.id)) continue
        const detail = await fetchCompanyDetail(c.id)
        for (const d of detail.dirigeants.filter((x) => x.type === 'physique')) {
          const [firstName, ...rest] = d.name.split(/\s+/)
          if (!firstName) continue
          const contact: Lead = {
            id: newId(), kind: 'contact', firstName, lastName: rest.join(' '),
            title: 'Dirigeant', persona: 'Founder/CEO', company: c.name,
            score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite', email: null, phone: null,
            siren: c.id, naf: c.naf || undefined, city: c.city || undefined, effectif: c.effectif || undefined,
          }
          await upsertLead(contact, ws)
          contactIds.push(contact.id); added++
        }
      }
      ctx.contactIds = contactIds
      return { result: `${added} dirigeant(s) réel(s) ajouté(s) en contacts (data.gouv, rien d'inventé).`, context: ctx }
    }

    case 'enrich_companies': {
      // Coûteux (tokens) → borné dur.
      const companies: SourcedCompany[] = ctx.companies || []
      const n = Math.min(Number(p.limit) || 5, MAX_ENRICH, companies.length)
      let ok = 0
      for (const c of companies.slice(0, n)) {
        const r = await enrichCompanyWeb(c.name, c.city, /^\d{9}$/.test(c.id) ? c.id : undefined)
        if (r.website || r.summary) {
          const id = ctx.accounts?.[c.id] || ctx.accounts?.[c.name]
          if (id) {
            const lead = accountFrom(c)
            lead.id = id
            if (r.website) lead.website = r.website
            if (r.summary) lead.summary = r.summary
            if (r.ca) lead.ca = r.ca
            await upsertLead(lead, ws)
          }
          ok++
        }
      }
      return { result: `${ok}/${n} entreprise(s) enrichie(s) via le web (site, activité, CA quand publics).`, context: ctx }
    }

    case 'create_list': {
      const ids: string[] = [...(ctx.contactIds || []), ...(ctx.accountIds || [])]
      if (!ids.length) return { result: 'Aucun lead à mettre en liste.', context: ctx }
      const name = String(p.name || mission.title || 'Mission').slice(0, 80)
      const list = { id: `ls_${Math.random().toString(36).slice(2, 9)}`, name, leadIds: Array.from(new Set(ids)), source: 'mission', createdAt: Date.now() }
      await upsertItem('list', list.id, list, ws)
      ctx.listId = list.id
      return { result: `Liste « ${name} » créée avec ${list.leadIds.length} lead(s).`, context: ctx }
    }

    case 'create_sequence': {
      const contactIds: string[] = ctx.contactIds || []
      const name = String(p.name || `Séquence · ${mission.title}`).slice(0, 80)
      const existing = await listItems<Sequence>('sequence', ws)
      let seq = existing.find((s) => (s.name || '').toLowerCase() === name.toLowerCase())
      if (!seq) {
        seq = {
          id: `sq_${Math.random().toString(36).slice(2, 9)}`, name, status: 'paused',
          enrolled: 0, responseRate: 0, leadIds: [],
          steps: [
            { id: 'st1', channel: 'linkedin', type: 'visit', condition: 'always', delayDays: 0 },
            { id: 'st2', channel: 'linkedin', type: 'invitation', condition: 'always', delayDays: 1 },
            { id: 'st3', channel: 'linkedin', type: 'message', condition: 'if_connected', delayDays: 2 },
            { id: 'st4', channel: 'linkedin', type: 'relance', condition: 'if_no_response', delayDays: 4 },
          ],
        }
      }
      seq.leadIds = Array.from(new Set([...(seq.leadIds || []), ...contactIds]))
      seq.enrolled = seq.leadIds.length
      await upsertItem('sequence', seq.id, seq, ws)
      ctx.sequenceId = seq.id
      // Honnêteté : la séquence est créée EN PAUSE — l'envoi réel dépend d'Unipile.
      return { result: `Séquence « ${name} » prête avec ${seq.enrolled} contact(s) — en pause (l'envoi réel nécessite Unipile).`, context: ctx }
    }

    default:
      return { result: `Outil inconnu : ${step.tool}.`, context: ctx }
  }
}
