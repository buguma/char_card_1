# scene3d 验收测试底座

本目录不是发布资源。测试通过真实 `index.html`，从 `scene3d/scripts` 解析局部依赖；不修改宿主源码、不连接真实 API、不复用用户 profile。纯协议/3D测试随实现追加，不能把当前基础设施单测等同于P1–P6验收。

## 前置条件与命令

- 已由维护者建立并安装 `scene3d/package.json` 的固定依赖（`puppeteer-core 25.10.0`）。本 runner 不自动安装依赖。
- Node 版本以每run `environment.json` 为准；使用本地 Chromium/Chrome/Edge。可设置 `$env:BROWSER_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'`，不要传 profile 路径。
- cwd为完整工作区根 `E:\JJBurst\git`。

```powershell
npm.cmd --prefix scene3d run test:unit
npm.cmd --prefix scene3d run test:browser -- --list --phase=all
npm.cmd --prefix scene3d run test:browser -- --phase=P0 --reportDir='E:\JJBurst\git\tests\scene3d\reports\p0-example-001'
# 显式测试其他隔离副本：
node scene3d/scripts/run-browser.mjs --phase=P0 --gameRoot='E:\JJBurst\git\.scene3d-work\baseline-original\game' --reportDir='E:\JJBurst\git\tests\scene3d\reports\p0-example-002'
```

`reportDir`必须绝对路径且尚不存在；避免覆盖已有证据。`gameRoot`如指定必须绝对路径，默认优先`.scene3d-work/baseline-original/game`，不存在才只读serve当前工作区。server随机端口只监听127.0.0.1，并输出真实URL、根和PID。不发现/复用已有URL，不启动Vite。仅允许根HTML与 module/ui/img/bgm/music/assets 静态目录；禁写HTTP方法、隐藏路径、穿越、目录与root外symlink。

退出码：0=选中registry全部必测PASS；1=有FAIL/BLOCKED/NOT RUN或源hash变化；2=CLI/基础设施致命错误。`--list`只列计划与实现状态，不执行、不生成PASS。固定40项registry不会因为未实现而删除；`--phase=all`覆盖P0–P6。P0-T01/T05现已自动化（manual=false）：T01核验源码基线JSON的snapshotRoot/game与/pro整树hash，绝不比较已接线workspace；T05用process.execPath运行经审读的只读pro预览validator并保存真实输出。两项无需浏览器，但不会假造人工证据。P0五项全部通过可退出0；P1-T05及其他真机项保持原manual门槛。

## 夹具与真实入口

`fixtures/manifest.json`列出五类合成旧档：地图、藏经阁、Gal、真实特殊事件ID的进行中状态、四人同场；包含源码revision、真实payload SHA256、固定seed/业务时间、全局假配置、预期和步骤。`saveName/gameData/uiConversation/...`来自实际 `storageService.buildSavePayload` 格式，稀疏旧版gameData由原 `mergeWithDefaults` 补齐。全部内容合成，没有复制用户存档。模式依源码：0=养成、1=SLG/Gal。

- 新BrowserContext里在document前注入旧 `jxz_saves` 槽位和 `jxz_apiConfig`，通过原存储迁移和 `index.html?intent=loadSave&saveId=scene3d-fixture` 启动。
- 初始化完成条件：包装原 `window.onload`，等待原async函数真正resolve，不以sleep或仅`__initDone`判定。
- JSON导入调用真实 `importSave()`、文件选择器和 `FileReader`，不将payload写入运行时gameData。
- 导出走真实 `exportSave()`、命名确认、`_doExportSave`；仅替换末端 `downloadJson` 操作系统下载运输以收集JSON。Android分享不在此项覆盖。
- 每case新context，只有本run origin的测试存储会初始化；浏览器由Puppeteer创建临时profile并在finally关闭，不连接用户Chrome。

## 探针、随机数与差异

