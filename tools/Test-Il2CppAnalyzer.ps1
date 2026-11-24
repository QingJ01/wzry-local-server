param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$analyzer = Join-Path $PSScriptRoot "analyze_il2cpp.mjs"
$inputApk = Join-Path $root "workspace\apk\3.81.1.8.apk"
$inputMetadata = Join-Path $root "workspace\analysis\extracted\assets\bin\Data\Managed\Metadata\global-metadata.dat"
$inputLibrary = Join-Path $root "workspace\analysis\extracted\lib\arm64-v8a\libil2cpp.so"
$outputDirectory = Join-Path $root "workspace\analysis\il2cpp"

foreach ($path in @($inputApk, $inputMetadata, $inputLibrary)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing input: $path"
    }
}

Write-Host "== node syntax check =="
node --check $analyzer
if ($LASTEXITCODE -ne 0) {
    throw "node --check failed"
}

Write-Host "== il2cpp analyzer =="
node $analyzer $inputApk $inputMetadata $inputLibrary $outputDirectory
if ($LASTEXITCODE -ne 0) {
    throw "il2cpp analyzer failed"
}

Write-Host "== analyzer assertions =="
$analysisPath = Join-Path $outputDirectory "il2cpp_analysis.json"
$targetIndexPath = Join-Path $outputDirectory "target-index.txt"
$stringHitsPath = Join-Path $outputDirectory "string-hits.txt"
foreach ($path in @($analysisPath, $targetIndexPath, $stringHitsPath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing analyzer output: $path"
    }
}

$analysis = Get-Content -LiteralPath $analysisPath -Raw | ConvertFrom-Json

function Assert-Value {
    param(
        [string] $Name,
        [object] $Actual,
        [object] $Expected
    )
    if ($Actual -ne $Expected) {
        throw "$Name expected $Expected, got $Actual"
    }
}

function Assert-Method {
    param(
        [object] $Target,
        [int] $Index,
        [string] $Name,
        [string] $Token
    )
    $method = $Target.methods | Where-Object { $_.index -eq $Index }
    if (-not $method) {
        throw "Missing method index $Index for $($Target.typeName)"
    }
    if ($method.name -ne $Name) {
        throw "Method $Index expected $Name, got $($method.name)"
    }
    if ($method.token -ne [Convert]::ToInt64($Token, 16)) {
        throw "Method $Index expected token $Token, got $($method.token)"
    }
}

Assert-Value "APK SHA-256" $analysis.apk.sha256 "a016d941a3d7ba0a8fc976dae6fe744efec85835a16dd10928b65a9c7e19ee5d"
Assert-Value "APK size" $analysis.apk.size 460348136
Assert-Value "Metadata SHA-256" $analysis.metadata.sha256 "c64ec24dbb1febc3f1edf9cd6f38f572b7ea767a0efb548ddd5425eb3f48e99b"
Assert-Value "Metadata size" $analysis.metadata.size 41405108
Assert-Value "Metadata version" $analysis.metadata.header.version 23
Assert-Value "String literal count" $analysis.metadata.header.tables.stringLiterals.count 47859
Assert-Value "Method count" $analysis.metadata.header.tables.methods.count 218980
Assert-Value "Type count" $analysis.metadata.header.tables.typeDefinitions.count 33929
Assert-Value "Field count" $analysis.metadata.header.tables.fields.count 249427
Assert-Value "Parameter count" $analysis.metadata.header.tables.parameters.count 201743
Assert-Value "Image count" $analysis.metadata.header.tables.images.count 26
Assert-Value "Assembly complete records" $analysis.metadata.header.tables.assemblies.count 55

$expectedTargets = @{
    5594 = "CEncryption"
    5706 = "SgNet.Script.SgConnector"
    5719 = "SgNet.Script.SgNetMgr"
    17193 = "Assets.Scripts.Framework.FrameSynchr"
    17195 = "Assets.Scripts.Framework.FrameWindow"
    18189 = "Assets.Scripts.Framework.LobbyConnector"
    24933 = "ApolloHelper"
    27146 = "CLoginSystem2"
    30081 = "Assets.Scripts.GameSystem.CShopSystem"
}
foreach ($typeIndex in $expectedTargets.Keys) {
    $target = $analysis.metadata.targets | Where-Object { $_.typeIndex -eq $typeIndex }
    if (-not $target) {
        throw "Missing target type index $typeIndex"
    }
    Assert-Value "Target $typeIndex name" $target.typeName $expectedTargets[$typeIndex]
}

