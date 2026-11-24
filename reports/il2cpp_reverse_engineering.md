# IL2CPP 静态逆向报告

## 结论

- `global-metadata.dat` 是有效的 Unity IL2CPP metadata v23；本次直接解析 header、image、type、method、field、parameter 与 string literal 表，能稳定恢复类名、方法名、字段名、方法序号、token 和参数名。
- `libil2cpp.so` 是 AArch64 ELF64 `ET_DYN` 共享库，保留 755 个动态符号，其中 511 个定义符号、244 个 `SHN_UNDEF` 符号；`connect`、`send`、`recvfrom` 是明确导入。
- 业务定位证据可靠：`SgConnector` / `LobbyConnector` 是网络边界，`FrameSynchr` / `FrameWindow` 是帧同步与命令边界，`ApolloHelper` / `CLoginSystem2` 是账号与支付入口，`CShopSystem` 是商城响应边界。
- `libil2cpp.so` 没有 `g_CodeRegistration` / `g_MetadataRegistration` 导出，也没有明文 `mscorlib.dll` 字符串；Il2CppDumper 识别 metadata v23 / IL2CPP 24.1，但 CodeRegistration 与 MetadataRegistration 均为 `0`，并报告 `This file may be protected`。
- 因此，静态阶段可以定位 C# 方法语义，但**不能恢复 C# 方法到 native 代码的映射**。metadata 方法 ID 和 token 不是 ELF 偏移，不能直接用于 patch 或 Frida offset。
- `CEncryption` 是文件加解密辅助类；现有证据不能证明它参与网络包加密。网络加密使用需待运行时调用链确认。

## 置信度规则

- **高**：二进制结构、表偏移、哈希、类型/方法/字段/参数名、token 等可由脚本复现的证据。
- **中**：由方法名、参数、字段和字符串联合定位的语义边界，尚未验证 native 调用链。
- **低**：缺少注册表映射或运行时证据的推断，不能作为修改依据。

## 可复现命令

```powershell
node --check .\tools\analyze_il2cpp.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Test-Il2CppAnalyzer.ps1
```

测试脚本会重新运行：

```powershell
node .\tools\analyze_il2cpp.mjs `
  .\workspace\apk\3.81.1.8.apk `
  .\workspace\analysis\extracted\assets\bin\Data\Managed\Metadata\global-metadata.dat `
  .\workspace\analysis\extracted\lib\arm64-v8a\libil2cpp.so `
  .\workspace\analysis\il2cpp
```

生成物：

- `workspace/analysis/il2cpp/il2cpp_analysis.json`：机器可读结果。
- `workspace/analysis/il2cpp/target-index.txt`：目标类、方法、字段、token、参数索引。
- `workspace/analysis/il2cpp/string-hits.txt`：过滤后的字符串字面量证据。

## 文件身份

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `workspace/apk/3.81.1.8.apk` | 460,348,136 | `a016d941a3d7ba0a8fc976dae6fe744efec85835a16dd10928b65a9c7e19ee5d` |
| `workspace/analysis/extracted/assets/bin/Data/Managed/Metadata/global-metadata.dat` | 41,405,108 | `c64ec24dbb1febc3f1edf9cd6f38f572b7ea767a0efb548ddd5425eb3f48e99b` |
| `workspace/analysis/extracted/lib/arm64-v8a/libil2cpp.so` | 157,700,152 | `a77f2dfac82faeef1cc291867245c0365c9345b8dff5668f7170a5ee4ac7c89d` |

## Metadata v23 结构

Header sanity 为 `0xFAB11BAF`，version 为 `23`。关键表如下：

| 表 | Offset | Size | Entry | Count |
| --- | ---: | ---: | ---: | ---: |
| String literals | `0x108` | `0x5D798` | 8 | 47,859 |
| String literal data | `0x5D8A0` | `0x126850` | - | - |
| Metadata strings | `0x1840F0` | `0x555A50` | - | - |
| Methods | `0x7533C4` | `0xBB1DE0` | 56 | 218,980 |
| Parameters | `0x14F6F78` | `0x3140F0` | 16 | 201,743 |
| Fields | `0x180B068` | `0x3CE530` | 16 | 249,427 |
| Type definitions | `0x1DCDE88` | `0x35D7A8` | 104 | 33,929 |
| Images | `0x21332D0` | `0x270` | 24 | 26 |

