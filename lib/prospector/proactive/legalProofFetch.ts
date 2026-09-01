// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — CAPTURE DE PREUVE LÉGALE, SSRF-SÛRE.
//
// ⚠️ CE MODULE N'EST PAS UN FETCHER GÉNÉRIQUE et ne doit jamais le devenir.
// Il capture UNE page de preuve légale première-partie sur EXACTEMENT l'hôte
// lié (modulo `www.`), en HTTPS:443 uniquement, avec épinglage DNS→connexion.
//
// ── MODÈLE DE MENACE (SSRF P0) ──────────────────────────────────────────────
// L'URL de preuve est DÉSIGNÉE par un navigateur : elle est hostile par
// défaut. Chaque saut (initial et chaque redirection, 3 max) répète TOUTES les
// gardes : schéma https seul, port 443 seul, FQDN seul (jamais localhost, nom
// interne mono-étiquette, littéral IP), résolution DNS côté serveur puis
// CONNEXION SUR L'IP VALIDÉE (le rappel `lookup` injecté à https.request rend
// l'adresse validée — pas de re-résolution entre validation et connexion,
// ce qui ferme le rebinding/TOCTOU), ensemble d'adresses ENTIÈREMENT licite
// (une seule adresse privée/interne dans la réponse DNS ⇒ échec, on ne
// « choisit » pas autour), hôte final = hôte lié.
//
// Plages refusées : 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16
// (métadonnées cloud 169.254.169.254 comprises), 100.64/10, 0.0.0.0/8,
// 224/4 et 240/4, plages de test/réservées (192.0.0/24, 192.0.2/24,
// 198.18/15, 198.51.100/24, 203.0.113/24), fe80::/10, fc00::/7, ff00::/8,
// `::`/`::1`, IPv6 mappé IPv4 (::ffff:a.b.c.d revalidé comme IPv4).
//
// Réponse : timeout borné, corps plafonné (flux coupé), Content-Type
// text/html|text/plain seulement, Accept-Encoding identity, AUCUN cookie,
// AUCUN Authorization, AUCUN en-tête navigateur retransmis, User-Agent fixe.
// ⚠️ Le corps distant ne sort JAMAIS de ce module par une erreur : les échecs
// sont des raisons CLOSES, le contrat SafeError/publicError reste intact.
import { promises as dns } from 'node:dns'
import { request as httpsRequest } from 'node:https'

export const PROOF_TIMEOUT_MS = 10_000
export const PROOF_MAX_BYTES = 1_000_000
export const PROOF_MAX_REDIRECTS = 3
const USER_AGENT = 'ProspectorLegalProof/1.0'

export type ProofFailureReason =
  | 'INVALID_URL'
  | 'PROHIBITED_TARGET'
  | 'DNS_FAILED'
  | 'REDIRECT_POLICY'
  | 'TOO_MANY_REDIRECTS'
  | 'FETCH_FAILED'
  | 'TIMEOUT'
  | 'BODY_TOO_LARGE'
  | 'BAD_CONTENT_TYPE'

export type LegalProofCapture =
  | { ok: true; finalUrl: string; body: string }
  | { ok: false; reason: ProofFailureReason }

/** Dépendances INJECTABLES — les tests ne touchent JAMAIS le réseau. */
export interface ProofDeps {
  /** Résout A puis AAAA ; rend l'UNION (vide si rien). Ne lève pas. */
  resolve(hostname: string): Promise<string[]>
  /** Une requête GET https, connectée à `ip`, SNI/Host = `hostname`. Ne suit AUCUNE redirection. */
  request(opts: {
    hostname: string
    ip: string
    path: string
    timeoutMs: number
    maxBytes: number
  }): Promise<{ status: number; location?: string; contentType?: string; body: string; truncated: boolean }>
}

/** Normalisation d'hôte V0 : minuscules + retrait d'UN `www.` de tête. RIEN d'autre. */
export function normalizeHost(host: unknown): string | null {
  if (typeof host !== 'string') return null
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === '') return null
  return h.startsWith('www.') ? h.slice(4) : h
}

const FQDN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export function isProhibitedIp(brut: string): boolean {
  const ip = String(brut || '').trim().toLowerCase()
  if (ip === '') return true
  if (ip.includes(':')) {
    // IPv6 mappé IPv4 : revalidé selon les règles IPv4.
    const mappe = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mappe) return isProhibitedIp(mappe[1])
    if (ip === '::' || ip === '::1') return true
    if (/^fe[89ab]/.test(ip)) return true            // link-local fe80::/10
    if (/^f[cd]/.test(ip)) return true               // unique-local fc00::/7
    if (/^ff/.test(ip)) return true                  // multicast ff00::/8
    return false
  }
  if (!IPV4.test(ip)) return true // ni IPv6 ni IPv4 canonique ⇒ refus fermé
  const [a, b, c] = ip.split('.').map(Number)
  if ([a, b, c].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true            // link-local + métadonnées cloud
  if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT 100.64/10
  if (a >= 224) return true                          // multicast 224/4 + réservé 240/4
  if (a === 192 && b === 0) return true              // 192.0.0/24 + 192.0.2/24 (doc)
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  return false
}

/**
 * Valide une URL de saut (initiale ou cible de redirection) contre l'hôte lié.
 * https: seul, port 443 seul, FQDN seul, hôte normalisé === domainHost.
 */
