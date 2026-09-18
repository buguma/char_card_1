# LLM 输出格式校验与二轮纠错方案

> 状态：方案待评审（决策点见第 12 节，未拍板项均已给出推荐默认值）
> 涉及模块：`module/format-checker.js`（新增）、`module/format-corrector.js`（新增）、`module/pipeline.js`、`module/api-service.js`、`index.html`
> 格式依据：`char_card_information/110格式规范_精简版_独立前端.txt`（下文简称「110 规范」）

---

## 1. 背景与目标

当前 LLM 每轮输出由 `response-parser.js` 以强容错方式消费：标签提取容忍大小写/空格/下划线变体，SIDE_NOTE JSON 有三层修复（弯引号 → CJK 间裸双引号 → jsonrepair）。因此「解析彻底失败」已很少见，但仍存在两类无人察觉的问题：

1. **静默降级**：段尾 `|NPC|场景|表情|none` 标记缺失或枚举越界时，`parseSlgMainText` 静默丢弃该行的头像/场景/表情展示；SIDE_NOTE 中「好感变化」「基调归类」等枚举越界会让对应变量更新静默跳过。玩家看到的是「这次没头像/没切场景/好感没变」，无从定位。
2. **规范漂移**：段落数、SUMMARY 字数、外层 `<SLG_MODE>` 包裹等偏离 110 规范，目前完全没有度量。

**目标**：

1. 纯代码实现对每轮原始输出的格式校验，将输出分类为：**合法 / 完整但非法 / LLM 截断 / 道歉拒答**。
2. 合法、截断、道歉：走现有流程（ autosave 或提示重生成），行为不变。
3. 完整但非法：将非法输出 + 错误清单 + 格式要求组装为纠错 prompt，发起**一次**二轮纠错调用。
4. 二轮仍非法：不再阻塞，按原文走现有流程，并额外弹窗提示「建议调低温度或更换预设」。

## 2. 现状盘点：解析器的容错边界

校验器的设计必须与现有解析器分工明确：**解析器负责「尽力消费」，校验器负责「严格度量」**。

| 环节 | 现有容错（response-parser.js） | 不管的事（校验器补位） |
|---|---|---|
| 标签提取 | 大小写/空格/下划线变体；MAIN_TEXT 闭合缺失时截到下一结构标签 | 标签是否成对闭合、顺序是否正确、外层 SLG_MODE 是否存在 |
| MAIN_TEXT | 无 `<MAIN_TEXT>` 时回退「中文/#/* 开头到下一个 `<`」 | 回退路径被触发本身就是规范破坏 |
| 段尾标记 | `parseSlgMainText` 要求恰好 5 段，否则丢弃标记只留文字 | 逐段校验标记存在性、字段数、枚举合法性 |
| SUMMARY | 主正则失败时从首个 `{` 前回溯兜底 | 兜底被触发即规范破坏；字数/行格式度量 |
| SIDE_NOTE JSON | 三层修复 | 三层全失败即 P0；修复成功也要记录「触发了第几层」作为度量 |

**关键结论**：校验器不是替代解析器，而是在「解析器能消费」之上叠加「规范是否满足」的判定。校验器的枚举校验口径与运行时渲染完全对齐（复用同一批 match 函数与枚举表，见 4.3），确保「校验器说非法 ⇒ 用户可见的降级确实发生」。

## 3. 总体流程

```
runTurn: LLM 完整输出 rawText
        │
        ▼
 formatChecker.validate(rawText, ctx)        ← 纯代码，同步，无网络
        │
        ├─ refusal  ──────────────► 现有流程（sideNote=null ⇒ 跳过 autosave + 弹窗建议重生成）
        │                            （弹窗文案可针对性改为「模型拒答/道歉」）
        ├─ truncated ─────────────► 现有流程（同上），不送纠错
        │                            （补写截断=内容生成，属于「重新生成」按钮的职责）
        ├─ valid（可含 P2）──────► 现有流程，P2 仅记日志
        │
        └─ invalid（含 P0/P1）──► formatCorrector.correct(rawText, errors, ctx)
                                        │  非流式、低温、可中断、有超时
                                        ▼
                              formatChecker.validate(修正文本, ctx)
                                        │
                              ├─ P0/P1 全过 ─► 用修正文本走 _commitResponse（console 记录采用修正版）
                              │
                              └─ 仍不合格 ──► 用【原始文本】走 _commitResponse（现有流程到 autosave/提示重生成）
                                             + 额外弹窗：格式错误提醒（建议调低温度/更换预设）
```