$targets = @{}
foreach ($target in $analysis.metadata.targets) {
    $targets[$target.typeName] = $target
}
Assert-Method $targets["CEncryption"] 41648 "CryptoFileXOR" "0x6002469"
Assert-Method $targets["SgNet.Script.SgConnector"] 42444 "Init" "0x6002785"
Assert-Method $targets["SgNet.Script.SgConnector"] 42446 "Connect" "0x6002787"
Assert-Method $targets["SgNet.Script.SgConnector"] 42448 "SendData" "0x6002789"
Assert-Method $targets["SgNet.Script.SgConnector"] 42449 "ReadData" "0x600278a"
Assert-Method $targets["Assets.Scripts.Framework.FrameSynchr"] 108190 "PushFrameCommand" "0x6001d17"
Assert-Method $targets["Assets.Scripts.Framework.FrameWindow"] 108253 "SendGameCmd" "0x6001d56"
Assert-Method $targets["Assets.Scripts.Framework.LobbyConnector"] 112114 "SendPackage" "0x6002c6b"
Assert-Method $targets["Assets.Scripts.Framework.LobbyConnector"] 112116 "RecvPackage" "0x6002c6d"
Assert-Method $targets["ApolloHelper"] 147061 "Login" "0x6000e46"
Assert-Method $targets["ApolloHelper"] 147081 "Pay" "0x6000e5a"
Assert-Method $targets["CLoginSystem2"] 164794 "OnLoginSuccess" "0x600538b"
Assert-Method $targets["Assets.Scripts.GameSystem.CShopSystem"] 184607 "ReceiveItemBuy" "0x600a0f0"

$requiredStrings = @(
    "BeginConnectHost:",
    "SocketConnectState: SocketConnectSuccess",
    "Socket.BeginReceive ReceiveCallback异常",
    "Socket.BeginSend SendCallback异常",
    "server_url.txt",
    "Account Initialize Encode Error",
    "login.smoba.qq.com",
    "smobaopenidhash",
    "Service_Login_GetAccountInfo",
    "System.Security.Cryptography.AesManaged, System.Core, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
    "keyMakingMethod:",
    "frameData",
    "OnFrameUpdate",
    "Frame Replay!",
    "GetGoodsInfo start!",
    "GetGoodsInfo failed!",
    "payItem=",
    "ApolloPayService Pay!",
    "Service_Buydia",
    "Service_Buyprop",
    "https://pay.qq.com/h5/shop.shtml?store_config_env="
)
foreach ($term in $requiredStrings) {
    $result = $analysis.stringResults | Where-Object { $_.term -eq $term }
    if (-not $result -or $result.matchCount -lt 1) {
        throw "Required string literal missing: $term"
    }
}

Assert-Value "Library SHA-256" $analysis.library.sha256 "a77f2dfac82faeef1cc291867245c0365c9345b8dff5668f7170a5ee4ac7c89d"
Assert-Value "Library size" $analysis.library.size 157700152
Assert-Value "ELF machine" $analysis.library.elf.machine 183
Assert-Value "ELF type" $analysis.library.elf.type 3
Assert-Value "ELF program headers" $analysis.library.elf.programCount 9
Assert-Value "ELF sections" $analysis.library.elf.sectionCount 22
Assert-Value "ELF dynamic symbols" $analysis.library.elf.dynamicSymbolCount 755
Assert-Value "ELF defined symbols" $analysis.library.elf.definedSymbolCount 511
Assert-Value "ELF undefined imports" $analysis.library.elf.undefinedImportCount 244
Assert-Value "ELF build ID" $analysis.library.elf.buildId "71e052dcfcfe63c4d702330463cb6f502da04cb9"
Assert-Value "JNI_OnLoad offset" $analysis.library.runtimeOffsets.JNI_OnLoad 125686320
Assert-Value "il2cpp_init offset" $analysis.library.runtimeOffsets.il2cpp_init 125780672
Assert-Value "il2cpp_method_get_name offset" $analysis.library.runtimeOffsets.il2cpp_method_get_name 125782444
Assert-Value "il2cpp_runtime_invoke offset" $analysis.library.runtimeOffsets.il2cpp_runtime_invoke 125782704
Assert-Value "connect import" $analysis.library.imports.connect $true
Assert-Value "send import" $analysis.library.imports.send $true
Assert-Value "recv import" $analysis.library.imports.recv $true
Assert-Value "CodeRegistration symbol" $analysis.library.protection.hasCodeRegistrationSymbol $false
Assert-Value "MetadataRegistration symbol" $analysis.library.protection.hasMetadataRegistrationSymbol $false
Assert-Value "mscorlib in native library" $analysis.library.protection.hasMscorlibString $false
Assert-Value "Direct method native offsets" $analysis.limits.directMetadataMethodOffsetsRecovered $false

Write-Host "== selected evidence =="
$evidence = Select-String -LiteralPath $targetIndexPath -Pattern '^METHOD (42444|42448|108253|112114|147061|147081|184607) '
$evidence | ForEach-Object { Write-Host $_.Line }

Write-Host "IL2CPP analyzer tests passed."
