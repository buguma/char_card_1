# 古风UI清雅化：设计与进度

## 本轮授权

用户要求学习E:\JJBurst\pro预览美术风格，只优化E:\JJBurst\git古风主题UI，不变更功能逻辑。原3D项目后置真机、兼容签名、API、灰度条件继续按P6记录，不当作本次UI完成条件。

## 已研究参考

- pro/viewer.css及主预览截图browser_environment_final_desktop.png、browser_reference.png。
- library/kitchen/council预览CSS：纸白、灰绿/灰蓝墨色、1px细线、宋体标题、低密度朱砂强调、通透小面板。
- 原git古风层theme+beautify：深黑粗框、印章整图自带文字、反白斜标题、枯笔border-image fill、进度条灰化伪元素。仅替换变量不足，须按组件解除图层。

## 实施原则

新增独立`module/game-styles-elegant.css`，index仅新增link，全部规则限定body.ui-style-ancient。不改任何JavaScript、事件、存档、API、NPC、3D模型/相机、场景显隐与按钮业务状态；扁平主题不应用新层。原006候选及APK保留，不原地更新旧不可变交付目录。

配色：纸#f4f1e5、浅纸#faf8f2、灰绿墨#34453f、朱砂#934d3c、灰蓝#526e81；标题宋体/正文无衬线。普通卡片细线无硬影，弹窗纸面轻影；有字图片按钮改用原DOM文字，保持菜单入口和交互；正文淡化山水不抢阅读；进度填充保留原inline width。

## 当前进度

- 已保存旧古风桌面/小屏截图`.scene3d-work/ui-elegant-before-02`；第一捕获脚本把page误传session导致TypeError，已修测试调用，无生产问题。
- 已实现第一版新CSS与link，桌面1280×900、小屏390×844视觉捕获运行中。
- 已亲看第一版map390/history1280截图，清除主要粗框并淡化正文山水；后续已调整状态栏去黑笔触。截图捕获补等待有限动画结束，避免将过渡帧误判为半透明布局。
- hostUI首次实跑116：扁平轨迹PASS，古风两lane背包关闭点击超时，报告`.scene3d-work/ui-elegant-host-wide`。这是待修样式回归，不签整体完成；11df只读诊断rect/scroll/overflow，父保持CSS稳定等待最小修复建议。
- 工作区HTTP预览已启`http://127.0.0.1:8088/`，新CSS HEAD200/text-css；旧8086仍指向冻结006，不会显示新UI。最终回归通过再给用户正式预览步骤。
- 已完成背包样式回归修复：菜单点击导致页面滚动，旧fixed modal锚点为top=-443、关闭y=-187；古风CSS覆盖层top0/max-height100dvh和border-box使紧凑内容的关闭按钮始终可见。不新增业务JS、不用放大测试窗口或伪点击。

## 回退说明（用户要求）

用户认为清雅化版本不符合预期，已按要求回退：`index.html` 不再引用`module/game-styles-elegant.css`，原`game-styles-theme.css`与`game-styles-beautify.css`继续生效。新增CSS文件及本记录保留作本次尝试的历史，不影响原UI、业务逻辑、3D资源或存档。HTTP预览已确认 elegant link不存在且原 beautify link存在。

## 最终验证与交付

- 最终CSS SHA256：`5366f044bec354c3658e723500e02d8ea9b2be80d42fbab4d68ba1a7fe3178ba`。
- `tests/scene3d/elegant-theme.browser.mjs`：`.scene3d-work/ui-elegant-final-visual/result.json` PASS。42条CSS规则古风限定；49个module/ui业务JS hash与006冻结源相同；index移除唯一link后逐字符等于冻结源。初次脚本忽略CRLF导致比较失败，改为准确保留原换行后通过，没有规范化差异掩盖业务改动。
- 两尺寸×两主题实际启停新CSS：业务/RNG完全相同；扁平主题受测组件computed styles逐项相同；古风确有视觉变化；实际3D主景/藏经阁与原弹窗关闭通过。
- hostUI最终`.scene3d-work/ui-elegant-final-wide`与`ui-elegant-final-small`各96checks PASS/0FAIL，两主题2D/3D全业务/prompt/RNG轨迹一致，包含背包装备、历史技能内部滚动、购买售出、原返回、输入、BGM，父121 exit0已收集。
- Gal/属性/关系/正文展开/分页/CG：`.scene3d-work/ui-elegant-gal-pages`P4-T04 PASS。runner因定向未跑其他项exit1，未执行项保留NOT RUN，不是本case失败。
- 已亲看最终桌面3D主景、小屏藏经阁、背包截图；纸色细线、竖排题签、轻朱砂强调生效。
- 正式本地预览改为`http://127.0.0.1:8086/index.html`，沿用用户之前origin，不清理其浏览器存档。服务现指向工作区git，index/CSS/current均HTTP200。临时8088关闭；旧006交付目录与APK原样保留，新UI尚未重新打入006 APK。
- 刷新后选择古风主题即可。若旧CSS缓存，使用Ctrl+F5；不要双击file://看3D。模型/渲染器仍006，不为纯CSS修改生成新资源版本。

## 实践Skill补充

1. 整图按钮带字时，去background-image须恢复真实DOM文字color，hover的旧高优先级图也要清。
2. border-image fill可以覆盖面板背景，换细框必须同时移除fill/还原border/background。
3. 新紧凑布局可能暴露旧fixed overlay负锚点，须真实页面滚动后测关闭按钮rect与hit-test。
4. 进度条从图片轨道改普通填充时，移除旧灰化遮罩但保留业务inline width；不能一刀切清所有伪元素。
5. UI-only验收同时验证原JS字节、HTML只增link、禁用新CSS后的flat计算样式与业务RNG不变，截图必须等待有限动画结束。
6. 用户已用的localhost origin继续提供新页面，可保留浏览器来源存储；不要为预览随意更换端口后让用户误以为存档消失。

## 验证边界

只用独立BrowserContext和合成存档、模拟API。不读写用户真实存档。浏览器实际截图、原控件点击、两主题业务对照后才宣布完成；Android视觉与字体仍以设备实测为准。
