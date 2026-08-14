// ==UserScript==
// @name         Anki Non-Word Highlighter
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Highlights words NOT present in Anki for SPA pages (Reddit, YouTube). Traverses Shadow DOM, uses node caching, and skips interactive elements.
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // === SETTINGS ===
    const ANKI_CONNECT_URL = 'http://127.0.0.1:8765';
    const TARGET_FIELDS = ['FrontSearch', 'Sentence'];
    const HIGHLIGHT_STYLE = 'background-color: rgba(255, 182, 193, 0.3) !important; border-bottom: 2px solid #FF69B4 !important; display: inline !important; color: inherit !important;';
    const SCAN_INTERVAL = 1500; // SPA scan interval in ms

    // Blacklisted tags to ignore
    const BLACKLIST_TAGS = ['BUTTON', 'A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'OPTION', 'SELECT', 'NAV', 'HEADER', 'FOOTER', 'SVG', 'TIME'];

    const processedNodes = new WeakMap();
    let currentWordSet = new Set();
    const segmenter = new Intl.Segmenter([], { granularity: 'word' });

    function ankiRequest(action, params = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: ANKI_CONNECT_URL,
                data: JSON.stringify({ action, version: 6, params }),
                headers: { "Content-Type": "application/json" },
                onload: (response) => {
                    try {
                        const json = JSON.parse(response.responseText);
                        if (json.error) reject(json.error);
                        else resolve(json.result);
                    } catch (e) { reject(e); }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    async function syncAnkiWords() {
        try {
            console.log('[Anki] Synchronizing database...');
            const noteIds = await ankiRequest('findNotes', { query: '-is:new' });
            const chunkSize = 5000;
            const uniqueWords = new Set();

            for (let i = 0; i < noteIds.length; i += chunkSize) {
                const chunk = noteIds.slice(i, i + chunkSize);
                const notesInfo = await ankiRequest('notesInfo', { notes: chunk });

                for (const note of notesInfo) {
                    for (const fieldName of TARGET_FIELDS) {
                        if (note.fields[fieldName]) {
                            let rawText = note.fields[fieldName].value.replace(/<\/?[^>]+(>|$)/g, "");
                            let cleanWord = rawText.trim().toLowerCase();
                            if (cleanWord) uniqueWords.add(cleanWord);
                        }
                    }
                }
            }

            const wordArray = Array.from(uniqueWords);
            localStorage.setItem('anki_words_cache', JSON.stringify(wordArray));
            localStorage.setItem('anki_last_sync', Date.now().toString());
            console.log(`[Anki] Synchronized ${wordArray.length} words.`);
            return wordArray;
        } catch (error) {
            console.error('[Anki] AnkiConnect error. Falling back to local cache.', error);
            return JSON.parse(localStorage.getItem('anki_words_cache') || '[]');
        }
    }

    function isInsideInteractive(node) {
        let parent = node.parentNode;
        let depth = 0;

        while (parent && depth < 4) {
            const tag = parent.tagName;
            if (BLACKLIST_TAGS.includes(tag)) return true;

            if (parent.getAttribute) {
                const role = parent.getAttribute('role');
                if (role === 'button' || role === 'link') return true;
            }

            parent = parent.parentNode || parent.host;
            depth++;
        }
        return false;
    }
    
    function collectTextNodes(root, nodes = []) {
        if (!root) return nodes;

        if (root.shadowRoot) {
            collectTextNodes(root.shadowRoot, nodes);
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const parentTag = node.parentNode?.tagName;
                if (!parentTag || ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT'].includes(parentTag)) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (node.parentNode.classList?.contains('anki-highlight')) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        while (walker.nextNode()) {
            const node = walker.currentNode;

            if (processedNodes.get(node) === node.nodeValue) {
                continue;
            }

            if (!isInsideInteractive(node)) {
                nodes.push(node);
            } else {
                processedNodes.set(node, node.nodeValue);
            }
        }

        let child = root.firstElementChild;
        while (child) {
            collectTextNodes(child, nodes);
            child = child.nextElementSibling;
        }

        return nodes;
    }

    function safeHighlight(segmenter, wordSet) {
        if (!wordSet) return;
        const textNodes = collectTextNodes(document.body);

        for (const node of textNodes) {
            const text = node.nodeValue;
            if (!text || !text.trim()) {
                processedNodes.set(node, text);
                continue;
            }

            const segments = segmenter.segment(text);
            const matches = [];

            for (const seg of segments) {
                if (seg.isWordLike && !wordSet.has(seg.segment.toLowerCase())) {
                    matches.push({
                        start: seg.index,
                        end: seg.index + seg.segment.length
                    });
                }
            }

            processedNodes.set(node, text);

            if (matches.length === 0) continue;

            let currentNode = node;
            for (let i = matches.length - 1; i >= 0; i--) {
                const match = matches[i];
                if (!currentNode.nodeValue || currentNode.nodeValue.length < match.end) continue;

                try {
                    const nextNode = currentNode.splitText(match.start);
                    nextNode.splitText(match.end - match.start);

                    const mark = document.createElement('mark');
                    mark.setAttribute('style', HIGHLIGHT_STYLE);
                    mark.className = 'anki-highlight';
                    mark.textContent = nextNode.nodeValue;

                    processedNodes.set(currentNode, currentNode.nodeValue);
                    processedNodes.set(nextNode, nextNode.nodeValue);

                    nextNode.parentNode.insertBefore(mark, nextNode);
                    nextNode.parentNode.removeChild(nextNode);
                } catch (e) {}
            }
        }
    }

    async function forceUpdateBase() {
        console.log('[Anki] User requested manual database update...');
        const words = await syncAnkiWords();
        currentWordSet = new Set(words);
        safeHighlight(segmenter, currentWordSet);
        alert(`Anki database updated successfully! Words cached: ${currentWordSet.size}`);
    }

    async function init() {
        GM_registerMenuCommand('🔄 Sync Anki Database', forceUpdateBase);

        const lastSync = parseInt(localStorage.getItem('anki_last_sync') || '0', 10);
        const oneDay = 24 * 60 * 60 * 1000;
        let words = JSON.parse(localStorage.getItem('anki_words_cache') || '[]');

        if (Date.now() - lastSync > oneDay || words.length === 0) {
            words = await syncAnkiWords();
        }

        currentWordSet = new Set(words);

        safeHighlight(segmenter, currentWordSet);
        setInterval(() => {
            safeHighlight(segmenter, currentWordSet);
        }, SCAN_INTERVAL);
    }

    init();
})();