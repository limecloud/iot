# 触摸伴读灯

把一个按钮模块和一个灯光模块组合成固定玩法：按下按钮，打开灯并把亮度设为35%。软件模拟器可直接运行，不需要采购硬件。包正文为[package.json](package.json)，设备绑定为[bindings.json](bindings.json)。

本例演示模块组合、明确启用、事件触发与原记录恢复。按钮可以由后续硬件适配器提供相同合同，灯光由相同能力模块实现；具体硬件接入前须核对并更新精确物模型修订。按键合同不等于触摸传感器驱动，本例没有玩具固件、语音模型或机械动作。

## 家庭网页操作

先按下文启动开发实例并登录家庭网关，进入“自动化 → 使用组合包”。选择“触摸伴读灯”，将触摸模块绑定`device-button`、灯光模块绑定`device-lamp`。点击“预演组合”，核对开启和亮度35两步，再明确“启用组合”。也可选择“自定义组合包”，粘贴包正文并逐一绑定实际设备。

预演不执行设备；启用后等待新的按钮事件。已启用列表展示两步，点击“停用”阻止后续触发。刷新后“查询当前部署”只读取当前状态；丢回执时保留原提交待核实，不重发或换实例。已确认或明确拒绝的记录可以“准备其他组合”，该操作不停止原部署。浏览器需支持Web Locks并允许保存站点数据。记录与恢复边界见[家庭网页合同](../../../contracts/composition.md#家庭网页)。

## CLI运行

在核心仓库根目录准备[本地开发依赖](../../../deploy/dev/README.md)，使用Node 24。第一个终端启动网关、MQTT和两个设备模拟器：

```sh
npm run dev
```

保持该终端打开。第二个终端加载该隔离开发实例的会话，只在本机使用：

```sh
source ".dev/local/session.env"
node packages/cli/src/main.mjs composition schema
node packages/cli/src/main.mjs composition plan \
  --input "examples/compositions/reading-companion/package.json" \
  --bindings "examples/compositions/reading-companion/bindings.json" \
  --id reading-demo --space-id space-demo > ".dev/reading-plan.json"
```

规划读取真实设备及模型修订，并验证和预演。此时没有新规则或设备命令。查看plan中的required_permissions、rule和simulation，再提取原规则：

```sh
node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(".dev/reading-plan.json","utf8")); if(p.gateway_checked!==true||p.deployed!==false) throw Error("invalid_plan"); fs.writeFileSync(".dev/reading-rule.json",JSON.stringify(p.rule));'
node packages/cli/src/main.mjs invoke rules.deploy \
  --space-id space-demo --input ".dev/reading-rule.json"
```

部署是明确启用，不会立即开灯。切回第一个终端，输入`button`并回车，产生一个新的模拟按键事件。在家庭网页的“设备”中查看灯光，也可查询：

```sh
node packages/cli/src/main.mjs devices get device-lamp --space-id space-demo
node packages/cli/src/main.mjs runs list --space-id space-demo
node packages/cli/src/main.mjs commands list --space-id space-demo
```

灯的上报值应为light.power=true、light.brightness=35；两条命令须各自读取confirmed回执。仅看到上报值不代表命令已确认。

## 更换组合

编辑bindings.json可以把角色绑定到同一空间的其他设备。所有角色必须绑定且设备不能重复。新模块需在包内声明其精确model_revision；规划发现实际模型不同、设备离线或属性不兼容时拒绝，不按名称猜测能力，也不自动安装或授权。

需要独立运行两个组合时，明确选择不同实例ID。修改包内容会改变package_digest；修改设备或实例会改变生成规则的修订。不要使用新实例ID重试未知提交。同ID部署会按原规则合同更新，执行前重新核对，存在多作者编辑时使用本地TUI条件修订流程。

## 停用与恢复

用rules.list读取当前修订，为本例准备停止输入，确认该实例后提交：

```sh
node packages/cli/src/main.mjs rules list --space-id space-demo > ".dev/reading-deployments.json"
node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(".dev/reading-deployments.json","utf8")); const d=p.items.find(x=>x.rule.id==="reading-demo"); if(!d) throw Error("deployment_not_found"); fs.writeFileSync(".dev/reading-stop.json",JSON.stringify({revision:d.revision}));'
node packages/cli/src/main.mjs invoke rules.stop \
  --space-id space-demo --id reading-demo --input ".dev/reading-stop.json"
```

再按按钮不会产生本例的新命令。停止自动化不关闭已经打开的灯，也不取消在途命令；需要关灯时使用现有设备控制入口。

使用相同开发目录重启后，读取原规则、运行和命令。unknown保持原状态，按原idempotency_key查询；不重复发布旧事件或重建原操作。旧记录会占用本地开发实例的容量，本例不自动清理数据库。

## 验证

```sh
npm run test:composition
npm run test:composition:web
```

两个入口启动独立软件实例，分别覆盖CLI规则执行/恢复和家庭网页操作。网页检查包括预演零执行、两步确认、明确停用、存储失败零提交、丢回执只读恢复、跨标签互斥、条件创建及390px布局。人工体验与自动检查使用相同包、规划器和原规则引擎。进一步字段及范围见[正式合同](../../../contracts/composition.md)。
