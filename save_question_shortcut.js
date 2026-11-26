// ==UserScript==
// @name         Metabase: Ctrl+S saves question
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Ctrl/Cmd+S clicks Metabase's Save button instead of opening the browser's Save dialog
// @author       Koojav
// @match        https://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SAVE_SEL = '[data-testid="qb-save-button"]';

    window.addEventListener('keydown', e => {
        const isSave = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
                       (e.key === 's' || e.key === 'S' || e.code === 'KeyS');
        if (!isSave) return;

        // always block the browser's Save dialog on these pages
        e.preventDefault();
        e.stopPropagation();

        const btn = document.querySelector(SAVE_SEL);
        if (btn && !btn.disabled) {
            btn.click();
        } else {
            console.log('[ctrl-s] Save button not available (no changes to save?)');
        }
    }, true);   // capture phase, so it runs before the SQL editor or the page can handle the key
})();
