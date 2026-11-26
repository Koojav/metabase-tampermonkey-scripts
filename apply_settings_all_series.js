// ==UserScript==
// @name         Metabase: Apply settings to all series
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  "Smooth Everything" button with configurable style options, applied to all series
// @match        https://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const LIST_SEL = '[data-testid="chart-settings-widget-graph.series_order"]';
    const TRIGGER_SEL = '[data-testid$="-settings-button"]';
    const CONTENT_SEL = '[data-testid="chart-settings-widget-popover-content"]';
    const ALL_ATTR = 'data-quick-apply-all';
    const ROW_ATTR = 'data-quick-apply-row';
    const STORE_KEY = 'qa-smooth-settings-v2';

    // Each option = a button group inside the series popup. Choice index = button position.
    const OPTIONS = [
        { key: 'display',     testId: 'chart-settings-widget-display',              label: 'Display type',    choices: ['Line', 'Area', 'Bar'] },
        { key: 'interpolate', testId: 'chart-settings-widget-line.interpolate',     label: 'Line shape',      choices: ['Straight', 'Curved', 'Stepped'] },
        { key: 'style',       testId: 'chart-settings-widget-line.style',           label: 'Line style',      choices: ['Solid', 'Dashed', 'Dotted'] },
        { key: 'size',        testId: 'chart-settings-widget-line.size',            label: 'Line size',       choices: ['S', 'M', 'L'] },
        { key: 'dots',        testId: 'chart-settings-widget-line.marker_enabled',  label: 'Show dots',       choices: ['Auto', 'On', 'Off'] },
        { key: 'axis',        testId: 'chart-settings-widget-axis',                 label: 'Y-axis position', choices: ['Auto', 'Left', 'Right'] }
    ];
    // null = leave unchanged
    const DEFAULTS = { display: 0, interpolate: 1, style: 0, size: 1, dots: 1, axis: 1 };

    let settings = Object.assign({}, DEFAULTS);
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY));
        if (saved) settings = Object.assign({}, DEFAULTS, saved);
    } catch (e) {}
    const saveSettings = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) {} };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const imp = (el, p, v) => el.style.setProperty(p, v, 'important');

    const style = document.createElement('style');
    style.textContent = `
        html.qa-busy [data-element-id="mantine-popover"]:has(${CONTENT_SEL}) {
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(style);

    async function waitFor(fn, timeout = 3000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            const r = fn();
            if (r) return r;
            await sleep(50);
        }
        return null;
    }

    function clickIndex(testId, idx) {
        const content = document.querySelector(CONTENT_SEL);
        const group = content && content.querySelector(`[data-testid="${testId}"]`);
        if (!group) { console.warn('[quick-apply] group not found:', testId); return; }
        const btns = group.querySelectorAll('button');
        if (btns[idx]) btns[idx].click();
    }

    async function closePopup(trigger) {
        const open = () => document.querySelector(CONTENT_SEL);
        trigger.click();
        await sleep(50);
        if (!open()) return;
        const c = open();
        ['keydown', 'keyup'].forEach(type =>
            c.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })));
        await sleep(50);
        if (!open()) return;
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await sleep(50);
    }

    async function applyOne(trigger) {
        if (!document.querySelector(CONTENT_SEL)) trigger.click();
        const content = await waitFor(() => document.querySelector(CONTENT_SEL));
        if (!content) { console.warn('[quick-apply] popup did not open'); return; }
        // inline hide as a fallback in case the <style> rule is blocked
        const popup = content.closest('[data-element-id="mantine-popover"]');
        if (popup) { imp(popup, 'opacity', '0'); imp(popup, 'pointer-events', 'none'); }
        await sleep(50);
        for (const opt of OPTIONS) {
            const idx = settings[opt.key];
            if (idx === null || idx === undefined) continue;
            clickIndex(opt.testId, idx);
            await sleep(25);
        }
        await closePopup(trigger);
    }

    let busy = false;
    async function runAll() {
        if (busy) return;
        busy = true;
        document.documentElement.classList.add('qa-busy');
        document.querySelectorAll(`[${ALL_ATTR}]`).forEach(b => b.disabled = true);
        try {
            const triggers = Array.from(document.querySelectorAll(`${LIST_SEL} ${TRIGGER_SEL}`));
            for (const t of triggers) {
                if (!document.contains(t)) continue;
                await applyOne(t);
            }
        } finally {
            document.documentElement.classList.remove('qa-busy');
            document.querySelectorAll(`[${ALL_ATTR}]`).forEach(b => b.disabled = false);
            busy = false;
        }
    }

    // ---------- UI (all styles inline, so CSP can't block them) ----------
    function styleBtn(btn, props) {
        Object.entries(props).forEach(([p, v]) => btn.style.setProperty(p, v, 'important'));
    }

    function buildPanel() {
        const panel = document.createElement('div');
        styleBtn(panel, {
            display: 'none',
            'box-sizing': 'border-box',
            width: '100%',
            padding: '12px',
            'margin-bottom': 'var(--mantine-spacing-sm)',
            border: '1px solid hsla(0, 0%, 100%, 0.21)',
            'border-radius': '6px'
        });

        function render() {
            panel.textContent = '';
            OPTIONS.forEach(opt => {
                const label = document.createElement('div');
                label.textContent = opt.label;
                styleBtn(label, { 'font-weight': 'bold', 'font-size': '13px', margin: '8px 0 6px' });
                panel.appendChild(label);

                const group = document.createElement('div');
                styleBtn(group, { display: 'flex', width: '100%' });
                opt.choices.forEach((text, i) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = text;
                    const selected = settings[opt.key] === i;
                    styleBtn(b, {
                        flex: '1',
                        padding: '6px 4px',
                        cursor: 'pointer',
                        border: '1px solid #509EE3',
                        background: selected ? '#509EE3' : 'transparent',
                        color: selected ? '#fff' : 'inherit',
                        'border-radius': i === 0 ? '4px 0 0 4px' : (i === opt.choices.length - 1 ? '0 4px 4px 0' : '0'),
                        'margin-left': i === 0 ? '0' : '-1px'
                    });
                    b.addEventListener('click', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        settings[opt.key] = selected ? null : i;   // click again to unset
                        saveSettings();
                        render();
                    });
                    group.appendChild(b);
                });
                panel.appendChild(group);
            });

            const hint = document.createElement('div');
            hint.textContent = 'Click a selected option again to leave that setting unchanged.';
            styleBtn(hint, { 'font-size': '11px', opacity: '0.6', 'margin-top': '10px' });
            panel.appendChild(hint);

            // Apply button (same action as "Smooth Everything")
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.setAttribute(ALL_ATTR, '1');   // gets disabled while a run is in progress
            apply.textContent = 'Apply';
            styleBtn(apply, {
                display: 'block',
                width: '100%',
                'box-sizing': 'border-box',
                'margin-top': '12px',
                padding: '8px 12px',
                border: 'none',
                'border-radius': '6px',
                background: '#689636',
                color: '#fff',
                'font-weight': 'bold',
                cursor: 'pointer'
            });
            apply.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                runAll();
            });
            panel.appendChild(apply);
        }
        render();
        return panel;
    }

    function inject() {
        const list = document.querySelector(LIST_SEL);
        if (!list || list.querySelector(`[${ROW_ATTR}]`)) return;
        const wrapper = list.firstElementChild || list;

        const container = document.createElement('div');
        container.setAttribute(ROW_ATTR, '1');

        const panel = buildPanel();

        const main = document.createElement('button');
        main.type = 'button';
        main.textContent = '✨ Smooth Everything 👌';
        styleBtn(main, {
            display: 'block',
            width: '100%',
            'box-sizing': 'border-box',
            'margin-block': 'var(--mantine-spacing-sm)',
            padding: '8px 12px',
            border: 'none',
            'border-radius': '6px',
            background: '#689636',
            color: '#fff',
            'font-weight': 'bold',
            cursor: 'pointer'
        });
        main.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const hidden = panel.style.display === 'none';
            panel.style.setProperty('display', hidden ? 'block' : 'none', 'important');
        });

        container.appendChild(main);
        container.appendChild(panel);
        wrapper.insertBefore(container, wrapper.firstChild);
    }

    function fixPopup() {
        document.querySelectorAll(CONTENT_SEL).forEach(content => {
            const popup = content.closest('[data-element-id="mantine-popover"]');
            let el = content;
            while (el) {
                imp(el, 'max-height', 'none');
                imp(el, 'height', 'auto');
                imp(el, 'overflow', 'visible');
                if (el === popup) break;
                el = el.parentElement;
            }
        });
    }

    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; inject(); fixPopup(); });
    }).observe(document.body, { childList: true, subtree: true });
    inject(); fixPopup();
})();