初始化后注入test-only **classic script**，只读取顶层`let GameMode/gameData/...`，返回JSON脱离引用；不读不存在的`window.GameMode`，不调用sync、save、displayNpcs来取快照。生产不留debug API。

固定 `Date`/`Date.now` 与计数LCG Math.random；保留真实 `performance.now`/rAF/setTimeout。探针记录state/count/next预览，不消费随机数。P0-T03还明确取下一次真实Math.random样本，比较两遍轨迹/完整prompt/存档与计数。当前差异忽略列表为空；不能随意忽略地点/NPC。

## 受控网络/SSE

所有页面外发默认拒绝，只有本run精确origin和data/blob直接放行，拒绝事件使case FAIL。用户另明确批准`fixtures/network/known-assets.json`中的**唯一精确GET/image URL** `https://files.catbox.moe/37jfr9.png`由本地固定SVG placeholder拦截履行；不发出原请求，不修改宿主CSS。URL附加query、其他同域图片、POST、fetch/API均不匹配，仍FAIL。替代素材hash及原URL写入每case network、environment和results；**替代图不是原Gal美术，不能作为原视觉资源/生产离线通过证据**。配置端点改为 `/__mock/<case>/chat/completions`，未排队或非匹配请求503并记失败；请求证据不保存headers/key。

响应样本采用实际OpenAI兼容格式：`status/headers/steps/terminal/expected`。`steps[].body`通过HTTP逐步write，`waitFor`等runner观察到宿主正文消费首段后经带随机token控制端点放行。支持正常end、断连与await-abort，记录write/release/end/abort。**不使用Puppeteer一次性respond冒充真实运输，不断言TCP分包**。foundation单测实测放行/取消运输；P0业务smoke实测完整pipeline分段回复。截断/HTTP失败/取消完整业务预期留P4，不能把样本存在等同于已验收。

## 实际用例与报告

- `foundation.unit.mjs`：种子/计数、字段diff、固定registry、五档hash、宿主responseParser真实格式、loopback安全及真实门控SSE/abort。
- `p0.browser.mjs`：五档导入/人物/历史/导出新context再导入；固定前往藏经阁→学习→流式提交→存读档重复轨迹；养成/Gal×两主题的属性/关系返回、正文展开与农田iframe。
- 每run：`environment.json`（源码清单hash、before/after只读校验、浏览器/PID等）、`results.json`、`mock-transport.json`、`defects.json`、`Pn-验收记录.md`及各ID下状态/prompt/diff/截图/console/network。
- 本底座不修改baseline以掩盖旧缺陷。UI/存档错误应记录FAIL及实际差异，由主代理独立决定是否批准修宿主。

## 2026-09-12 实测记录（P0，不代表P0阶段整体通过）

- P0基础设施 `foundation.unit.mjs` 的7个Node测试全部PASS，含真实HTTP checkpoint/abort运输与Gal夹具背景实际存在校验。该次命令为`node scene3d/scripts/run-unit.mjs`；末轮发现其他代理新增`build-unit.mjs`/`runtime-unit.mjs`/`npc-unit.mjs`后，runner已兼容`.unit.mjs`和`-unit.mjs`两种显式后缀，后续统一命令会包含它们。这里的7/7只代表本人P0测试文件。依赖确认后再次直接运行统一`node scene3d/scripts/run-unit.mjs`（作业pwsh-10）：实际发现4个文件，**56/56 PASS、退出0**，包含build/foundation/NPC/runtime全部当前单测。输出中的`Manifest hash mismatch`来自故意损坏清单的负测，其所属测试PASS，不是被忽略的运行失败。纯Node结果仍不替代真实renderer/Android验收。
- 实际完整浏览器命令：`node scene3d/scripts/run-browser.mjs --phase=P0 --gameRoot=E:\JJBurst\git\.scene3d-work\baseline-original\game --reportDir=E:\JJBurst\git\tests\scene3d\reports\p0-validated-fixtures`。
- 报告：`reports/p0-validated-fixtures/results.json`，runId `7073ea80-4f81-4c43-ae68-e3db1ee31e9a`，Node `v24.9.0`，Chrome `153.0.8010.36`，冻结宿主清单SHA256 `55508c476e43c75f71f88d967df7eb7135d793b9d51ddec18a7f1c7811e08a56`，before/after一致。
- **P0-T03 PASS**：两遍真实前往/学习/首段消费/受控SSE放行/正文摘要提交/存读档，业务与prompt完整diff为`[]`；无忽略路径，包含RNG计数及下一次真实随机样本。
- **P0-T02总FAIL**：五档业务往返均PASS，Gal和特殊事件触发既有外部CSS图片请求，默认拒绝后网络安全断言FAIL。map/library/crowded三个case总PASS。详见`P0-T02/roundtrip-cases.json`及五个`*-roundtrip-diff.json`（均空）。
- **P0-T04总FAIL**：养成×两主题PASS；Gal×两主题的导航/正文/农田已执行并留图，但同一CSS外部请求使case FAIL。
- P0-T01/T05 **NOT RUN**，未由runner代签还原/预览资源报告。命令整体退出**1**。

