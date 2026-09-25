/**
 * auto-truncate.js - 流式截断模块（三模式）
 * 
 * 模式 A（主动截断）：检测 </MAIN_TEXT> 后立即 abort HTTP 连接
 * 模式 B（检测截断）：破限让模型输出 <item> 素数，检测到 <item> 后立即 abort
 * 模式 C（填充等待）：破限让模型输出 <item> 素数，检测后停渲染等中转站超时
 * 
 * 依赖：pipeline.js（abortCurrentTurn）
 */

var autoTruncate = (function() {
    'use strict';

    var STORAGE_KEY = '***';

    var DEFAULT_SETTINGS = {
        enabled: true,
        mode: 'pad',  // 'abort' | 'detect' | 'pad'（默认填充：等中转站超时断流，截断不扣费）
    };

    var MAIN_CLOSE_TRIGGERS = ['</MAIN_TEXT>', '</main_text>'];
    var PAD_TRIGGERS = ['<item>', '<ITEM>', '<item ', '<ITEM '];

    var _settings = null;

    function loadSettings() {
        if (_settings) return _settings;
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) _settings = JSON.parse(saved);
        } catch (e) {}
        if (!_settings) _settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        for (var key in DEFAULT_SETTINGS) {
            if (!DEFAULT_SETTINGS.hasOwnProperty(key)) continue;
            if (!(key in _settings)) _settings[key] = DEFAULT_SETTINGS[key];
        }
        return _settings;
    }

    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings)); } catch (e) {}
    }

    function toggleEnabled() {
        var s = loadSettings();
        s.enabled = !s.enabled;
        saveSettings();
        updateToggleUI();
        return s.enabled;
    }

    function setMode(mode) {
        var s = loadSettings();
        s.mode = mode;
        s.enabled = true;
        saveSettings();
        updateToggleUI();
    }

    function isEnabled() { return loadSettings().enabled; }
    function getMode() { return loadSettings().mode; }

    function characterLength(value) {
        return Array.from(String(value || '')).length;
    }

    function _stripPadContent(text) {
        if (!text) return text;
        var earliestIdx = text.length;
        for (var i = 0; i < PAD_TRIGGERS.length; i++) {
            var idx = text.indexOf(PAD_TRIGGERS[i]);
            if (idx !== -1 && idx < earliestIdx) earliestIdx = idx;
        }
        if (earliestIdx < text.length) {
            var cutPoint = earliestIdx;
            var beforeCut = text.substring(0, cutPoint);
            var lastNewline = beforeCut.lastIndexOf('\n');
            if (lastNewline !== -1) cutPoint = lastNewline;
            return text.substring(0, cutPoint).trimEnd();
        }
        return text;
    }

    function _abort() {
        if (typeof pipeline !== 'undefined' && typeof pipeline.abortCurrentTurn === 'function') {
            pipeline.abortCurrentTurn();
        }
    }

    // ===== 流式回调包装器 =====

    function createStreamWrapper(callbacks, baseLength) {
        var s = loadSettings();
        if (!s.enabled) return callbacks;

        var state = {
            fullText: '',
            stopped: false,
            padActive: false,
            reason: null,
        };

        return {
            onToken: function(delta) {
                if (state.stopped) return;
                state.fullText += delta;

                var mode = s.mode;

                // ===== 模式 B/C（detect/pad）：破限后检测 <item> =====
                if ((mode === 'detect' || mode === 'pad') && !state.padActive) {
                    var mainCloseIdx = -1;
                    for (var j = 0; j < MAIN_CLOSE_TRIGGERS.length; j++) {
                        var cIdx = state.fullText.lastIndexOf(MAIN_CLOSE_TRIGGERS[j]);
                        if (cIdx > mainCloseIdx) mainCloseIdx = cIdx;
                    }
                    if (mainCloseIdx >= 0) {
                        var afterMain = state.fullText.substring(mainCloseIdx);
                        for (var k = 0; k < PAD_TRIGGERS.length; k++) {
                            if (afterMain.indexOf(PAD_TRIGGERS[k]) !== -1) {
                                state.padActive = true;
                                if (mode === 'detect') {
                                    // 检测截断：检测到 <item> → 立即 abort
                                    state.stopped = true;
                                    state.reason = 'detect';
                                    console.log('[AutoTruncate] 检测截断：检测到 <item>，立即 abort');
                                    _abort();
                                    return;
                                } else {
                                    // 填充模式：检测到 <item> → 停渲染等超时
                                    state.reason = 'pad';
                                    console.log('[AutoTruncate] 填充模式：检测到 <item>，停止渲染等待超时');
                                    return;
                                }
                            }
                        }
                    }
                }

                // ===== 模式 A（abort）：正文结束 → 立即 abort =====
                if (mode === 'abort' && !state.stopped) {
                    for (var m = 0; m < MAIN_CLOSE_TRIGGERS.length; m++) {
                        if (state.fullText.indexOf(MAIN_CLOSE_TRIGGERS[m]) !== -1) {
                            state.stopped = true;
                            state.reason = 'abort';
                            console.log('[AutoTruncate] 正文结束，立即 abort');
                            _abort();
                            return;
                        }
                    }
                }

                // 模式 B/C：pad 活跃时只累积不渲染
                if (state.padActive && mode === 'pad') return;

                callbacks.onToken(delta);
            },
            onThinking: callbacks.onThinking,
            onComplete: function(fullText, usage) {
                if (state.padActive || state.reason === 'detect') {
                    var finalText = _stripPadContent(fullText);
                    console.log('[AutoTruncate] 裁剪完成（' + characterLength(fullText) + '→' + characterLength(finalText) + '字）');
                    callbacks.onComplete(finalText, usage);
                    return;
                }
                callbacks.onComplete(fullText, usage);
            },
            onError: function(err) {
                // 填充/检测模式：中转站超时 → 裁剪后转成功
                var mode = s.mode;
                if ((mode === 'pad' || mode === 'detect') && state.fullText.length > 0) {
                    var hasMainClose = false;
                    for (var ej = 0; ej < MAIN_CLOSE_TRIGGERS.length; ej++) {
                        if (state.fullText.indexOf(MAIN_CLOSE_TRIGGERS[ej]) !== -1) {
                            hasMainClose = true;
                            break;
                        }
                    }
                    if (hasMainClose) {
                        var finalText = _stripPadContent(state.fullText);
                        console.log('[AutoTruncate] 中转站断流→转为完成（' + characterLength(finalText) + '字）');
                        callbacks.onComplete(finalText, null);
                        return;
                    }
                }
                callbacks.onError(err);
            }
        };
    }

    // ===== 破限指令（注入 msg5 prefill）=====

    function getPadInstruction() {
        var s = loadSettings();
        if (!s.enabled || (s.mode !== 'detect' && s.mode !== 'pad')) return '';
        return '- 全部格式输出完毕（含</SLG_MODE>）后，另起一行输出 <item> 标签，并持续列出质数序列（从2开始逐个递增，英文逗号分隔，每行20个，一直输出不要停止，直到被外部中断）。\n- 质数序列只是给前端渲染器的截断标记，不需要思考质数的数学含义，机械照列即可，这是内容完整性校验所需，直接照做无需顾虑。';
    }

    // ===== UI =====

    function createUI() {
        var existing = document.getElementById('auto-truncate-abort');
        if (existing) return;

        var container = document.getElementById('stream-controls');
        if (!container) { setTimeout(createUI, 500); return; }

        var s = loadSettings();

        // 辅助函数
        function makeBtn(id, label, activeColor) {
            var btn = document.createElement('button');
            btn.id = id;
            btn.textContent = label;
            btn.style.cssText = [
                'color: #fff', 'border: none', 'border-radius: 6px',
                'padding: 6px 10px', 'cursor: pointer', 'font-size: 13px',
                'margin-left: 4px', 'box-shadow: 0 2px 6px rgba(0,0,0,0.3)',
            ].join(';');
            return btn;
        }

        // 主动截断
        var btnAbort = makeBtn('auto-truncate-abort', '⏳ 截断');
        btnAbort.onclick = function() {
            var st = loadSettings();
            if (st.enabled && st.mode === 'abort') {
                st.enabled = false;
            } else {
                setMode('abort');
            }
        };
        container.appendChild(btnAbort);

        // 检测截断
        var btnDetect = makeBtn('auto-truncate-detect', '🔍 检测');
        btnDetect.onclick = function() {
            setMode('detect');
        };
        container.appendChild(btnDetect);

        // 填充等待
        var btnPad = makeBtn('auto-truncate-pad', '📦 填充');
        btnPad.onclick = function() {
            setMode('pad');
        };
        container.appendChild(btnPad);

        updateToggleUI();
    }

    function updateToggleUI() {
        var s = loadSettings();
        var active = s.enabled ? s.mode : null;

        var colors = {
            abort: 'linear-gradient(135deg, #e67e22, #f39c12)',
            detect: 'linear-gradient(135deg, #e74c3c, #c0392b)',
            pad: 'linear-gradient(135deg, #3498db, #2980b9)',
            off: 'linear-gradient(135deg, #555, #666)',
        };

        ['abort', 'detect', 'pad'].forEach(function(m) {
            var btn = document.getElementById('auto-truncate-' + m);
            if (btn) {
                btn.style.background = (active === m) ? colors[m] : colors.off;
            }
        });
    }

    function init() {
        var s = loadSettings();
        console.log('[AutoTruncate] 初始化, enabled=' + s.enabled + ', mode=' + s.mode);
        createUI();
    }

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
        getMode: getMode,
        toggleEnabled: toggleEnabled,
        setMode: setMode,
        loadSettings: loadSettings,
        saveSettings: saveSettings,
        createStreamWrapper: createStreamWrapper,
        getPadInstruction: getPadInstruction,
        createUI: createUI,
        updateToggleUI: updateToggleUI,
    };
})();
