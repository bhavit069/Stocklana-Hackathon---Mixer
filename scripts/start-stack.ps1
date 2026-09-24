
$ErrorActionPreference = "Stop"

$StackRoot = "C:\Users\bhavi\mixer-stack"
$Cockroach = Join-Path $StackRoot "cockroach\cockroach.exe"
$RedisDir  = Join-Path $StackRoot "redis"
$DataDir   = Join-Path $StackRoot "data"

function Test-Port($Port) {
    $c = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
    return $c
}

if (Test-Port 6379) {
    Write-Host "Redis        already running on 6379"
} else {
    Write-Host "Redis        starting..."

    Start-Process -FilePath (Join-Path $RedisDir "redis-server.exe") `
        -ArgumentList "--port","6379","--bind","127.0.0.1",
                      "--dir","$DataDir/redis",'--save ""',"--appendonly","no" `
        -WorkingDirectory $RedisDir -WindowStyle Hidden
}

if (Test-Port 26257) {
    Write-Host "CockroachDB  already running on 26257"
} else {

    $env:COCKROACH_ENGINE_MAX_SYNC_DURATION_FATAL = "false"
    Write-Host "CockroachDB  starting..."
    Start-Process -FilePath $Cockroach `
        -ArgumentList "start-single-node","--insecure",
                      "--store=$DataDir\crdb",
                      "--listen-addr=localhost:26257",
                      "--http-addr=localhost:8080" `
        -WorkingDirectory $StackRoot -WindowStyle Hidden
}

foreach ($svc in @(@{Name="Redis"; Port=6379}, @{Name="CockroachDB"; Port=26257})) {
    $tries = 0
    while (-not (Test-Port $svc.Port)) {
        Start-Sleep -Milliseconds 500
        if (++$tries -gt 60) { throw "$($svc.Name) failed to start on port $($svc.Port)" }
    }
    Write-Host "$($svc.Name.PadRight(12)) ready on $($svc.Port)"
}

Write-Host ""
Write-Host "Stack up. DB console: http://localhost:8080"
Write-Host "Run 'npm start' to launch the app on http://localhost:6900"