关键记录布局已用目标类和方法名交叉验证：

| 记录 | 字段 | 偏移 |
| --- | --- | ---: |
| `Il2CppMetadataImage` | `nameIndex` / `assemblyIndex` / `typeStart` / `typeCount` | `+0` / `+4` / `+8` / `+12` |
| `Il2CppFieldDefinition` | name index / token | `+0` / `+12` |
| `Il2CppParameterDefinition` | name index / token | `+0` / `+12` |
| `Il2CppMethodDefinition` | name / parameter start / token / parameter count | `+0` / `+12` / `+44` / `+54` |
| `Il2CppTypeDefinition` | field start / method start / method count / field count / token | `+48` / `+52` / `+80` / `+84` / `+100` |

`global-metadata.dat` 中可读 image 名包括：`mscorlib.dll`、`Mono.Security.dll`、`System.dll`、`Assembly-CSharp.dll`、`Assembly-CSharp-firstpass.dll`。`Il2CppDumper` 对应识别结果为 metadata v23 / IL2CPP 24.1。

## ELF 特征

| 属性 | 值 |
| --- | --- |
| Class / endian | ELF64 / little-endian |
| Machine | `0xB7` / 183 / AArch64 |
| Type | `ET_DYN` / 3 |
| Entry point | `0x1333440` |
| Program headers | 9 |
| Sections | 22 |
| Build ID | `71e052dcfcfe63c4d702330463cb6f502da04cb9` |
| Dynamic symbols | 755 |
| Defined / `SHN_UNDEF` | 511 / 244 |

关键 section：

| Section | Address | Offset | Size |
| --- | ---: | ---: | ---: |
| `.text` | `0x1333440` | `0x1333440` | `0x658055C` |
| `.rodata` | `0x78B39A0` | `0x78B39A0` | `0xD5448` |
| `.data.rel.ro` | `0x8E66160` | `0x8E56160` | `0x4BE1A0` |
| `.data` | `0x9337840` | `0x9327840` | `0x3291C0` |
| `.bss` | `0x9660A00` | `0x9650A00` | `0x13D6170` |

可靠导出入口：

| Native 导出 | Offset | 置信度 |
| --- | ---: | --- |
| `JNI_OnLoad` | `0x77DD230` | 高 |
| `il2cpp_init` | `0x77F42C0` | 高 |
| `il2cpp_method_get_name` | `0x77F49AC` | 高 |
| `il2cpp_runtime_invoke` | `0x77F4AB0` | 高 |
| `il2cpp_domain_assembly_open` | `0x77F47E8` | 高 |

保护特征：

- 无 `g_CodeRegistration` / `g_MetadataRegistration` 动态符号。
- Native 库内未发现明文 `mscorlib.dll`。
- Il2CppDumper 静态恢复注册表失败：`CodeRegistration: 0`、`MetadataRegistration: 0`、`This file may be protected`。
- `JNI_OnLoad` 与 `DT_INIT` 触发 Il2CppDumper 的保护判断。

## 网络模块

| 类 / 方法 | Method index | Token | 参数 | 置信度 |
| --- | ---: | ---: | --- | --- |
| `SgNet.Script.SgConnector` | type 5706 | - | - | 高（类定位） |
| `SgConnector.Init` | 42444 | `0x6002785` | `connType, ipStr, port, timeoutMs` | 高 |
| `SgConnector.Connect` | 42446 | `0x6002787` | - | 高 |
| `SgConnector.Disconnect` | 42447 | `0x6002788` | - | 高 |
| `SgConnector.SendData` | 42448 | `0x6002789` | `data, len` | 高 |
| `SgConnector.ReadData` | 42449 | `0x600278A` | `data, actualLen` | 高 |
| `SgNet.Script.SgNetMgr.CreateConnector` | 42483 | `0x60027AC` | `connType, ipStr, port, timeoutMs` | 高 |
| `Assets.Scripts.Framework.LobbyConnector.SendPackage` | 112114 | `0x6002C6B` | `msg, tdrResult, apolloRes` | 高 |
| `LobbyConnector.RecvPackage` | 112116 | `0x6002C6D` | - | 高 |
| `LobbyConnector.LookUpDNSOfServerTongcai` | 112117 | `0x6002C6E` | `host, port` | 中 |

