/* Inventory presentation only; all mutations belong to game-helpers.js. */
(function () {
    'use strict';
    let category = '武器', selected = null, previousNames = [], opener = null;
    let modal, viewport, bound = false, busy = false;
    const equipmentTypes = ['武器', '防具', '饰品'];
    const classify = item => equipmentTypes.includes(item?.装备类型) ? item.装备类型 : item?.可使用 ? '消耗品' : '其他';
    function node(tag, text, className) {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (className) el.className = className;
        return el;
    }
    function size() {
        const style = getComputedStyle(viewport);
        const left = parseFloat(style.borderLeftWidth) || 0, top = parseFloat(style.borderTopWidth) || 0;
        // Absolute positioning uses the padding box; include the viewport border.
        modal.style.left = -left + 'px';
        modal.style.top = -top + 'px';
        const right = parseFloat(style.borderRightWidth) || 0, bottom = parseFloat(style.borderBottomWidth) || 0;
        modal.style.width = `calc(100% + ${left + right}px)`;
        modal.style.height = `calc(100% + ${top + bottom}px)`;
        modal.style.setProperty('--inventory-font', Math.max(11, Math.min(22, viewport.clientWidth / 42)) + 'px');
    }
    function init() {
        if (bound) return;
        modal = document.getElementById('inventory-modal');
        viewport = document.getElementById('main-viewport');
        viewport.appendChild(modal);
        modal.addEventListener('click', async event => {
            const button = event.target.closest('button');
            if (!button || !modal.contains(button)) return;
            if (button.hasAttribute('data-inventory-close')) { close(); return; }
            if (button.dataset.inventoryCategory) {
                category = button.dataset.inventoryCategory;
                selected = null; previousNames = []; render();
                document.getElementById('inventory-grid').scrollTop = 0;
            } else if (button.dataset.inventoryItem) {
                selected = button.dataset.inventoryItem; render();
            } else if (button.dataset.inventoryAction && !busy && selected) {
                busy = true;
                const name = selected;
                button.disabled = true;
                try {
                    if (button.dataset.inventoryAction === 'equip') await equipItem(name, true);
                    else await useItem(name);
                } finally {
                    busy = false;
                    render();
                }
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
        const names = Object.keys(inventory).filter(name => inventory[name] > 0 && classify(item_list[name]) === category);
        if (!names.includes(selected)) {
            const oldIndex = previousNames.indexOf(selected);
            selected = names[Math.min(Math.max(0, oldIndex), names.length - 1)] || null;
        }
        previousNames = names;
        modal.querySelectorAll('[data-inventory-category]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.inventoryCategory === category));
        });
        const grid = document.getElementById('inventory-grid');
        const scroll = grid.scrollTop;
        const focusedItem = document.activeElement?.dataset.inventoryItem;
        grid.replaceChildren();
        names.forEach(name => {
            const button = node('button', undefined, 'inventory-panel-item');
            button.type = 'button';
            button.dataset.inventoryItem = name;
            button.setAttribute('aria-pressed', String(name === selected));
            button.append(node('span', name), node('span', '×' + inventory[name], 'inventory-panel-quantity'));
            grid.append(button);
        });
        if (!names.length) grid.append(node('p', '此分类暂无物品', 'inventory-panel-empty'));
        grid.scrollTop = scroll;
        if (focusedItem) [...grid.children].find(el => el.dataset.inventoryItem === focusedItem)?.focus({ preventScroll: true });
        const detail = document.getElementById('inventory-detail');
        const actions = document.getElementById('inventory-actions');
        detail.replaceChildren(); actions.replaceChildren();
        if (!selected) { detail.append(node('h3', '暂无物品'), node('p', '获得物品后，可在此查看属性与描述。')); return; }
        const item = item_list[selected];
        detail.append(node('h3', selected));
        const stats = node('div', undefined, 'inventory-panel-stats');
        stats.append(node('p', '持有数量：' + inventory[selected]));
        if (item?.可装备) {
            stats.append(node('p', '装备类型：' + item.装备类型), node('p', '装备属性：' + getEquipEffectText(item)));
            if (Object.values(equipment).includes(selected)) stats.append(node('p', '已有同名装备 · 库存仍可装备'));
        }
        if (item?.可使用) stats.append(node('p', '使用效果：' + getItemEffectText(item)));
        if (item?.可交易) stats.append(node('p', '买入价格：' + item.买入价格 + ' 金'), node('p', '卖出价格：' + item.卖出价格 + ' 金'));
        detail.append(stats, node('p', item?.描述 || '暂无物品描述。', 'inventory-panel-description'));
        const action = (text, kind) => {
            const button = node('button', text);
            button.type = 'button'; button.dataset.inventoryAction = kind; button.disabled = busy;
            actions.append(button);
        };
        if (item?.可装备 && equipmentTypes.includes(item.装备类型)) action('装备', 'equip');
        if (item?.可使用) action('使用', 'use');
        detail.scrollTop = 0;
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
        if (!alreadyOpen) modal.querySelector('[data-inventory-close]').focus({ preventScroll: true });
    }
    function close() {
        if (!bound) return;
        modal.style.display = 'none';
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    window.InventoryPanel = { open, close };
}());