**不卡用户原则**：纠错最多一轮；纠错请求失败/超时/被用户取消，均视同「修正未成功」，按原文继续。

## 4. 校验器设计（`module/format-checker.js`，新增）

### 4.1 接口

```js
var formatChecker = (function() {
    /**
     * @param {string} rawText LLM 原始完整输出
     * @param {object} ctx 分支上下文（见 4.2）
     * @returns {{
     *   status: 'valid'|'invalid'|'truncated'|'refusal',
     *   errors: Array<{level:'P0'|'P1'|'P2', code:string, message:string, location:string}>,
     *   branch: object   // 实际判定的格式分支，供纠错器复用
     * }}
     */
    function validate(rawText, ctx) { ... }
    return { validate: validate };
})();
```

- 纯函数、同步、无副作用；不写任何全局变量，不触网。
- 复用全局只读数据：`npcNameToId`、`npcs`、`locationNames`、`slgSceneOptions`、`legacySceneOptions`、`slgEmotionOptions`、`slgCGOptions`，以及 `matchNPC/matchScene/matchEmotion/matchCG`（game-utils.js）。
- 按项目惯例以 `typeof xxx !== 'undefined'` 守卫所有外部依赖，任一缺失时对应检查项降级跳过（记 P2「校验器数据缺失」），保证 file://、iframe、SR 环境下不抛错。

### 4.2 分支上下文与分支判定矩阵

110 规范的输出分支由 EJS 变量决定。校验发生在「响应已返回、_commitResponse 未执行」的时点，此时全局变量仍保持**请求时**的值（commit 才会清零），可直接读取：

| 分支 | 判定条件 | 段尾第 4 字段 | SUMMARY 形态 | SIDE_NOTE 额外要求 |
|---|---|---|---|---|
| A 标准轮 | `GameMode===0 && newWeek!==1` | 固定 `none` | 单段 80-120 字 | 无随机事件块 |
| B 新周·选项事件 | `GameMode===0 && newWeek===1` 且输出中 `随机事件.事件类型==='选项事件'` | 固定 `none` | 多条 `[第x年第x月第x周]...`，每条 ≤50 字 | 选项一/二/三齐全，各含 描述/奖励/成功率 |
| C 新周·战斗事件 | `GameMode===0 && newWeek===1` 且 `事件类型==='战斗事件'` | 固定 `none` | 同 B | 敌方信息结构完整 |
| D SLG 下山 | `GameMode===1` | NSFWList 枚举或 `none` | 单段 80-120 字 | 按 `randomEvent`/`battleEvent` 全局标记校验随机事件块 |

**分支 B/C 的推定**：110 规范在 `newWeek==1` 时用模板内 `randomNum` 掷 50/50 决定选项/战斗变体，校验端无法重知掷骰结果。推定规则：

1. SIDE_NOTE JSON 可解析且含 `随机事件.事件类型` → 以该值为准，再按对应子 schema 校验（LLM 把类型写错本身即 P1）。
2. JSON 不可解析 → 按「B∪C 并集」校验（只查共性项：标签结构、段尾标记、时间/用户/当前NPC/剧情基调），随机事件子 schema 跳过。

**分支 D 的随机事件**：直接读全局 `randomEvent`/`battleEvent`（110 规范同款变量 `randomEventforFormat`/`battleEventforFormat`），为 1 则要求对应事件块存在且合法。

### 4.3 检查项清单与严重等级

**等级定义**：

- **P0 解析破坏型**：现有解析链路无法消费或产出不可用结果。
- **P1 规范破坏·影响逻辑/展示**：导致变量更新跳过、SLG 图层/头像/表情丢失、事件流卡死风险等**用户可感知**的降级。
- **P2 规范偏离·不影响运行**：装饰性偏离，仅记录日志，不触发纠错。

`status` 判定优先级（先命中先得）：`refusal` → `truncated` → `invalid`（存在任一 P0/P1）→ `valid`。

#### (a) 拒答/道歉（refusal）

同时满足：

