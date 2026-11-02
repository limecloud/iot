# 控制面网关配对 0.1

控制面HTTP入口与JSON字段以 [OpenAPI](control.openapi.yaml) 为准；本地网关动作以 [工具目录](tools/catalog.json) 为准。Go/MySQL与Rust本地审核、机器证明、原绑定恢复及家庭PWA已接通。可选 [出站WSS机器连接](control-relay.md) 支持受限远程HTTP读写及原操作核实；远程CLI、Console/Admin页面和原生客户端云入口尚未实现。`gateway.active` 表示绑定未撤销，不表示连接在线或设备执行成功。

## 证明

网关使用独立 Ed25519 密钥。`public_key` 是原始32字节公钥的标准 RFC 4648 Base64，保留 `=` 填充，不换行；`gateway_id` 为 `gw-` 加原始公钥字节的 SHA-256 小写十六进制。不是 PEM，也不是对 Base64 文本计算摘要。

签名输入为以下字段的 UTF-8 编码，字段间使用单个 LF (`0x0a`)，最后一行没有换行。所有 ID 限定 ASCII 字母、数字、下划线和短横线；origin 不含末尾斜线。期限取返回 `expires_at` 的整数 Unix 秒。

```text
LIMEIOT-PAIR-1
<control_origin>
<pairing_id>
<challenge>
<cloud_space_id>
<gateway_id>
<local_space_id>
<principal_id>
<public_key>
<expires_unix_seconds>
```

`signature` 是64字节 Ed25519 签名的标准 Base64，保留填充。`code` 是独立的256位随机秘密，只在请求体中传递，不参与签名；它选择的配对 ID、挑战、主体、空间和期限均已进入证明。实现与跨控制面/主体篡改负例位于 [crypto.go](../server/internal/control/crypto.go) 和 [config_test.go](../server/internal/control/config_test.go)。

## 生命周期

1. 已认证的 Console 所有者先在本地保存 `request_key`，再申请配对。空间 ID 由控制面分配，与本地空间分开。
2. 本地网关取得 origin、配对 ID 和 code，调用 review；界面须让本地所有者看到目标控制面、主体、云空间及 scopes。云端登录不取代本地审批。
3. 所有者明确批准冻结的 `review_revision` 后，网关先持久保存审批与原请求身份，再发送 claim。重复批准已批准的请求只读原状态，不再次发送 claim。
4. 控制面在事务内复核当前所有者、未取消窗口、期限及活动绑定唯一性。一个云空间至多一个活动网关，一个网关身份也只能有一个活动云绑定。
5. 同一 claim 重复返回原 revision，已完成后允许超过原120秒窗口查询原结果；换公钥、本地空间或重放已撤销绑定均拒绝。新配对不能重新开启旧请求。
6. 所有者撤销时携带原绑定 revision。重复撤销只作用于该 revision；重新配对生成新 revision 并保留历史。未来中继须以当前绑定检查拒绝旧连接和新控制。

## 本地审核与恢复

本地入口为 `/api/v1/spaces/{space_id}/control-pairings`，沿用本地所有者会话、精确 Origin 与 CSRF；CLI 使用本地所有者 Bearer。创建输入见 [Schema](control-pairing-request.schema.json)：CLI 将 `space_id` 放路径、`idempotency_key` 放请求头，正文只含 `control_origin/pairing_id/code`。最多保存128条记录，不自动清理审批历史。

| 动作 | HTTP | 行为 |
| --- | --- | --- |
| `control-pairings.create` | `POST /control-pairings` | 原键同参恢复，只读取云配对，不授权 |
| `control-pairings.list/get/resolve` | `GET` 集合、`/{id}`、`/by-key/{key}` | 读取脱敏状态，不返回 code 或其密文/摘要 |
| `control-pairings.approve` | `POST /{id}/approve` | 正文 `{"review_revision":"sha256:..."}`，核对冻结审核后提交一次证明 |
| `control-pairings.reconcile` | `POST /{id}/reconcile` | 未批准时重新读取审核；已批准时只查询原云绑定 |
| `control-pairings.revoke` | `POST /{id}/revoke` | 本地立即撤销，迟到结果不能重新启用 |

上表 HTTP 路径均接在本地集合后。创建和批准返回202只表示受理；状态包括 `reviewing/awaiting_approval/claiming/reconciling/active/unknown/rejected/expired/revoked`。重启将未完成的网络操作恢复为 `unknown`，不自动重放。已批准且结果未知的记录占据本地授权，不能用新请求绕过；需核实原绑定或明确本地撤销。

控制面 `POST /api/pairing/v1/{pairing}/status` 使用原 code 和相同 Ed25519 证明，只读原绑定，绝不建立或重新激活。已撤销绑定返回 `active=false`，未建立返回404，过期且未建立返回410。本地核实同时比对主体、云/本地空间、机器公钥、权限与 revision。

本地撤销与云侧撤销各自留存：本地撤销不依赖网络，也不自动更改云记录；同一机器重新配对前，云所有者须先撤销旧活动绑定。家庭 PWA 的“网关配对”先读取、再批准，浏览器仅保存原操作键，不保存配对码。配对码、审批输入和密钥不得交给模型。

## 机器配置与备份

安装者通过 `LIMEIOT_CONTROL_ALLOWED_ORIGINS` 允许最多8个精确 canonical origin；未设置时不启用配对。HTTPS 始终校验证书与主机名，只有字面回环地址允许实验 HTTP。适配器固定 DNS 解析地址、禁止代理和重定向、不自动重试；请求8秒超时，DNS解析2秒超时。

`LIMEIOT_GATEWAY_KEY_FILE` 指向独立 Ed25519 PKCS8 DER 文件，Unix权限0600，拒绝符号链接和非普通文件。新开发安装可离线运行 `limeiot-gateway identity-init "/new/private/identity.pk8"`，只输出公钥与 gateway_id，拒绝覆盖已有文件。NAS 初始化自动创建 `secrets/gateway-identity.pk8`；可选私有 CA 通过 `LIMEIOT_CONTROL_CA_FILE` 指定。

本地 code 使用从原 PKCS8 材料域分隔派生的 AES-256-GCM 密钥加密，AAD绑定本地空间与原幂等键。原始密钥文件必须和 SQLite 一起备份，不能只用相同公钥的另一种编码替换；替换会导致原材料无法解密。NAS恢复遇到包含配对记录却缺机器私钥的备份时拒绝继续。已有安装补充密钥与可选 Compose 配置的步骤见 [NAS安装](../deploy/nas/README.md)。

数据库只存 Cookie/code 摘要。外部凭据、PKCE verifier 与恢复用 code 使用 AES-256-GCM，AAD 绑定对应受众和会话或配对身份；密钥留在独立文件。迁移不存储这些文件。备份必须按同一安全边界保管数据库与加密密钥。

## 当前保留与限制

每主体最多创建16个空间，每空间最多保留1024个配对。达到配额返回409；原键恢复不消耗新配额。首期没有删除/转移空间、邀请成员、自动归档或公网注册。私有凭据属于实例所有者和实例管理员，二者相互独立；不将 Admin 认作家庭成员。

配对请求与认证入口每客户端、每类型一分钟最多30次，内存限流表最多4096项。状态会话/flow 存储在 MySQL，flow 一次性消费；会话最长八小时且不晚于外部 access token 的到期时间。过期会话/flow 每分钟分批清理，绑定、原操作键和审计保留。