### 既有依赖及契约澄清

1. **P0-NET-001（未修）**：`module/game-styles.css:1853`的Gal背景硬编码 `https://files.catbox.moe/37jfr9.png`。测试明确拒绝且记录；没有放宽网络策略、没有请求远端、没有修改CSS或冻结源。该旧轮次FAIL不改写。用户后续已明确批准测试专用已知URL→固定本地placeholder映射，登记于`fixtures/network/known-assets.json`并重新运行；生产CSS本地化及原素材离线依赖问题仍未修复。
2. 养成属性/关系页返回行为由原`index.html:2508–2536`决定：普通模式回map且写`userLocation=tianshanpai`，Gal回`previousScene`。测试记录现状，不假定普通模式也返回藏经阁，不在P0擅改交互。
3. `_activeEvent`是导出携带、导入后消费到运行时的封装字段；P0-T03显式断言运行时事件与其相同，而非把事件字段加入全局忽略列表。
4. `reports/p0-first`保留首轮失败证据：早期测试错误地在业务改变的返回操作后比较原地点，并直接比较已消费的`_activeEvent`。这些是测试契约修正，不是宿主代码修复。`p0-second`/`p0-final`也保留作历史证据；最终`p0-validated-fixtures`又将Gal正文的scene字段换成经磁盘校验的`街道`/`山道`，并重新计算fixture hash、完整重跑。新增response状态日志中仅浏览器隐式`/favicon.ico`为404（非业务资源），Gal合法背景均本地200。

## 授权placeholder后的复测（历史轮次）

用户明确批准已知远程CSS图片使用合成替代fixture后，执行：

```powershell
node scene3d/scripts/run-unit.mjs
node scene3d/scripts/run-browser.mjs --phase=P0 --gameRoot=E:\JJBurst\git\.scene3d-work\baseline-original\game --reportDir=E:\JJBurst\git\tests\scene3d\reports\p0-approved-placeholder
```

- 统一Node测试发现6文件（其他代理期间新增APK/bridge单测）：**69/69 PASS，退出0**；其中foundation为8项，新增已知图片精确匹配与未知请求拒绝负测。
- 该轮浏览器报告`reports/p0-approved-placeholder/results.json`，runId `c25c17e0-0555-4924-bbfc-5fe68781d555`，**P0-T02/T03/T04全部PASS**。五类档往返、两遍业务/prompt/RNG差异及养成/Gal两主题UI均实际执行；`business-prompt-diff.json=[]`。
- 该命令显式使用冻结baseline；源码hash仍为`55508c476e43c75f71f88d967df7eb7135d793b9d51ddec18a7f1c7811e08a56`且before/after一致。
- 该runner自身未执行P0-T01/T05，仍保留NOT RUN并整体退出1；主代理可在阶段总验收中绑定其已采集的基线复制/资源validator独立证据，不能将历史runner输出改为执行过。
- `known-assets.json`登记唯一替代URL，SVG SHA256为`155cee9478bdf514a4680741de289ef3604f2219b02f8269276daf8da01bc5cf`。网络日志显示`action=substitute`、`originalNetworkAccess=false`；原Gal视觉资源是否正确/可用及原生产离线依赖仍**未验证/未解决**。当前PASS限业务/界面流程，不是原素材视觉验收。
- 主游戏CSS及宿主源码没有为此修改。未知外发仍使case FAIL，没有宽泛域名白名单。