1. 全文未命中 `<MAIN_TEXT>`、`<SUMMARY>`、`<SIDE_NOTE>` 任何开标签（用 response-parser 同款容错正则）；
2. 前 300 字符内命中拒答模式，例如：`抱歉|对不起|很遗憾|无法(生成|完成|继续|提供)|不能(生成|完成|继续)|I('m| am) sorry|I can(not|'t)|As an AI`；
   或全文长度 < 50 且不含任何结构标签（防空输出）。

误判防护：剧情对话中可能含「抱歉」等词，但合法输出必有标签，条件 1 已排除。

#### (b) 截断（truncated）

任一命中：

1. `<MAIN_TEXT>` / `<SUMMARY>` / `<SIDE_NOTE>` 开标签存在而闭标签缺失（用 `responseParser.extractXmlBlock` 的 `found && !closed` 判定，直接复用）；
2. SIDE_NOTE 块内存在 `{` 但 JSON 三层修复后仍失败，且文本明显在 JSON 中途结束（如末尾为未闭合字符串/半截键名）；
3. （可选增强）`finish_reason === 'length'`（OpenAI）/ `MAX_TOKENS`（Gemini）——需 api-service 捕获后透传，见第 7 节 P3 项。

注意：MAIN_TEXT 闭合缺失时解析器会「截到下一结构标签」自救，若 SUMMARY/SIDE_NOTE 均完整闭合，则不判截断，转入 invalid 由纠错补齐 `</MAIN_TEXT>`。即：**只有「尾部真的没了」才算截断**。

#### (c) 外层结构（P2 为主）

| 检查项 | 等级 | 说明 |
|---|---|---|
| `<SLG_MODE>` 外层包裹缺失 | P2 | 解析器不依赖它，纯规范项 |
| 三块顺序非 MAIN_TEXT→SUMMARY→SIDE_NOTE | P1 | 顺序错乱会导致 LatestReply 拼接与回退提取混乱 |
| 同名标签重复出现 | P1 | 易使 SUMMARY 兜底正则误吞 SIDE_NOTE 内容 |
| MAIN_TEXT 内容为空 | P0 | 无正文可渲染 |
| SUMMARY 内容为空或缺失（非截断场景） | P0 | 会阻断 assistant 楼层写入 uiConversation，等同于本轮报废 |
| SIDE_NOTE 缺失（非截断场景） | P0 | 全部变量更新丢失 |

#### (d) MAIN_TEXT 段尾标记（P1 密集区）

按行拆分（跳过空行），对每一行：

| 检查项 | 等级 | 说明 |
|---|---|---|
| 行内 `\|` 分隔后段数 ≠ 5 | P1 | `parseSlgMainText` 将丢弃该行全部标记，SLG 展示静默丢失；正文内含 `\|` 也会触发，同样是不规范 |
| 第 2 段 NPC 名：`matchNPC` 结果为 `'none'` 但原文非 none/无 | P1 | 头像不显示 |
| 第 3 段场景名：`matchScene` 结果为 `'none'` 但原文非 none/无 | P1 | 场景图不切换 |
| 第 4 段表情：`matchEmotion` 无法匹配（含 `特殊CG\d+` 直通）且原文非 none/无 | P1 | 表情不显示 |
| 第 5 段（分支 A/B/C）：值非 `none/无` | P1 | GameMode 0 下固定填 none |
| 第 5 段（分支 D）：`matchCG` 无法匹配且非 none/无 | P1 | NSFW 标记失效 |
| 段落数不在 8-12 | P2 | 渲染不依赖，仅规范 |
| 单段正文字数不在 150-250 | P2 | 同上 |

**口径说明**：NPC/场景/表情/CG 的枚举校验**复用运行时 match 函数**（fuzzy 匹配 + 关键词兜底），而非要求逐字等于枚举表。即「渲染器能认 ⇒ 校验器放行」，把误报压到零；「渲染器认了但做了归一化」（如 `议事厅内→议事厅`）记 P2 提示，不触发纠错。

**分支相关等级（重要）**：段尾标记类错误（段数≠5、NPC/场景/表情越界、第 5 段非 none）的等级按 GameMode 区分——GameMode 1（SLG 下山）下 `parseSlgMainText` 逐行消费标记驱动头像/场景/表情图层，错误=P1；GameMode 0（地图模式）下渲染路径仅 `split('|')[0]` 剥离标记（game-ui.js 478/486 行），当前无消费方，同类错误降为 P2（若未来 3D 场景接入段落标记则升回 P1，届时调整一处常量即可）。110 规范虽在 GameMode 0 同样要求标记，但 P 级划分以「是否存在用户可感知的降级」为准，而非「偏离规范字面的程度」。