function urlDeSautValide(brut: string, domainHost: string): URL | null {
  let u: URL
  try { u = new URL(brut) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (u.port !== '' && u.port !== '443') return null
  if (u.username !== '' || u.password !== '') return null
  const hote = u.hostname.toLowerCase()
  if (!FQDN.test(hote)) return null                  // rejette localhost, noms internes, littéraux IP
  if (IPV4.test(hote) || hote.includes(':')) return null
  if (normalizeHost(hote) !== domainHost) return null
  return u
}

async function resolutionLicite(hostname: string, deps: ProofDeps): Promise<string | null> {
  let adresses: string[] = []
  try { adresses = await deps.resolve(hostname) } catch { return null }
  if (!Array.isArray(adresses) || adresses.length === 0) return null
  // ⚠️ UNE adresse interdite dans l'ensemble ⇒ échec ENTIER. On ne sélectionne
  // pas optimistement une adresse publique dans une réponse mixte.
  for (const a of adresses) if (isProhibitedIp(a)) return null
  return adresses[0]
}

/**
 * Capture la page de preuve. `domainHost` est l'hôte LIÉ (déjà normalisé par
 * l'appelant serveur — jamais par le navigateur) ; `proofUrl` est l'URL
 * désignée. Tout échec de garde ⇒ raison close, RIEN n'est persisté ici.
 */
export async function captureLegalProof(
  domainHost: string, proofUrl: string, deps: ProofDeps = depsReelles,
): Promise<LegalProofCapture> {
  const hote = normalizeHost(domainHost)
  if (!hote || !FQDN.test(hote)) return { ok: false, reason: 'INVALID_URL' }

  let courante = urlDeSautValide(String(proofUrl || ''), hote)
  if (!courante) return { ok: false, reason: 'INVALID_URL' }

  for (let saut = 0; saut <= PROOF_MAX_REDIRECTS; saut++) {
    const ip = await resolutionLicite(courante.hostname.toLowerCase(), deps)
    if (ip === null) {
      // Résolution vide/échouée ET ensemble contenant une adresse interdite
      // convergent volontairement : dans les deux cas, on ne se connecte pas.
      return { ok: false, reason: 'PROHIBITED_TARGET' }
    }
    let rep: Awaited<ReturnType<ProofDeps['request']>>
    try {
      rep = await deps.request({
        hostname: courante.hostname.toLowerCase(),
        ip,
        path: `${courante.pathname}${courante.search}`,
        timeoutMs: PROOF_TIMEOUT_MS,
        maxBytes: PROOF_MAX_BYTES,
      })
    } catch (e: any) {
      return { ok: false, reason: e?.message === 'PROOF_TIMEOUT' ? 'TIMEOUT' : 'FETCH_FAILED' }
    }

    if ([301, 302, 303, 307, 308].includes(rep.status)) {
      if (saut === PROOF_MAX_REDIRECTS) return { ok: false, reason: 'TOO_MANY_REDIRECTS' }
      if (typeof rep.location !== 'string' || rep.location.trim() === '') {
        return { ok: false, reason: 'REDIRECT_POLICY' }
      }
      let absolue: string
      try { absolue = new URL(rep.location, courante).toString() } catch {
        return { ok: false, reason: 'REDIRECT_POLICY' }
      }
      // ⚠️ CHAQUE cible de redirection repasse TOUTES les gardes (schéma,
      // port, FQDN, hôte lié) puis DNS/IP au tour suivant.
      const suivante = urlDeSautValide(absolue, hote)
      if (!suivante) return { ok: false, reason: 'REDIRECT_POLICY' }
      courante = suivante
      continue
    }

    if (rep.status !== 200) return { ok: false, reason: 'FETCH_FAILED' }
    if (rep.truncated) return { ok: false, reason: 'BODY_TOO_LARGE' }
    const ct = String(rep.contentType || '').toLowerCase().split(';')[0].trim()
    if (ct !== 'text/html' && ct !== 'text/plain') return { ok: false, reason: 'BAD_CONTENT_TYPE' }
    return { ok: true, finalUrl: courante.toString(), body: rep.body }
  }
  return { ok: false, reason: 'TOO_MANY_REDIRECTS' }
}

// ── DÉPENDANCES RÉELLES (jamais exercées par les tests automatisés) ─────────

const depsReelles: ProofDeps = {
  async resolve(hostname) {
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ])
    return [...v4, ...v6]
  },
  request({ hostname, ip, path, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: hostname, // Host + SNI/validation de certificat = nom d'origine
          port: 443,
          path,
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html, text/plain',
            'Accept-Encoding': 'identity',
          },
          // ⚠️ ÉPINGLAGE : la connexion utilise l'IP DÉJÀ VALIDÉE — aucune
          // seconde résolution entre validation et connexion.
          lookup: (_h: string, opts: any, cb: any) => {
            const famille = ip.includes(':') ? 6 : 4
            if (opts && opts.all) cb(null, [{ address: ip, family: famille }])
            else cb(null, ip, famille)
          },
          timeout: timeoutMs,
        },
        (res) => {
          let corps = ''
          let coupe = false
          res.on('data', (chunk: Buffer) => {
            if (coupe) return
            corps += chunk.toString('utf8')
            if (Buffer.byteLength(corps, 'utf8') > maxBytes) {
              coupe = true
              res.destroy()
            }
          })
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined,
            body: coupe ? '' : corps,
            truncated: coupe,
          }))
          res.on('close', () => {
            if (coupe) resolve({ status: res.statusCode ?? 0, body: '', truncated: true })
          })
          res.on('error', () => reject(new Error('PROOF_STREAM')))
        },
      )
      req.on('timeout', () => { req.destroy(new Error('PROOF_TIMEOUT')) })
      req.on('error', (e) => reject(e instanceof Error ? e : new Error('PROOF_REQUEST')))
      req.end()
    })
  },
}
