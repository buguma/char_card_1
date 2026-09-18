// Import-safe full-game regression. CLI: node tests/scene3d/npc-focus.browser.mjs <absolute evidence dir>
// Four isolated synthetic-save lanes; real native pointer/keyboard/wheel input.
// Only the terminal spar operation is intercepted, after the original npcAction runs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { artifact, assertSessionSafe, hashFile, json, launchBrowser, newGameContext, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const overlay = '.npc-selection-overlay.scene3d-npc-selection';
const frames = (page, ms = 1000) => page.evaluate(ms => new Promise(resolve => {
  const start = performance.now(); let count = 0;
  const step = now => { count++; if (now - start >= ms && count >= 5) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), ms);
const direction = c => { const v = c.position.map((n, i) => n - c.target[i]), length = Math.hypot(...v); return v.map(n => n / length); };
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
async function identity(root) {
  const release = await json(path.join(root, 'assets/sect3d/current.json'));
  const manifest = await json(path.join(root, 'assets/sect3d', release.manifest));
  const files = ['index.html', 'module/scene3d-bridge.js', 'module/scene3d-host.css', 'module/game-helpers.js', 'module/game-styles-theme.css', 'module/game-styles.css', 'module/game-styles-beautify.css', 'module/game-styles-elegant.css', 'assets/sect3d/current.json', `assets/sect3d/${release.manifest}`, `assets/sect3d/${release.buildId}/${manifest.entry}`, ...manifest.css.map(f => `assets/sect3d/${release.buildId}/${f}`)];
  return Object.fromEntries(await Promise.all(files.map(async f => [f, await hashFile(path.join(root, f))])));
}
async function installObservation(page, buildId) {
  await page.evaluate(async buildId => {
    window.__npcFocusTrace = { pointers: [], calls: [], mutations: [], operations: [], focusTransitions: [], returnTransitions: [] };
    const box = element => {
      if (!element) return null;
      const css = getComputedStyle(element);
      const rect = element.getBoundingClientRect(), pseudo = getComputedStyle(element,'::before');
      return { className: element.className, display: css.display, visibility: css.visibility, opacity: css.opacity, pointerEvents: css.pointerEvents, position: css.position, borders:[css.borderTopWidth,css.borderRightWidth,css.borderBottomWidth,css.borderLeftWidth], background:css.backgroundImage, before:{content:pseudo.content,background:pseudo.backgroundImage,size:pseudo.backgroundSize,display:pseudo.display}, rect: rect.toJSON(), text: element.textContent, centerTarget: document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.outerHTML.slice(0,250) };
    };
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'wheel', 'keydown']) document.addEventListener(type, event => {
      __npcFocusTrace.pointers.push({ type, trusted: event.isTrusted, pointerType: event.pointerType, x: event.clientX, y: event.clientY, target: event.target.tagName + '.' + event.target.className, key: event.key, deltaY: event.deltaY, at: performance.now() });
      if(type==='pointerdown') { const d=GameSceneBridge.getDiagnostics().renderer; if(d.returningNpcView) __npcFocusTrace.returnTransitions.push({returning:d.returningNpcView,zoom:d.cameraView.zoom,outline:d.npc.outline.selectedNpcId}); }
      if(type==='pointerup') requestAnimationFrame(()=>{const d=GameSceneBridge.getDiagnostics().renderer;__npcFocusTrace.focusTransitions.push({at:performance.now(),selectedNpcId:d.selectedNpcId,focusingNpc:d.focusingNpc,overlay:!!document.querySelector('.scene3d-npc-selection.show')});});
    }, true);
    const original = document.querySelector('#npc-info-popup');
    new MutationObserver(() => __npcFocusTrace.mutations.push({ at: performance.now(), original: box(original), overlay: box(document.querySelector('.scene3d-npc-selection')) })).observe(document.querySelector('#main-viewport'), { attributes: true, childList: true, subtree: true });
    // Independent image alpha oracle: inspect actual published atlas pixels, not picker internals.
    const base = new URL(`assets/sect3d/${buildId}/`, location.href);
    const manifest = await (await fetch(new URL('npc/generated/manifest.json', base))).json();
    const visuals = new Map();
    window.__npcFocusLoadVisuals = async () => {
      const keys = GameSceneBridge.getDiagnostics().snapshot.renderedNpcs.map(n => n.visualKey);
      for (const visual of manifest.npcs.filter(n => keys.includes(n.id) && !visuals.has(n.id))) {
        const sheets = [];
        for (const sheet of visual.sheets) {
          const image = new Image(); image.src = new URL(sheet.file, base).href; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
          sheets.push({ ...sheet, ctx });
        }
        visuals.set(visual.id, { ...visual, sheets });
      }
    };
    await window.__npcFocusLoadVisuals();
    window.__npcFocusPixel = (id, fx, fy) => {
      const d = GameSceneBridge.getDiagnostics(), resident = d.renderer.npc.residents.find(n => n.gameNpcId === id);
      const key = d.snapshot.renderedNpcs.find(n => n.gameNpcId === id)?.visualKey, v = visuals.get(key);
      const sheet = v?.sheets.find(s => resident.frame >= s.first && resident.frame < s.first + s.count);
      if (!sheet) return null;
      const cell = resident.frame - sheet.first, x = (cell % v.columns) * v.cellWidth + v.padding + Math.min(v.width - 1, Math.floor(fx * v.width));
      const y = Math.floor(cell / v.columns) * v.cellHeight + v.padding + Math.min(v.heightPixels - 1, Math.floor(fy * v.heightPixels));
      return { frame: resident.frame, alpha: sheet.ctx.getImageData(x,y,1,1).data[3] };
    };
    window.__npcFocusSample = () => {
      const diagnostics = GameSceneBridge.getDiagnostics();
      const residents = diagnostics.renderer.npc.residents.map(resident => {
        const key = diagnostics.snapshot.renderedNpcs.find(n => n.gameNpcId === resident.gameNpcId)?.visualKey;
        const v = visuals.get(key), sheet = v?.sheets.find(s => resident.frame >= s.first && resident.frame < s.first + s.count);
        if (!sheet) return { ...resident, alpha: null };
        const cell = resident.frame - sheet.first, width = v.width, height = v.heightPixels;
        const x = (cell % v.columns) * v.cellWidth + v.padding, y = Math.floor(cell / v.columns) * v.cellHeight + v.padding;
        const rgba = sheet.ctx.getImageData(x, y, width, height).data;
        let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
        for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) if (rgba[(py * width + px) * 4 + 3] >= 90) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); pixels++; }
        return { ...resident, alpha: { width, height, minX, minY, maxX, maxY, pixels, heightRatio: (maxY - minY + 1) / height, widthRatio: (maxX - minX + 1) / width } };
      });
      return { at: performance.now(), diagnostics, residents, original: box(original), overlay: box(document.querySelector('.scene3d-npc-selection')), frame: box(document.querySelector('.scene3d-npc-selection .npc-selection-frame')), buttons: [...document.querySelectorAll('.scene3d-npc-selection .npc-selection-option')].map(box), modal: box(document.querySelector('#modal')), modalButtons: [...document.querySelectorAll('#modal-buttons button')].map(box), canvas: box(document.querySelector('canvas.scene3d-canvas')), trace: __npcFocusTrace };
    };
  }, buildId);
  const cdp = await page.createCDPSession(); await cdp.send('Debugger.enable');
  const fn = await cdp.send('Runtime.evaluate', { expression: 'GameSceneBridge.showNpcInfoAtAnchor' });
  await cdp.send('Debugger.setBreakpointOnFunctionCall', { objectId: fn.result.objectId, condition: '(window.__npcFocusTrace.calls.push({npcId,locationId,anchor,event,at:performance.now()}),false)' });
  for (const [name, args] of [['giveGift', '{npcId}'], ['npcAction', '{npcId,action}']]) {
    const operation = await cdp.send('Runtime.evaluate', { expression: name });
    await cdp.send('Debugger.setBreakpointOnFunctionCall', { objectId: operation.result.objectId, condition: `(window.__npcFocusTrace.operations.push({name:'${name}',args:${args},at:performance.now()}),false)` });
  }
  return cdp;
}
async function realNpcClick(page, id) {
  await page.evaluate(() => __npcFocusLoadVisuals());
  const attempts = [];
  for (const [fx, fy] of [[.5,.5],[.5,.3],[.5,.7],[.3,.5],[.7,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]]) {
    const state = await page.evaluate(id => {
      const d = GameSceneBridge.getDiagnostics(), a = d.renderer.npc.residents.find(n => n.gameNpcId === id)?.anchor;
      return { a, calls: __npcFocusTrace.calls.length };
    }, id);
    assert.ok(state.a, 'Resident must have a diagnostic search anchor');
    const x = state.a.left + state.a.width * fx, y = state.a.top + state.a.height * fy;
    const { top, pixel } = await page.evaluate(({x,y,id,fx,fy}) => ({top:document.elementFromPoint(x,y)?.matches('canvas.scene3d-canvas'),pixel:__npcFocusPixel(id,fx,fy)}), {x,y,id,fx,fy});
    attempts.push({ x, y, canvasOnTop: top, pixel }); if (!top || (pixel && pixel.alpha < 90)) continue;
    await page.mouse.click(x, y); await frames(page, 1000); // Includes native click bubbling, tween, and delayed legacy closers.
    const hit = await page.evaluate(n => __npcFocusTrace.calls.length > n, state.calls);
    if (hit) return attempts;
  }
  throw Error(`No real NPC click reached the internal bridge: ${JSON.stringify(attempts)}`);
}
async function clickAction(page, text) {
  await frames(page, 350);
  const buttons = await page.$$(`${overlay} .npc-selection-option`);
  for (const button of buttons) if ((await button.evaluate(n => n.textContent)).includes(text)) { await button.click(); return; }
  throw Error(`Missing action ${text}`);
}