`SgConnector` 字段包含 `ConnectEvent`、`DataReceiveEvent`、`DisconnectEvent`、`ErrorEvent`、`selfUid`、`tempReadBuffer`，与连接生命周期一致。字符串证据包含 `BeginConnectHost:`、`BeginConnectSocket:`、`Socket链接监控超时`、`Socket链接失败`、`SocketConnectState: SocketConnectSuccess`、`Socket.BeginReceive ReceiveCallback异常`、`Socket.BeginSend SendCallback异常`、`server_url.txt`、`ip: `、`port: `。

## 账号与登录

| 类 / 方法 | Method index | Token | 参数 | 置信度 |
| --- | ---: | ---: | --- | --- |
| `ApolloHelper.Login` | 147061 | `0x6000E46` | `platform, wait, uin, pwd` | 高 |
| `ApolloHelper.AutoLogin` | 147062 | `0x6000E47` | - | 高 |
| `ApolloHelper.LoginHandler` | 147063 | `0x6000E48` | `platform, uin, pwd` | 高 |
| `ApolloHelper.OnLogin` | 147067 | `0x6000E4C` | `platform` | 高 |
| `ApolloHelper.OnLoginEvent` | 147068 | `0x6000E4D` | `loginResult, accountInfo` | 高 |
| `ApolloHelper.OnRefreshAccessTokenEvent` | 147069 | `0x6000E4E` | `result, tokenList` | 高 |
| `ApolloHelper.GetAccountInfo` | 147075 | `0x6000E54` | `refreshToken` | 高 |
| `CLoginSystem2.Init` | 164780 | `0x600537D` | - | 高 |
| `CLoginSystem2.RegisterNetworkHandler` | 164782 | `0x600537F` | - | 中 |
| `CLoginSystem2.OnLoginSuccess` | 164794 | `0x600538B` | `info` | 高 |
| `CLoginSystem2.OnLoginFail` | 164795 | `0x600538C` | `rs` | 高 |
| `CLoginSystem2.OnConnectSuccess` | 164796 | `0x600538D` | `sender` | 高 |
| `CLoginSystem2.OnConnectFail` | 164798 | `0x600538F` | `rs` | 高 |

字符串证据：`Account Initialize Encode Error`、`OnAccountInitializeProc`、`OnRealNameAuthProc`、`login.smoba.qq.com`、`smobaopenidhash`、`user_openid`、`OpenId`、`TokenList Begin`、`TokenList End`、`Service_Login_GetAccountInfo`。Apollo 侧证据较强；实际游戏登录连接仍需从 `ApolloHelper` 事件追踪到 `SgConnector` / `LobbyConnector`。

## 对战与帧同步

| 类 / 方法 | Method index | Token | 参数 | 置信度 |
| --- | ---: | ---: | --- | --- |
| `FrameSynchr.SetSynchrConfigure` | 108178 | `0x6001D0B` | `inSvrFrameDelta, inCltFrameDelta` | 高 |
| `FrameSynchr.SetKeyFrameIndex` | 108183 | `0x6001D10` | `svrNum` | 高 |
| `FrameSynchr.UpdateFrame` | 108189 | `0x6001D16` | - | 高 |
| `FrameSynchr.PushFrameCommand` | 108190 | `0x6001D17` | `command` | 高 |
| `FrameSynchr.SetNetAccIPAndPort` | 108195 | `0x6001D1C` | - | 中 |
| `FrameSynchr.RealPing` | 108196 | `0x6001D1D` | - | 中 |
| `FrameWindow.OnConfigureParams` | 108209 | `0x6001D29` | `pkg` | 高 |
| `FrameWindow.OnSvrGameCoreFrapInfo` | 108212 | `0x6001D2D` | `pkg` | 高 |
| `FrameWindow.UpdateFrame` | 108244 | `0x6001D4D` | - | 高 |
| `FrameWindow.FillFrameHoles` | 108249 | `0x6001D52` | `reqPkg` | 高 |
| `FrameWindow.GetNewSendCmdSeqByPlayerId` | 108251 | `0x6001D54` | `playerId` | 高 |
| `FrameWindow.SendGameCmd` | 108253 | `0x6001D56` | `cmd, bMultiGame, bAI` | 高 |

