/* Corner controls (viewport-dock-gear + scene3d-reset) track the HUD action buttons:
   their diameter is 80% of a dock control button's rendered height, so the two circles
   shrink/grow with the 属性查看 / 跳过一周 row instead of holding a fixed px size. */
(function () {
    'use strict';
    let viewport = null, viewportObserver = null, probeObserver = null, probe = null;

    function apply() {
        if (!viewport || !probe) return;
        const height = probe.getBoundingClientRect().height;
        if (height > 0) {
            const size = Math.max(12, Math.min(64, 0.8 * height));
            viewport.style.setProperty('--viewport-corner-size', Math.round(size * 10) / 10 + 'px');
        }
    }
    // Defer two frames so a transition/font-settle that resized the probe has fully landed.
    function settle() {
        requestAnimationFrame(() => requestAnimationFrame(apply));
    }

    function bindProbe() {
        const next = viewport ? viewport.querySelector('#viewport-dock-menu .control-btn') : null;
        if (next === probe) return;
        if (probeObserver) { probeObserver.disconnect(); probeObserver = null; }
        probe = next;
        if (probe && typeof ResizeObserver !== 'undefined') {
            probeObserver = new ResizeObserver(() => settle());
            probeObserver.observe(probe);
        }
    }

    function start() {
        viewport = document.getElementById('main-viewport');
        if (!viewport) return;
        if (typeof ResizeObserver !== 'undefined') {
            viewportObserver = new ResizeObserver(() => settle());
            viewportObserver.observe(viewport);
        }
        bindProbe();
        settle();
        window.addEventListener('resize', settle);
        window.addEventListener('load', settle);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}());