## P0最终自动化闭环（最新）

```powershell
node scene3d/scripts/run-browser.mjs --phase=P0 --gameRoot=E:\JJBurst\git\.scene3d-work\baseline-original\game --reportDir=E:\JJBurst\git\tests\scene3d\reports\p0-complete-retest
```

实际结果：**P0-T01至T05全部PASS，退出0**。报告`reports/p0-complete-retest/results.json`，runId `91cb979f-5873-49b7-a5d2-22d4bd8687a6`。

- T01：读取`开发文档/3D整合/P0-源码基线.json`（SHA256 `9ae3f48ca2ea4d7f459a8c46e5062fc6c8b2ef6e7d045c073a50267bb9d1a7ad`），独立扫描snapshotRoot/game **2250**文件、snapshotRoot/pro **121**文件，无多余/缺失/字节或hash差异。只计算hash，不复制/改写原目录。详见`P0-T01/baseline-restoration.json`和逐文件核验JSON。
- T05：实际以`process.execPath`（Node24.9.0）执行`E:\JJBurst\pro\tools\verify-package.mjs E:\JJBurst\pro\yunxiu-debug.apk E:\JJBurst\pro\viewer-dist`。保存原始stdout/stderr、PID、参数、退出0，以及执行前后hash。结果：**30 webfiles / 13 sourceGLBs**一致，无stale entries。APK SHA256 `2ee00b8ec951035f8b5ee9681179f6f3312d37481b0956e063d2dbf578324d23`；部署manifest SHA256 `ac442b27204febd4885877be80a7084308e20504bbc708817481a617bbdfe0ec`。源模型与冻结P0相同，执行前后输入差异为空。此项是原pro预览验包，不代表整合游戏APK或真机验证。
- T02/T03/T04沿真实宿主流程通过；源码只读hash不变。Gal合成placeholder限制继续适用，原生产离线图片问题不被此PASS消除。
- 本次新增baseline核验负测及P1/P2契约检查：`node --test tests/scene3d/foundation.unit.mjs tests/scene3d/p1-p2-contracts.unit.mjs` **12/12 PASS**。
- 保留`reports/p0-complete`异常中断证据：宿主创建的detached file input在Puppeteer解析文件选择器backend node前被回收，触发DOM.resolveNode异常。已仅在测试上传运输中挂载/保活**原输入节点**，不更换原onchange/FileReader，不写gameData；导入成功后移除，之后全P0重跑通过。开测前现落盘专用进程PID；崩溃runner的直接子进程检查为空。

## P1/P2真实浏览器套件（已实现，结果以版本绑定实跑为准）

`p1.browser.mjs`和`p2.browser.mjs`已列出固定10项后续契约，以及：
- 只读`GameSceneBridge.getDiagnostics()`观测；完成必须同时匹配bridge epoch/revision、真实renderer.appliedVersion/activeSceneId/readyScene。
- 发布current/manifest SHA256前置检查（只确认输入，不能当renderer通过）。
- 完整业务字段及RNG的2D/3D检查点diff；不忽略地点/NPC/gameData字段。
- P2乱序用例使用owned server精确assets路径HTTP gate；等宿主实际切页/恢复epoch后才由认证control端点放行旧GLB，另支持404/无效GLB负测。

