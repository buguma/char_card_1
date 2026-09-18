import { t as INTERIOR_SCENES } from "./chunks/interior-scenes-Lg8DtedF.mjs";
//#region scene3d/src/protocol.js
var PROTOCOL = 1;
var LOCATION_TO_SCENE = Object.freeze({
	tianshanpai: "main",
	map: "main",
	yanwuchang: "training",
	cangjingge: "library",
	huofang: "kitchen",
	houshan: "back_mountain",
	yishiting: "council",
	tiejiangpu: "forge",
	nandizi: "male_quarters",
	nvdizi: "female_quarters",
	shanmen: "gate",
	gongtian: "fields",
	danfang: "alchemy"
});
var SCENE_TO_LOCATION = Object.freeze(Object.fromEntries(Object.entries(LOCATION_TO_SCENE).filter(([id]) => id !== "map").map(([id, scene]) => [scene, id])));
var own = (object, key) => Object.hasOwn(object, key);
var freeze = (value) => {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
};
function invalid(message) {
	const error = new TypeError(message);
	error.code = "PROTOCOL_INVALID";
	throw error;
}
function normalizeSnapshot(input) {
	if (!input || input.protocol !== 1) invalid("Unsupported Scene3D protocol");
	for (const key of ["sessionEpoch", "revision"]) if (!Number.isSafeInteger(input[key]) || input[key] < 0) invalid(`Invalid ${key}`);
	if (!Number.isSafeInteger(input.mode)) invalid("Invalid mode");
	const sceneId = input.sceneId ?? null;
	if (sceneId !== null && !own(SCENE_TO_LOCATION, sceneId)) invalid("Unknown or unavailable scene");
	if (sceneId && (input.mode !== 0 || LOCATION_TO_SCENE[input.logicalPage] !== sceneId || LOCATION_TO_SCENE[input.gameLocationId] !== sceneId)) invalid("Inconsistent route");
	for (const key of [
		"visible",
		"renderEnabled",
		"interactive"
	]) if (typeof input[key] !== "boolean") invalid(`Invalid ${key}`);
	const residents = (input.residents ?? []).map((item) => {
		if (!/^[A-O]$/.test(item.gameNpcId) || item.visible === false) invalid("Inconsistent resident");
		return {
			gameNpcId: item.gameNpcId,
			displayName: String(item.displayName ?? "")
		};
	});
	const ids = new Set(residents.map((item) => item.gameNpcId));
	if (ids.size !== residents.length) invalid("Duplicate residents");
	const renderedNpcs = (input.renderedNpcs ?? []).map((item) => {
		if (!ids.has(item.gameNpcId) || ![
			"static",
			"animated",
			"atlas"
		].includes(item.visualKind)) invalid("Inconsistent rendered NPC");
		return {
			gameNpcId: item.gameNpcId,
			displayName: String(item.displayName ?? residents.find((resident) => resident.gameNpcId === item.gameNpcId)?.displayName ?? item.gameNpcId),
			visualKind: item.visualKind,
			visualKey: String(item.visualKey ?? ""),
			portraitUrl: String(item.portraitUrl ?? ""),
			heightMeters: Number.isFinite(item.heightMeters) && item.heightMeters > 0 && item.heightMeters < 10 ? item.heightMeters : 1.5
		};
	});
	if (renderedNpcs.length > 3 || new Set(renderedNpcs.map((item) => item.gameNpcId)).size !== renderedNpcs.length) invalid("Invalid rendered subset");
	const env = input.environment ?? {};
	return freeze({
		protocol: 1,
		sessionEpoch: input.sessionEpoch,
		revision: input.revision,
		mode: input.mode,
		logicalPage: String(input.logicalPage ?? "other"),
		gameLocationId: String(input.gameLocationId ?? ""),
		sceneId,
		environment: {
			season: [
				"spring",
				"summer",
				"autumn",
				"winter"
			].includes(env.season) ? env.season : "winter",
			hour: Number.isFinite(env.hour) && env.hour >= 0 && env.hour < 24 ? env.hour : 12,
			timeSource: String(env.timeSource ?? "dayNightFallback")
		},
		residents,
		renderedNpcs,
		layoutKey: String(input.layoutKey ?? `${input.sessionEpoch}:${sceneId}:${renderedNpcs.map((n) => n.gameNpcId).join(",")}`),
		visible: input.visible,
		renderEnabled: input.renderEnabled,
		interactive: input.interactive,
		blockReasons: (input.blockReasons ?? []).map(String)
	});
}
function applyResult(status, snapshot) {
	return Object.freeze({
		status,
		epoch: snapshot?.sessionEpoch ?? null,
		revision: snapshot?.revision ?? null,
		sceneId: snapshot?.sceneId ?? null
	});
}
function compareVersion(a, b) {
	return a.sessionEpoch === b.sessionEpoch ? Math.sign(a.revision - b.revision) : Math.sign(a.sessionEpoch - b.sessionEpoch);
}
function normalizeAssetBase(value) {
	if (typeof value !== "string" || !value) invalid("assetBaseUrl must be explicit and absolute");
	let url;
	try {
		url = new URL(value);
	} catch {
		invalid("assetBaseUrl must be absolute");
	}
	if (![
		"http:",
		"https:",
		"file:",
		"capacitor:"
	].includes(url.protocol) || url.search || url.hash || url.username || url.password) invalid("Invalid asset base URL");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}
