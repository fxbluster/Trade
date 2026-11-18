<#
.SYNOPSIS
    TradeOS v1 to v2 Cutover Cleanup Script.
.DESCRIPTION
    Dynamically identifies and terminates orphaned TradeOS v1 processes (including
    tradeos_agent_keeper, legacy server.js on port 3300, and cmd wrappers) using
    Get-CimInstance Win32_Process without hardcoding PIDs.
    Neutralizes the Windows Startup hook TradeOS_Agent_Keeper.vbs by renaming it to .vbs.bak.
#>

param(
    [switch]$WhatIf
)

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " TradeOS v1 -> v2 Dynamic Cutover & Cleanup Script   " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

# -----------------------------------------------------------------------------
# Step 1: Neutralize Windows Startup persistence
# -----------------------------------------------------------------------------
Write-Host "`n[Step 1/3] Neutralizing Windows Startup Persistence..." -ForegroundColor Yellow

$startupFolder = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$startupVbs = [System.IO.Path]::Combine($startupFolder, 'TradeOS_Agent_Keeper.vbs')
$startupBak = [System.IO.Path]::Combine($startupFolder, 'TradeOS_Agent_Keeper.vbs.bak')

if (Test-Path -LiteralPath $startupVbs) {
    if ($WhatIf) {
        Write-Host "  [WHATIF] Would rename: $startupVbs -> $startupBak" -ForegroundColor Magenta
    } else {
        try {
            if (Test-Path -LiteralPath $startupBak) {
                Remove-Item -LiteralPath $startupBak -Force -ErrorAction Stop
                Write-Host "  Removed existing backup file: $startupBak" -ForegroundColor DarkGray
            }
            Move-Item -LiteralPath $startupVbs -Destination $startupBak -Force -ErrorAction Stop
            Write-Host "  [SUCCESS] Renamed startup hook to: $startupBak" -ForegroundColor Green
        } catch {
            Write-Warning "  Failed to rename startup script: $($_.Exception.Message)"
        }
    }
} else {
    if (Test-Path -LiteralPath $startupBak) {
        Write-Host "  [OK] Startup hook is already neutralized (backup exists at $startupBak)." -ForegroundColor Green
    } else {
        Write-Host "  [INFO] No TradeOS_Agent_Keeper.vbs found in Startup folder." -ForegroundColor Gray
    }
}

# -----------------------------------------------------------------------------
# Step 2: Dynamically detect orphaned v1 processes
# -----------------------------------------------------------------------------
Write-Host "`n[Step 2/3] Querying Win32_Process for orphaned TradeOS v1 processes..." -ForegroundColor Yellow

$port3300Pids = @()
try {
    $connections = Get-NetTCPConnection -LocalPort 3300 -ErrorAction SilentlyContinue
    if ($connections) {
        $port3300Pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
        Write-Host "  Found active listener PID(s) on port 3300: $($port3300Pids -join ', ')" -ForegroundColor DarkYellow
    }
} catch {
    # Ignore if NetTCPConnection is unavailable
}

$allProcesses = Get-CimInstance Win32_Process
$v1Processes = $allProcesses | Where-Object {
    $p = $_
    if ($p.ProcessId -eq $PID) { return $false }
    if ($p.Name -like "*powershell*" -or $p.Name -like "*pwsh*" -or $p.Name -like "*code*") { return $false }

    $cmd = if ($p.CommandLine) { $p.CommandLine } else { "" }

    $matchesPort = $port3300Pids -contains $p.ProcessId
    $matchesKeeper = $cmd -like "*tradeos_agent_keeper*"
    $matchesV1Server = ($cmd -like "*server.js*" -and ($cmd -like "*TradeOS*" -or $cmd -like "*3300*" -or $matchesPort))
    $matchesV1Cmd = ($p.Name -eq "cmd.exe" -and $cmd -like "*TradeOS*" -and ($cmd -like "*server.js*" -or $cmd -like "*3300*"))

    return ($matchesPort -or $matchesKeeper -or $matchesV1Server -or $matchesV1Cmd)
}

if (-not $v1Processes -or $v1Processes.Count -eq 0) {
    Write-Host "  [OK] No active TradeOS v1 processes detected." -ForegroundColor Green
} else {
    Write-Host "  Discovered $($v1Processes.Count) TradeOS v1 process(es) to terminate:" -ForegroundColor Yellow
    foreach ($proc in $v1Processes) {
        $cmdSnippet = if ($proc.CommandLine.Length -gt 80) { $proc.CommandLine.Substring(0, 77) + "..." } else { $proc.CommandLine }
        Write-Host "    - PID $($proc.ProcessId) [$($proc.Name)]: $cmdSnippet" -ForegroundColor White
    }

    if ($WhatIf) {
        Write-Host "  [WHATIF] Would stop $($v1Processes.Count) process(es)." -ForegroundColor Magenta
    } else {
        # Stop keepers first to prevent them from auto-restarting workers
        $keepers = $v1Processes | Where-Object { $_.CommandLine -like "*tradeos_agent_keeper*" }
        $others = $v1Processes | Where-Object { $_.CommandLine -notlike "*tradeos_agent_keeper*" }

        foreach ($proc in @($keepers) + @($others)) {
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-Host "  [TERMINATED] PID $($proc.ProcessId) ($($proc.Name))" -ForegroundColor Green
            } catch {
                Write-Warning "  Could not stop PID $($proc.ProcessId): $($_.Exception.Message)"
            }
        }

        # Verify termination
        Start-Sleep -Milliseconds 800
        $targetPids = @($v1Processes.ProcessId)
        $remaining = Get-CimInstance Win32_Process | Where-Object { $targetPids -contains $_.ProcessId }
        if ($remaining) {
            Write-Warning "  Retrying force stop on stubborn processes: $($remaining.ProcessId -join ', ')"
            foreach ($r in $remaining) {
                Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

# -----------------------------------------------------------------------------
# Step 3: Verify port 3300 status
# -----------------------------------------------------------------------------
Write-Host "`n[Step 3/3] Verifying port 3300 availability..." -ForegroundColor Yellow
$postCheck = Get-NetTCPConnection -LocalPort 3300 -ErrorAction SilentlyContinue
if ($postCheck) {
    if ($WhatIf) {
        Write-Host "  [INFO] Port 3300 is currently occupied by PID(s): $($postCheck.OwningProcess -join ', ')" -ForegroundColor DarkYellow
    } else {
        Write-Warning "  [WARNING] Port 3300 is still in use by PID(s): $($postCheck.OwningProcess -join ', ')"
    }
} else {
    Write-Host "  [OK] Port 3300 is fully cleared and released." -ForegroundColor Green
}

Write-Host "`nCutover cleanup completed successfully.`n" -ForegroundColor Cyan