function assertFraming(state, id, initialDirection) {
  const resident = state.residents.find(n => n.gameNpcId === id), a = resident.anchor, r = state.canvas.rect;
  assert.ok(Math.abs(a.height / r.height - .29) < .002, 'Focused card height is .29 of canvas CSS height');
  assert.ok(Math.abs(a.left+a.width/2-r.left-r.width/2) < 2 && Math.abs(a.top+a.height/2-r.top-r.height/2) < 2, 'Focused card stays at viewport center');
  assert.ok(distance(direction(state.diagnostics.renderer.cameraView), initialDirection) < .002, 'Original room camera direction restored');
  assert.equal(state.diagnostics.renderer.selectedNpcId,id); assert.equal(state.diagnostics.renderer.focusingNpc,false);
  if(state.frame) assert.ok(Math.abs(state.frame.rect.left+state.frame.rect.width/2-a.left-a.width/2)<2 && Math.abs(state.frame.rect.top+state.frame.rect.height/2-a.top-a.height/2)<2,'Overlay ring follows current NPC anchor');
}
async function assertClosed(page, initialCamera) {
  await page.waitForFunction(()=>!GameSceneBridge.getDiagnostics().renderer.returningNpcView,{timeout:15000});
  await frames(page,100);
  assert.equal(await page.$('.scene3d-npc-selection.show'),null);
  const d = await page.evaluate(()=>GameSceneBridge.getDiagnostics());
  assert.equal(d.renderer.selectedNpcId,null); assert.equal(d.renderer.focusingNpc,false);
  assert.ok(!d.snapshot.blockReasons.includes('scene-menu')); assert.equal(d.renderer.interactionEnabled,true);
  assert.equal(d.renderer.returningNpcView,false);
  assert.equal(d.renderer.npc.outline.selectedNpcId,null);
  if (initialCamera) {
    assert.ok(distance(d.renderer.cameraView.position,initialCamera.position)<.001,'Dismissal restores canonical camera position');
    assert.ok(distance(d.renderer.cameraView.target,initialCamera.target)<.001,'Dismissal restores canonical target');
    assert.ok(Math.abs(d.renderer.cameraView.zoom-initialCamera.zoom)<.0001,'Dismissal restores canonical zoom');
  }
}
async function assertDescription(page) {
  const result = await page.$eval('.scene3d-npc-selection .npc-selection-desc', n => {
    const s=getComputedStyle(n),r=n.getBoundingClientRect(),v=document.querySelector('.scene3d-canvas').getBoundingClientRect();
    const range=document.createRange(); range.selectNodeContents(n);
    const lines=new Set([...range.getClientRects()].filter(x=>x.width>0&&x.height>0).map(x=>Math.round(x.top))).size;
    return {text:n.textContent,lines,overflow:s.overflowY,scroll:n.scrollHeight,height:n.clientHeight,width:n.clientWidth,font:s.fontSize,rect:r.toJSON(),inside:r.left>=v.left&&r.right<=v.right&&r.bottom<=v.bottom};
  });
  assert.ok(result.lines<=3,`Description must have at most three complete lines: ${JSON.stringify(result)}`);
  assert.ok(result.scroll<=result.height+1,'Description must not be clipped or scroll');
  assert.equal(result.overflow,'hidden'); assert.ok(result.inside,'Entire description remains inside the 3D viewport');
  return result;
}
async function emptyClick(page) {
  const point = await page.evaluate(()=>{
    const canvas=document.querySelector('.scene3d-canvas'),r=canvas.getBoundingClientRect();
    const anchors=GameSceneBridge.getDiagnostics().renderer.npc.residents.map(n=>n.anchor).filter(Boolean);
    for(const [fx,fy] of [[.97,.95],[.03,.95],[.97,.35],[.03,.35]]) {
      const x=r.left+r.width*fx,y=r.top+r.height*fy;
      if(document.elementFromPoint(x,y)===canvas&&!anchors.some(a=>x>=a.left&&x<=a.left+a.width&&y>=a.top&&y<=a.top+a.height)) return {x,y};
    }
    return null;
  });
  assert.ok(point,'Need empty canvas coordinate outside NPC/overlay controls'); await page.mouse.click(point.x,point.y);
}
const expectedLocations = {library:'藏经阁',council:'议事厅',alchemy:'丹房',kitchen:'伙房',male_quarters:'男弟子房',female_quarters:'女弟子房',forge:'铁匠铺',back_mountain:'后山',gate:'山门',training:'演武场',fields:'公田'};
async function locationSample(page) {
  return page.evaluate(()=>({diagnostics:GameSceneBridge.getDiagnostics(),labels:[...document.querySelectorAll('.scene3d-location-label')].map(n=>{
    const s=getComputedStyle(n),r=n.getBoundingClientRect();
    return {id:n.dataset.sceneId,text:n.textContent,visible:!n.hidden&&!n.parentElement.hidden&&s.display!=='none',x:parseFloat(n.style.left),y:parseFloat(n.style.top),rect:r.toJSON(),color:s.color,stroke:s.webkitTextStrokeColor,strokeWidth:s.webkitTextStrokeWidth,borders:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],background:s.backgroundColor,image:s.backgroundImage,shadow:s.boxShadow,pointerEvents:s.pointerEvents};
  })}));
}
async function verifyMainLabels(page,dir) {
  await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().readyScene==='main'&&GameSceneBridge.getDiagnostics().renderer.interactionEnabled,{timeout:120000}); await frames(page,400);
  const initial=await locationSample(page); await artifact(dir,'main-labels-initial.json',initial); await page.screenshot({path:path.join(dir,'main-labels-initial.png')});
  assert.equal(initial.labels.length,11); assert.deepEqual(Object.fromEntries(initial.labels.map(n=>[n.id,n.text])),expectedLocations);
  for(const label of initial.labels) {
    assert.equal(label.color,'rgb(255, 255, 255)'); assert.equal(label.stroke,'rgb(0, 0, 0)'); assert.equal(label.strokeWidth,'2px');
    assert.ok(label.borders.every(n=>n==='0px')); assert.equal(label.background,'rgba(0, 0, 0, 0)'); assert.equal(label.image,'none'); assert.equal(label.shadow,'none'); assert.equal(label.pointerEvents,'none');
  }
  const canvas=await page.$('.scene3d-canvas'),r=await canvas.boundingBox(),x=r.x+r.width*.5,y=r.y+r.height*.55;
  await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+Math.min(65,r.width*.15),y+4,{steps:12}); await page.mouse.up(); await frames(page,650);
  const orbit=await locationSample(page);
  const moved=(a,b)=>a.labels.some(n=>{const next=b.labels.find(v=>v.id===n.id);return n.visible&&next?.visible&&Math.hypot(n.x-next.x,n.y-next.y)>1;});
  assert.ok(moved(initial,orbit),'Main labels follow actual orbit');
  await page.mouse.move(x,y); await page.mouse.wheel({deltaY:-120}); await frames(page,500);
  const zoom=await locationSample(page); assert.ok(moved(orbit,zoom),'Main labels follow actual wheel zoom');
  assert.notEqual(zoom.diagnostics.renderer.cameraView.zoom,orbit.diagnostics.renderer.cameraView.zoom);
  await artifact(dir,'main-labels-orbit-zoom.json',{orbit,zoom}); await page.screenshot({path:path.join(dir,'main-labels-zoom.png')});
  assert.equal(zoom.diagnostics.renderer.selectedNpcId,null); assert.equal(await page.$('.scene3d-npc-selection'),null);
}

