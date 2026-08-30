# FACTUAL_MEMORY_TEST_HARNESS_001 — enveloppe PowerShell du harnais factuel.
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
# Prérequis : Node >= 22.15 (même mécanisme que `npm run proactive:eval` —
# aucune dépendance npm ajoutée). Persistance : Supabase LOCAL (`npm run
# db:test:up`) ; sans base locale le mode par défaut rend BLOCKED, jamais un
# faux PASS en mémoire. Aucun fichier .env n'est modifié ; les drapeaux
# SIGNAL_ARCH_V1_* sont activés pour le processus enfant uniquement.
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

Push-Location $racine
try {
  & node @arguments
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