现在P1-T01..T04及P2-T01..T05已注册为真实可执行测试，不再停留在契约骨架。Node契约测试不会把它们标记为E2E PASS；必须运行真实浏览器。`--buildId`必填，当前指针及每个发布文件hash必须匹配，CSS清单必须非空；已知漏CSS/旧runtime的`integration-001`明确拒绝。

```powershell
# VERSION替换为主代理发布并确认的当前版本；不要用integration-001
node scene3d/scripts/run-browser.mjs --phase=P1 --buildId=VERSION --gameRoot=E:\JJBurst\git --reportDir=E:\JJBurst\git\tests\scene3d\reports\p1-VERSION
node scene3d/scripts/run-browser.mjs --phase=P2 --buildId=VERSION --gameRoot=E:\JJBurst\git --reportDir=E:\JJBurst\git\tests\scene3d\reports\p2-VERSION
# 仅调试某项时，其他本阶段必测仍标记NOT RUN，因此不会误报整个阶段成功
node scene3d/scripts/run-browser.mjs --phase=P1 --tests=P1-T01 --buildId=VERSION --gameRoot=E:\JJBurst\git --reportDir=E:\JJBurst\git\tests\scene3d\reports\cold-VERSION
```

- P1：未存偏好时默认关、冷Gal即使已存enabled也无资源/renderer、native import无body/canvas/listener/RNG副作用、真实主GLB；4宽度×2主题父容器resize/0尺寸恢复；20次宿主enable/disable、隐藏10秒帧计数不增长、component销毁资源清零；main/Draco404、损坏GLB、getContext失败、timeout、同revision retry、context loss。
- P2：冻结原版2D与当前3D独立origin/context进行真实菜单→前往藏经阁→学习→分段SSE→返回→export/import，对每检查点业务/prompt/RNG零忽略diff；20次canvas拖动/缩放/归位及菜单开关不变业务/存档/API；四类旧GLB恢复乱序及同revision hide/resume；子景404/损坏/timeout、retry、未知/Gal/模态/生成锁与异常地点档。
- 直接component lanes只测试实际发布renderer的生命周期/超时/同revision竞争，在报告中明确标记；不会把它们冒充宿主业务路径。宿主路径使用真实index、原业务函数、已有3D菜单和原返回按钮，3D模型命中/复杂NPC操作不在本次未授权P3范围内。
- P2及以后保留P0核心smoke与P1导入/生命周期smoke。P1-T05仍要求真实Android证据，桌面子项通过不能代签；阶段报告保留NOT RUN。
- foundation+contracts现为14项，包含静态asset门控真实HTTP和未授权control拒绝负测；图形、设备性能结论必须看独立实跑，不从单测推导。

### 已执行003结果与证据基础设施修正

