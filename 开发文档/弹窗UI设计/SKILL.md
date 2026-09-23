---
name: dialog-ui-design
description: 为姬侠传设计或重做弹窗/面板 UI（布局几何 + 古风皮肤 + 响应式 + 无障碍），复用背包弹窗沉淀的 边框-fill/水墨笔触2/框5-短/水墨笔触1 素材套路与九宫格/整图皮肤技法。当用户要求新增、美化、或调整某个弹窗/面板的视觉与布局时使用。
---

# 弹窗/面板 UI 设计（以背包弹窗为范本）

背包弹窗（`#inventory-modal`）是本项目目前最规范的弹窗示例：几何、主题皮肤、响应式、无障碍、测试五层清晰分层。本文把它设计和施工过程中的可复用经验提炼成套路。

## 一、动笔前必读资料（按顺序）

1. **范本三件套**：
   - `module/inventory-panel.css` —— 基座（几何/语义）+ 扁平皮肤 + 古风皮肤三段式，这是分层样板。
   - `module/inventory-panel.js` —— 布局的 JS 侧：`size()` 填满视窗、字体 clamp、单一委托监听、`render()` 幂等。
   - `index.html` 内 `#inventory-modal`（约 L1114-1133）—— 语义 HTML 骨架。
2. **古风素材 canonical 套路**：`module/game-styles-beautify.css`
   - `4.5b` 二级/短按钮（框5-短 / 框5-fill 三段式）
   - `4.6` 弹窗外框（水墨粗方框 九宫格）+ `4.6b` 面板（边框-fill 九宫格 + fill 米黄铺底）
   - 「标题牌」段（水墨笔触2 + 纸色反白 + 黑描边）
3. **弹窗基础样式与主题变量**：`module/game-styles.css`、`module/game-styles-dialogs.css`、`module/game-styles-theme.css`（`--paper-base`/`--ink-black`/`--font-serif` 等）。
4. **移动端密度/安全区**：`module/mobile-density-overrides.css`。
5. **全屏/响应式验收口径**：`开发文档/弹窗响应式与安卓全屏验收.md`。
6. **素材清单**（`assets/image/static/`，先查原图固有尺寸再决定拉伸策略）：

   | 素材 | 固有尺寸 | 宽高比 | 用途 |
   |---|---|---|---|
   | 边框-fill.png | 597×602 | 1:1 | 面板/卡片枯笔方框（九宫格 + fill 米黄铺底） |
   | 水墨粗方框.png | — | — | 弹窗外框（九宫格四角墨团） |
   | 水墨笔触2.png | 1989×791 | 2.515:1 | 标题牌弧形浓墨笔触 |
   | 框5-短.png | 542×220 | 2.464:1 | 短/紧凑按钮整图皮肤（卷草纹两端） |
   | 框5-fill.png | — | — | 全宽长按钮（三段式：左右角纹不拉伸、中段纯色拉伸） |
   | 水墨笔触1.png | 383×175 | 2.189:1 | 选中态墨团衬底 |

## 二、架构决策（骨架）

1. **弹窗归属二选一**：
   - **视窗内填充弹窗**（背包）：`position:absolute` 填满 `#main-viewport` 的 padding box（**含 border**），由 JS `size()` 用 `getComputedStyle(viewport)` 读边框宽、`left:-borderLeft; top:-borderTop; width/height: calc(100%+边框和)`，再挂 `ResizeObserver` 重排。适合"独占视窗整块矩形"的背包/装备类。
   - **全屏 overlay**（多数弹窗）：`.modal.viewport-overlay` + `fitModalToViewport()`。适合居中小窗。
2. **语义结构**：`section[role=dialog][aria-modal][aria-labelledby]` > `header` + 内容列。标题居中用 `grid-template-columns: 1fr auto 1fr`（关闭按钮靠右 `justify-self:end`）。
3. **内容区滚动**：grid/flex 子项一律 `min-height:0`（不写则撑破），滚动区 `overflow:auto + overscroll-behavior:contain`。
4. **数据驱动渲染**：单一委托 click 监听，`data-*` 分派（分类/物品/动作三分支）；`render()` 幂等（`replaceChildren` 全量重绘），不维护增量 DOM。
5. **主题分离**：基座只写**几何/语义**，皮肤全放 `body.ui-style-flat` / `body.ui-style-ancient` 覆盖块；**皮肤绝不改几何**（列宽、滚动、字体 clamp 保持原样）。

## 三、古风皮肤套路（皮肤只换皮）

