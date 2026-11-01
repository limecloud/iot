# Android 原生客户端

使用 Kotlin、Jetpack Compose 和 Android Keystore，最低 Android 8/API 26，编译和目标 API 36。`:core` 是不依赖 Android SDK 的类型化客户端，`:app` 是原生 Android 应用。没有 WebView 或跨平台 UI 框架。

应用提供家庭网关连接、设备开关/亮度、状态和回执、事件规则预演/启用/停用、关联运行及退出。当前规则表单支持布尔属性联动，界面与 CLI 共用网关执行语义。

自动化页支持“用一句话设置”：网关配置本地模型后生成草案，展示触发、全部动作、冷却和原文，预演通过后明确启用。生成前通过 Keystore 适配器保存原空间与幂等键，写入失败不发送；丢失响应或应用重启后查询原记录，不自动重发。修改需求清空预演证明；模型未配置仍可手工设置。推理模型配置见[NAS说明](../../deploy/nas/README.md)。

## 构建和连接

需要 JDK 21、Android SDK Platform 36 和 Build Tools 36.0.0。Android Studio 打开本目录，或者设置当前终端的 SDK 路径后执行：

```sh
sh "gradlew" :app:assembleDebug
```

调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。正式签名材料由使用者管理，仓库不包含私钥或发布凭据。

输入 NAS 的精确 HTTPS Origin，例如 `https://192.168.1.20:8443`，以及本地所有者凭据。使用本地 CA 时先在系统安装证书。客户端接受系统/用户受信 CA，验证证书与主机名，禁止明文网络和跨来源重定向。

会话通过 Android Keystore 中的 AES-GCM 密钥加密后存入应用私有存储，使用 Origin 绑定附加认证数据；不保存所有者原始凭据。Android 12以上的云备份与设备迁移通过显式规则排除应用数据，旧版禁用备份。控制前先耐久保存原幂等身份，本地写入失败时不发送。响应丢失、代理5xx或响应无法解析时保留身份，重新登录后仍查询原操作，不自动重发或离线排队。设备操作界面当前显示最近100条，完整分页合同由API/CLI提供。

启动图标沿用官网已有品牌包，提供自适应前景及兼容图标；素材的专有许可范围见 [品牌素材](../BRAND.md)，其余客户端代码遵循仓库代码许可。

## 结构和验证

| 路径 | 职责 |
| --- | --- |
| `core/` | Kotlin 合同、会话与 HTTPS 传输适配、网关任务 |
| `app/.../HomeViewModel.kt` | 生命周期、会话、快照和操作恢复 |
| `app/.../SecureStore.kt` | Android Keystore 存储适配 |
| `app/.../MainActivity.kt` | Compose 设备、规则、运行和设置界面 |

```sh
sh "gradlew" --configure-on-demand :core:test
```

纯 JVM 检查覆盖 HTTPS 地址、原幂等键、CSRF、所有者凭据隔离、控制/草案超时不重发与原草案查询。仓库根目录的 `npm run test:android` 额外启动独立网关、真实 Broker、模拟设备与假 Ollama 提供方，验证控制回执、草案幂等/无自动部署/预演/明确启用、规则生命周期、原操作查询及撤销。提供方检查不代表模型质量。

当前API36调试APK构建与lint通过；lint仍有依赖更新提示、用户CA信任和代码风格提示。请顺序执行同一Gradle工程的构建、lint与JVM检查，避免多个编译进程共写缓存。APK构建通过不代表真机验收，仍需在 Android 模拟器/设备上验证 Keystore、证书、局域网、前后台切换、离线禁用和字体缩放。
