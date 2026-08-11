param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'help', 'reset-codebase-memory')]
    [string]$Command = 'help',
    [string]$ConfigPath,
    [int]$PublicPort = 0,
    [int]$InternalPort = 3100
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $scriptDir 'supergateway.config.json'
}

function Show-Usage {
    Write-Host 'Usage: supergateway.ps1 <command> [options]'
    Write-Host ''
    Write-Host 'Files:'
    Write-Host '  .vscode/supergateway.js      Proxy implementation'
    Write-Host '  .vscode/supergateway.config.json  Gateway configuration'
    Write-Host ''
    Write-Host 'Commands:'
    Write-Host '  start                  Start both the public gateway and admin UI'
    Write-Host '  stop                   Stop both the public gateway and admin UI'
    Write-Host '  status                 Show gateway status for both endpoints'
    Write-Host '  reset-codebase-memory  Remove local Codebase Memory runtime/cache state so it can recreate its config store'
    Write-Host '  help                   Show this help text'
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)

    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($process -and $process.CommandLine) {
            return $process.CommandLine
        }
    } catch {
        return $null
    }

    return $null
}

function Test-HttpEndpoint {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
    } catch {
        return $false
    }
}

function Stop-ProcessOnPort {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        return $false
    }

    $ownerId = $listener.OwningProcess
    $commandLine = Get-ProcessCommandLine -ProcessId $ownerId
    if ($ownerId -and $commandLine -and $commandLine -match 'mcp-http-forward-proxy|mcp-stdio-http-proxy|supergateway') {
        Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
        return $true
    }

    return $false
}

function Get-GatewayConfig {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "Config file not found: $Path"
    }

    try {
        return Get-Content -Raw -Path $Path | ConvertFrom-Json
    } catch {
        throw "Failed to parse config file: $Path"
    }
}

function Get-ConfiguredPorts {
    param([object]$Config, [int]$PublicPort, [int]$AdminPort)

    $public = $PublicPort
    if ($public -le 0) {
        if ($Config.PSObject.Properties.Name -contains 'ports' -and $Config.ports) {
            $portsConfig = $Config.ports
            if ($portsConfig.PSObject.Properties.Name -contains 'public' -and $null -ne $portsConfig.public) {
                $public = [int]$portsConfig.public
            } elseif ($portsConfig.PSObject.Properties.Name -contains 'publicPort' -and $null -ne $portsConfig.publicPort) {
                $public = [int]$portsConfig.publicPort
            }
        }

        if ($public -le 0 -and $Config.PSObject.Properties.Name -contains 'publicPort' -and $null -ne $Config.publicPort) {
            $public = [int]$Config.publicPort
        }

        if ($public -le 0 -and $Config.PSObject.Properties.Name -contains 'port' -and $null -ne $Config.port) {
            $public = [int]$Config.port
        }

        if ($public -le 0) {
            $public = 8080
        }
    }

    $admin = $AdminPort
    if ($admin -le 0) {
        if ($Config.PSObject.Properties.Name -contains 'ports' -and $Config.ports) {
            $portsConfig = $Config.ports
            if ($portsConfig.PSObject.Properties.Name -contains 'admin' -and $null -ne $portsConfig.admin) {
                $admin = [int]$portsConfig.admin
            } elseif ($portsConfig.PSObject.Properties.Name -contains 'adminPort' -and $null -ne $portsConfig.adminPort) {
                $admin = [int]$portsConfig.adminPort
            }
        }

        if ($admin -le 0 -and $Config.PSObject.Properties.Name -contains 'adminPort' -and $null -ne $Config.adminPort) {
            $admin = [int]$Config.adminPort
        }

        if ($admin -le 0) {
            $admin = 3100
        }
    }

    return [pscustomobject]@{ Public = $public; Admin = $admin }
}

function Get-ConfiguredUpstreamEntries {
    param([object]$Config)

    if ($Config.PSObject.Properties.Name -contains 'upstreams' -and $Config.upstreams) {
        return @($Config.upstreams)
    }

    if ($Config.PSObject.Properties.Name -contains 'mcpServers' -and $Config.mcpServers) {
        return @($Config.mcpServers.PSObject.Properties)
    }

    return @()
}