字符串证据：`frameData`、`frame`、`OnFrameUpdate`、`Frame Replay!`、`Enter DoBattleStartFightStart`、`BattleLogic bPauseGameLogic is true`。该组合能高置信定位帧同步与战斗命令模块；帧格式仍需 native 层和运行时观测确认。

## 商城与支付

| 类 / 方法 | Method index | Token | 参数 | 置信度 |
| --- | ---: | ---: | --- | --- |
| `ApolloHelper.InitPay` | 147080 | `0x6000E59` | `accountInfo` | 高 |
| `ApolloHelper.Pay` | 147081 | `0x6000E5A` | `quantity, productId, payVarItem, depositGameCoin` | 高 |
| `ApolloHelper.GetGoodsFriendsPayUrl` | 147082 | `0x6000E5B` | `itemID, itemType, price, buyCount, ...` | 高 |
| `ApolloHelper.InitPay4Goods` | 147083 | `0x6000E5C` | `accountInfo, offerid, zoneId` | 高 |
| `ApolloHelper.Pay4Goods` | 147084 | `0x6000E5D` | `quantity, offerid, zoneId, productId, ...` | 高 |
| `CShopSystem.RefreshShop` | 184550 | `0x6000A0B7` | `shopType` | 高 |
| `CShopSystem.OnShop_BuyItem` | 184585 | `0x6000A0DA` | `uiEvent` | 高 |
| `CShopSystem.OnShop_BuyItemConfirm` | 184586 | `0x6000A0DB` | `uiEvent` | 高 |
| `CShopSystem.OnShop_ManualRefresh` | 184587 | `0x6000A0DC` | `uiEvent` | 高 |
| `CShopSystem.OnRequestGoodsRefershShopItems` | 184604 | `0x6000A0ED` | `shopType` | 高 |
| `CShopSystem.OnReceiveShopItems` | 184605 | `0x6000A0EE` | `shopType` | 高 |
| `CShopSystem.ReceiveItemBuy` | 184607 | `0x6000A0F0` | `msg` | 高 |
| `CShopSystem.ReceiveShopItems` | 184608 | `0x6000A0F1` | `msg` | 高 |

字符串证据：`GetGoodsInfo start!`、`GetGoodsInfo failed!`、`payItem=`、`&goodsmeta=`、`&goodsurl=`、`https://pay.qq.com/h5/shop.shtml?store_config_env=`、`https://pay.qq.com/h5/shop.shtml?pf=`、`ApolloPayService GetGoodsInfo!`、`ApolloPayService Pay!`、`Service_Buydia`、`Service_Buyprop`。商城 UI 与响应处理定位可靠；具体购买协议与 Apollo 支付流程的连接关系尚需运行时验证。

## 加密模块

`CEncryption` 为 type 559，方法序号 41640–41649：

| 方法 | Method index | Token | 参数 |
| --- | ---: | ---: | --- |
| `DeEncryptFile` | 41643 | `0x6002464` | `srcFile, dstFile, password, buffer, bufferLength, overwrite` |
| `EncryptFile` | 41644 | `0x6002465` | `srcFile, dstFile, password, buffer, bufferLength, overwrite` |
| `CryptoFileStream` | 41645 | `0x6002466` | `srcFile, dstFile, cryptoTransform, buffer, bufferLength, overwrite` |
| `DeEncryptFileXOR` | 41646 | `0x6002467` | `srcFile, dstFile, password, buffer, bufferLength, overwrite` |
| `EncryptFileXOR` | 41647 | `0x6002468` | `srcFile, dstFile, password, buffer, bufferLength, overwrite` |
| `CryptoFileXOR` | 41648 | `0x6002469` | `srcFile, dstFile, passwordKey, buffer, bufferLength, overwrite` |

