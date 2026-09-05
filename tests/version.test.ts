import { describe, it, expect } from 'vitest'
import { BUILD, buildTag, withBuild } from '../lib/version'

// Ces fonctions sont le socle de la traçabilité : c'est l'étiquette qu'elles
// produisent qui permet de savoir, depuis une capture d'écran, quelle version du
// code a produit un message d'erreur. Leur régression est silencieuse et coûteuse.
describe('lib/version', () => {
  it('expose une empreinte de build non vide', () => {
    expect(BUILD.sha).toBeTruthy()
    expect(BUILD.branch).toBeTruthy()
    expect(BUILD.short.length).toBeLessThanOrEqual(7)
  })

  it('buildTag() renvoie « branche@commit »', () => {
    expect(buildTag()).toBe(`${BUILD.branch}@${BUILD.short}`)
    expect(buildTag()).toContain('@')
  })

  it('withBuild() ajoute l’étiquette au message', () => {
    const out = withBuild('Anthropic 400 — erreur')
    expect(out).toContain('Anthropic 400 — erreur')
    expect(out).toContain(`[build ${buildTag()}]`)
  })

  it('withBuild() est idempotent : jamais deux étiquettes', () => {
    const once = withBuild('erreur')
    const twice = withBuild(once)
    expect(twice).toBe(once)
    expect(twice.match(/\[build /g)).toHaveLength(1)
  })

  it('withBuild() préserve un message vide sans planter', () => {
    expect(() => withBuild('')).not.toThrow()
  })
})
