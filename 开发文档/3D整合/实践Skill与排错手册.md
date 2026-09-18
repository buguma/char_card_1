# 3D整合实践Skill与排错手册

这里的Skill指本项目可复用的工程操作规程，不声称已安装为工具平台插件。随着实测结论追加或纠正；不能把猜测固化成规则。

## Skill 1：把表现层和业务随机数彻底分开

**适用：** 给既有文字游戏接入Three表现层。

1. 业务继续由原游戏维护；桥只读classic词法变量、原有已选NPC集合和地点，不调用同步、保存或重新抽人函数。
2. Three对象UUID等也可能消耗Math.random。构建期对锁定的浏览器依赖做AST隔离，使用渲染私有随机源；不要临时替换全局Math.random。
3. 同档、同业务时钟/种子分别执行2D与3D，比较完整业务状态、prompt和RNG计数；不随意忽略字段。
4. 把Draco worker单独视为随机数运行域，不与宿主业务域混为一谈。

**已验证：** 005 P2完整对照diff=[]；真实Three UUID与渲染生命周期测试通过。

## Skill 2：真实点击失败先分层，别先移动NPC

**适用：** 人物可见但点击不开菜单。

排查顺序：

1. 记录实际buildId、epoch、revision、角色ID、foot、camera/viewport和纯投影anchor。
2. 用`elementsFromPoint`确认顶层元素。候选像素数不等于发送到canvas的真实点击数，必须分别记录。
3. 记录真实pointerdown/up、isTrusted和目标；随后检查当前GameMode、地点、可见性、选中名单、inputEnable及活动场景。
4. 用MutationObserver观察菜单新增/移除/标题，再观察scroll等关闭原因。rejectedIntents为0不能证明未产生intent，因为后续live权限检查可能静默拒绝。
5. 只有排除DOM路由和权限后，才检查alpha、raycast和实体遮挡；anchor存在不等于像素可点。

**已验证案例：** 原importSave末尾会toggle历史下拉菜单。测试直接调用时把原本关闭的菜单展开，挡住C/A全部anchor点；真实canvas点击数实际为0。只修测试流程，用原toggle关闭菜单后，同foot一次真实点击成功，005全15角色×2主题通过。没有必要重抽站位或忽略实体遮挡。

## Skill 3：异步GPU编译必须纳入取消和释放协议

**适用：** 读档、切场景、隐藏或销毁时出现Three异步异常。

- Three0.185.1的compileAsync内部用不可取消timer轮询`currentProgram.isReady()`。材质dispose后renderer properties被移除，旧timer可能抛异常，且原Promise不reject。
- 外层catch或Promise.race不能取消第三方内部timer；不要通过window.error吞错。
- 本项目采用真实renderer.compile提交、自有受控KHR轮询；取消、材质释放、超时、上下文丢失都要结算并清理timer/listener。
- 所有资源释放前先同步取消编译；版本检查必须覆盖每个await，且ready仍等真实首帧。
- 私有properties适配必须锁Three版本并显式检查API变化，不承诺跨版本兼容。

**已验证：** 真实WebGL复现旧错；新路径绘制一帧、取消和销毁后timer/listener为0；005异常roster/ST相关回归继续按具体case记账。

## Skill 4：测试入口必须走原UI的完整状态转换

**适用：** 模态、iframe、文件导入及小屏滚动控件。

- 直接调用业务入口可能省略正常菜单前置状态。先读原入口/结束动作，不通过改生产业务迎合测试。
- 文件导入保留真实input、FileReader、onchange及文件选择。仅为CDP保活原input；操作完成后清理。
- 点击前等待有限动画完成、滚动控件到可见区域、验证中心hit-test与disabled状态；无限装饰动画不应使测试永远等待。
- 子游戏退出先注册只读message观察器，捕获精确iframe contentWindow；由真实iframe按钮触发消息，不伪造postMessage。
- 农场周事件要先点击原确认；炼丹商城在原开始/药材界面内；21点按钮可能在iframe滚动区域下方。
- 结算尽量用非零oracle。21点平局不能单独证明金额写回；本项目另跑真实爆牌，500→490，再真实重开退出仍490。

**范围限制：** 合法消息来自正确iframe不等于宿主已拒绝恶意跨origin/source重放；原处理器的信任边界需如实披露。

### 长弹窗的真实可达性

- fixed定位的弹窗不能按整页container高度计算后就假定底部可达。记录top/height、关闭按钮rect及elementFromPoint，区分内容内部滚动与整个弹窗超屏。
- 保持原窗口尺寸复现，不能仅把1280×900改成1000×1500后宣称缺陷消失。
- 长模态需要限制到实际visualViewport或inner尺寸，并在可见区域变化时重新布局；相关resize/scroll监听和排队rAF必须在关闭时清理。
- 桌面缩小可见区的布局测试只能验证几何和监听协议，真实Android软键盘仍需单独实测。

