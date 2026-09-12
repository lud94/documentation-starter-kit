// Empreinte de l'intention facturable — clé d'intégrité de l'idempotence.
//
// POURQUOI PAS hash(model + estimation + agent). Ces trois valeurs ne
// caractérisent pas la requête : deux appels du même agent, sur le même modèle,
// avec le même `max_tokens` mais des messages entièrement différents produisent
// la même valeur. Un rejeu portant sur une requête DIFFÉRENTE serait alors
// accepté comme idempotent, et la seconde dépense partirait sans réservation.
//
// CE QU'ON EMPREINTE : le corps Anthropic RÉELLEMENT ENVOYÉ, plus le point de
// terminaison. C'est la définition exacte de « la même dépense » : même corps,
// même destinataire, donc même facturation attendue.
//
// CANONICALISATION. Les clés d'objet sont triées récursivement — l'ordre de
// sérialisation d'un objet JS n'est pas garanti stable entre deux constructions,
// et une simple permutation produirait une empreinte différente pour une requête
// identique, donc un faux `integrity_error`. L'ordre des TABLEAUX est en revanche
// conservé : dans `messages` et `tools`, il porte du sens.
//
// AUCUN CHAMP N'EST EXCLU. Le corps est intégralement déterministe au moment de
// l'appel : aucun horodatage, aucun identifiant aléatoire n'y figure. Si un champ
// non déterministe devait être introduit un jour, il faudrait l'exclure ICI et le
// documenter — pas le laisser casser l'idempotence en silence.
//
// ⚠️ L'échelle de dégradation de `send()` MUTE le corps entre deux tentatives
// (une option refusée est retirée). C'est voulu et sans danger : chaque requête
// HTTP porte son PROPRE identifiant de réservation, donc sa propre empreinte.
// Deux tentatives sont deux dépenses distinctes, pas un rejeu.
import { createHash } from 'node:crypto'

function canonical(v: any): any {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonical)
  const out: Record<string, any> = {}
  for (const k of Object.keys(v).sort()) out[k] = canonical(v[k])
  return out
}

export function requestFingerprint(endpoint: string, body: any): string {
  const payload = JSON.stringify({ endpoint, body: canonical(body) })
  return createHash('sha256').update(payload).digest('hex')
}