function Get-AdminDbPath {
    param([string]$Path)

    $config = Get-GatewayConfig -Path $Path
    if ($config.PSObject.Properties.Name -contains 'adminDbPath' -and $config.adminDbPath) {
        $dbPath = [string]$config.adminDbPath
        if (-not [System.IO.Path]::IsPathRooted($dbPath)) {
            $workspaceRoot = Split-Path (Split-Path $Path -Parent) -Parent
            $dbPath = Join-Path $workspaceRoot $dbPath
        }

        $dbDir = Split-Path $dbPath -Parent
        if ($dbDir) {
            New-Item -Path $dbDir -ItemType Directory -Force | Out-Null
        }

        return $dbPath
    }

    $adminConfigDir = Split-Path $Path -Parent
    $adminDataDir = Join-Path $adminConfigDir 'data'
    if (-not (Test-Path $adminDataDir)) {
        New-Item -Path $adminDataDir -ItemType Directory -Force | Out-Null
    }

    return Join-Path $adminDataDir 'gateway.db'
}

function Get-AdminGatewayConfigPath {
    param([string]$Path)

    $configDir = Split-Path $Path -Parent
    $adminConfigDir = Join-Path $configDir 'data'
    if (-not (Test-Path $adminConfigDir)) {
        New-Item -Path $adminConfigDir -ItemType Directory -Force | Out-Null
    }

    return Join-Path $adminConfigDir 'admin-gateway-config.json'
}

function Get-GitLabPatFromEnvironment {
    $value = [System.Environment]::GetEnvironmentVariable('GITLAB_PAT', 'Process')
    if ($value) {
        return ([string]$value).Trim('"', "'")
    }
    return $null
}

function Get-CbmCacheDir {
    # Must live on local disk (not the repo path, which may be a network share) —
    # CBM's "secure CLI coordination" / private-cache checks fail on network filesystems.
    $baseDir = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }
    $cacheDir = Join-Path $baseDir 'supergateway-cbm-cache'
    if (-not (Test-Path $cacheDir)) {
        New-Item -Path $cacheDir -ItemType Directory -Force | Out-Null
    }
    return $cacheDir
}

function Apply-UpstreamConfiguration {
    param([object]$Config)

    if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
        return
    }

    # Windows default config-db location under LOCALAPPDATA can fail with
    # "cannot open config database"; pin CBM to a known-writable dir instead.
    $env:CBM_CACHE_DIR = Get-CbmCacheDir

    $serverEntries = Get-ConfiguredUpstreamEntries -Config $Config
    foreach ($entry in $serverEntries) {
        $serverName = $null
        $server = $null

        if ($entry -is [System.Management.Automation.PSProperty]) {
            $serverName = [string]$entry.Name
            $server = $entry.Value
        } else {
            $serverName = if ($entry.PSObject.Properties.Name -contains 'id') { [string]$entry.id } else { [string]$entry.name }
            $server = $entry
        }

        if ($serverName -ne 'codebase-memory' -and [string]$server.id -ne 'codebase-memory') {
            continue
        }

        if ($server.PSObject.Properties.Name -contains 'config' -and $server.config) {
            foreach ($configProp in $server.config.PSObject.Properties) {
                $configKey = [string]$configProp.Name
                $configValue = [string]$configProp.Value
                & npx.cmd -y codebase-memory-mcp config set $configKey $configValue | Out-Null
            }
        }

        if ($server.PSObject.Properties.Name -contains 'ui' -and $server.ui) {
            $uiConfig = $server.ui
            if ($uiConfig.PSObject.Properties.Name -contains 'enabled' -and [bool]$uiConfig.enabled) {
                $uiPort = 9749
                if ($uiConfig.PSObject.Properties.Name -contains 'port' -and $null -ne $uiConfig.port) {
                    $uiPort = [int]$uiConfig.port
                }
                $toolProfile = 'analysis'
                if ($uiConfig.PSObject.Properties.Name -contains 'toolProfile' -and $uiConfig.toolProfile) {
                    $toolProfile = [string]$uiConfig.toolProfile
                }

                $env:CBM_UI_ENABLED = 'true'
                $env:CBM_UI_PORT = [string]$uiPort
                $env:CBM_TOOL_PROFILE = $toolProfile
            }
        }
    }
}

