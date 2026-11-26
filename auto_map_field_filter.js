// ==UserScript==
// @name         Metabase: auto-map field filter variable
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Button next to "Variable type": sets Field Filter, picks schema (1st part of name) and searches (2nd part)
// @match        https://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const PANEL_PREFIX = 'tag-editor-variable-';
    const BTN_ATTR = 'data-quick-map-btn';
    const SEARCH_PART_INDEX = 1;   // which "_" part of the name goes into "Find..." (0 = first)

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const log = (...a) => console.warn('[quick-map]', ...a);
    const trace = (...a) => console.log('[quick-map]', ...a);

    function pressKey(el, key, keyCode) {
        const o = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', o));
        el.dispatchEvent(new KeyboardEvent('keyup', o));
    }

    // a "real" click: pointer + mouse events with coordinates, like a user would produce
    function realClick(el) {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, button: 0,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new MouseEvent('click', o));
    }

    async function waitFor(fn, timeout = 3000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            const r = fn();
            if (r) return r;
            await sleep(10);
        }
        return null;
    }

    function setNativeValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ---- selectors taken from the Metabase markup ----
    const getPanel = name => document.querySelector(`[data-testid="${PANEL_PREFIX}${name}"]`);
    const typeSelect = panel => panel.querySelector('[data-testid="variable-type-select"]');
    const searchField = () => document.querySelector('[data-testid="list-search-field"]');
    const schemaCrumb = () => document.querySelector('[data-testid="source-schema"]');
    const databaseCrumb = () => document.querySelector('[data-testid="source-database"]');

    function fieldTrigger(panel) {
        for (const label of panel.querySelectorAll('label')) {
            const head = label.firstElementChild;
            if (head && norm(head.textContent).startsWith('field to map to')) {
                return label.querySelector('[aria-haspopup="dialog"]');
            }
        }
        return null;
    }

    function pickerRoot() {
        const f = searchField();
        return f && (f.closest('[data-element-id="mantine-popover"]') || f.closest('[role="dialog"]') || document.body);
    }

    // find a list entry by its visible text, whatever the markup (schema list, table list, ...)
    function pickerOption(text) {
        const root = pickerRoot();
        if (!root) return null;
        const matches = Array.from(root.querySelectorAll('*')).filter(el =>
            el.tagName !== 'INPUT' && el.tagName !== 'svg' && norm(el.textContent) === text);
        // deepest element whose text is exactly the name
        const leaf = matches.filter(el => !Array.from(el.children).some(c => matches.includes(c)))[0];
        if (!leaf) return null;
        return leaf.closest('[role="option"], [role="treeitem"], [data-element-id="list-item"]') || leaf;
    }

    let lastPicked = '';   // full name of the result clicked by clickOnlyResult

    // ---- added in v3.0: click the single remaining result of a picker list ----
    // pickerSel: '#TablePicker' or '#FieldPicker'; isDone(): true once the click has taken effect
    // returns 'clicked' | 'many' (2+ results) | 'none' (0 results) | 'failed' (clicked, nothing happened)
    async function clickOnlyResult(pickerSel, isDone, label, waitMs = 1500, term = '') {
        const rows = () => Array.from(document.querySelectorAll(`${pickerSel} [role="option"]`));
        // wait until the list is filtered: exactly one row, or the row count has stopped changing for 250 ms
        // (and every row contains the typed term, so a not-yet-filtered list is not mistaken for the result)
        const t = norm(term);
        const filtered = () => rows().every(o => norm(o.getAttribute('aria-label')).includes(t));
        const t0 = Date.now();
        let last = -1, since = t0, count = rows().length;
        while (Date.now() - t0 < waitMs) {
            count = rows().length;
            if (count === 1) break;
            if (count !== last) { last = count; since = Date.now(); }
            else if (Date.now() - since >= 250 && filtered()) break;
            await sleep(10);
        }
        if (count !== 1) {
            count = rows().length;
            trace(label + ': ' + count + ' results, not clicking');
            return count === 0 ? 'none' : 'many';
        }
        await sleep(100);                                   // let the list settle
        if (rows().length !== 1) { trace(label + ': list changed, not clicking'); return 'many'; }
        const item = rows()[0];
        lastPicked = item.getAttribute('aria-label') || (item.textContent || '').trim();
        trace(label + ': clicking the only result:', lastPicked);
        realClick(item);
        if (await waitFor(isDone, 100)) return 'clicked';
        item.click();
        if (await waitFor(isDone, 100)) return 'clicked';
        const box = searchField();                          // keyboard fallback
        if (box) {
            box.focus();
            for (let i = 0; i < 4; i++) {
                const row = rows()[0];
                if (!row || row.getAttribute('data-hascursor') === 'true') break;
                pressKey(box, 'ArrowDown', 40);
                await sleep(60);
            }
            pressKey(box, 'Enter', 13);
        }
        return (await waitFor(isDone, 1500)) ? 'clicked' : 'failed';
    }

    async function run(name, btn) {
        const parts = name.split('_');
        const first = norm(parts[0]);
        const search = parts[SEARCH_PART_INDEX] || '';

        btn.disabled = true;
        try {
            // 1. Variable type -> Field Filter
            let panel = getPanel(name);
            const select = panel && typeSelect(panel);
            if (!select) return log('variable type select not found');

            if (norm(select.value) !== 'field filter') {
                select.click();
                // "Field Filter" entry: Metabase's internal option value is "dimension" (same for every variable)
                const findOpt = () => document.querySelector('[data-combobox-option][value="dimension"]') ||
                    Array.from(document.querySelectorAll('[role="option"]'))
                        .find(o => norm(o.textContent).includes('field filter'));
                let opt = await waitFor(findOpt, 1500);
                if (!opt) {                      // dropdown didn't open: try a full mouse sequence on the input
                    ['mousedown', 'mouseup', 'click'].forEach(t =>
                        select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
                    opt = await waitFor(findOpt, 1500);
                }
                if (!opt) return log('"Field Filter" option not found');
                opt.click();
                await waitFor(() => { const p = getPanel(name); return p && fieldTrigger(p); });
            }

            trace('step 1 done (Field Filter set)');
            // 2. open "Field to map to"
            panel = getPanel(name);
            const trigger = panel && fieldTrigger(panel);
            if (!trigger) return log('"Field to map to" not found');
            if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();

            trace('step 2: opening Field to map to');
            const picker = await waitFor(searchField);
            if (!picker) return log('picker did not open (no "Find..." box)');

            // 3. pick schema = first part of the name
            if (schemaCrumb() && norm(schemaCrumb().textContent) !== first) {
                // already inside another schema: go back to the schema list
                databaseCrumb() && databaseCrumb().click();
                await waitFor(() => !schemaCrumb());
            }
            const schemaOpen = () => document.querySelector('#TablePicker') ||
                (schemaCrumb() && norm(schemaCrumb().textContent) === first);
            if (!schemaOpen()) {
                const item = await waitFor(() => pickerOption(first));
                if (!item) {
                    const root = pickerRoot();
                    return log('schema item not found:', first, '\npicker text:', root && root.innerText,
                        '\npicker html:', root && root.outerHTML.slice(0, 4000));
                }
                trace('clicking schema item:', first);
                realClick(item);
                let ok = await waitFor(schemaOpen, 100);
                if (!ok) { trace('retrying with .click()'); item.click(); ok = await waitFor(schemaOpen, 100); }
                if (!ok) {
                    // keyboard fallback: filter the list, move the cursor onto the row, press Enter
                    trace('retrying with keyboard');
                    const box = searchField();
                    box.focus();
                    setNativeValue(box, parts[0]);
                    await sleep(150);
                    for (let i = 0; i < 4 && !schemaOpen(); i++) {
                        const row = pickerOption(first);
                        if (row && row.getAttribute('data-hascursor') === 'true') break;
                        pressKey(box, 'ArrowDown', 40);
                        await sleep(60);
                    }
                    pressKey(box, 'Enter', 13);
                    ok = await waitFor(schemaOpen, 1500);
                }
                if (!ok) {
                    const root = pickerRoot();
                    return log('schema did not open:', first, '\npicker text:', root && (root.innerText || root.textContent || '').slice(0, 300),
                        '\nrow html:', item.outerHTML.slice(0, 600));
                }
            }

            // 4. type the second part into "Find..."
            const input = await waitFor(searchField);
            if (!input) return log('"Find..." box missing after schema click');
            input.focus();
            setNativeValue(input, search);

            // ---- added in v3.0/3.2: pick the table (growing the search term), then the field ----
            try {
                // parts from the table name onward; the last one is kept for the field when there is more than one
                const n = parts.length - SEARCH_PART_INDEX;
                const maxK = Math.max(1, n - 1);
                let usedK = 0;
                for (let k = 1; k <= maxK; k++) {
                    const term = parts.slice(SEARCH_PART_INDEX, SEARCH_PART_INDEX + k).join('_');
                    if (k > 1) {                               // k = 1 was already typed above
                        const box = searchField();
                        if (!box) return log('"Find..." box missing while extending the table search');
                        box.focus();
                        setNativeValue(box, term);
                        trace('table search extended to:', term);
                    }
                    const r = await clickOnlyResult('#TablePicker', () => document.querySelector('#FieldPicker'),
                        'table "' + term + '"', k === 1 ? 1500 : 1000, term);
                    if (r === 'clicked') { usedK = k; break; }
                    if (r !== 'many') return;                  // no results, or the click had no effect
                }
                if (!usedK) return trace('table: still several results, stopping');

                // text for the field box = variable name (after the schema) minus the full name of the clicked table
                const tail = parts.slice(SEARCH_PART_INDEX).join('_');
                let rest;
                if (norm(tail) === norm(lastPicked)) {
                    rest = '';
                } else if (norm(tail).startsWith(norm(lastPicked) + '_')) {
                    rest = tail.slice(lastPicked.length + 1);
                } else {                                   // table name isn't a prefix of the name: use the unused parts
                    rest = parts.slice(SEARCH_PART_INDEX + usedK).join('_');
                    trace('table name is not a prefix of the variable name, using unused parts');
                }
                trace('table picked:', lastPicked, '| rest of name =', JSON.stringify(rest));
                if (!rest) return;

                const fieldBox = await waitFor(() => document.querySelector('#FieldPicker [data-testid="list-search-field"]'));
                if (!fieldBox) return log('field search box missing after table click');
                fieldBox.focus();
                setNativeValue(fieldBox, rest);
                trace('typed field name:', rest);
                await clickOnlyResult('#FieldPicker', () => !document.querySelector('#FieldPicker'), 'field "' + rest + '"', 1500, rest);
            } catch (err) {
                log('error in table/field step:', err);
            }
        } finally {
            btn.disabled = false;
        }
    }

    function inject() {
        document.querySelectorAll(`[data-testid^="${PANEL_PREFIX}"]`).forEach(panel => {
            if (panel.querySelector(`[${BTN_ATTR}]`)) return;
            const name = panel.getAttribute('data-testid').slice(PANEL_PREFIX.length);

            let header = null;
            for (const label of panel.querySelectorAll('label')) {
                const d = label.firstElementChild;
                if (d && norm(d.textContent) === 'variable type') { header = d; break; }
            }
            if (!header) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute(BTN_ATTR, '1');
            btn.textContent = '⚡ Auto-map';
            btn.title = 'Field Filter → ' + name.split('_')[0] + ' → ' + (name.split('_')[SEARCH_PART_INDEX] || '');
            const s = (p, v) => btn.style.setProperty(p, v, 'important');
            s('float', 'right');
            s('padding', '2px 8px');
            s('border', 'none');
            s('border-radius', '4px');
            s('background', '#689636');
            s('color', '#fff');
            s('font-size', '12px');
            s('font-weight', 'bold');
            s('cursor', 'pointer');
            btn.addEventListener('click', e => {
                e.preventDefault();     // button sits inside a <label>: don't focus/open the select
                e.stopPropagation();
                run(name, btn);
            });
            header.appendChild(btn);
        });
    }

    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; inject(); });
    }).observe(document.body, { childList: true, subtree: true });
    inject();
    console.log('[quick-map] v3.4 loaded');
})();
