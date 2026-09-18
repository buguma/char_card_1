# P5 APK网页入口与资源验证

## 实测结论

**005 APK所用www目录在桌面Chrome真实入口测试通过。** 这补充P5-T02/T03的桌面可自动分支，不替代Android/WebView首次安装断网启动。

- 测试脚本：`tests/scene3d/apk-web.browser.mjs`。
- 实跑：父job67 exit0，Chrome153.0.8010.36。
- 报告：`.scene3d-work/acceptance/integration-005-apk-web-a/result.json`，资源状态与MIME：同目录`resource-mime.json`，还有截图/network/console。
- 来源：已严格验包run的`prepare:apk.wwwRoot`，不是将工作区index假称为APK游戏入口。
- buildId：integration-005；manifest SHA256 `3f70495e184f8f2b43e8685f086b433c824ba123058587ae2bf44ab9a9f47655`。

## 实际操作与断言

1. 独立BrowserContext预置合成存档和模拟API配置；测试服务只绑定loopback，并部署于`/apk-web/`子路径，所有外部请求阻断。
2. 访问打包后`index.html`开局页，真实点击“重续前缘”和合成存档按钮，由原页面跳转`game.html?intent=loadSave...`。
3. 开局页和默认关闭3D的游戏页均无3D请求。通过宿主开关开启低画质，等待真实主景首帧可交互。
4. 初次渲染前后完整gameData/RNG相同。
5. 依次进入演武场、藏经阁、伙房、后山、议事厅、铁匠铺、男弟子、女弟子、山门、公田、丹房，等待每个真实场景ready，再点击原返回按钮回地图。
6. 所有3D请求HTTP200，路径保留`/apk-web/assets/sect3d/`前缀；MJS/GLB/WASM MIME分别检查。
7. 全程API请求0、外部素材替代0、未知外部流量0、pageerror0。关闭3D后恢复原map-scene。

## 复现

从工作区根运行，报告目录必须为新的绝对`.scene3d-work`子目录：

```powershell
node tests/scene3d/apk-web.browser.mjs 'E:\JJBurst\git\.scene3d-work\integration-005\run.json' 'E:\JJBurst\git\.scene3d-work\acceptance\<新的报告目录>'
```

输入run必须已有成功verify:apk记录。脚本为独立CLI，不自动导入总browser runner，不能因别的测试通过声称运行过它。

## 证据边界

- 请求隔离保留loopback供本地文件服务，并阻断外网；不是把浏览器设成offline后模拟Android资产加载。
- 测试使用Node静态服务的MIME；Capacitor真实WebView MIME和离线首次安装仍需实际设备。此前读取Capacitor源代码的映射只是辅助证据。
- 本次是005冻结www；后续ST锁/长模态等宿主修复不在此包中，最终候选需对新run重跑本脚本。
- 冷缓存Web磁盘状态不等于手机第一次安装，GPU/性能也不能从桌面迁移到设备。
- Gal原404加载图不在本次养成遍历路径；外部替代0不能说明整个应用所有路径完全离线。
