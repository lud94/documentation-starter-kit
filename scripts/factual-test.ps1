# FACTUAL_MEMORY_TEST_HARNESS_001 — enveloppe PowerShell du harnais factuel.
# (+ RUNTIME_FIX_001 : amorçage automatique de l'environnement Supabase LOCAL)
#
# Usage :
#   .\scripts\factual-test.ps1 funding
#   .\scripts\factual-test.ps1 executive
#   .\scripts\factual-test.ps1 hiring
#   .\scripts\factual-test.ps1 funding-correction
#   .\scripts\factual-test.ps1 funding-disagreement
#   .\scripts\factual-test.ps1 hiring-same-day-correction
#   .\scripts\factual-test.ps1 manual -InputFile .\case.json
#   .\scripts\factual-test.ps1 funding -Json
#   .\scripts\factual-test.ps1 funding -Memory        # mode unitaire EXPLICITE (rien n'est persisté)
#   .\scripts\factual-test.ps1 funding -Verbose
#   .\scripts\factual-test.ps1 -Cleanup               # purge l'espace ws_factual_harness uniquement
#
# Codes de sortie :
#   0 = PASS    1 = FAIL fonctionnel
#   2 = BLOCKED (environnement / prérequis, ex. Supabase local absent)
#   3 = entrée manuelle ou cas invalide
#
# ── AMORÇAGE LOCAL AUTOMATIQUE ────────────────────────────────────────────────
# Après `npm run db:test:up`, aucune manipulation d'environnement n'est requise :
# si `-Memory` n'est pas demandé et qu'aucune variable SUPABASE_* n'est déjà
# posée, l'enveloppe interroge le CLI LOCAL (`npx supabase status -o env`),
# vérifie que l'API est bien sur localhost/127.0.0.1, et injecte URL + clé de
# service dans l'ENVIRONNEMENT DU PROCESSUS ENFANT uniquement — valeurs
# restaurées en `finally`, jamais imprimées, jamais écrites dans un .env, jamais
# dans l'environnement utilisateur/global. URL non locale ⇒ REFUS (code 2).
# Un environnement local déjà fourni explicitement reste prioritaire.
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string]$Case = 'help',
  [string]$InputFile,
  [switch]$Json,
  [switch]$Memory,
  [switch]$Cleanup
)

$ErrorActionPreference = 'Stop'
$racine = Split-Path -Parent $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'BLOCKED : node introuvable (Node >= 22.15 requis)'
  exit 2
}

$arguments = @(
  '--experimental-strip-types',
  '--disable-warning=ExperimentalWarning',
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  '--import', './scripts/ts-resolve-hook.mjs',
  'scripts/factual-harness.mjs'
)
if ($Cleanup) { $arguments += '--cleanup' } else { $arguments += $Case }
if ($Json) { $arguments += '--json' }
if ($Memory) { $arguments += '--memory' }
if ($PSBoundParameters.ContainsKey('Verbose')) { $arguments += '--verbose' }
if ($InputFile) { $arguments += @('--input', $InputFile) }

# Sauvegarde pour restauration : l'amorçage ne doit survivre ni à ce script ni
# à la session au-delà de lui.
$sauvegarde = @{
  SUPABASE_URL              = $env:SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY = $env:SUPABASE_SERVICE_ROLE_KEY
}
$amorce = $false

Push-Location $racine
try {
  $envDejaFourni = $env:SUPABASE_URL -or $env:NEXT_PUBLIC_SUPABASE_URL -or $env:SUPABASE_PROJECT_URL
  if (-not $Memory -and -not $envDejaFourni) {
    # ⚠️ CLI LOCAL uniquement — jamais `supabase link`, jamais un projet distant.
    $statut = & npx supabase status -o env 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $statut) {
      Write-Error 'BLOCKED : `supabase status` a échoué — la pile locale est-elle démarrée ? (npm run db:test:up)'
      exit 2
    }
    $apiUrl = ($statut | Select-String -Pattern '^API_URL="(.*)"$' | Select-Object -First 1).Matches.Groups[1].Value
    $serviceKey = ($statut | Select-String -Pattern '^SERVICE_ROLE_KEY="(.*)"$' | Select-Object -First 1).Matches.Groups[1].Value
    if (-not $apiUrl -or -not $serviceKey) {
      Write-Error 'BLOCKED : API_URL/SERVICE_ROLE_KEY absents de `supabase status` (auth locale activée ?)'
      exit 2
    }
    # ⚠️ VÉRIFICATION D'HÔTE AVANT USAGE — et la valeur n'est JAMAIS imprimée.
    $hote = ([uri]$apiUrl).Host
    if ($hote -notin @('localhost', '127.0.0.1', '::1', '[::1]')) {
      Write-Error 'REFUSED : l''API rendue par `supabase status` n''est pas locale — amorçage refusé'
      exit 2
    }
    $env:SUPABASE_URL = $apiUrl
    $env:SUPABASE_SERVICE_ROLE_KEY = $serviceKey
    $amorce = $true
    Write-Host "Amorçage Supabase LOCAL : API sur $hote (valeurs non affichées, portée = ce processus)"
  }

  & node @arguments
  exit $LASTEXITCODE
}
finally {
  if ($amorce) {
    # Restauration : absence redevient absence, valeur préalable redevient valeur.
    if ($null -eq $sauvegarde.SUPABASE_URL) { Remove-Item Env:SUPABASE_URL -ErrorAction SilentlyContinue }
    else { $env:SUPABASE_URL = $sauvegarde.SUPABASE_URL }
    if ($null -eq $sauvegarde.SUPABASE_SERVICE_ROLE_KEY) { Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue }
    else { $env:SUPABASE_SERVICE_ROLE_KEY = $sauvegarde.SUPABASE_SERVICE_ROLE_KEY }
  }
  Pop-Location
}