function semanticLocation(object) {
	for (let node = object; node; node = node.parent) {
		const id = node.userData?.interactionId;
		if (id) return node.userData.clickable === true && own(SCENE_TO_LOCATION, id) && id !== "main" ? SCENE_TO_LOCATION[id] : null;
	}
	return null;
}
function clientAnchor(point, rect) {
	if (!rect.width || !rect.height || point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return null;
	return Object.freeze({
		space: "client-css-px",
		left: rect.left + (point.x + 1) * rect.width / 2,
		top: rect.top + (1 - point.y) * rect.height / 2,
		width: 0,
		height: 0
	});
}
//#endregion
//#region scene3d/src/resources.js
function createResourceRegistry() {
	const roots = /* @__PURE__ */ new Map(), refs = /* @__PURE__ */ new Map(), disposed = /* @__PURE__ */ new WeakSet();
	const totals = {
		registered: 0,
		disposed: 0
	};
	function resourcesOf(root) {
		const found = /* @__PURE__ */ new Set();
		const inspect = (value) => {
			if (value?.isTexture) {
				found.add(value);
				for (const image of [].concat(value.source?.data || value.image || [])) if (typeof image?.close === "function") found.add(image);
			} else if (Array.isArray(value)) value.forEach(inspect);
		};
		root?.traverse?.((object) => {
			if (object.geometry) found.add(object.geometry);
			if (object.skeleton) found.add(object.skeleton);
			for (const material of [].concat(object.material || [])) {
				found.add(material);
				Object.values(material).forEach(inspect);
				for (const uniform of Object.values(material.uniforms || {})) inspect(uniform?.value);
			}
		});
		return found;
	}
	function track(root) {
		if (!root) return root;
		let owned = roots.get(root);
		if (!owned) {
			owned = /* @__PURE__ */ new Set();
			roots.set(root, owned);
		}
		for (const resource of resourcesOf(root)) if (!owned.has(resource)) {
			owned.add(resource);
			refs.set(resource, (refs.get(resource) || 0) + 1);
			totals.registered++;
		}
		return root;
	}
	function release(root) {
		if (!roots.has(root)) return;
		track(root);
		const owned = roots.get(root);
		roots.delete(root);
		root.removeFromParent?.();
		for (const resource of owned) {
			const count = refs.get(resource) - 1;
			if (count > 0) {
				refs.set(resource, count);
				continue;
			}
			refs.delete(resource);
			if (disposed.has(resource)) continue;
			disposed.add(resource);
			try {
				resource.dispose?.();
			} catch {}
			if (!resource.isTexture) try {
				resource.close?.();
			} catch {}
			totals.disposed++;
		}
	}
	return {
		track,
		release,
		dispose() {
			for (const root of [...roots.keys()]) release(root);
		},
		snapshot() {
			let geometries = 0, materials = 0, textures = 0;
			for (const resource of refs.keys()) {
				if (resource.isBufferGeometry) geometries++;
				if (resource.isMaterial) materials++;
				if (resource.isTexture) textures++;
			}
			return Object.freeze({
				roots: roots.size,
				resources: refs.size,
				geometries,
				materials,
				textures,
				...totals
			});
		}
	};
}
function createListenerRegistry() {
	const disposers = /* @__PURE__ */ new Set();
	return {
		listen(target, type, handler, options) {
			target.addEventListener(type, handler, options);
			const remove = () => {
				target.removeEventListener(type, handler, options);
				disposers.delete(remove);
			};
			disposers.add(remove);
			return remove;
		},
		dispose() {
			for (const remove of [...disposers]) remove();
		},
		get size() {
			return disposers.size;
		}
	};
}
//#endregion
//#region scene3d/src/navigation.js
function createNavigation({ load, activate, deactivate, release, onStart = () => {}, onError = () => {} }) {
	let generation = 0, task = null, main = null, room = null, active = null, destroyed = false;
	let failedKey = null, committedKey = null;
	const keyOf = (id, epoch) => `${epoch}:${id}`;
	function cancel() {
		generation++;
		committedKey = null;
		if (task) {
			task.controller.abort();
			task = null;
		}
	}
	function drop(record) {
		if (!record) return;
		if (active === record) {
			deactivate(record);
			active = null;
		}
		release(record);
	}
	function navigate(id, epoch, { force = false } = {}) {
		if (destroyed) return Promise.resolve("destroyed");
		const key = keyOf(id, epoch);
		if (!force && task?.key === key) return task.promise;
		if (!force && failedKey === key) return Promise.resolve("degraded");
		if (!force && active?.id === id && committedKey === key) return Promise.resolve("applied");
		cancel();
		failedKey = null;
		committedKey = null;
		const token = generation, controller = new AbortController();
		const valid = () => !destroyed && token === generation && !controller.signal.aborted;
		onStart(id);
		if (room && room.id !== id && id !== "main") {
			const old = room;
			room = null;
			drop(old);
		}
		const run = {
			key,
			controller,
			promise: null
		};
		task = run;
		let abortResolve;
		const aborted = new Promise((resolve) => {
			abortResolve = resolve;
		});
		controller.signal.addEventListener("abort", () => abortResolve(destroyed ? "destroyed" : "superseded"), { once: true });
		const work = (async () => {
			let candidate = null;
			try {
				if (!main) {
					candidate = await load("main", controller.signal);
					if (!valid()) return destroyed ? "destroyed" : "superseded";
					main = candidate;
					candidate = null;
				}
				if (!valid()) return destroyed ? "destroyed" : "superseded";
				let record = main;
				if (id !== "main") {
					if (!room || room.id !== id) {
						candidate = await load(id, controller.signal);
						if (!valid()) return destroyed ? "destroyed" : "superseded";
						room = candidate;
						candidate = null;
					}
					record = room;
				}
				if (active && active !== record) deactivate(active);
				active = record;
				record.epoch = epoch;
				await activate(record, valid);
				if (!valid()) return destroyed ? "destroyed" : "superseded";
				committedKey = key;
				return "applied";
			} catch (error) {
				if (!valid()) return destroyed ? "destroyed" : "superseded";
				failedKey = key;
				if (active) {
					deactivate(active);
					active = null;
				}
				if (room) {
					const old = room;
					room = null;
					release(old);
				}
				onError(error, id);
				return "degraded";
			} finally {
				if (candidate) release(candidate);
				if (task === run) task = null;
			}
		})();
		run.promise = Promise.race([work, aborted]);
		return run.promise;
	}
	return {
		navigate,
		cancel,
		dispose() {
			if (destroyed) return;
			destroyed = true;
			cancel();
			if (active) {
				deactivate(active);
				active = null;
			}
			if (room) release(room);
			if (main) release(main);
			main = room = null;
		},
		get active() {
			return active;
		},
		get busy() {
			return Boolean(task);
		},
		get generation() {
			return generation;
		},
		snapshot() {
			return Object.freeze({
				routeGeneration: generation,
				pending: Number(Boolean(task)),
				cachedMain: Number(Boolean(main)),
				cachedRooms: Number(Boolean(room)),
				activeSceneId: active?.id ?? null
			});
		}
	};
}
//#endregion
//#region scene3d/src/runtime.js
var instances = /* @__PURE__ */ new WeakMap();
var nextInstance = 0;
var dependencies;
function importDependencies() {
	if (!dependencies) dependencies = Promise.all([
		import("./chunks/three.module-DEUH6-St.mjs"),
		import("./chunks/OrbitControls-B62UhULX.mjs"),
		import("./chunks/GLTFLoader-DpM_B4sa.mjs"),
		import("./chunks/DRACOLoader-CYkkE_hg.mjs"),
		import("./chunks/environment-CbngW-tM.mjs"),
		import("./chunks/npcs-DCWZWqud.mjs")
	]).catch((error) => {
		dependencies = null;
		throw error;
	});
	return dependencies;
}
var noopNpc = () => ({
	bind() {},
	update() {},
	tick() {},
	pick() {
		return null;
	},
	dispose() {}
});
function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
function diagnosticSnapshot(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (!value || typeof value !== "object" || seen.has(value)) return null;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
	seen.add(value);
	const copy = Array.isArray(value) ? value.map((item) => diagnosticSnapshot(item, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnosticSnapshot(item, seen)]));
	seen.delete(value);
	return Object.freeze(copy);
}
/** Three 0.185.1 compileAsync owns uncancellable timers over disposable materials.
* Use its public compile submission and the same KHR readiness query, but own
* every continuation. Never retain GPU resources merely to keep a poll alive.
* properties/currentProgram is a version-pinned Three adapter, not a stable API.
*/
function createCompileLifecycle(renderer, clock, { timeoutMs = 3e4 } = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Compile timeout must be finite and positive");
	let active = null, disposed = false;
	const stats = {
		started: 0,
		completed: 0,
		cancelled: 0,
		failed: 0
	};
	function cancel() {
		active?.finish(false);
	}
	function compile(scene, camera, valid = () => true) {
		cancel();
		if (disposed || !valid()) return Promise.resolve(false);
		return new Promise((resolve, reject) => {
			let timer = null, done = false, materials = /* @__PURE__ */ new Set(), elapsed = 0;
			const observed = /* @__PURE__ */ new Set();
			const onDispose = () => finish(false);
			function finish(result, error) {
				if (done) return;
				done = true;
				if (timer !== null) clock.clearTimeout(timer);
				timer = null;
				for (const material of observed) material.removeEventListener("dispose", onDispose);
				observed.clear();
				materials.clear();
				if (active?.finish === finish) active = null;
				if (error) {
					stats.failed++;
					reject(error);
				} else {
					stats[result ? "completed" : "cancelled"]++;
					resolve(result);
				}
			}
			active = {
				finish,
				get timer() {
					return timer;
				},
				get materials() {
					return observed.size;
				}
			};
			stats.started++;
			function poll() {
				timer = null;
				if (done) return;
				try {
					if (disposed || !valid()) {
						finish(false);
						return;
					}
					if (renderer.getContext().isContextLost()) throw failure("COMPILE_CONTEXT_LOST", "Context lost during shader compilation");
					for (const material of materials) {
						const program = renderer.properties.has(material) && renderer.properties.get(material).currentProgram;
						if (!program?.program || typeof program.isReady !== "function") throw failure("COMPILE_PROGRAM_MISSING", "Compiled material program was released or is unavailable");
						if (program.isReady()) materials.delete(material);
					}
					if (!materials.size) {
						finish(true);
						return;
					}
					if (elapsed >= timeoutMs) throw failure("COMPILE_TIMEOUT", "Shader compilation timeout");
					elapsed += 10;
					timer = clock.setTimeout(poll, 10);
				} catch (error) {
					finish(false, error);
				}
			}
			try {
				const submitted = renderer.compile(scene, camera);
				if (done) return;
				if (disposed || !valid()) {
					finish(false);
					return;
				}
				if (renderer.getContext().isContextLost()) throw failure("COMPILE_CONTEXT_LOST", "Context lost during shader compilation");
				if (!(submitted instanceof Set)) throw failure("COMPILE_API_CHANGED", "Expected Three compile() to return Set<Material>");
				materials = new Set(submitted);
				for (const material of materials) {
					material.addEventListener("dispose", onDispose);
					observed.add(material);
				}
				if (renderer.extensions.get("KHR_parallel_shader_compile") === null) finish(true);
				else poll();
			} catch (error) {
				finish(false, error);
			}
		});
	}
	return {
		compile,
		cancel,
		dispose() {
			disposed = true;
			cancel();
		},
		snapshot() {
			return Object.freeze({
				...stats,
				pending: Number(Boolean(active)),
				timers: Number(active?.timer != null),
				materialListeners: active?.materials || 0,
				disposed
			});
		}
	};
}
/** Import and mount never initialize WebGL. The first visible applyState does.
* npcFactory is an internal renderer extension, not a business-state owner.
*/
function mount(container, options = {}) {
	options = { ...options };
	for (const key of ["mainTimeoutMs", "roomTimeoutMs"]) if (options[key] !== void 0 && (!Number.isFinite(options[key]) || options[key] <= 0)) throw new TypeError(`Invalid ${key}`);
	if (!container?.appendChild || !container.ownerDocument) throw new TypeError("Scene3D requires a DOM container");
	if (instances.has(container)) throw new Error("A Scene3D instance already owns this container");
	if (options.protocol !== void 0 && options.protocol !== 1) throw new TypeError("Unsupported Scene3D protocol");
	const assetBaseUrl = normalizeAssetBase(options.assetBaseUrl);
	if (options.quality !== void 0 && !["low", "balanced"].includes(options.quality)) throw new TypeError("Unknown quality");
	const doc = container.ownerDocument, win = doc.defaultView;
	const instanceId = ++nextInstance, registry = createResourceRegistry(), listeners = createListenerRegistry();
	const api = { metrics: {} }, decoders = /* @__PURE__ */ new Set(), requests = /* @__PURE__ */ new Set();
	let latest = null, destroyed = false, destroyPromise, initializing = null, initializeFailure = null;
	let visible = false, renderEnabled = false, interactive = false, ready = false;
	let renderer, scene, camera, controls, environment, cinematic, atmosphere, navigation, THREE, sun, observer, shell, back, reset;
	let npc = noopNpc(), lastNpcStats = null, activeRecord = null, appliedVersion = null, readyKey = null, drawable = false;
	let raf = 0, lastFrame = 0, width = 0, height = 0, frameWaiters = /* @__PURE__ */ new Set(), motionReduced = false;
	let gesture = null, pointers = /* @__PURE__ */ new Set(), quality = options.quality || "low", qualityFallback = false;
	const counters = {
		frames: 0,
		rendererCreated: 0,
		rendererDisposed: 0,
		modelRequests: 0,
		pendingLoads: 0,
		errors: 0,
		attempts: 0,
		npcErrors: 0
	};
	let initializationSerial = 0, compiler = null, lastCompileStats = null;
	function emit(type, detail = {}, snapshot = latest) {
		if (destroyed || !snapshot) return;
		try {
			options.onEvent?.(Object.freeze({
				type,
				epoch: snapshot.sessionEpoch,
				revision: snapshot.revision,
				...detail
			}));
		} catch {}
	}
	function emitError(error, sceneId = latest?.sceneId) {
		counters.errors++;
		emit("error", {
			scope: "scene",
			code: error?.code || "RENDER_FAILED",
			message: String(error?.message || error || "Scene rendering failed"),
			retryable: true,
			sceneId
		});
	}
	function eligible() {
		return !destroyed && visible && latest?.mode === 0 && Boolean(latest.sceneId) && !doc.hidden && width > 0 && height > 0;
	}
	function canDraw() {
		return eligible() && renderEnabled && drawable && Boolean(renderer && activeRecord);
	}
	function canInteract() {
		return eligible() && renderEnabled && interactive && !latest?.blockReasons.length && ready && !navigation?.busy;
	}
	function flushGestures() {
		pointers.clear();
		gesture = null;
	}
	function syncInput() {
		const enabled = canInteract();
		if (controls) controls.enabled = enabled;
		if (!enabled) flushGestures();
		if (back) {
			back.hidden = !latest?.sceneId || latest.sceneId === "main";
			back.disabled = !enabled;
		}
		if (reset) reset.disabled = !enabled;
		if (shell) {
			shell.hidden = !visible || !latest?.sceneId;
			shell.dataset.state = destroyed ? "destroyed" : ready ? "ready" : initializeFailure ? "degraded" : "loading";
		}
	}
	function stopFrames() {
		if (raf) win.cancelAnimationFrame(raf);
		raf = 0;
		lastFrame = 0;
	}
	function wakeWaiters() {
		for (const resolve of frameWaiters) resolve();
		frameWaiters.clear();
	}
	function schedule() {
		syncInput();
		if (!canDraw()) {
			stopFrames();
			return;
		}
		if (!raf) raf = win.requestAnimationFrame(frame);
	}
	function dropPostprocessing() {
		cinematic?.dispose();
		atmosphere?.dispose();
		cinematic = atmosphere = null;
		if (renderer) {
			renderer.toneMapping = THREE.AgXToneMapping;
			renderer.setPixelRatio(1);
			renderer.shadowMap.enabled = false;
		}
		quality = "low";
		qualityFallback = true;
		api.metrics.atmosphere = false;
		environment?.refreshAtmosphere(false);
	}
	function draw(delta) {
		if (cinematic) try {
			cinematic.setFocus(controls.target);
			cinematic.render(delta);
		} catch (error) {
			if (qualityFallback) throw error;
			dropPostprocessing();
			resize();
			renderer.render(scene, camera);
		}
		else renderer.render(scene, camera);
		counters.frames++;
	}
	function frame(now) {
		raf = 0;
		if (!canDraw()) return;
		const delta = lastFrame ? Math.min((now - lastFrame) / 1e3, .1) : 0;
		lastFrame = now;
		try {
			if (canInteract()) controls.update(delta);
			environment?.tick(motionReduced ? 0 : delta);
			try {
				npc.tick?.(now, motionReduced ? 0 : delta);
			} catch {
				counters.npcErrors++;
			}
			draw(motionReduced ? 0 : delta);
		} catch (error) {
			ready = false;
			renderEnabled = false;
			initializeFailure = error;
			cancelNavigation();
			wakeWaiters();
			emitError(error);
			syncInput();
			return;
		}
		wakeWaiters();
		schedule();
	}
	async function firstFrame(valid) {
		while (valid()) {
			if (canDraw()) {
				draw(0);
				return;
			}
			await new Promise((resolve) => frameWaiters.add(resolve));
		}
	}
	function fit(record = activeRecord) {
		if (!camera || !width || !height) return;
		const aspect = width / height;
		if (record && record.id !== "main") {
			const diagonal = Math.hypot(record.size.x, record.size.z);
			const span = Math.max((diagonal + record.size.y) / Math.SQRT2, diagonal / aspect) * 1.3;
			camera.left = -span * aspect / 2;
			camera.right = span * aspect / 2;
			camera.top = span / 2;
			camera.bottom = -span / 2;
		} else {
			const span = 40 * Math.max(1, 1.36 / aspect), offset = aspect > 1 ? -1.2 : 0;
			camera.left = -span * aspect / 2;
			camera.right = span * aspect / 2;
			camera.top = span / 2 + offset;
			camera.bottom = -span / 2 + offset;
		}
		camera.updateProjectionMatrix();
	}
	function resize() {
		if (destroyed) return;
		width = Math.max(0, container.clientWidth || 0);
		height = Math.max(0, container.clientHeight || 0);
		if (renderer && width && height) {
			fit();
			renderer.setSize(width, height, false);
			cinematic?.resize(width, height);
		}
		wakeWaiters();
		schedule();
	}
	function resetView() {
		if (!canInteract() || !activeRecord) return false;
		positionCamera(activeRecord);
		fit();
		return true;
	}
	function positionCamera(record) {
		controls.enableDamping = false;
		controls.update();
		controls.autoRotate = false;
		controls.enablePan = record.id === "main";
		controls.zoomToCursor = false;
		controls.minZoom = .5;
		controls.maxZoom = 5;
		controls.minPolarAngle = record.id === "main" ? .12 : Math.PI / 4;
		controls.maxPolarAngle = record.id === "main" ? Math.PI / 2 - .08 : Math.PI / 4;
		if (record.id === "main") {
			camera.position.set(18, 53, 45);
			controls.target.set(0, 7.5, -3);
		} else {
			camera.position.copy(record.position);
			controls.target.copy(record.target);
		}
		camera.zoom = 1;
		camera.updateProjectionMatrix();
		controls.update();
		camera.updateMatrixWorld(true);
		controls.enableDamping = !motionReduced;
	}
	function invalidateNpc() {
		compiler?.cancel();
		try {
			Promise.resolve(npc.bind?.(null, null, latest || void 0)).catch(() => {
				counters.npcErrors++;
			});
		} catch {
			counters.npcErrors++;
		}
	}
	function cancelNavigation() {
		navigation?.cancel();
		invalidateNpc();
	}
	function projectEnvironment() {
		if (!environment || !latest) return;
		environment.setAutoTime?.(false);
		environment.setSeason(latest.environment.season);
		environment.setTime(latest.environment.hour);
		cinematic?.setTime(latest.environment.hour);
		try {
			npc.update?.(latest);
		} catch {
			counters.npcErrors++;
		}
	}
	function emitNpcIntent(gameNpcId, anchor) {
		if (gameNpcId && typeof gameNpcId === "object") ({gameNpcId, anchor} = gameNpcId);
		if (!canInteract() || !latest.renderedNpcs.some((n) => n.gameNpcId === gameNpcId)) return false;
		if (anchor?.space !== "client-css-px" || ![
			"left",
			"top",
			"width",
			"height"
		].every((k) => Number.isFinite(anchor[k]))) return false;
		emit("npcIntent", {
			gameNpcId,
			anchor: Object.freeze({ ...anchor })
		});
		return true;
	}
	function installInput() {
		const canvas = renderer.domElement;
		const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
		listeners.listen(canvas, "pointerdown", (event) => {
			if (!canInteract()) return;
			pointers.add(event.pointerId);
			if (pointers.size > 1 && gesture) gesture.multiple = true;
			if (pointers.size === 1) gesture = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				time: event.timeStamp,
				button: event.button,
				moved: false,
				multiple: false
			};
		});
		listeners.listen(canvas, "pointermove", (event) => {
			if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true;
		});
		listeners.listen(canvas, "pointerup", (event) => {
			const press = gesture;
			pointers.delete(event.pointerId);
			if (!pointers.size) gesture = null;
			if (!canInteract() || !press || press.id !== event.pointerId || press.button !== 0 || press.moved || press.multiple || event.timeStamp - press.time > 700 || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
			const rect = canvas.getBoundingClientRect();
			if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
			let npcHit;
			try {
				npcHit = npc.pick?.(event.clientX, event.clientY);
			} catch {
				counters.npcErrors++;
			}
			if (npcHit && emitNpcIntent(npcHit.gameNpcId, npcHit.anchor)) return;
			if (activeRecord?.id !== "main") return;
			pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
			raycaster.setFromCamera(pointer, camera);
			const hit = raycaster.intersectObject(activeRecord.root, true)[0];
			const locationId = hit && semanticLocation(hit.object);
			if (!locationId) return;
			const anchor = clientAnchor(hit.point.clone().project(camera), rect);
			if (anchor) emit("locationIntent", {
				locationId,
				anchor
			});
		});
		const cancel = (event) => {
			pointers.delete(event.pointerId);
			if (gesture) gesture.multiple = true;
			if (!pointers.size) gesture = null;
		};
		listeners.listen(canvas, "pointercancel", cancel);
		listeners.listen(canvas, "lostpointercapture", cancel);
		listeners.listen(canvas, "pointerleave", (event) => {
			if (!event.buttons) cancel(event);
		});
		listeners.listen(canvas, "webglcontextlost", (event) => {
			event.preventDefault();
			emitError(failure("CONTEXT_LOST", "WebGL context lost"));
			destroy();
		});
		listeners.listen(back, "click", () => {
			if (canInteract() && activeRecord.id !== "main") emit("returnIntent");
		});
		listeners.listen(reset, "click", resetView);
	}
	function releaseRecord(record) {
		if (!record || record.released) return;
		record.released = true;
		if (record.prepared && record.id !== "main") environment?.releaseInterior(record.root);
		for (const root of record.roots) registry.release(root);
	}
	function deactivate(record) {
		record.root.visible = false;
		if (activeRecord !== record) return;
		activeRecord = null;
		ready = false;
		invalidateNpc();
		environment?.setInterior(null);
		stopFrames();
		syncInput();
	}
	async function loadModel(id, routeSignal) {
		const controller = new AbortController(), signal = controller.signal;
		const abort = () => controller.abort(routeSignal.reason);
		routeSignal.addEventListener("abort", abort, { once: true });
		if (routeSignal.aborted) abort();
		const timeoutMs = id === "main" ? options.mainTimeoutMs ?? 3e4 : options.roomTimeoutMs ?? 6e4;
		let timedOut = false;
		const timer = win.setTimeout(() => {
			timedOut = true;
			controller.abort(failure("MODEL_TIMEOUT", "Model timeout"));
		}, timeoutMs);
		requests.add(controller);
		counters.pendingLoads++;
		counters.modelRequests++;
		let requestFinished = false;
		function finishRequest() {
			if (requestFinished) return;
			requestFinished = true;
			win.clearTimeout(timer);
			routeSignal.removeEventListener("abort", abort);
			requests.delete(controller);
			counters.pendingLoads--;
		}
		let draco, record;
		const work = (async () => {
			try {
				const url = new URL(id === "main" ? "sect_diorama.glb" : INTERIOR_SCENES[id].file, assetBaseUrl);
				const response = await (options.fetch || win.fetch.bind(win))(url.href, { signal });
				if (!response.ok) throw failure("MODEL_HTTP", `Model HTTP ${response.status}`);
				const bytes = await response.arrayBuffer();
				if (signal.aborted) throw signal.reason;
				const [, , { GLTFLoader }, { DRACOLoader }] = await importDependencies();
				if (signal.aborted) throw signal.reason;
				draco = new DRACOLoader().setDecoderPath(new URL("draco/", assetBaseUrl).href).setWorkerLimit(2);
				decoders.add(draco);
				const gltf = await new GLTFLoader().setDRACOLoader(draco).parseAsync(bytes, new URL(".", url).href);
				const root = gltf.scene, roots = [...new Set(gltf.scenes?.length ? gltf.scenes : [root])];
				for (const item of roots) registry.track(item);
				record = {
					id,
					root,
					roots,
					bytes: bytes.byteLength,
					prepared: false,
					released: false
				};
				if (signal.aborted || destroyed) throw signal.reason || failure("CANCELLED", "Destroyed");
				root.updateMatrixWorld(true);
				let meshes = 0;
				root.traverse((object) => {
					if (object.isMesh) {
						meshes++;
						const floor = object.userData.navigationOnly || object.userData.interactionId === "floor";
						object.castShadow = object.receiveShadow = quality !== "low" && !floor;
					}
				});
				const bounds = new THREE.Box3().setFromObject(root);
				if (!meshes || bounds.isEmpty()) throw failure("MODEL_EMPTY", "Model has no visible mesh");
				const size = bounds.getSize(new THREE.Vector3()), target = bounds.getCenter(new THREE.Vector3());
				const angle = (INTERIOR_SCENES[id]?.azimuth || 0) * Math.PI / 180;
				const position = target.clone().add(new THREE.Vector3(Math.sin(angle), 1, Math.cos(angle)).multiplyScalar(Math.max(size.x, size.z) * 1.8));
				Object.assign(record, {
					size,
					target,
					position,
					meshes
				});
				root.visible = false;
				return record;
			} catch (error) {
				releaseRecord(record);
				if (timedOut) throw failure("MODEL_TIMEOUT", "Model timeout");
				throw error?.code ? error : failure("MODEL_PARSE", "Model could not be decoded");
			} finally {
				finishRequest();
				if (draco) {
					decoders.delete(draco);
					draco.dispose();
				}
			}
		})();
		let cancelListener;
		const cancellation = new Promise((_, reject) => {
			cancelListener = () => reject(timedOut ? failure("MODEL_TIMEOUT", "Model timeout") : signal.reason || failure("CANCELLED", "Cancelled"));
			signal.addEventListener("abort", cancelListener, { once: true });
			if (signal.aborted) cancelListener();
		});
		try {
			return await Promise.race([work, cancellation]);
		} finally {
			signal.removeEventListener("abort", cancelListener);
			finishRequest();
		}
	}
	async function activate(record, valid) {
		if (!valid()) return;
		if (!record.prepared) {
			record.prepared = true;
			if (record.id === "main") environment.collect(record.root);
			else environment.prepareInterior(record.root, record.id);
		}
		if (!valid()) return;
		scene.add(record.root);
		record.root.visible = true;
		activeRecord = record;
		environment.setInterior(record.id === "main" ? null : record.root, record.id);
		if (atmosphere) atmosphere.enabled = record.id === "main";
		cinematic?.set("interior", Number(record.id !== "main"));
		positionCamera(record);
		fit();
		projectEnvironment();
		try {
			await npc.bind?.(record.root, record.id, latest);
		} catch {
			counters.npcErrors++;
		}
		if (!valid()) return;
		projectEnvironment();
		renderer.shadowMap.needsUpdate = true;
		let compiled;
		try {
			compiled = await compiler.compile(scene, camera, valid);
		} catch (error) {
			if (!valid()) return;
			if (!cinematic || qualityFallback) throw error;
			dropPostprocessing();
			resize();
			compiled = await compiler.compile(scene, camera, valid);
		}
		if (!valid()) return;
		if (!compiled) throw failure("COMPILE_CANCELLED", "Material lifetime changed during shader compilation");
		drawable = true;
		await firstFrame(valid);
		if (!valid()) return;
		ready = true;
		initializeFailure = null;
		const key = `${latest.sessionEpoch}:${record.id}:${navigation.generation}`;
		if (key !== readyKey) {
			readyKey = key;
			emit("ready", { sceneId: record.id });
		}
		schedule();
	}
	async function initialize() {
		if (initializing) return initializing;
		if (renderer) return;
		const serial = ++initializationSerial;
		initializing = (async () => {
			const [three, { OrbitControls }, , , { createEnvironment }, { createNpcController }] = await importDependencies();
			if (destroyed || serial !== initializationSerial || !visible) return;
			THREE = three;
			motionReduced = options.reducedMotion ?? Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
			shell = doc.createElement("div");
			shell.className = "scene3d-runtime";
			shell.dataset.scene3dInstance = String(instanceId);
			shell.hidden = true;
			renderer = new THREE.WebGLRenderer({
				antialias: true,
				alpha: true,
				powerPreference: quality === "low" ? "low-power" : "high-performance"
			});
			compiler = createCompileLifecycle(renderer, win);
			counters.rendererCreated++;
			renderer.setClearColor("#d5e2dd", 1);
			renderer.outputColorSpace = THREE.SRGBColorSpace;
			renderer.toneMapping = quality === "low" ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = quality === "low" ? 1.08 : 1;
			renderer.shadowMap.enabled = quality !== "low";
			renderer.shadowMap.type = THREE.PCFShadowMap;
			renderer.shadowMap.autoUpdate = false;
			renderer.setPixelRatio(quality === "low" ? 1 : Math.min(win.devicePixelRatio || 1, 1.25));
			renderer.domElement.className = "scene3d-canvas";
			renderer.domElement.tabIndex = 0;
			renderer.domElement.setAttribute("aria-label", "门派3D场景：拖动环绕，双指或滚轮缩放，点击建筑查看信息");
			shell.appendChild(renderer.domElement);
			back = doc.createElement("button");
			back.className = "scene3d-back";
			back.type = "button";
			back.textContent = "返回地图";
			reset = doc.createElement("button");
			reset.className = "scene3d-reset";
			reset.type = "button";
			reset.textContent = "镜头归位";
			shell.appendChild(back);
			shell.appendChild(reset);
			container.appendChild(shell);
			scene = new THREE.Scene();
			scene.fog = quality === "low" ? new THREE.Fog("#d5e2dd", 76, 160) : null;
			camera = new THREE.OrthographicCamera(-60, 60, 41, -41, .1, 420);
			camera.position.set(18, 53, 45);
			controls = new OrbitControls(camera, renderer.domElement);
			controls.enabled = false;
			controls.target.set(0, 7.5, -3);
			controls.autoRotate = false;
			controls.enableDamping = !motionReduced;
			controls.dampingFactor = .075;
			controls.rotateSpeed = .55;
			controls.zoomSpeed = .85;
			controls.panSpeed = .75;
			const fill = new THREE.HemisphereLight("#dcebf4", "#8c8d82", 1.65), ambient = new THREE.AmbientLight("#efdfc9", .2);
			sun = new THREE.DirectionalLight("#ffdfb1", 3);
			sun.position.set(-32, 65, 38);
			sun.target.position.set(0, 4, -2);
			sun.castShadow = quality !== "low";
			Object.assign(sun.shadow.camera, {
				left: -42,
				right: 42,
				top: 42,
				bottom: -42,
				near: 1,
				far: 180
			});
			sun.shadow.camera.updateProjectionMatrix();
			sun.shadow.mapSize.set(2048, 2048);
			sun.shadow.normalBias = .035;
			sun.shadow.bias = -15e-5;
			sun.shadow.radius = 3;
			scene.add(fill, ambient, sun, sun.target);
			api.metrics.atmosphere = quality !== "low";
			environment = createEnvironment({
				scene,
				camera,
				renderer,
				sun,
				fill,
				ambient,
				api,
				reducedMotion: motionReduced,
				paperColor: options.paperColor || "#eee5d6",
				exposureOverride: quality === "low" ? null : 1,
				volumeClouds: quality !== "low",
				onTimeChange: (hour) => cinematic?.setTime(hour),
				onCloudHeight: (value) => atmosphere?.setHeight(value),
				onCloudSpeed: (value) => atmosphere?.setSpeed(value),
				onCloudMotion: (value) => atmosphere?.setMotion(value)
			});
			environment.setAutoTime?.(false);
			if (quality === "balanced") try {
				const [{ createCinematic }, { createAtmospherePass }] = await Promise.all([import("./chunks/cinematic-Dhl-sxxA.mjs"), import("./chunks/atmosphere-B1OraK87.mjs")]);
				if (destroyed || serial !== initializationSerial) return;
				atmosphere = createAtmospherePass(camera, sun);
				atmosphere.setHeight(4.4);
				atmosphere.setSpeed(api.environment.cloudSpeed);
				atmosphere.setMotion(api.environment.cloudMotion);
				cinematic = createCinematic(renderer, scene, camera, {
					atmosphere,
					paperColor: options.paperColor || "#eee5d6"
				});
			} catch (error) {
				if (!destroyed) dropPostprocessing();
			}
			if (destroyed || serial !== initializationSerial) return;
			setNpcController((options.npcFactory || createNpcController)({
				scene,
				camera,
				renderer,
				assetBaseUrl,
				emitNpcIntent,
				container: shell,
				registry,
				isInteractionEnabled: canInteract,
				fetch: options.fetch
			}));
			navigation = createNavigation({
				load: loadModel,
				activate,
				deactivate,
				release: releaseRecord,
				onStart() {
					ready = false;
					drawable = false;
					appliedVersion = null;
					invalidateNpc();
					stopFrames();
					syncInput();
				},
				onError(error, id) {
					ready = false;
					initializeFailure = error;
					emitError(error, id);
					syncInput();
				}
			});
			installInput();
			listeners.listen(doc, "visibilitychange", () => {
				if (doc.hidden) {
					cancelNavigation();
					ready = false;
					wakeWaiters();
				} else if (visible && latest) applyState(latest);
				schedule();
			});
			listeners.listen(win, "pagehide", () => {
				destroy();
			});
			if (win.ResizeObserver) {
				observer = new win.ResizeObserver(resize);
				observer.observe(container);
			} else listeners.listen(win, "resize", resize);
			resize();
			projectEnvironment();
		})().catch((error) => {
			if (!destroyed) {
				initializeFailure = error;
				cleanupGraphics();
				throw error;
			}
		}).finally(() => {
			initializing = null;
		});
		return initializing;
	}
	async function applyState(input) {
		if (destroyed) return applyResult("destroyed", latest || input);
		const snapshot = normalizeSnapshot(input);
		if (latest && compareVersion(snapshot, latest) < 0) return applyResult("superseded", snapshot);
		if (latest && (latest.sessionEpoch !== snapshot.sessionEpoch || latest.sceneId !== snapshot.sceneId)) {
			cancelNavigation();
			ready = false;
			drawable = false;
			appliedVersion = null;
		}
		latest = snapshot;
		visible = snapshot.visible && snapshot.mode === 0 && Boolean(snapshot.sceneId);
		renderEnabled = snapshot.renderEnabled;
		interactive = snapshot.interactive;
		wakeWaiters();
		schedule();
		if (!visible || !snapshot.sceneId) {
			cancelNavigation();
			ready = false;
			appliedVersion = null;
			wakeWaiters();
			schedule();
			return applyResult("superseded", snapshot);
		}
		if (initializeFailure && !renderer) return applyResult("degraded", snapshot);
		try {
			await initialize();
			if (destroyed) return applyResult("destroyed", snapshot);
			if (!latest || compareVersion(snapshot, latest) !== 0) return applyResult("superseded", snapshot);
			if (!visible || !navigation) return applyResult("superseded", snapshot);
			projectEnvironment();
			syncInput();
			const status = await navigation.navigate(snapshot.sceneId, snapshot.sessionEpoch);
			if (destroyed) return applyResult("destroyed", snapshot);
			if (compareVersion(snapshot, latest) !== 0) return applyResult("superseded", snapshot);
			if (status === "applied") {
				appliedVersion = `${snapshot.sessionEpoch}:${snapshot.revision}`;
				ready = true;
				projectEnvironment();
			}
			schedule();
			return applyResult(status, snapshot);
		} catch (error) {
			if (destroyed) return applyResult("destroyed", snapshot);
			if (compareVersion(snapshot, latest) !== 0) return applyResult("superseded", snapshot);
			initializeFailure = error;
			ready = false;
			emitError(error);
			syncInput();
			return applyResult("degraded", snapshot);
		}
	}
	function setVisible(value) {
		if (destroyed) return;
		visible = Boolean(value);
		if (!visible) {
			cancelNavigation();
			ready = false;
			appliedVersion = null;
			wakeWaiters();
		}
		syncInput();
		schedule();
	}
	function setRenderEnabled(value) {
		if (!destroyed) {
			renderEnabled = Boolean(value);
			wakeWaiters();
			schedule();
		}
	}
	function setInteractionEnabled(value) {
		if (!destroyed) {
			interactive = Boolean(value);
			syncInput();
		}
	}
	function setNpcController(controller) {
		if (destroyed) {
			controller?.dispose?.();
			return false;
		}
		if (!controller || typeof controller !== "object") throw new TypeError("NPC controller must be an object");
		compiler?.cancel();
		try {
			npc.dispose?.();
		} catch {
			counters.npcErrors++;
		}
		npc = controller;
		lastNpcStats = null;
		if (activeRecord) try {
			Promise.resolve(npc.bind?.(activeRecord.root, activeRecord.id, latest)).catch(() => {
				counters.npcErrors++;
			});
			npc.update?.(latest);
		} catch {
			counters.npcErrors++;
		}
		return true;
	}
	async function retry() {
		if (destroyed) return applyResult("destroyed", latest);
		if (!latest) throw new Error("Apply a snapshot before retry");
		counters.attempts++;
		initializeFailure = null;
		appliedVersion = null;
		readyKey = null;
		cancelNavigation();
		wakeWaiters();
		if (navigation) {
			const snapshot = latest;
			if (!visible) return applyResult("superseded", snapshot);
			projectEnvironment();
			const status = await navigation.navigate(snapshot.sceneId, snapshot.sessionEpoch, { force: true });
			if (destroyed) return applyResult("destroyed", snapshot);
			if (compareVersion(snapshot, latest) !== 0) return applyResult("superseded", snapshot);
			if (status === "applied") appliedVersion = `${snapshot.sessionEpoch}:${snapshot.revision}`;
			schedule();
			return applyResult(status, snapshot);
		}
		return applyState(latest);
	}
	function getNpcStats() {
		try {
			return npc.getStats ? diagnosticSnapshot(npc.getStats()) : lastNpcStats;
		} catch {
			return null;
		}
	}
	function cleanupGraphics() {
		compiler?.dispose();
		lastCompileStats = compiler?.snapshot() || lastCompileStats;
		compiler = null;
		stopFrames();
		wakeWaiters();
		observer?.disconnect();
		observer = null;
		listeners.dispose();
		controls?.dispose();
		controls = null;
		for (const request of requests) request.abort();
		for (const decoder of decoders) decoder.dispose();
		decoders.clear();
		try {
			npc.dispose?.();
		} catch {
			counters.npcErrors++;
		}
		lastNpcStats = getNpcStats();
		npc = noopNpc();
		environment?.dispose();
		environment = null;
		navigation?.dispose();
		navigation = null;
		activeRecord = null;
		cinematic?.dispose();
		atmosphere?.dispose();
		cinematic = atmosphere = null;
		registry.dispose();
		sun?.dispose();
		sun = null;
		if (renderer) {
			renderer.dispose();
			renderer.forceContextLoss?.();
			renderer.domElement.remove();
			renderer = null;
			counters.rendererDisposed++;
		}
		scene?.clear();
		scene = camera = null;
		shell?.remove();
		shell = back = reset = null;
	}
	function destroy() {
		if (destroyPromise) return destroyPromise;
		destroyed = true;
		visible = renderEnabled = interactive = ready = false;
		initializationSerial++;
		cancelNavigation();
		stopFrames();
		wakeWaiters();
		flushGestures();
		cleanupGraphics();
		instances.delete(container);
		destroyPromise = Promise.resolve();
		return destroyPromise;
	}
	function getDiagnostics() {
		return Object.freeze({
			instanceId,
			destroyed,
			ready,
			visible,
			renderEnabled,
			interactionEnabled: canInteract(),
			phase: destroyed ? "destroyed" : initializeFailure ? "degraded" : ready ? "ready" : navigation?.busy || initializing ? "loading" : "idle",
			epoch: latest?.sessionEpoch ?? null,
			revision: latest?.revision ?? null,
			sceneId: latest?.sceneId ?? null,
			activeSceneId: activeRecord?.id ?? null,
			appliedVersion,
			quality,
			qualityFallback,
			dpr: renderer?.getPixelRatio() ?? 0,
			width,
			height,
			drawingWidth: renderer?.domElement.width ?? 0,
			drawingHeight: renderer?.domElement.height ?? 0,
			raf: Number(Boolean(raf)),
			listeners: listeners.size,
			controls: Number(Boolean(controls)),
			observers: Number(Boolean(observer)),
			renderers: Number(Boolean(renderer)),
			canvases: Number(Boolean(renderer?.domElement.parentNode)),
			decoders: decoders.size,
			fetches: requests.size,
			...counters,
			...registry.snapshot(),
			...navigation?.snapshot() || {
				routeGeneration: 0,
				pending: 0,
				cachedMain: 0,
				cachedRooms: 0
			},
			environmentResources: environment ? Object.freeze({
				preparedInteriors: api.metrics.environment?.preparedInteriors || 0,
				exteriorMaterials: api.metrics.environment?.exteriorMaterials || 0,
				interiorMaterials: api.metrics.environment?.interiorMaterials || 0,
				backgroundDraws: api.metrics.environment?.backgroundDraws || 0
			}) : null,
			postprocessing: Number(Boolean(cinematic)),
			atmosphere: Number(Boolean(atmosphere)),
			npc: getNpcStats(),
			compilation: compiler?.snapshot() || lastCompileStats
		});
	}
	const handle = {
		applyState,
		setVisible,
		setRenderEnabled,
		setInteractionEnabled,
		resize,
		retry,
		destroy,
		resetView,
		setNpcController,
		getDiagnostics,
		getDebugState: getDiagnostics
	};
	if (options.debug) Object.defineProperty(handle, "debug", {
		enumerable: true,
		get: getDiagnostics
	});
	Object.freeze(handle);
	instances.set(container, handle);
	return handle;
}
//#endregion
export { LOCATION_TO_SCENE, PROTOCOL, SCENE_TO_LOCATION, mount };
