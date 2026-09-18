// Fixed acceptance registry; NOT RUN is not a successful test. Do not filter missing implementations.
const definitions = [
 ['P0',['基线可还原','五类旧档往返','固定响应业务基准','模式和两主题UI基准','预览资源基线']],
 ['P1',['导入与按需创建','容器适配','生命周期与资源','失败回退','静态与Android smoke']],
 ['P2',['单场景闭环','非业务操作','请求乱序','子景失败','导航和输入防护']],
 ['P3',['地点遍历','NPC全覆盖','刷新规则','拥挤和素材失败','拾取与菜单','环境同步']],
 ['P4',['模式入口矩阵','读档入口矩阵','回滚与失败','特殊页面','子游戏及UI','配置与存档隔离','原生导出']],
 ['P5',['构建与验包','真实部署结构','离线与网络','缓存版本','设备性能','持续运行和资源释放','生产降级']],
 ['P6',['覆盖升级','回退演练','灰度观察','交接复现','最终回归']]
];
const manualIds=new Set(['P1-T05','P3-T05','P4-T07','P5-T02','P5-T03','P5-T05','P5-T06','P5-T07','P6-T01','P6-T02','P6-T03','P6-T04','P6-T05']);
const p0Completion={
 'P0-T01':'Hash every file in P0 manifest snapshotRoot/game and snapshotRoot/pro; exact inventory and SHA256 match, never compare modified workspace game',
 'P0-T02':'Five actual JSON imports and new-context export/import/export preserve business fields, NPC state and histories; no unmatched external requests',
 'P0-T03':'Two real index trajectories complete host initialization, location action, application-consumed SSE checkpoint, pipeline persistence and save reload; state/prompt/RNG/next sample diffs empty',
 'P0-T04':'Cultivation/Gal and both themes cover attributes/relationships and original return paths, expand/collapse story, actual subgame iframe; screenshots and no unmatched external requests',
 'P0-T05':'Run reviewed pro/tools/verify-package.mjs with process.execPath against existing preview APK/Web manifest; capture actual output, exit0, 13 frozen source GLBs, unchanged input hashes'
};
export const registry=definitions.flatMap(([firstPhase,names])=>names.map((name,index)=>{
 const testId=`${firstPhase}-T${String(index+1).padStart(2,'0')}`;
 const integrated=['P1','P2','P3','P4'].includes(firstPhase),manual=manualIds.has(testId);
 return {testId,name,firstPhase,required:true,manual,
   ...(integrated?{browserFile:['P3','P4'].includes(firstPhase)?'p3p4.browser.mjs':`${firstPhase.toLowerCase()}.browser.mjs`,implementationState:manual?'manual-or-real-device-evidence-required':'executable-real-browser'}:{}),
   requiresBrowser:!['P0-T01','P0-T05'].includes(testId),
   fixture:testId==='P0-T01'?'开发文档/3D整合/P0-源码基线.json':testId==='P0-T05'?'../pro/viewer-dist/deployment-manifest.json':firstPhase==='P0'||integrated?'fixtures/manifest.json + browser-module fault/synthetic fixtures (integrated cases require --buildId)':'NOT IMPLEMENTED',
   completion:p0Completion[testId]||`Plan section 9 / ${testId} ${name}: implementation and same-version evidence required`};
}));
// A passing desktop branch can never silently clear an existing device/manual gate.
export const statusAfterAutomation=entry=>entry.manual?'NOT RUN':'PASS';
// Each new stage must retain deterministic 2D behavior and all earlier implemented smoke.
export function selectTests(phase) {
 if (phase==='all') return registry;
 if (!/^P[0-6]$/.test(phase)) throw Error(`Unknown phase: ${phase}`);
 return registry.filter(test=>test.firstPhase===phase || (phase!=='P0' && ['P0-T02','P0-T03','P0-T04'].includes(test.testId)) || (Number(phase.slice(1))>=2&&['P1-T01','P1-T03'].includes(test.testId)) || (Number(phase.slice(1))>=3&&['P2-T01','P2-T03'].includes(test.testId)));
}
