// LOCAL_SUPABASE_ISOLATION_001 — verrous DÉTERMINISTES d'isolation locale.
//
// Le poste de développement héberge une pile Supabase indépendante
// `jarvis-v31` (54321 / 54322 / 54324). Ces tests verrouillent le fait que la
// pile LOCALE de Prospector vit dans son propre espace de noms de conteneurs
// et sa propre plage de ports hôte 5532x — sans démarrer Docker : ce sont des
// verrous de CONFIGURATION, le démarrage réel relève du poste et de la CI
// d'intégration.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const config = readFileSync(join(process.cwd(), 'supabase', 'config.toml'), 'utf8')
const section = (nom: string): string => {
  const m = config.match(new RegExp(`\\n\\[${nom.replace('.', '\\.')}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))
  return m ? m[1] : ''
}

describe('espace de noms local', () => {
  it('project_id = prospector-factual-local — espace de CONTENEURS locaux, pas une référence distante', () => {
    expect(config).toMatch(/^project_id = "prospector-factual-local"$/m)
    // ⚠️ AUCUNE référence de projet distant : pas de project_ref, pas d'URL
    // supabase.co, pas de `supabase link` matérialisé dans le fichier versionné.
    expect(config).not.toMatch(/project_ref/)
    expect(config).not.toMatch(/supabase\.co/)
    expect(config).not.toMatch(/\bAWS\b|service_role_key\s*=|anon_key\s*=/i)
  })
})

describe('plage de ports 5532x — jamais celle de jarvis-v31', () => {
  it('ports hôte explicites et cohérents', () => {
    expect(section('api')).toMatch(/^port = 55321$/m)
    expect(section('db')).toMatch(/^port = 55322$/m)
    expect(section('db')).toMatch(/^shadow_port = 55320$/m)
    expect(section('studio')).toMatch(/^port = 55323$/m)
    expect(section('local_smtp')).toMatch(/^port = 55324$/m)
    expect(section('local_smtp')).toMatch(/^smtp_port = 55325$/m)
    expect(section('local_smtp')).toMatch(/^pop3_port = 55326$/m)
  })

  it('aucun port de la pile jarvis-v31 (54321/54322/54324) ni défaut résiduel (54327, 8083) déclaré', () => {
    // Sur les LIGNES DIRECTIVES uniquement : les commentaires ont le droit de
    // documenter les ports occupés par jarvis-v31, pas les directives de les prendre.
    const directives = config.split('\n').filter((l) => !l.trim().startsWith('#'))
    for (const l of directives) expect(l, l).not.toMatch(/\b5432[0-9]\b/)
    expect(config).not.toMatch(/^inspector_port/m)
    // Les services qui réclameraient des ports par défaut sont ÉTEINTS.
    expect(section('analytics')).toMatch(/^enabled = false$/m)
    expect(section('edge_runtime')).toMatch(/^enabled = false$/m)
  })
})

describe('forme préservée du lot précédent', () => {
  it('db 17, api/auth/studio actifs, storage/realtime éteints', () => {
    expect(section('db')).toMatch(/^major_version = 17$/m)
    expect(section('api')).toMatch(/^enabled = true$/m)
    expect(section('auth')).toMatch(/^enabled = true$/m)
    expect(section('studio')).toMatch(/^enabled = true$/m)
    expect(section('storage')).toMatch(/^enabled = false$/m)
    expect(section('realtime')).toMatch(/^enabled = false$/m)
  })
})

describe('aucun port codé en dur là où l’environnement fait foi', () => {
  it('le harnais factuel découvre l’URL par l’environnement, jamais par un port figé', () => {
    const harnais = readFileSync(
      join(process.cwd(), 'lib/prospector/proactive/harness/factualHarness.ts'), 'utf8',
    )
    expect(harnais).not.toMatch(/5432\d|5532\d/)
  })

  it('les tests d’intégration privilégient SUPABASE_TEST_URL ; leur repli local vise la pile Prospector (55321)', () => {
    for (const f of [
      'tests/integration/store-claim-pg.test.ts', 'tests/integration/leads-pg.test.ts',
      'tests/integration/ai-budget-module-pg.test.ts', 'tests/integration/ai-budget-pg.test.ts',
      'tests/integration/reset-authority-pg.test.ts', 'tests/integration/platform-vault-pg.test.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).toMatch(/SUPABASE_TEST_URL \|\| 'http:\/\/127\.0\.0\.1:55321'/)
      expect(src, f).not.toMatch(/54321/)
    }
  })
})
