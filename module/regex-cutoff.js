/**
 * regex-cutoff.js - 正则截断模块
 *
 * 原理：
 *   1. 用户配置多组正则（每组支持 any/all 匹配模式）
 *   2. 流式生成中每个 token 到达时，对累积文本执行实时检测
 *   3. 命中后立即 abort HTTP 连接，截断消息
 *   4. 落库后兜底再检测一次，防止流式漏检
 *
 * 截断规则：
 *   - 组内逻辑：any=任一命中（并集），all=全部命中（交集）
 *   - 组间逻辑：并集，任意一组命中即触发
 *   - 取所有命中组中最早匹配位置作为截断点
 *   - 截断点再往前多删 X 个字符（按码点计数）
 *   - 截断后可自动追加文本
 *
 * 依赖：pipeline.js（abortCurrentTurn）
 */

var regexCutoff = (function() {
    'use strict';

    var STORAGE_KEY = 'jxz_rc_settings';

    var DEFAULT_GROUP = {
        name: '新分组',
        enabled: true,
        mode: 'any',       // any = 任一命中（并集），all = 全部命中（交集）
        patterns: '',      // 每行一条正则，支持 /pattern/flags 写法
    };

    var DEFAULT_SETTINGS = {
        enabled: false,
        deleteChars: 20,      // 截断点往前多删的字符数（按码点计）
        appendText: '',       // 截断后追加的文本
        streamAbort: true,    // 流式命中时立即中止
        notify: true,         // 触发时弹出 toast
        groups: [{
            name: '段落重复',
            enabled: true,
            mode: 'any',
            patterns: '(.{50,})\\1{3,}',
        }, {
            name: '字符重复',
            enabled: true,
            mode: 'any',
            patterns: '(.)\\1{80,}',
        }, {
            name: '素数填充',
            enabled: false,
            mode: 'any',
            patterns: '<item>\\s*\\d+(,\\d+){5,}',
        }],
    };

    // ========== 设置 ==========

    var _settings = null;

    function loadSettings() {
        if (_settings) return _settings;
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) _settings = JSON.parse(saved);
        } catch (e) {}
        if (!_settings) _settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        // 补全缺失字段
        for (var key in DEFAULT_SETTINGS) {
            if (!DEFAULT_SETTINGS.hasOwnProperty(key)) continue;
            if (!(key in _settings)) _settings[key] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]));
        }
        if (!Array.isArray(_settings.groups)) _settings.groups = [];
        for (var i = 0; i < _settings.groups.length; i++) {
            var g = _settings.groups[i];
            for (var gk in DEFAULT_GROUP) {
                if (!DEFAULT_GROUP.hasOwnProperty(gk)) continue;
                if (!(gk in g)) g[gk] = DEFAULT_GROUP[gk];
            }
        }
        return _settings;
    }

    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings)); } catch (e) {}
    }

    function isEnabled() { return loadSettings().enabled; }

    function toggleEnabled() {
        var s = loadSettings();
        s.enabled = !s.enabled;
        saveSettings();
        updateToggleUI();
        return s.enabled;
    }

    // ========== 正则编译（带缓存）==========

    /**
     * 解析一行正则文本
     * 支持两种写法：
     *   - 普通文本：直接作为正则模式
     *   - /pattern/flags：提取模式和 flags（g/y 会被剔除）
     */
    function parsePatternLine(line) {
        var m = line.match(/^\/(.+)\/([a-zA-Z]*)$/);
        if (m) {
            var flags = m[2].replace(/[gy]/g, '');
            return new RegExp(m[1], flags);
        }
        return new RegExp(line);
    }

    var compiledCache = { key: null, groups: [] };

    function compileGroups(s) {
        var key = JSON.stringify(s.groups);
        if (compiledCache.key === key) return compiledCache.groups;

        var groups = [];
        for (var i = 0; i < s.groups.length; i++) {
            var g = s.groups[i];
            var regexes = [];
            var errors = [];
            var lines = String(g.patterns || '').split('\n');
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (!line) continue;
                try {
                    regexes.push(parsePatternLine(line));
                } catch (e) {
                    errors.push('「' + line + '」：' + e.message);
                }
            }
            groups.push({
                idx: i,
                name: g.name || ('分组' + (i + 1)),
                enabled: !!g.enabled,
                mode: g.mode === 'all' ? 'all' : 'any',
                regexes: regexes,
                errors: errors
            });
        }

        compiledCache = { key: key, groups: groups };
        return groups;
    }

    // ========== 检测逻辑 ==========

    /**
     * 对文本执行正则检测
     * @returns {{cutStart: number, groupNames: string[]}} 或 null
     *
     * 组内逻辑：
     *   - any（任一命中）：组内任意一条正则匹配即视为该组命中
     *   - all（全部命中）：组内所有正则都匹配才视为该组命中
     * 组间：并集，任何一组命中即触发
     * 截断点：取所有命中组中最早的匹配位置
     */
    function detect(text, s) {
        if (!text) return null;
        var groups = compileGroups(s);
        var cutStart = -1;
        var groupNames = [];

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (!g.enabled || g.regexes.length === 0) continue;

            var earliest = -1;
            var matchedCount = 0;

            for (var j = 0; j < g.regexes.length; j++) {
                var re = g.regexes[j];
                // 重置 lastIndex（虽然已剔除 g flag，但防御性重置）
                re.lastIndex = 0;
                var m = re.exec(text);
                if (m) {
                    matchedCount++;
                    if (earliest === -1 || m.index < earliest) {
                        earliest = m.index;
                    }
                }
            }

            var hit = g.mode === 'all'
                ? (matchedCount === g.regexes.length)
                : (matchedCount > 0);
            if (!hit) continue;

            groupNames.push(g.name);
            if (cutStart === -1 || earliest < cutStart) {
                cutStart = earliest;
            }
        }

        if (cutStart === -1) return null;
        return { cutStart: cutStart, groupNames: groupNames };
    }

    // ========== 文本截断 ==========

    /**
     * 从截断位置往前多删 X 个字符（按码点计数，CJK/emoji 均按 1 字算）
     */
    function cutText(text, cutStart, deleteChars) {
        var head = text.slice(0, cutStart);
        var x = Math.max(0, Number(deleteChars) || 0);
        if (x === 0) return head;
        var cps = Array.from(head);
        return cps.slice(0, Math.max(0, cps.length - x)).join('');
    }

    /**
     * 循环截断：截断后拼接处可能产生新匹配，最多循环 5 次
     */
    function cutLoop(text, s) {
        var hitGroups = new Set();
        var result = text;
        for (var i = 0; i < 5; i++) {
            var hit = detect(result, s);
            if (!hit) break;
            hit.groupNames.forEach(function(n) { hitGroups.add(n); });
            var next = cutText(result, hit.cutStart, s.deleteChars);
            if (next === result) break;
            result = next;
        }
        return { text: result, hitGroups: hitGroups };
    }

    function appendAfterCut(text, appendText) {
        var trimmed = text.replace(/\s+$/, '');
        var append = String(appendText || '');
        return trimmed + append;
    }

    // ========== 流式回调包装器 ==========

    /**
     * 包装流式回调，添加正则实时检测
     *
     * 工作流程：
     *   1. 每个 token 拼入累积文本
     *   2. 执行正则检测
     *   3. 命中 → 记录截断位置 → abort HTTP 连接
     *   4. onError 中检查是否为本模块触发的 abort
     *   5. 是本模块的 abort → 截断文本 → 转 onComplete
     */
    function createStreamWrapper(callbacks, baseLength) {
        var s = loadSettings();
        if (!s.enabled) return callbacks;

        var state = {
            fullText: '',
            aborted: false,      // 是否被本模块 abort
            cutStart: -1,        // 截断位置
            groupNames: [],      // 命中的分组名
            lastCheck: 0,        // 上次检测时间戳（节流）
        };

        var THROTTLE_MS = 250;  // 最长 250ms 检测一次，防止大文本 regex 拖慢 UI

        return {
            onToken: function(delta) {
                if (state.aborted) return;
                state.fullText += delta;

                if (!s.streamAbort) {
                    callbacks.onToken(delta);
                    return;
                }

                // 节流：最多每 250ms 检测一次
                var now = Date.now();
                if (now - state.lastCheck < THROTTLE_MS) {
                    callbacks.onToken(delta);
                    return;
                }
                state.lastCheck = now;
                var hit = detect(state.fullText, s);
                if (hit) {
                    state.aborted = true;
                    state.cutStart = hit.cutStart;
                    state.groupNames = hit.groupNames;
                    console.log('[RegexCutoff] 流式命中分组 [' + hit.groupNames.join('、') + ']，位置=' + hit.cutStart + '，中止生成');
                    if (typeof pipeline !== 'undefined' && typeof pipeline.abortCurrentTurn === 'function') {
                        pipeline.abortCurrentTurn();
                    }
                    return;
                }

                // 没命中，正常传递
                callbacks.onToken(delta);
            },

            onThinking: callbacks.onThinking,

            onComplete: function(fullText, usage) {
                var s2 = loadSettings();
                // 本模块触发的 abort：api-service 把 AbortError 转成了 onComplete
                // 必须在这里截断文本，不能等 onError（onError 根本不会被调用）
                if (state.aborted && state.cutStart >= 0) {
                    var truncated = cutText(fullText, state.cutStart, s2.deleteChars);
                    truncated = truncated.replace(/\s+$/, '');
                    var finalText = appendAfterCut(truncated, s2.appendText);

                    var removed = Array.from(fullText).length - Array.from(truncated).length;
                    var appended = Array.from(String(s2.appendText || '')).length;
                    console.log('[RegexCutoff] 截断完成：删除 ' + removed + ' 字' + (appended > 0 ? '，追加 ' + appended + ' 字' : '') + '，分组 [' + state.groupNames.join('、') + ']');

                    if (s2.notify && typeof toastr !== 'undefined') {
                        toastr.success(
                            '命中 [' + state.groupNames.join('、') + ']，已截断删除 ' + removed + ' 字',
                            '正则截断'
                        );
                    }

                    callbacks.onComplete(finalText, usage);
                    return;
                }
                // 正常完成：透传
                callbacks.onComplete(fullText, usage);
            },

            onError: function(err) {
                var s2 = loadSettings();
                // 防御性处理：万一某些 API 实现把 abort 当 error 报
                if (state.aborted && state.cutStart >= 0) {
                    var truncated = cutText(state.fullText, state.cutStart, s2.deleteChars);
                    truncated = truncated.replace(/\s+$/, '');
                    var finalText = appendAfterCut(truncated, s2.appendText);
                    console.log('[RegexCutoff] 截断完成（onError路径）：命中分组 [' + state.groupNames.join('、') + ']');
                    callbacks.onComplete(finalText, null);
                    return;
                }

                // 非本模块触发的错误：透传
                callbacks.onError(err);
            }
        };
    }

    // ========== 落库后兜底检测 ==========

    function findLastAssistantIndex(chat) {
        for (var i = chat.length - 1; i >= 0; i--) {
            var m = chat[i];
            if (m && m.is_user === false && m.is_system !== true) return i;
        }
        return -1;
    }

    /**
     * 对最后一条 AI 消息执行正则检测并截断（兜底用）
     */
    async function applyCutToLastMessage(options) {
        options = options || {};
        var silent = options.silent || false;

        var s = loadSettings();
        if (!s.enabled) return false;

        // 获取最后一条 AI 消息
        var uiConv;
        try {
            if (typeof storageService !== 'undefined') {
                uiConv = storageService.loadUIConversation();
            }
        } catch (e) {}

        if (!uiConv || uiConv.length === 0) {
            if (!silent) console.log('[RegexCutoff] uiConversation 为空，无法检测');
            return false;
        }

        // 找最后一条 assistant
        var lastIdx = -1;
        for (var i = uiConv.length - 1; i >= 0; i--) {
            if (uiConv[i].role === 'assistant') { lastIdx = i; break; }
        }
        if (lastIdx < 0) return false;

        var original = String(uiConv[lastIdx].content || '');
        if (!original) return false;

        var cutResult = cutLoop(original, s);
        if (cutResult.text === original) {
            if (!silent && s.notify && typeof toastr !== 'undefined') {
                toastr.info('最后一条 AI 消息未命中任何正则组', '正则截断');
            }
            return false;
        }

        var finalText = appendAfterCut(cutResult.text, s.appendText);
        var removed = Array.from(original).length - Array.from(cutResult.text).length;

        // 更新 uiConversation
        uiConv[lastIdx].content = finalText;
        try {
            if (typeof storageService !== 'undefined' && storageService.saveUIConversation) {
                storageService.saveUIConversation(uiConv);
            }
        } catch (e) {
            console.warn('[RegexCutoff] 保存 uiConversation 失败：', e);
        }

        console.log('[RegexCutoff] 兜底截断：命中 [' + [...cutResult.hitGroups].join('、') + ']，删除 ' + removed + ' 字');

        if (s.notify && typeof toastr !== 'undefined') {
            toastr.success('兜底命中 [' + [...cutResult.hitGroups].join('、') + ']，已截断删除 ' + removed + ' 字', '正则截断');
        }

        // 刷新渲染
        try {
            if (typeof renderMainText === 'function') {
                renderMainText(finalText);
            }
        } catch (e) {}

        return true;
    }

    // ========== UI ==========

    function createUI() {
        var existing = document.getElementById('regex-cutoff-btn');
        if (existing) return;

        var container = document.getElementById('stream-controls');
        if (!container) { setTimeout(createUI, 500); return; }

        var btn = document.createElement('button');
        btn.id = 'regex-cutoff-btn';
        btn.textContent = '🔪 正则';
        btn.title = '正则截断：命中配置的正则时自动中止生成';
        btn.style.cssText = [
            'color: #fff', 'border: none', 'border-radius: 6px',
            'padding: 6px 10px', 'cursor: pointer', 'font-size: 13px',
            'margin-left: 4px', 'box-shadow: 0 2px 6px rgba(0,0,0,0.3)',
        ].join(';');

        btn.onclick = function() {
            toggleEnabled();
        };

        // 插入到停止按钮之后
        var stopBtn = document.getElementById('stream-stop-btn');
        if (stopBtn) {
            stopBtn.parentNode.insertBefore(btn, stopBtn.nextSibling);
        } else {
            container.appendChild(btn);
        }

        updateToggleUI();
    }

    function updateToggleUI() {
        var s = loadSettings();
        var btn = document.getElementById('regex-cutoff-btn');
        if (!btn) return;

        if (s.enabled) {
            btn.style.background = 'linear-gradient(135deg, #9b59b6, #8e44ad)';
            btn.style.opacity = '1';
            btn.title = '正则截断：已开启（' + s.groups.filter(function(g){ return g.enabled; }).length + ' 组启用）';
        } else {
            btn.style.background = 'linear-gradient(135deg, #555, #666)';
            btn.style.opacity = '0.7';
            btn.title = '正则截断：已关闭，点击开启';
        }
    }

    /**
     * 生成正则组的设置 HTML（供 config-modal 使用）
     */
    function buildSettingsHtml() {
        var s = loadSettings();
        var html = '<div style="margin-top:10px;">';

        html += '<label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">';
        html += '<input type="checkbox" id="rc-modal-enable"' + (s.enabled ? ' checked' : '') + ' />';
        html += '<span>启用正则截断</span>';
        html += '</label>';

        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">';
        html += '<span>截断点往前多删</span>';
        html += '<input type="number" id="rc-modal-delete" value="' + s.deleteChars + '" min="0" step="1" style="width:60px;background:#1a1a2e;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 8px;" />';
        html += '<span>个字符</span>';
        html += '</div>';

        html += '<label style="display:block;margin-bottom:4px;">截断后追加文本（留空不追加）</label>';
        html += '<textarea id="rc-modal-append" style="width:100%;height:40px;background:#1a1a2e;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 8px;resize:vertical;" placeholder="追加内容不会参与正则检测">' + escapeHtml(s.appendText) + '</textarea>';

        html += '<div style="margin:10px 0 6px;font-weight:bold;">正则组</div>';
        html += '<div style="font-size:12px;color:#8a7a5a;margin-bottom:8px;">每行一条正则，支持 <code>/pattern/flags</code> 写法。</div>';

        html += '<div id="rc-modal-groups">';
        for (var i = 0; i < s.groups.length; i++) {
            html += buildGroupHtml(s.groups[i], i);
        }
        html += '</div>';

        html += '<button onclick="regexCutoff._addGroup()" style="margin-top:6px;background:#2a2a4a;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 12px;cursor:pointer;">+ 添加分组</button>';

        html += '<div style="margin-top:10px;font-size:12px;color:#8a7a5a;">';
        html += '命中后行为：① 流式生成中实时检测，命中立即中止（可关）；';
        html += '② 从最早命中位置截断 + 往前多删；③ 落库后兜底检测。';
        html += '</div>';

        html += '</div>';
        return html;
    }

    function buildGroupHtml(g, idx) {
        var html = '<div class="rc-group-item" data-idx="' + idx + '" style="background:#1a1a2e;border:1px solid #3a2a1a;border-radius:4px;padding:8px;margin-bottom:6px;">';

        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">';
        html += '<input type="checkbox" class="rc-g-enabled"' + (g.enabled ? ' checked' : '') + ' title="启用" />';
        html += '<input type="text" class="rc-g-name" value="' + escapeHtml(g.name) + '" placeholder="分组名" style="flex:1;background:#2a2a4a;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 8px;" />';
        html += '<select class="rc-g-mode" style="background:#2a2a4a;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 8px;">';
        html += '<option value="any"' + (g.mode !== 'all' ? ' selected' : '') + '>任一命中</option>';
        html += '<option value="all"' + (g.mode === 'all' ? ' selected' : '') + '>全部命中</option>';
        html += '</select>';
        html += '<button class="rc-g-del" style="background:#c0392b;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;">✕</button>';
        html += '</div>';

        html += '<textarea class="rc-g-patterns" rows="2" style="width:100%;background:#2a2a4a;color:#e0d5b0;border:1px solid #4a3a2a;border-radius:4px;padding:4px 8px;resize:vertical;font-size:12px;" placeholder="每行一条正则">' + escapeHtml(g.patterns) + '</textarea>';

        html += '</div>';
        return html;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * 将 modal 中的设置写入 localStorage
     */
    function saveFromModal() {
        var s = loadSettings();

        var enableEl = document.getElementById('rc-modal-enable');
        if (enableEl) s.enabled = enableEl.checked;

        var deleteEl = document.getElementById('rc-modal-delete');
        if (deleteEl) s.deleteChars = Math.max(0, parseInt(deleteEl.value) || 0);

        var appendEl = document.getElementById('rc-modal-append');
        if (appendEl) s.appendText = String(appendEl.value);

        // 遍历分组元素收集设置
        var groupEls = document.querySelectorAll('#rc-modal-groups .rc-group-item');
        var newGroups = [];
        groupEls.forEach(function(el) {
            var enabledEl = el.querySelector('.rc-g-enabled');
            var nameEl = el.querySelector('.rc-g-name');
            var modeEl = el.querySelector('.rc-g-mode');
            var patternsEl = el.querySelector('.rc-g-patterns');

            if (enabledEl || nameEl || patternsEl) {
                newGroups.push({
                    name: nameEl ? String(nameEl.value) : '分组',
                    enabled: enabledEl ? enabledEl.checked : true,
                    mode: modeEl ? String(modeEl.value) : 'any',
                    patterns: patternsEl ? String(patternsEl.value) : '',
                });
            }
        });

        s.groups = newGroups.length > 0 ? newGroups : JSON.parse(JSON.stringify(DEFAULT_SETTINGS.groups));

        _settings = s;
        compiledCache = { key: null, groups: [] }; // 清缓存
        saveSettings();
        updateToggleUI();
    }

    function _addGroup() {
        var s = loadSettings();
        s.groups.push(JSON.parse(JSON.stringify(DEFAULT_GROUP)));
        saveSettings();
        // 重新渲染 modal 中的分组
        var groupsEl = document.getElementById('rc-modal-groups');
        if (groupsEl) {
            var html = '';
            for (var i = 0; i < s.groups.length; i++) {
                html += buildGroupHtml(s.groups[i], i);
            }
            groupsEl.innerHTML = html;
            bindModalGroupEvents();
        }
    }

    function bindModalGroupEvents() {
        var groupsEl = document.getElementById('rc-modal-groups');
        if (!groupsEl) return;

        // 事件委托
        groupsEl.onclick = function(e) {
            var delBtn = e.target.closest('.rc-g-del');
            if (delBtn) {
                var item = delBtn.closest('.rc-group-item');
                if (item) item.remove();
            }
        };
    }

    function init() {
        var s = loadSettings();
        console.log('[RegexCutoff] 初始化, enabled=' + s.enabled + ', groups=' + s.groups.length);
        createUI();
    }

    // DOM 就绪后初始化
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        init: init,
        isEnabled: isEnabled,
        toggleEnabled: toggleEnabled,
        loadSettings: loadSettings,
        saveSettings: saveSettings,
        createStreamWrapper: createStreamWrapper,
        applyCutToLastMessage: applyCutToLastMessage,
        createUI: createUI,
        updateToggleUI: updateToggleUI,
        buildSettingsHtml: buildSettingsHtml,
        saveFromModal: saveFromModal,
        _addGroup: _addGroup,
        bindModalGroupEvents: bindModalGroupEvents,
    };
})();