function Write-AdminGatewayConfig {
    param([string]$Path, [string]$AdminConfigPath)

    $config = Get-GatewayConfig -Path $Path
    $serverEntries = Get-ConfiguredUpstreamEntries -Config $config
    if ($serverEntries.Count -eq 0) {
        throw 'No upstreams found in gateway config.'
    }

    $gitlabPat = Get-GitLabPatFromEnvironment
    if (-not $gitlabPat) {
        Write-Warning 'No GitLab token found in the current environment. Falling back to unauthenticated GitLab upstream behavior.'
    }

    $upstreams = @()
    foreach ($entry in $serverEntries) {
        if ($entry -is [System.Management.Automation.PSProperty]) {
            $serverName = $entry.Name
            $server = $entry.Value
            $isEnabled = $true
            if ($server.PSObject.Properties.Name -contains 'enabled' -and $null -ne $server.enabled) {
                $isEnabled = [bool]$server.enabled
            }

            if (-not $isEnabled) {
                continue
            }

            $namespace = ($serverName -replace '[^a-z0-9]', '').ToLowerInvariant()
            if (-not $namespace) {
                $namespace = "mcp$($upstreams.Count + 1)"
            }
            if ($serverName -eq 'codebase-memory') {
                $namespace = 'codebasememory'
            }
            if ($serverName -eq 'gitlab') {
                $namespace = 'gitlab'
            }

            $upstreamCommand = [string]$server.command
            $upstreamArgs = @($server.args)
            if ($upstreamCommand -ieq 'cmd.exe' -or $upstreamCommand -ieq 'cmd') {
                if ($upstreamArgs.Count -ge 2 -and $upstreamArgs[0] -ieq '/c') {
                    $upstreamArgs = @($upstreamArgs[1..($upstreamArgs.Count - 1)])
                }

                if ($upstreamArgs.Count -gt 0 -and ($upstreamArgs[0] -ieq 'npx' -or $upstreamArgs[0] -ieq 'npx.cmd')) {
                    $upstreamArgs = @($upstreamArgs[1..($upstreamArgs.Count - 1)])
                }

                $upstreamCommand = 'npx.cmd'
            }

            $upstream = [ordered]@{
                id = $serverName
                namespace = $namespace
                transport = 'stdio'
                command = $upstreamCommand
                args = $upstreamArgs
            }

            if ($server.PSObject.Properties.Name -contains 'env' -and $server.env) {
                $upstream.env = [ordered]@{}
                foreach ($envProp in $server.env.PSObject.Properties) {
                    $upstream.env[$envProp.Name] = [string]$envProp.Value
                }
            }

            if ($serverName -eq 'gitlab' -and $gitlabPat) {
                if (-not $upstream.env) {
                    $upstream.env = [ordered]@{}
                }
                $upstream.env['GITLAB_PAT'] = $gitlabPat
                # @zereight/mcp-gitlab reads this name, not GITLAB_PAT.
                $upstream.env['GITLAB_PERSONAL_ACCESS_TOKEN'] = $gitlabPat
            }

            if ($serverName -eq 'codebase-memory') {
                if (-not $upstream.env) {
                    $upstream.env = [ordered]@{}
                }
                # mcp-gateway spawns upstreams without inheriting the parent env,
                # so CBM's cache location must be passed explicitly here too.
                $upstream.env['CBM_CACHE_DIR'] = Get-CbmCacheDir

                if ($server.PSObject.Properties.Name -contains 'ui' -and $server.ui) {
                    $uiConfig = $server.ui
                    if ($uiConfig.PSObject.Properties.Name -contains 'enabled' -and [bool]$uiConfig.enabled) {
                        $upstream.env['CBM_UI_ENABLED'] = 'true'
                        if ($uiConfig.PSObject.Properties.Name -contains 'port' -and $null -ne $uiConfig.port) {
                            $upstream.env['CBM_UI_PORT'] = [string]$uiConfig.port
                        }
                        if ($uiConfig.PSObject.Properties.Name -contains 'toolProfile' -and $uiConfig.toolProfile) {
                            $upstream.env['CBM_TOOL_PROFILE'] = [string]$uiConfig.toolProfile
                        }
                    }
                }
            }

            $upstreams += $upstream
        } else {
            $upstream = [ordered]@{
                id = [string]$entry.id
                namespace = if ($entry.namespace) { [string]$entry.namespace } else { ([string]$entry.id -replace '[^a-z0-9]', '').ToLowerInvariant() }
                transport = if ($entry.transport) { [string]$entry.transport } else { 'stdio' }
                command = [string]$entry.command
                args = @($entry.args)
            }
            if ([string]$entry.id -eq 'gitlab') {
                $upstream.namespace = 'gitlab'
            }

            if ($entry.PSObject.Properties.Name -contains 'env' -and $entry.env) {
                $upstream.env = [ordered]@{}
                foreach ($envProp in $entry.env.PSObject.Properties) {
                    $upstream.env[$envProp.Name] = [string]$envProp.Value
                }
            }

            if ([string]$entry.id -eq 'gitlab' -and $gitlabPat) {
                if (-not $upstream.env) {
                    $upstream.env = [ordered]@{}
                }
                $upstream.env['GITLAB_PAT'] = $gitlabPat
                $upstream.env['GITLAB_PERSONAL_ACCESS_TOKEN'] = $gitlabPat
            }

            if ([string]$entry.id -eq 'codebase-memory') {
                if (-not $upstream.env) {
                    $upstream.env = [ordered]@{}
                }
                $upstream.env['CBM_CACHE_DIR'] = Get-CbmCacheDir
            }

            $upstreams += $upstream
        }
    }

    if ($upstreams.Count -eq 0) {
        throw 'No enabled upstreams found in gateway config.'
    }

    $adminConfig = [ordered]@{ upstreams = $upstreams }
    $adminConfigJson = $adminConfig | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($AdminConfigPath, $adminConfigJson, [System.Text.UTF8Encoding]::new($false))
}

