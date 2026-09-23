/* Equipment presentation only; all mutations belong to game-helpers.js (unequipItem). */
(function () {
    'use strict';
    let modal, viewport, bound = false, busy = false, opener = null;
    const SLOTS = ['武器', '防具', '饰品1', '饰品2'];
    function node(tag, text, className) {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (className) el.className = className;
        return el;
    }
    function size() {
        const style = getComputedStyle(viewport);
        const left = parseFloat(style.borderLeftWidth) || 0, top = parseFloat(style.borderTopWidth) || 0;
        modal.style.left = -left + 'px';
        modal.style.top = -top + 'px';
        const right = parseFloat(style.borderRightWidth) || 0, bottom = parseFloat(style.borderBottomWidth) || 0;
        modal.style.width = `calc(100% + ${left + right}px)`;
        modal.style.height = `calc(100% + ${top + bottom}px)`;
        modal.style.setProperty('--equipment-font', Math.max(11, Math.min(22, viewport.clientWidth / 42)) + 'px');
    }
    function init() {
        if (bound) return;
        modal = document.getElementById('equipment-modal');
        viewport = document.getElementById('main-viewport');
        viewport.appendChild(modal);
        modal.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button || !modal.contains(button)) return;
            if (button.hasAttribute('data-equipment-close')) { close(); return; }
            const name = button.dataset.equipmentUnequip;
            if (name && !busy) {
                busy = true;
                button.disabled = true;
                Promise.resolve(unequipItem(name)).catch(() => {}).finally(() => { busy = false; });
            }
        });
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); close(); }
            if (event.key === 'Tab') {
                const buttons = [...modal.querySelectorAll('button:not(:disabled)')];
                const first = buttons[0], last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        });
        new ResizeObserver(size).observe(viewport);
        bound = true;
    }
    function render() {
        const grid = document.getElementById('equipment-grid');
        const focusedName = document.activeElement?.dataset?.equipmentUnequip;
        grid.replaceChildren();
        SLOTS.forEach(key => {
            const slot = node('div', undefined, 'equipment-panel-slot');
            slot.append(node('div', key, 'equipment-panel-slot-label'));
            const itemName = equipment[key];
            if (itemName && item_list[itemName]) {
                const body = node('div', undefined, 'equipment-panel-slot-item');
                const row = node('div', undefined, 'equipment-panel-name-row');
                const name = node('span', itemName, 'equipment-panel-name');
                row.append(name);
                const attrs = node('div', getEquipEffectText(item_list[itemName]), 'equipment-panel-attrs');
                // 卸下按钮独立成行，由 CSS 推到槽位方框底部居中。
                const unequip = node('button', '卸下');
                unequip.type = 'button';
                unequip.dataset.equipmentUnequip = itemName;
                body.append(row, attrs, unequip);
                slot.append(body);
            } else {
                slot.append(node('div', '空', 'equipment-panel-empty'));
            }
            grid.append(slot);
        });
        if (focusedName) grid.querySelector(`[data-equipment-unequip="${focusedName}"]`)?.focus({ preventScroll: true });
    }
    function open() {
        init();
        const alreadyOpen = modal.style.display === 'block';
        if (!alreadyOpen) {
            opener = document.activeElement?.closest('.dropdown-menu')?.previousElementSibling || document.activeElement;
            closeAllSpecialModals();
        }
        const dropdown = document.getElementById('attribute-dropdown');
        dropdown?.classList.remove('show');
        dropdown?.previousElementSibling?.classList.remove('active');
        modal.style.display = 'block';
        size(); render();
        if (!alreadyOpen) modal.querySelector('[data-equipment-close]')?.focus({ preventScroll: true });
    }
    function close() {
        if (!bound) return;
        modal.style.display = 'none';
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    window.EquipmentPanel = { open, close };
}());