参数和名称证明这是文件加解密工具。网络包加密置信度为低。相关字符串 `System.Security.Cryptography.AesManaged...`、`key is null`、`Key is too small`、`body={0}&send_timestamp={1}&buis_key={2}`、`keyMakingMethod:` 属于其他字符串证据，不能直接归因到 `CEncryption`。此前发现的 GCloud TEA 符号位于 `libgcloudcore.so`，不属于本类。

## Hook 目标与置信度

| Hook 目标 | Offset / Index | 置信度 | 解释 |
| --- | ---: | --- | --- |
| `libil2cpp.so!JNI_OnLoad` | `0x77DD230` | 高 | ELF 导出入口，稳定初始化观察点 |
| `libil2cpp.so!il2cpp_init` | `0x77F42C0` | 高 | 运行时初始化观察点 |
| `libil2cpp.so!il2cpp_method_get_name` | `0x77F49AC` | 高 | 运行时方法名解析观察点 |
| `libil2cpp.so!il2cpp_runtime_invoke` | `0x77F4AB0` | 高 | 运行时调用观察点 |
| libc `connect` / `send` / `recv` | 运行时导出查找 | 高（观测），低（归因） | 第一阶段网络观测入口 |
| `SgConnector.Init` | method 42444 / token `0x6002785` | 中 | 语义网络初始化目标 |
| `SgConnector.Connect` | method 42446 / token `0x6002787` | 中 | 语义连接目标 |
| `SgConnector.SendData` | method 42448 / token `0x6002789` | 中 | 语义发送边界 |
| `SgConnector.ReadData` | method 42449 / token `0x600278A` | 中 | 语义接收边界 |
| `LobbyConnector.SendPackage` | method 112114 / token `0x6002C6B` | 中 | 大厅包发送边界 |
| `LobbyConnector.RecvPackage` | method 112116 / token `0x6002C6D` | 中 | 大厅包接收边界 |
| `FrameSynchr.PushFrameCommand` | method 108190 / token `0x6001D17` | 中 | 帧命令边界 |
| `FrameWindow.SendGameCmd` | method 108253 / token `0x6001D56` | 中 | 游戏命令发送边界 |
| `ApolloHelper.Login` | method 147061 / token `0x6000E46` | 中 | 账号登录流程 |
| `CShopSystem.ReceiveItemBuy` | method 184607 / token `0x6000A0F0` | 中 | 商城响应边界 |
| 任意 C# 方法的直接 native offset | 未恢复 | 低 | 静态注册表不可用，禁止直接 patch |

### Hook 顺序建议

1. 先 hook `JNI_OnLoad`、`il2cpp_init`、`il2cpp_runtime_invoke`，确认初始化和运行时方法对象。
2. 再通过 IL2CPP runtime API 或 `il2cpp_method_get_name` 对方法 ID 做**运行时确认**。
3. 同时 hook libc `connect`、`send`、`recvfrom`，保存调用栈和字节流。
4. 只有当 method index 与运行时 native 指针对上后，才可把 `SgConnector`、`LobbyConnector`、`FrameWindow`、`ApolloHelper`、`CShopSystem` 作为直接 offset 目标。

## 关键限制

- `global-metadata.dat` 的方法 ID 与 token 是 metadata 索引，**不是 `libil2cpp.so` 的 RVA/offset**。
- 静态证据不能确认 C# 方法调用链、网络帧格式、消息 ID、压缩、加密算法或网关地址。
- 不能把 `CEncryption` 或 AES 相关字符串当作网络包加密结论。
- 在 CodeRegistration / MetadataRegistration 未恢复前，任何“C# 方法 native 偏移”都属于低置信推断。