function Reset-AdminGatewayState {
    param([string]$Path)

    $adminConfigPath = Get-AdminGatewayConfigPath -Path $Path
    if (Test-Path $adminConfigPath) {
        Remove-Item -Path $adminConfigPath -Force -ErrorAction SilentlyContinue
    }

    $adminDbPath = Get-AdminDbPath -Path $Path
    if (Test-Path $adminDbPath) {
        Remove-Item -Path $adminDbPath -Force -ErrorAction SilentlyContinue
    }

    $adminDataDir = Split-Path $adminDbPath -Parent
    if (Test-Path $adminDataDir) {
        Get-ChildItem -Path $adminDataDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'gateway.db*' -or $_.Name -like '*.db*' -or $_.Name -like '*.db-wal' -or $_.Name -like '*.db-shm' } |
            ForEach-Object {
                Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
            }
    }
}

function Start-AdminGateway {
    param([string]$Path, [int]$Port)

    if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
        throw 'npx.cmd not found on PATH. Please install Node.js and npm.'
    }

    Reset-AdminGatewayState -Path $Path

    $adminConfigPath = Get-AdminGatewayConfigPath -Path $Path
    Write-AdminGatewayConfig -Path $Path -AdminConfigPath $adminConfigPath | Out-Null

    $config = Get-GatewayConfig -Path $Path
    Apply-UpstreamConfiguration -Config $config

    $gitlabPat = Get-GitLabPatFromEnvironment
    if ($gitlabPat) {
        $env:GITLAB_PAT = $gitlabPat
    }

    $adminDbPath = Get-AdminDbPath -Path $Path
    $workingDirectory = Split-Path $adminConfigPath -Parent
    $env:DEV_ALLOW_UNAUTHENTICATED = 'true'
    $env:MCP_GATEWAY_PORT = [string]$Port
    $env:PORT = [string]$Port
    $env:DB_PATH = $adminDbPath
    $env:CI = 'true'
    $env:CBM_LOG_LEVEL = 'error'
    $env:CBM_CACHE_DIR = Get-CbmCacheDir

    $childEnv = [System.Collections.Generic.Dictionary[string,string]]::new()
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().Keys) {
        $childEnv[$entry] = [string][System.Environment]::GetEnvironmentVariable([string]$entry, 'Process')
    }
    $childEnv['DEV_ALLOW_UNAUTHENTICATED'] = 'true'
    $childEnv['MCP_GATEWAY_PORT'] = [string]$Port
    $childEnv['PORT'] = [string]$Port
    $childEnv['DB_PATH'] = $adminDbPath
    $childEnv['CI'] = 'true'
    $childEnv['CBM_LOG_LEVEL'] = 'error'
    $childEnv['CBM_CACHE_DIR'] = $env:CBM_CACHE_DIR

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $ownerId = $listener.OwningProcess
        $commandLine = Get-ProcessCommandLine -ProcessId $ownerId
        if ($ownerId -and $commandLine -and $commandLine -match '@mspstack/mcp-gateway|@mspstack\\mcp-gateway|mcp-gateway\\dist\\index.js|supergateway') {
            Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }

    foreach ($entry in $childEnv.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }

    # Start-Process without stdio redirection uses ShellExecute, which breaks
    # handle inheritance for the gateway's own grandchild upstream processes
    # (they fail their internal stdio handshake with "Connection closed").
    # Redirecting output forces the CreateProcess path instead.
    $gatewayLog = Join-Path $workingDirectory 'mcp-gateway.log'
    $gatewayErrLog = Join-Path $workingDirectory 'mcp-gateway.err.log'
    $process = Start-Process -FilePath 'npx.cmd' -ArgumentList @(
        '-y',
        '@mspstack/mcp-gateway',
        '--port',
        [string]$Port,
        '--config',
        $adminConfigPath,
        '--db-path',
        $adminDbPath
    ) -WorkingDirectory $workingDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayErrLog
    $adminUrl = "http://127.0.0.1:$Port/admin"
    $ready = $false
    for ($attempt = 1; $attempt -le 300; $attempt++) {
        if ($process.HasExited) {
            break
        }

        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri $adminUrl -TimeoutSec 5
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                    $ready = $true
                    break
                }
            } catch {
                Start-Sleep -Milliseconds 1000
            }
        } else {
            Start-Sleep -Milliseconds 1000
        }
    }

    if (-not $ready) {
        if ($process.HasExited) {
            throw "Admin UI exited before becoming reachable at $adminUrl."
        }

        throw "Admin UI did not become reachable at $adminUrl within 300 seconds."
    }

    Write-Host "Admin UI is reachable at $adminUrl"
}