- `reports/p1-integration003-cold`：P1-T01四个冷启动/真实主景子项PASS；诊断子集整体exit1是其余必测NOT RUN，不是假全阶段通过。
- `reports/p1-integration003-full`：P0核心smoke和P1-T02/T03/T04全部PASS；P1-T01的全body惰性导入采样受到宿主延迟资源布局影响而FAIL（没有放宽断言）。修正为等待真实网络idle、`document.fonts.ready`及原rAF后采样，仍严格比较完整body，记录before/after HTML及MutationObserver证据。
- `reports/p2-integration003-full`：P0三项+P1两项smoke+P2五项，**10/10 PASS，退出0**。2D/3D业务/prompt差异为`[]`；惰性导入bodyEqual=true、added=0、canvasDelta=0、mutations=[]。所有GLB/故障/竞争使用真实003发布物，不是stub renderer。
- `reports/p1-integration003-retest`：P1四自动项PASS；P0-T03暴露测试server记录POST body的UTF-8分包缺陷——逐Buffer转字符串把中文句末字符变成replacement字符。历史FAIL不改写、不做字符串归一化。现收齐Buffer后一次UTF-8解码，并保存原body字节数/SHA256；新增真实HTTP将一个中文字符拆跨两片、等待服务端消费首片后才发末片的验证。14/14定向单测PASS；随后用修正后的证据运输完成下列最终复测。
- **最终P0** `reports/p0-utf8-evidence-retest/results.json`：**5/5 PASS，exit0**，runId `c2a635a3-8877-46e1-9393-208f4bd0e079`。T01仍核验冻结2250+121文件，T05再次真实输出30 webfiles/13 GLBs验证成功。
- **最终P1** `reports/p1-integration003-final/results.json`：**P1四个自动项+P0三个smoke共7/7 PASS**，runId `3c74188b-2dfe-4a6b-8dcc-d69779b30f03`。唯一P1-T05 NOT RUN导致exit1，报告明确未通过完整阶段门槛。
- **最终P2** `reports/p2-integration003-final/results.json`：**5项P2+5项核心smoke共10/10 PASS，exit0**，runId `09c1c18c-5898-4eaa-83a0-f9089363fc7c`。包含实际右键pan，旧请求必须superseded/新请求applied的同revision竞争硬断言；最终2D/3D业务/prompt diff `[]`。
- P1/P2最终run的source SHA256均为`490b2ff362b723c9d1750e26d3197bacfe9df0975a9cd255d67b7f720c18515d`，sourceUnchanged和publicationUnchanged均true。Node24.9.0、Chrome153.0.8010.36，发布版本integration-003。
- P1-T05现已实现可自动的嵌套静态部署分支：独立owned server `/test-deployment/game/` 下真实index/main/library/back，断言GLB/CSS请求均维持prefix。即使该分支PASS，runner也仅写automatedStatus=PASS、总status=NOT RUN，真实Android缺口不得被清除；同样保护已有P3-T05 manual门槛。
- 新增T05后首轮`reports/p1-integration003-static-complete`安全失败：参数期待003而实际current已发布005，P1各项在版本前置断言被拒绝，未混用新旧版本；P0核心仍PASS、14单测PASS。等待父代理稳定新版本再运行该新增静态分支，不回写发布指针，也不修改历史PASS/FAIL。
- 已按父代理授权把独立代理的`p3p4.browser.mjs` 12个实现导出合并runner；本人只验证导出/语法并接线，未将该模块未执行的测试宣称PASS。P3/P4保留P0、P1、P2核心smoke。
- 上述桌面结果绝非Android代签。003以外版本须重新绑定buildId/manifest并实测。002因构建来源变化未正式发布，001/002均拒绝用作新验收输入。

### 正式integration-005复测

父代理正式发布005后各运行一轮完整P1/P2，使用`--gameRoot=E:\JJBurst\git --buildId=integration-005`；本轮未修改父维护的importJsonFile历史菜单真实toggle修正，也未修改宿主/renderer/P3P4实现。

- `reports/p1-integration005/results.json`：P1-T01..T04和P0三项smoke全部PASS；**P1-T05 nested static桌面分支也PASS**，真实独立`/test-deployment/game/`入口加载主景/藏经阁/返回，资源prefix及无404断言通过。该项automatedStatus=PASS，但Android仍NOT RUN，因此整项和阶段门槛不冒称通过。runId `b01651ad-0161-4ce8-b59c-6c941a0198e5`。
- `reports/p2-integration005/results.json`：**P2五项+五项回归smoke 10/10 PASS，exit0**。真实2D/3D业务、prompt、RNG检查点差异`[]`。runId `5513c9fe-9f6a-450c-a64f-b3edddd43d0e`。
- 两轮sourceUnchanged/publicationUnchanged均true。保留原Gal素材本地placeholder的视觉/离线限制，桌面验证不替代Android。

正常完成的测试server/浏览器均由本run在finally结束，未操作用户浏览器或其他服务。桌面390×844结果不是Android真机验收。