#### (e) SUMMARY

| 检查项 | 等级 |
|---|---|
| 分支 A/D：字数不在 80-120 | P2 |
| 分支 B/C：存在不以 `[第x年第x月第x周]` 开头的行 | P1（行格式错误会污染 weekHistory 检索） |
| 分支 B/C：任一行 > 60 字（50 字规范 + 容差） | P2 |

#### (f) SIDE_NOTE schema（JSON 可解析后的字段级校验）

| 检查项 | 等级 |
|---|---|
| 三层修复后仍无法解析（且非截断） | P0 |
| 触发了第 2/3 层修复才成功 | P2（度量用，日志记录修复层数） |
| `时间` 缺失或不匹配 `^([01]?\d|2[0-3]):[0-5]\d$` | P1（昼夜/场景背景不更新） |
| `用户.位置变动` 非 none 且 `matchScene` 失败 | P1 |
| `当前NPC` 的某个 key `matchNPC` 失败 | P1（该 NPC 好感/位置更新被跳过） |
| `当前NPC.*.好感变化`  ∉ {大幅下降,下降,不变,上升,大幅上升} | P1 |
| `当前NPC.*.位置变动` 非 none 且 `matchScene` 失败 | P1 |
| `剧情基调.基调归类` ∉ {平淡,紧张,激昂,欢快,悲伤,暧昧} | P1（bgm-manager `isValidMood=false` → 退回平淡 BGM） |
| `剧情基调.置信度` 非数字（如「很高」） | P1（bgm-manager `parseFloat` → NaN → `conf>0.75` 恒 false，情绪 BGM 判定失守；若写成「85%」则 parseFloat=85 恒 true，反向失守） |
| `剧情基调.判定依据` 缺失或 > 40 字（30 规范 + 容差） | P2 |
| 分支 B：`随机事件` 缺失，或选项一/二/三不全，或任一缺 描述/奖励/成功率 | P1（事件弹窗流中断） |
| 分支 B：奖励不匹配 `^(根骨|悟性|心性|魅力)\+\d$`、成功率不匹配 `^\d{1,2}%$` 且不在 10-90 | P1 |
| 分支 C：`随机事件.敌方信息` 缺 名称/类别/属性/战斗报酬；类别 ∉ 9 枚举；攻击力/生命力 ∉ 5 枚举；武学非 0-9 整数；报酬类型 ∉ {武学,学识,声望,金钱}；数值非数字 | P1 |
| 分支 D（按 randomEvent/battleEvent 全局标记）：应有随机事件块而缺失 | P1 |
| 分支 A：出现随机事件块 | P2（多出无害字段，parseLLMResponse 会消费但不影响） |

### 4.4 输出示例

```js
{
  status: 'invalid',
  branch: { id: 'A', label: '标准轮' },
  errors: [
    { level: 'P1', code: 'MARKER_NPC_UNMATCHED', location: 'MAIN_TEXT 第3段',
      message: '段尾NPC「施延年n」无法匹配 NPC 列表，头像将不显示' },
    { level: 'P1', code: 'SIDENOTE_FAVOR_ENUM', location: 'SIDE_NOTE.当前NPC.唐沐梨.好感变化',
      message: '好感变化「微微上升」不在五档枚举内，好感更新将被跳过' },
    { level: 'P2', code: 'PARA_COUNT', location: 'MAIN_TEXT',
      message: '段落数 7，不在 8-12 规范内' }
  ]
}
```

## 5. 纠错器设计（`module/format-corrector.js`，新增）

### 5.1 接口与流程

```js
var formatCorrector = (function() {
    /**
     * @param {string} rawText 非法原始输出
     * @param {object} checkResult formatChecker.validate 的返回（含 errors、branch）
     * @param {object} opts { originalMessages, signal }
     * @returns {Promise<{ text:string, used:boolean, reason:string, checkResult:object }>}
     *   used=true 表示修正文本通过 P0/P1 复核，可替代原文提交
     */
    async function correct(rawText, checkResult, opts) { ... }
    return { correct: correct };
})();
```