export async function npcFocusBrowser({ browser, server, directory, buildId, lanes = [
  { style: 0, width: 1280, height: 900, quality: 'balanced', widthVariant: true }, { style: 1, width: 1280, height: 900, quality: 'low' },
  { style: 0, width: 390, height: 844, quality: 'low' }, { style: 1, width: 390, height: 844, quality: 'low' },
], quality }) {
  assert.ok(directory && path.isAbsolute(directory), 'Provide an absolute evidence directory');
  const pointer = await json(path.join(server.root, 'assets/sect3d/current.json'));
  if (buildId) assert.equal(pointer.buildId, buildId); buildId = pointer.buildId;
  const before = await identity(server.root), results = [];
  await artifact(directory, 'source-before.json', before);
  for (const lane of lanes) {
    const laneQuality = quality || lane.quality || 'low';
    const label = `style${lane.style}-${lane.width}x${lane.height}-${laneQuality}`, channel = `npc-focus-${label}`, dir = path.join(directory, label);
    const session = await newGameContext(browser, server, { payload: await json(path.join(workspace, 'tests/scene3d/fixtures/saves/library.json')), channel, style: lane.style, viewport: { width: lane.width, height: lane.height, deviceScaleFactor: 1 }, scene3dPreferences: { enabled: true, quality: laneQuality } });
    const { page } = session; let cdp;
    try {
      await startGame(session, server);
      await page.waitForFunction(() => GameSceneBridge.getDiagnostics().readyScene === 'library' && GameSceneBridge.getDiagnostics().renderer?.npc?.cards > 0, { timeout: 120000 });
      cdp = await installObservation(page, buildId); await frames(page, 250);
      const sample = async name => { const value = await page.evaluate(() => __npcFocusSample()); await artifact(dir, `${name}.json`, value); await page.screenshot({ path: path.join(dir, `${name}.png`) }); return value; };
      const initial = await sample('initial'), initialDirection = direction(initial.diagnostics.renderer.cameraView), id = initial.residents[0].gameNpcId;
      assert.equal(await page.$$eval('.scene3d-location-label',ns=>ns.length),0,'Main labels absent inside library');
      assert.equal(initial.diagnostics.renderer.selectedNpcId,null); assert.equal(initial.diagnostics.renderer.focusingNpc,false);
      const r = initial.canvas.rect, x = r.left + r.width * .55, y = r.top + r.height * .58;
      await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x + Math.min(65,r.width*.12),y,{steps:12}); await page.mouse.up(); await frames(page, 800);
      const dragged = await sample('dragged');
      assert.ok(distance(direction(dragged.diagnostics.renderer.cameraView), initialDirection) > .015, 'Real drag changes the initial camera azimuth');
      assert.equal(dragged.trace.calls.length, 0, 'Drag must not emit an NPC intent');
      const attempts = await realNpcClick(page,id); await artifact(dir,'click-attempts.json',attempts);
      const opened = await sample('settled-menu'); await frames(page,1000); const settled = await sample('menu-plus-one-second');
      assert.ok(settled.overlay && settled.overlay.display !== 'none' && settled.overlay.visibility === 'visible' && Number(settled.overlay.opacity) > .95, 'Owned menu remains actually visible after native click and one second');
      assert.ok(!settled.original.className.split(/\s+/).includes('show'), 'Legacy popup remains closed');
      assert.equal(settled.frame.position,'absolute','Both themes must enable absolute ink-frame positioning');
      assert.ok(settled.overlay.borders.every(n=>n==='0px'),'Owned full-viewport layer must not inherit legacy popup borders');
      assert.equal(settled.overlay.background,'none','Owned viewport layer must not paint legacy popup texture');
      assert.ok(settled.frame.before.content!=='none'&&settled.frame.before.display!=='none'&&decodeURI(settled.frame.before.background).includes('框选2.png'),'Visible ::before uses original ink-ring artwork');
      assert.ok(settled.frame.rect.width > 0 && settled.frame.rect.height > 0 && settled.frame.rect.left < settled.canvas.rect.right && settled.frame.rect.right > settled.canvas.rect.left && settled.frame.rect.top < settled.canvas.rect.bottom, 'Ink frame is laid out inside scene');
      for (const button of settled.buttons) {
        assert.ok(button.rect.width > 0 && button.rect.height > 0 && button.visibility === 'visible' && button.display !== 'none' && button.pointerEvents !== 'none', `Action is visibly laid out and pointer-enabled: ${button.text}`);
        assert.ok(button.centerTarget?.includes('npc-selection-option'), `Action center is not clipped or covered: ${button.text}`);
      }
      assertFraming(settled,id,initialDirection);
      assert.equal(settled.diagnostics.renderer.npc.outline.selectedNpcId,id);
      assert.equal(settled.diagnostics.renderer.npc.outline.mode,'alpha-contour');
      await artifact(dir,'description.json',await assertDescription(page));
      assert.ok(settled.trace.focusTransitions.some(t=>t.focusingNpc&&t.selectedNpcId===id&&!t.overlay),'Focus tween precedes the owned overlay');
      assert.ok(settled.diagnostics.snapshot.blockReasons.includes('scene-menu'));
      assert.equal(settled.diagnostics.snapshot.interactive,false); assert.equal(settled.diagnostics.snapshot.renderEnabled,true);
      assert.equal(settled.diagnostics.renderer.interactionEnabled,false); assert.equal(settled.diagnostics.renderer.renderEnabled,true);
      assert.ok(settled.diagnostics.renderer.frames > opened.diagnostics.renderer.frames, 'NPC menu must keep rendering');
      const resident = settled.residents.find(n => n.gameNpcId === id), a = resident.anchor, canvas = settled.canvas.rect;
      const fraction = a.height / canvas.height, visibleAlphaFraction = fraction * resident.alpha.heightRatio;
      assert.ok(fraction >= .25 && fraction <= 1/3, `Card height must occupy 1/4–1/3 of scene: ${fraction}`);
      assert.ok(visibleAlphaFraction >= .25 && visibleAlphaFraction <= 1/3, `Actual alpha silhouette height must occupy 1/4–1/3: ${visibleAlphaFraction}`);
      assert.ok(Math.abs(a.left+a.width/2-(canvas.left+canvas.width/2)) <= 2, 'Focused card is horizontally centered');
      assert.ok(Math.abs(a.top+a.height/2-(canvas.top+canvas.height/2)) <= 2, 'Focused card is vertically centered');
      assert.ok(distance(direction(settled.diagnostics.renderer.cameraView),initialDirection)<.002, 'Focus restores original room camera direction after drag');
      assert.ok(settled.trace.pointers.filter(e=>e.type==='pointerdown'||e.type==='pointerup').every(e=>e.trusted));
      assert.equal(settled.trace.calls.at(-1).event.type,'npcIntent');
      const resizedViewport={width:lane.width>600?1060:430,height:lane.height>850?780:920,deviceScaleFactor:1};
      await page.setViewport(resizedViewport); await frames(page,650); const resized=await sample('resized-menu'); assertFraming(resized,id,initialDirection);
      await page.setViewport({width:lane.width,height:lane.height,deviceScaleFactor:1}); await frames(page,650); assertFraming(await sample('restored-size-menu'),id,initialDirection);
      if (lane.widthVariant) {
        const prose=await page.evaluate(()=>Object.entries(npcs).map(([id,n])=>({id,text:n.description}))), matrix=[];
        for (const width of [953,729,390]) {
          await page.setViewport({width,height:900,deviceScaleFactor:1}); await frames(page,100);
          for (const entry of prose) {
            await page.evaluate(text=>{document.querySelector('.scene3d-npc-selection .npc-selection-desc').textContent=text; dispatchEvent(new Event('resize'));},entry.text);
            await frames(page,30); matrix.push({width,id:entry.id,...await assertDescription(page)});
          }
        }
        await artifact(dir,'description-all-npcs-width-matrix.json',matrix);
        await page.setViewport({width:lane.width,height:lane.height,deviceScaleFactor:1});
        await page.evaluate(id=>{document.querySelector('.scene3d-npc-selection .npc-selection-desc').textContent=npcs[id].description; dispatchEvent(new Event('resize'));},id); await frames(page,150);
      }
      await emptyClick(page);
      // Observe synchronously in the native event, not 100ms later: software GPU
      // scheduling can delay the next automation task beyond the whole tween.
      const returning=await page.evaluate(()=>__npcFocusTrace.returnTransitions.at(-1));
      assert.equal(returning?.returning,true,'Dismissal arms an animation rather than jumping');
      assert.equal(returning.outline,null,'Gold contour clears immediately');
      assert.ok(Math.abs(returning.zoom-settled.diagnostics.renderer.cameraView.zoom)<.001,'Camera starts return at the focused zoom without a jump');
      await assertClosed(page,initial.diagnostics.renderer.cameraView); await sample('empty-click-closed');
      await realNpcClick(page,id); await page.keyboard.press('Escape'); await assertClosed(page,initial.diagnostics.renderer.cameraView); await sample('escape-closed');
      await realNpcClick(page,id);
      const labels = await page.$$eval(`${overlay} .npc-selection-option`, ns=>ns.map(n=>({text:n.textContent,disabled:n.disabled})));
      assert.equal(labels.length,3);
      assert.ok(labels.some(n=>n.text.includes('送礼')) && labels.some(n=>n.text.includes('切磋')) && labels.some(n=>n.text.includes('互动')), 'All three NPC action affordances present in both themes');
      await clickAction(page,'互动'); await page.waitForSelector('#interaction-input',{visible:true});
      assert.equal(await page.evaluate(()=>currentInteractionNpc),id); assert.equal(await page.$(overlay),null);
      await frames(page,500); const modal=await sample('interaction-before-cancel');
      assert.equal(modal.diagnostics.snapshot.interactive,false); assert.equal(modal.diagnostics.renderer.interactionEnabled,false); assert.equal(modal.diagnostics.renderer.selectedNpcId,null);
      const callCount=modal.trace.calls.length;
      await page.mouse.click(modal.canvas.rect.right-12,modal.canvas.rect.bottom-12); await frames(page,500);
      assert.equal(await page.evaluate(()=>__npcFocusTrace.calls.length),callCount,'Modal blocks NPC/canvas selection');
      await page.click('#modal-buttons .cancel'); await frames(page,250); await sample('interaction-after-cancel'); await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().renderer.interactionEnabled);
      await realNpcClick(page,id); const money = await page.evaluate(()=>playerStats.金钱); await clickAction(page,'送礼');
      await page.waitForFunction(id=>npcGiftGiven[id]===true,{},id); assert.equal(await page.evaluate(()=>playerStats.金钱),money-500);
      await page.waitForSelector('#modal-buttons button',{visible:true}); await frames(page,500); await page.click('#modal-buttons button');
      await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().renderer.interactionEnabled);
      // Observe original npcAction; replace only its terminal battle-view operation,
      // avoiding an unrelated iframe battle/LLM while preserving original routing.
      await page.evaluate(()=>{window.__npcFocusBattleOriginal=showBattleGame;window.__npcFocusBattleData=null;showBattleGame=data=>{window.__npcFocusBattleData=structuredClone(data);};});
      await realNpcClick(page,id); await clickAction(page,'切磋');
      await page.waitForFunction(id=>currentBattleNpcId===id&&window.__npcFocusBattleData!==null,{},id); assert.equal(await page.$(overlay),null);
      const actionProof=await page.evaluate(()=>({operations:__npcFocusTrace.operations,battleData:__npcFocusBattleData,battleNpc:currentBattleNpcId}));
      await page.evaluate(()=>{showBattleGame=window.__npcFocusBattleOriginal;delete window.__npcFocusBattleOriginal;});
      assert.ok(actionProof.operations.some(o=>o.name==='giveGift'&&o.args.npcId===id));
      for(const action of ['互动','切磋']) assert.ok(actionProof.operations.some(o=>o.name==='npcAction'&&o.args.npcId===id&&o.args.action===action),`Original npcAction receives ${action}`);
      await artifact(dir,'actions.json',{labels,interactionNpc:id,giftSpent:500,...actionProof,fraction,visibleAlphaFraction});
      await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().renderer.interactionEnabled);
      await realNpcClick(page,id); // Route change must dispose an active selection/menu.
      await page.click('#cangjingge-scene .back-btn');
      await verifyMainLabels(page,dir); await sample('main-after-selection');
      if(lane.widthVariant) {
        // Supplemental wide-room route uses the original host navigation action,
        // never direct renderer state and never the bridge's NPC-open method.
        await page.evaluate(()=>goToLocation('houshan'));
        await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().readyScene==='back_mountain'&&GameSceneBridge.getDiagnostics().renderer.interactionEnabled,{timeout:120000}); await frames(page,500);
        const wide=await sample('wide-room-initial'); assert.equal(await page.$$eval('.scene3d-location-label',ns=>ns.length),0,'Main labels removed on wide-room entry');
        const wideNpc=wide.residents.find(n=>n.anchor);
        if(wideNpc) {
          await realNpcClick(page,wideNpc.gameNpcId); const focused=await sample('wide-room-focus'); assertFraming(focused,wideNpc.gameNpcId,direction(wide.diagnostics.renderer.cameraView));
          await page.keyboard.press('Escape'); await assertClosed(page);
        }
        await artifact(dir,'wide-room-scope.json',{scene:'back_mountain',npcFocusExercised:!!wideNpc,reason:wideNpc?'Actual fixture resident focused with trusted click':'No resident with projected anchor in unchanged synthetic fixture; room layout/switch/label removal still verified'});
      }
      assertSessionSafe(session,server,channel); results.push({label,status:'PASS',quality:laneQuality,fraction,visibleAlphaFraction});
    } catch(error) { results.push({label,status:'FAIL',message:error.message}); await artifact(dir,'failure.json',{message:error.message,stack:error.stack}); }
    finally { try { await artifact(dir,'final-diagnostics.json',await page.evaluate(()=>window.__npcFocusSample?.() ?? GameSceneBridge.getDiagnostics())); } catch {} await saveSessionEvidence(session,dir,'final'); await cdp?.detach(); await session.close(); }
  }
  const after = await identity(server.root); await artifact(directory,'source-after.json',after);
  const sourceStable = JSON.stringify(before)===JSON.stringify(after);
  const result = {status:results.every(r=>r.status==='PASS')&&sourceStable?'PASS':'FAIL',buildId,quality,sourceStable,results};
  await artifact(directory,'result.json',result); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let browser,server;
  const directory = process.argv[2];
  try { assert.ok(directory&&path.isAbsolute(directory),'Usage: node tests/scene3d/npc-focus.browser.mjs <absolute evidence dir>'); await mkdir(directory,{recursive:false}); server=await startTestServer({gameRoot:workspace}); browser=await launchBrowser(); const result=await npcFocusBrowser({browser,server,directory}); console.log(JSON.stringify({...result,directory})); if(result.status!=='PASS')process.exitCode=1; }
  catch(error) { console.error(error.stack);process.exitCode=1; }
  finally { await browser?.close();await server?.close(); }
}
