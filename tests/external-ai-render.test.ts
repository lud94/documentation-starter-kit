import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AskExternalAI from '../components/AskExternalAI'
import type { Lead } from '../types/prospector'

// Lot SEC-0d — cas A du §6 et « DOM state initial » du §8.
//
// ── CE QUE CE TEST PROUVE ────────────────────────────────────────────────────
// `renderToStaticMarkup` produit le PREMIER état du composant, celui qui existe
// avant que le moindre effet ne s'exécute — donc exactement ce qu'un
// utilisateur a sous les yeux, et sous le curseur, pendant le chargement de la
// politique. C'est la fenêtre qu'attaque le §8 : « clic très rapide avant
// chargement », « bouton/copy avant policy », « offline ».
//
// Le défaut mesuré : la condition de refus était `policy && !policy.allowed`.
// Avec `policy` à `null`, elle était FAUSSE — l'interface complète s'affichait,
// prompt inclus, boutons actifs, et `!!policy?.maskPii` valant `false`, le NOM
// RÉEL de la personne y figurait. Un fetch lent, ou qui ne revient jamais,
// laissait donc l'egress ouvert indéfiniment.
//
// Rendu SERVEUR, sans JSX ni DOM : aucune dépendance nouvelle, et le fichier
// reste un `.test.ts` ordinaire pour la configuration existante.

const LEAD = {
  id: 'lead_1', firstName: 'Séverine', lastName: 'NOM-SENSIBLE-8841',
  company: 'Redsen', title: 'Directrice', city: 'Paris', siren: '123456789',
} as unknown as Lead

const initial = () =>
  renderToStaticMarkup(createElement(AskExternalAI, { lead: LEAD, onSaveNotes: async () => {} }))

describe('A — l\'état INITIAL du composant est inerte', () => {
  it('aucune destination externe dans le premier rendu', () => {
    const html = initial()
    for (const host of ['claude.ai', 'chatgpt.com', 'perplexity.ai', 'google.com']) {
      expect(html).not.toContain(host)
    }
  })

  it('aucun prompt affiché tant que la politique n\'accorde rien', () => {
    // ⚠️ HONNÊTETÉ DU CAS. Ce seul test passait DÉJÀ sur le code vulnérable :
    // la carte s'ouvrait sur `open = false`, donc le prompt n'était pas dans le
    // premier rendu de toute façon. Il documente l'invariant ; ce n'est pas lui
    // qui prouve la correction. Les deux cas qui la prouvent sont l'état
    // affiché et l'absence de tout bouton, plus bas.
    const html = initial()
    expect(html).not.toContain('synthèse commerciale')
    expect(html).not.toContain('Copier le prompt')
    expect(html).not.toContain('Ouvrir dans')
  })

  it('LE NOM DE LA PERSONNE N\'EST PAS DANS LE PREMIER RENDU', () => {
    // Conséquence concrète du fail-open : `maskPii` valant `false` par défaut,
    // le nom réel partait dans le prompt affiché — et copiable.
    const html = initial()
    expect(html).not.toContain('NOM-SENSIBLE-8841')
    expect(html).not.toContain('Séverine')
  })

  it('l\'état affiché est « vérification », jamais « autorisé »', () => {
    expect(initial()).toContain('Vérification de la politique')
  })

  it('AUCUN bouton — la carte ne peut même pas être dépliée', () => {
    // C'est le cas décisif. Sur le code vulnérable, le bouton « Ouvrir » était
    // rendu et son clic ne déclenche AUCUN réseau : un simple basculement
    // d'état révélait prompt, sélecteur de destination et bouton d'ouverture,
    // pendant que la politique était encore en vol. Ici, il n'existe pas.
    const html = initial()
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<button')
  })
})
