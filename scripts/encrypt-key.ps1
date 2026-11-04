$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Get-Location) '.env'
$lines = [System.IO.File]::ReadAllLines($envFile)
$line = $lines | Where-Object { $_ -match '^OPENAI_API_KEY=.+$' } | Select-Object -First 1
if (-not $line) { throw 'No hay clave en .env para cifrar.' }
$key = $line.Substring('OPENAI_API_KEY='.Length).Trim()
if (-not $key.StartsWith('sk-')) { throw 'La clave no tiene el formato esperado.' }
$secure = ConvertTo-SecureString -String $key -AsPlainText -Force
$cipher = ConvertFrom-SecureString -SecureString $secure
$secretDir = Join-Path (Get-Location) '.secrets'
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$destination = Join-Path $secretDir 'openai.dpapi'
[System.IO.File]::WriteAllText($destination, $cipher, [System.Text.Encoding]::ASCII)
$verification = (Get-Content -LiteralPath $destination -Raw) | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($verification)
try { if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -ne $key) { throw 'Falló la verificación del cifrado.' } } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$updated = $lines | ForEach-Object { if ($_ -match '^OPENAI_API_KEY=') { 'OPENAI_API_KEY=' } else { $_ } }
[System.IO.File]::WriteAllLines($envFile, $updated, [System.Text.UTF8Encoding]::new($false))
Write-Output 'Clave cifrada para el usuario de Windows actual y retirada de .env.'