### 真实缓存与不可变版本复核

- 同内容A/B或no-store演练只能证明指针/会话冻结，不能签真实缓存更新；必须让合法测试JS/GLB bytes/hash不同并实际记录fromCache/CDP。
- GLB注入诊断元数据时保留原JSON token（含-0），校验去标记语义相同与binary块原样；不能为测试破坏合法资产或改生产模型。
- 升级验证同时覆盖暖上下文同URL刷新、新上下文B，以及旧A会话首次取未缓存子景仍走A路径。
- 404降级的契约是原2D可用/原控件真实可点/业务不变，不是强制renderer对象为null。
- 收口时冻结受保护文件。将并发所有权通知合并为一个最新目标，旧排队指令不得重复触发已通过批次或删除已确认强断言。

## Skill 5：模拟API证据也需要完整传输校验

- HTTP请求body先收集Buffer，最后一次UTF8解码；逐片`body += chunk`可能把跨chunk中文损坏成替换字符。
- 使用真实HTTP主动拆开中文字符字节，验证服务器记录仍逐字一致。
- fixture要符合原stream/non-stream配置、真实重试次数及解析器修复语义。
- 截断回复可能被旧解析器修复并追加历史，不能仅凭fixture标注commitCount=0断言整个业务无提交。分别验证数值、历史、自动存档与2D/3D等价性。
- 未匹配mock请求与未知外部请求应失败，不放宽网络白名单掩盖遗漏。

## Skill 6：构建、发布和APK输入必须串行冻结

1. 用显式绝对runRecord和唯一buildId，不猜latest。
2. 构建前后核验所有受控源码hash。并行编辑导致失败时保留失败目录，用新run，不放松校验。
3. 发布不可变版本目录，最后原子替换current.json；已打开会话冻结所选版本。
4. 绑定旧build的测试未结束时切指针会造成版本前置拒绝，不能当新版本功能失败或混算PASS。
5. APK必须复制完整native与Web输入到隔离目录；仅切cwd不能保证隔离路径解析。
6. npm ci、Capacitor sync、Gradle只在副本执行。原APK直到新包验包、验签成功都不得删除/覆盖。
7. 新run一键PS1从prepare开始；手工先prepare后继续的005不算完整一键入口验收。

## Skill 7：精确验包不能仅扫描现有文件“自授权”

- staging先依据冻结输入建立期望文件集合；APK ZIP逐文件检查路径、大小、SHA256、CRC及碰撞。
- 二进制manifest核对appId/version，DEX检查真实class_defs而不是搜索字符串。
- Capacitor Android8.4库会额外合入native-bridge.js。只有固定版本、npm lock integrity、官方包审计指纹、源文件、Gradle映射及APK bytes一致时才授权这一个文件。
- 不能因为发现extra就递归扫描node_modules并全部允许；其他extra/missing仍严格失败。
- Gradle成功、内容验包、密码学签名验证、设备安装、旧档升级是不同证据层次，不能互相替代。

## Skill 8：Windows工具链采用显式路径与保守语法

- 本环境命令工具名虽为pwsh，实际执行曾为Windows PowerShell5.1；先核验，不假设PS7语法。
- PS1使用ASCII源码避免UTF8无BOM中文解析问题；中文输出文件名可由Unicode码点生成。
- Node与npm.cmd可能选到不同版本。用同一个明确Node执行npm-cli.js，在实际目标cwd安装，避免--prefix歧义。
- Java21、SDK36和apksigner路径显式记录。执行策略仅影响当前进程，不全局修改。
- 所有长命令记录jobId，完成后收集；子会话job由该子会话收集，不能用父session读取替代。

## Skill 9：证据、状态和协作交接

- 每条PASS绑定版本、运行ID、输入hash、报告路径和实际覆盖范围。
- FAIL、NOT RUN、INCOMPLETE分别记录；桌面自动分支PASS不能清除Android缺口。
- 重试会改变run step状态时，先独占保存完整原run字节快照，再执行重验。
- 不用模糊文件名glob判断证据不存在。005真实快照名为run-before-library-asset-verifier.json，仅搜*fail*会漏掉。
- 子任务消息可能迟到。明确当前版本与文件所有权，已完成的同版本回归不要因旧指令反复执行；变更写入文档后再交接。
- 本手册与当前进度文档即时维护，最终结论仍以原始报告、版本hash和真实产物为准。