流程：组装纠错 messages → 预清洗 → 非流式调用 → 再次预清洗 → `formatChecker.validate` 复核 → 裁决。

### 5.2 纠错 prompt：续写式（推荐，v1 采用）

```
messages = originalMessages.concat([
    { role: 'assistant', content: rawText },
    { role: 'user',      content: correctionInstruction }
])
```

- `originalMessages` 直接取 runTurn 本次已渲染的 messages（pipeline 局部变量，也已镜像到 `window._lastPipelineMessages`）。**好处**：
  - 内含当次实际下发的 110 规范分支原文（避免 EJS `randomNum` 重掷导致分支不一致）；
  - 内含 `<NpcList>/<SceneList>/<ExpressionList>/<NSFWList>` 等枚举定义与全部剧情上下文，模型只需局部修补，内容漂移最小。
- 代价：输入 token 较大（原 prompt + 非法输出 + 指令）。备选「极简 prompt」（仅格式规范 + 枚举 + 错误清单 + 非法输出）见 12.1 决策点。

`correctionInstruction` 模板：

```text
你刚才的回复存在以下格式错误，请修正后【完整重新输出】全部内容：

[错误清单]
1. （MAIN_TEXT 第3段）段尾NPC「施延年n」不在<NpcList>中，请改为列表中最接近的合法NPC名或 none
2. （SIDE_NOTE.当前NPC.唐沐梨.好感变化）「微微上升」非法，只能从 大幅下降/下降/不变/上升/大幅上升 中选择
...

[硬性要求]
- 只修正上述格式问题，严禁改写剧情内容：MAIN_TEXT 各段正文文字必须逐字保留，段落数量与顺序不变；
- SUMMARY 语义不变，仅允许调整格式与字数到规范范围；
- SIDE_NOTE 的数值与语义保持不变，仅允许修正枚举取值、类型与 JSON 结构；
- 输出必须以 <SLG_MODE> 开始、</SIDE_NOTE>\n</SLG_MODE> 结束，包含且仅包含完整的 MAIN_TEXT、SUMMARY、SIDE_NOTE 三部分；
- 不要输出任何解释、前言或后记。
```

错误清单 → 自然语言的映射：checker 的每条 error 带 `code`，corrector 内建 code → 修正指引文案表（含该错误对应的枚举可选项，如五档好感、六种基调、场景列表引用方式）。

### 5.3 调用参数