function Start-Gateway {
    param([string]$Path, [int]$Port)

    $config = Get-GatewayConfig -Path $Path
    $ports = Get-ConfiguredPorts -Config $config -PublicPort $Port -AdminPort $InternalPort
    $publicPort = $ports.Public
    $adminPort = $ports.Admin

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'node.exe not found on PATH. Please install Node.js.'
    }

    Start-AdminGateway -Path $Path -Port $adminPort | Out-Null

    $workspaceRoot = Split-Path $Path -Parent
    $forwardProxyScript = Join-Path $workspaceRoot 'supergateway.js'
    if (-not (Test-Path $forwardProxyScript)) {
        throw "Forward proxy script not found: $forwardProxyScript"
    }

    Stop-ProcessOnPort -Port $publicPort | Out-Null

    $process = Start-Process -FilePath 'node.exe' -ArgumentList @(
        $forwardProxyScript,
        '--port',
        $publicPort,
        '--target',
        "http://127.0.0.1:$adminPort"
    ) -WorkingDirectory $workspaceRoot -PassThru -WindowStyle Hidden

    $healthUrl = "http://127.0.0.1:$publicPort/ping"
    $ready = $false
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        if ($process.HasExited) {
            break
        }

        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $ready) {
        throw "Supergateway did not become reachable at $healthUrl."
    }

    Write-Host "Supergateway is reachable at http://127.0.0.1:$publicPort/mcp"
}