1. **边框-fill 枯笔方框**：`border:10px solid transparent; border-image:url('边框-fill.png') 4% fill / 10px / 1px stretch;`。外壳 10px、内区 6px（`/ 6px /`）。**内区容器退掉直角 border**（`border:none`），避免"壳框里再套一条线"的双线。
2. **水墨粗方框弹窗外框**：`border-image:url('水墨粗方框.png') 24% / 26px / 4px stretch;`，四角墨团固定、边线中段拉伸。
3. **标题牌（水墨笔触2）**：`paper-base` 反白字 + 黑描边：
   `background-color:var(--paper-base); background-image:url('水墨笔触2.png'); background-size:contain; background-blend-mode:multiply; color:var(--paper-base); -webkit-text-stroke:1.5px var(--ink-black); paint-order:stroke fill;` 再加 `transform:rotate(-1.6deg)` 微斜、`align-self:flex-start`（防 flex 拉伸拉扁墨迹）。
4. **框5-短 整图按钮**：卷草纹在两端、米黄内填在图中。
   - 紧凑小按钮：`background-size:100% 100%` 即可（卷草纹不糊）。
   - **要求"保持原始宽高比不拉伸"时**：`background-size:100% auto` + `aspect-ratio:2.46/1`（**绝不 100% 100%**）。
   - **全宽长按钮禁用框5-短**（横拉糊边），换 `框5-fill` 三段式：`border-image:url('框5-fill.png') 52 fill / 16px / 1px stretch;`。
5. **选中态（水墨笔触1）**：`background-image:url('水墨笔触1.png'); background-size:100% 100%; color:#fff;` + 8 向黑描边 `text-shadow`；同时退掉基座的 selected 底色与左竖条。
6. **选中/悬停态通用替代**：`border-image ... fill` 米黄会盖住元素 `background`，选中/悬停改用 `box-shadow: inset 0 0 0 999px rgba(44,44,44,.10)` 轻罩（box-shadow 画在背景之上、内容之下）。

## 四、响应式与适配

1. **字体 clamp**：`--inventory-font: max(11px, min(22px, viewport.clientWidth/42))`，随视窗连续缩放。
2. **尺寸单位**：间距/字号用 `em`、容器比例用 `cqw`/百分比，不用死 px。
3. **重排用 ResizeObserver**（背包在 `init()` 里 `new ResizeObserver(size).observe(viewport)`，打开时再手动 `size()` 一次）。若尺寸要**联动测量另一个元素的布局高度**，用双 rAF settle 等布局稳定（教训：单次 rAF 会读到 probe 旧高度差 1px，见 `module/viewport-corner-sync.js`）。
4. 绝对定位填充务必**计入 border 宽**（`left:-borderLeft`、`width:calc(100%+left+right)`）。

## 五、无障碍与交互

1. `role=dialog` + `aria-modal` + `aria-labelledby`；详情区 `aria-live=polite`；选中态用 `aria-pressed`。
2. 键盘：`Escape` 关闭、`Tab` 焦点循环、关闭后焦点还给 opener（`opener.focus()`）。
3. 焦点可见：`:focus-visible` 描边，颜色对比足够。

## 六、测试验收

1. **计算样式断言**：浏览器返回的 `borderImageSource`/`backgroundImage` URL 会 **percent-encode 中文**，断言前 `decodeURIComponent`。
2. **不拉伸断言**：`background-size !== '100% 100%'`（要求原始比例时）；或断言 `aspect-ratio` 逼近素材比（如 2.46）。
3. **全尺寸矩阵**：390×844 / 844×390 / 1440×900（竖横屏）× ancient/flat 双主题，验证不越出、可滚动、按钮可达。
4. 断言选中态颜色为 `rgb(255,255,255)` 等具体计算值，别只查 class。

## 七、工作流程与常见坑（施工经验）

1. 读齐范本与素材 → 定归属（视窗内填充 vs 全屏 overlay）→ 写语义 HTML → 基座 CSS → 皮肤覆盖 → JS 渲染/焦点 → 跑测试矩阵。
2. **拉伸三连坑**：`100% 100%` 会压扁卷草纹/笔触；分场景用 `auto`（保比例）/ `contain`（标题牌）/ 三段式 border-image（长按钮）。任何"保持原始宽高比"需求都用 `auto`+`aspect-ratio`。
3. **min-height:0**：grid/flex 子项漏写就滚动失效、内容溢出撑破。
4. **双线**：壳已用 border-image，内区必须 `border:none`。
5. **描边吃字**：`-webkit-text-stroke` 先画边后填字 → `paint-order:stroke fill`，否则白字被黑边吃掉。
6. **fill 盖 background**：选中/悬停不用 `background-color`，用 `inset 999px` 大阴影轻罩。
7. **主题覆盖 specificity**：主题 `background` 常是 `!important` shorthand（会连带重置 image），皮肤里要用 longhand 逐项恢复，必要时 `!important` 对抗。
8. **需求歧义要先记录并反馈**：本次"白底黑字"与"和其他弹窗一致"冲突，最终按"一致"做成纸白字+墨描边，注释里留档。以后遇到矛盾需求，先问或先记录口径，别闷头猜。
9. **CSS 全部作用域化**：所有规则挂在 `#inventory-modal` 前缀下，杜绝泄漏到其他弹窗。
10. 收尾用浏览器真实截图/计算样式验证，不只看代码；改完跑一次多尺寸矩阵。