| 项 | 取值 | 说明 |
|---|---|---|
| 流式 | 非流式 `apiService.sendMessages` | 纠错是后台工序，无需逐 token 上屏 |
| 温度 | `options.temperature = 0.3`（可配置） | **需扩展 api-service**，见第 7 节；未扩展前回退主配置温度 |
| maxOutputTokens | 继承主配置 | 修正输出与原文等长 |
| 超时 | 120s，`AbortController` + `setTimeout` | 超时视同修正失败 |
| 中断 | controller 挂到 `pipeline._currentAbort` | 流式控件停止键在纠错期间仍可用；语义见 12.6 |
| 状态文案 | `_setStreamLog('施延年勘误校稿')` | 与既有「铺纸研墨/伏案疾书/题尾落款」文风一致 |
| 预清洗 | 剥离首个 `<SLG_MODE>/<MAIN_TEXT` 之前的散文前言、剥离 markdown 代码围栏 | 防「好的，修正如下：```」类包装 |

### 5.4 二轮结果裁决

1. 复核结果 `valid`（允许 P2）→ **采用修正文本**提交，`console.log('[FormatCorrect] 采用修正版，原错误 N 条 → 0')`。
2. 复核仍为 `invalid` / `truncated` / `refusal` → **回退原始文本**走 `_commitResponse`，并置 `formatWarningPending`，在 commit 完成后弹窗（见 6.3）。
3. 纠错调用抛错/超时/被取消 → 同 2，弹窗文案区分「修正未生效」与「修正请求失败」。

不采用「谁错少用谁」的部分采纳策略：混合两份文本的风险（JSON 修好了但正文被改写）大于收益，裁决保持二元。

## 6. pipeline.js 集成

### 6.1 插入点

`runTurn` 内，`wasAborted` 早退块（现 651-665 行）之后、`await _commitResponse(...)`（现 668 行）之前：

```js
// === 格式校验 + 可选二轮纠错（仅 runTurn 链路；handleSpecialEvent 直接调
// _commitResponse，天然绕过，不受本机制影响）===
var _fmtWarning = null;
if (typeof formatChecker !== 'undefined' && _isFormatCorrectionEnabled()) {
    var _fmtCtx = { gameMode: GameMode, newWeek: newWeek,
                    randomEvent: randomEvent, battleEvent: battleEvent };
    var _fmtResult = formatChecker.validate(rawText, _fmtCtx);
    console.log('[FormatCheck] 分类=' + _fmtResult.status + ' 错误=' + _fmtResult.errors.length);
    if (_fmtResult.status === 'invalid') {
        _showStreamMask(); _setInteractionEnabled(false); _setStreamLog('施延年勘误校稿');
        try {
            var _corr = await formatCorrector.correct(rawText, _fmtResult, { originalMessages: messages });
            if (_corr.used) {
                rawText = _corr.text;
                window._lastPipelineLLMReplyCorrected = rawText; // 调试镜像
            } else {
                _fmtWarning = _corr.reason; // 'still-invalid' | 'request-failed'
            }
        } catch (fmtErr) {
            console.warn('[FormatCorrect] 纠错异常，按原文继续:', fmtErr && fmtErr.message);
            _fmtWarning = 'request-failed';
        }
        _hideStreamControls();
    } else if (_fmtResult.status === 'refusal') {
        _fmtWarning = 'refusal'; // 文案不同，流程不变
    }
}
```

### 6.2 警告弹窗的时机

`_commitResponse` 内部可能自行弹窗（如「自动存档已跳过，建议重新生成」），其 catch 路径也有「状态保存异常」弹窗。为避免互相覆盖出歧义：

- 给 `_commitResponse` 增加返回值：`return { ok: true }` / catch 中 `return { ok: false }`（内部函数，改动安全）；
- runTurn 中 `var _commitRes = await _commitResponse(...)`；
- 仅当 `_commitRes.ok !== false` 且 `_fmtWarning` 非空时，`showModal(警告文案)`：
  - `still-invalid`：「本轮输出存在格式错误，自动修正未完全生效，已按原样继续。建议：调低模型温度，或更换/调整预设。（可在控制台 [FormatCheck] 日志查看详情）」
  - `request-failed`：「本轮输出存在格式错误，自动修正请求失败，已按原样继续。建议：调低模型温度，或更换/调整预设。」
  - `refusal`：「模型返回了拒答/道歉内容而非剧情，未自动存档。可调整输入后重新生成。」（替代原「格式不完整」文案，更对症；若 SIDE_NOTE 恰为 null 时原文案被本弹窗覆盖，语义是超集，可接受）

### 6.3 与现有「截断保护」的关系

现有两道闸门不变，且天然兼容：

- `parsed.summaries` 为空 → 不写 assistant 楼层；
- `parsed.sideNote === null` → 跳过 autoSave + 弹窗。

纠错机制的退出路径（回退原文）只是把 rawText 原样交还给这两道闸门，行为与今天完全一致。

## 7. api-service.js 扩展（小改，向后兼容）

1. **`options.temperature` 覆盖**（P0 依赖）：`sendMessages` → `_callOpenAI/_callGemini` 签名第三参数后增加 `options` 透传，请求体温度取 `options.temperature ?? config.temperature`。涉及现 123/135/173/188 行附近，约 6 行改动；不传时行为完全不变。
2. **（可选 P3）`finish_reason` 捕获**：OpenAI SSE 末块与与非流式响应中记录 `choices[0].finish_reason`；Gemini 记录 `finishReason`。经 `sendMessages/sendMessagesStream` 返回值透传给 pipeline，作为校验器截断判定的强信号。不做也不影响主流程（结构判定已足够）。

## 8. 配置项

沿用 `gameData.recallConfig` 的先例，新增 gameData 字段（`defaultGameData` 中加默认值，`mergeWithDefaults` 自动迁移旧存档）：

```js
formatCorrection: {
    enabled: true,        // 总开关；false 时校验器也不运行（保持现状零开销）
    temperature: 0.3,     // 纠错轮温度（api-service 扩展后生效）
    logP2: true           // P2 级偏离是否写 console
}
```

UI 入口：系统设置弹窗加「输出格式自动修正」分组（开关 + 温度滑条）。v1 可先只落 gameData 字段与默认开启，UI 后补。

日志：`[FormatCheck]` / `[FormatCorrect]` 前缀；如需进历史管理弹窗的模块分流，在 `log-capture.js` 的前缀表中追加两项（1 行）。

## 9. 边界与异常场景

| 场景 | 行为 |
|---|---|
| 特殊事件链路（handleSpecialEvent → _commitResponse） | 不经过 runTurn 校验点，完全不受影响（文本来自 special-event.js，可信） |
| 重新生成（isRegenerate） | 同样走校验 + 纠错；快照在发送前已落盘，commit 仍只发生一次 |
| 纠错期间用户点停止 | 取消纠错请求，**按原文继续提交**（本轮文本已完整拿到，不应被丢弃）；与「中断流式=丢弃本轮」语义不同，见 12.6 |
| 纠错输出带前言/代码围栏 | corrector 预清洗剥离；清洗后复核 |
| newWeek==1 且 SIDE_NOTE JSON 全坏 | 无法推定 B/C 分支 → 按并集校验共性项；若判 invalid，纠错 prompt 中注明两种随机事件子 schema 供模型对齐其一 |
| 悬赏战斗兜底（parseLLMResponse 内从 activeBounty 构造事件） | 该兜底在 SIDE_NOTE 缺随机事件时救流程；校验器仍如实记 P1（LLM 未按规输出），纠错轮可能把它修好——不冲突 |
| 校验器依赖的全局缺失（SR/iframe 环境） | 守卫降级：该项跳过并记 P2；绝不抛错阻断主流程 |
| rawText 为空串 | 命中 refusal 的空输出条件，走现有流程 |
| 纠错轮把格式修对但顺手改了剧情文字 | 当前裁决无法检测逐字保真（见 12.7 风险）；v1 依赖低温 + 强指令约束，console 保留原文与修正版 diff 供事后审计 |
|  apology 文本恰含「抱歉」且带了半个标签 | 条件 1 不成立（有标签）→ 不判 refusal，转入结构判定 |

## 10. 测试方案

### 10.1 校验器单元测试（构造样本库）

在 `tests/` 或浏览器控制台驱动，样本覆盖：

1. 四个分支各自的**合法样本**（取自真实存档 `window._lastPipelineLLMReply` 历史值）→ 期望 `valid`；
2. 逐类坏样本：缺 `</SUMMARY>`（截断）、JSON 半截（截断）、JSON 三层修复仍失败（P0）、段尾标记缺失/字段数错/NPC 名越界/场景越界/表情越界/GameMode0 第 5 段非 none（各 P1）、好感变化越界/基调越界/时间格式错（各 P1）、选项事件缺选项三（P1）、段落数 7（P2）、SLG_MODE 缺失（P2）、纯道歉文本（refusal）、含「抱歉」对话的合法文本（不得误判 refusal）；
3. 断言：status 符合预期、errors 的 code/level/location 准确、四个分支推定正确（尤其 B/C 推定）。

checker 仅依赖少量全局（枚举表 + match 函数），Node 侧可用 stub 全局跑通，无需 jsdom。

### 10.2 纠错器集成测试

1. 控制台手测：`formatCorrector.correct(坏样本text, formatChecker.validate(坏样本text), { originalMessages: window._lastPipelineMessages })`，人工核对修正文本的剧情保真度与格式；
2. 端到端：临时在 runTurn 校验点后强制 `_fmtResult.status='invalid'`（console 注入），观察完整纠错链路、状态文案、警告弹窗；
3. 回归：合法输出下控制台无任何 `[FormatCorrect]` 日志、无额外请求发出（Network 面板确认零额外调用）。

## 11. 实施步骤

| # | 文件 | 改动 | 预估 |
|---|---|---|---|
| 1 | `module/format-checker.js` | 新增，校验器全量（4.1-4.4） | ~350 行 |
| 2 | `module/format-corrector.js` | 新增，纠错 prompt 组装 + 调用 + 复核裁决（5.1-5.4） | ~200 行 |
| 3 | `module/api-service.js` | `options.temperature` 透传（P0）；可选 finish_reason（P3） | ~10 行 |
| 4 | `module/pipeline.js` | runTurn 插入校验/纠错块（6.1）；`_commitResponse` 增加 ok 返回值（6.2）；警告弹窗 | ~45 行 |
| 5 | `module/game-config.js` | `defaultGameData.formatCorrection` 默认值 | ~6 行 |
| 6 | `index.html` | 两个新 module 的 `<script>` 标签（位置在 game-utils 之后、pipeline 之前） | ~2 行 |
| 7 | `index.html` / `ui/config-modal.js` | 设置 UI（可后置） | ~30 行 |
| 8 | `module/log-capture.js` | 前缀分流（可后置） | ~1 行 |

加载顺序约束：format-checker 依赖 game-config/game-utils 的枚举与 match 函数；format-corrector 依赖 format-checker、api-service；两者均被 pipeline 以 `typeof` 守卫方式引用，缺失时静默跳过，保证部分部署不坏。

## 12. 决策点汇总（均已给推荐值，待拍板）

| # | 决策点 | 推荐 | 备选 / 影响 |
|---|---|---|---|
| 12.1 | 纠错 prompt 形态 | **续写式**（原始 messages + 非法输出 + 指令）：上下文/枚举/分支保真最高 | 极简式：输入 token 省 50-70%，但需自行拼装当次分支规范与枚举表，内容漂移风险略高。可作为 v2 的 `promptMode` 配置 |
| 12.2 | 枚举校验口径 | **与运行时 match 函数对齐**（fuzzy 可认即放行，归一化记 P2）：零误报 | 严格逐字等于枚举表：更贴近规范字面，但会把「渲染器其实能认」的输出送进纠错轮，浪费 token |
| 12.3 | P2 是否触发纠错 | **不触发**，仅日志（段落数/字数/SLG_MODE 缺失等） | 若追求规范收敛可改为「P2 累计 ≥3 条也触发」，但纠错轮会明显增多 |
| 12.4 | 纠错轮温度 | **扩展 api-service 支持 `options.temperature=0.3`** | 不扩展则沿用主配置（常见 0.8-1.0），纠错成功率下降 |
| 12.5 | 开关默认值 | **默认开启**（只在非法时才有额外调用，合法输出零开销） | 默认关闭则更保守，需要用户发现入口 |
| 12.6 | 纠错期间停止键语义 | **取消纠错、按原文提交** | 视为整轮中断丢弃——但此时文本已完整，丢弃可惜，不推荐 |
| 12.7 | 剧情保真校验 | **v1 不校验**（低温+强指令+console diff 审计） | v2 可加「修正前后 MAIN_TEXT 正文段文本相似度 < 阈值则拒用修正版」的硬闸门（如逐段编辑距离占比） |
| 12.8 | 二轮仍非法时的提交文本 | **回退原始文本** | 「错误更少者胜」的部分采纳——混合风险大于收益，不推荐 |

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 纠错轮改写剧情 | 玩家看到与流式期间不同的文字 | 低温 + 逐字保留强指令；console 双版本 diff；12.7 的 v2 硬闸门 |
| 延迟增加 | 非法输出时多一次完整生成（数十秒） | 仅非法时触发；状态文案明确「勘误校稿」；可随时停止并按原文提交 |
| token 成本 | 非法轮输入翻倍 | 同上；12.1 极简式备选；默认开关可控 |
| 误报导致多余纠错 | 浪费一次调用 | 枚举口径与渲染对齐（12.2）；P2 不触发（12.3） |
| 纠错请求失败 | 用户多等了一段时间仍回到原文 | 超时 120s 封顶；失败文案明确；行为等价于现状 |
| 分支 B/C 推定错误 | 校验项对错 schema | 以输出自声明的 事件类型 为准；JSON 全坏时降级并集校验 |

---

### 附：与现有机制的定位关系速查

| 机制 | 职责 | 触发时机 |
|---|---|---|
| response-parser 容错 | 尽力消费输出 | 每轮，提交阶段 |
| summaries/sideNote 双闸门 | 截断不污染历史、不存档 | 每轮，提交阶段 |
| 快照回滚 | commit 异常恢复 | 每轮，异常路径 |
| **format-checker（本方案）** | 严格度量输出规范 | 每轮，commit 前 |
| **format-corrector（本方案）** | 完整但非法时的一次格式修复 | 校验 invalid 时 |