function Stop-AdminGateway {
    param([int]$Port)

    if ($Port -le 0) {
        $Port = 3100
    }

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        Write-Host "No Admin UI listener found on port $Port."
        return
    }

    $ownerId = $listener.OwningProcess
    $commandLine = Get-ProcessCommandLine -ProcessId $ownerId
    if ($ownerId -and $commandLine -and $commandLine -match '@mspstack/mcp-gateway|@mspstack\\mcp-gateway|mcp-gateway\\dist\\index.js|supergateway') {
        Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped Admin UI on port $Port."
    } else {
        Write-Host "Port $Port is used by a different process."
    }
}

function Stop-Gateway {
    param([int]$Port)

    $config = Get-GatewayConfig -Path $ConfigPath
    $ports = Get-ConfiguredPorts -Config $config -PublicPort $Port -AdminPort $InternalPort
    $publicPort = $ports.Public
    $adminPort = $ports.Admin

    Stop-AdminGateway -Port $adminPort

    $listener = Get-NetTCPConnection -LocalPort $publicPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        Write-Host "No Supergateway listener found on port $publicPort."
        return
    }

    $ownerId = $listener.OwningProcess
    $commandLine = Get-ProcessCommandLine -ProcessId $ownerId
    if ($ownerId -and $commandLine -and $commandLine -match 'supergateway') {
        Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped Supergateway on port $publicPort."
    } else {
        Write-Host "Port $publicPort is used by a different process."
    }
}

function Reset-CodebaseMemoryRuntimeState {
    $candidatePaths = [System.Collections.Generic.List[string]]::new()

    if ($env:LOCALAPPDATA) {
        $candidatePaths.Add((Join-Path $env:LOCALAPPDATA 'codebase-memory-mcp'))
    }

    if ($env:APPDATA) {
        $candidatePaths.Add((Join-Path $env:APPDATA 'codebase-memory-mcp'))
    }

    if ($env:USERPROFILE) {
        $candidatePaths.Add((Join-Path $env:USERPROFILE '.codebase-memory-mcp'))
        $candidatePaths.Add((Join-Path $env:USERPROFILE '.config/codebase-memory-mcp'))
        $candidatePaths.Add((Join-Path $env:USERPROFILE '.cache/codebase-memory-mcp'))
    }

    if ($env:HOME) {
        $candidatePaths.Add((Join-Path $env:HOME '.codebase-memory-mcp'))
        $candidatePaths.Add((Join-Path $env:HOME '.config/codebase-memory-mcp'))
        $candidatePaths.Add((Join-Path $env:HOME '.cache/codebase-memory-mcp'))
    }

    $removedPaths = @()
    foreach ($candidatePath in $candidatePaths | Select-Object -Unique) {
        if (-not (Test-Path $candidatePath)) {
            continue
        }

        Remove-Item -Path $candidatePath -Recurse -Force -ErrorAction SilentlyContinue
        $removedPaths += $candidatePath
    }

    if ($removedPaths.Count -eq 0) {
        Write-Host 'No Codebase Memory runtime state found to remove.'
        return
    }

    Write-Host 'Removed Codebase Memory runtime state from:'
    foreach ($removedPath in $removedPaths) {
        Write-Host " - $removedPath"
    }
}

function Show-Status {
    param([string]$Path, [int]$Port)

    $config = Get-GatewayConfig -Path $Path
    $ports = Get-ConfiguredPorts -Config $config -PublicPort $Port -AdminPort $InternalPort
    $publicReady = Test-HttpEndpoint -Uri "http://127.0.0.1:$($ports.Public)/ping"
    $adminReady = Test-HttpEndpoint -Uri "http://127.0.0.1:$($ports.Admin)/admin"
    Write-Host ("Supergateway: {0}" -f ($(if ($publicReady) { 'reachable' } else { 'stopped' })))
    Write-Host ("Admin UI: {0}" -f ($(if ($adminReady) { 'reachable' } else { 'stopped' })))
}

if ($Command -eq 'help') {
    Show-Usage
    exit 0
}

switch ($Command) {
    'start' {
        Start-Gateway -Path $ConfigPath -Port $PublicPort
    }
    'stop' {
        Stop-Gateway -Port $PublicPort
    }
    'status' {
        Show-Status -Path $ConfigPath -Port $PublicPort
    }
    'reset-codebase-memory' {
        Reset-CodebaseMemoryRuntimeState
    }
    default {
        Show-Usage
        exit 1
    }
}
