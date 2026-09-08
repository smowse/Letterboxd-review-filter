// ==UserScript==
// @name         Letterboxd Review Filter
// @namespace    https://letterboxd.com/
// @version      1.0.0
// @description  Hides joke/tweet-style reviews on Letterboxd using tunable heuristics. Flag corrections to improve it over time.
// @author       you
// @match        https://letterboxd.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ======================================================================
   * SELECTORS — READ THIS FIRST
   * ----------------------------------------------------------------------
   * These are Letterboxd's known/typical markup patterns for review list
   * items. I wasn't able to fetch a live page from this environment to
   * confirm today's exact classnames, so each list below is tried in order
   * and the script also falls back to a heuristic scan (any element that
   * contains both a paragraph of text and a star-rating span).
   *
   * If nothing gets hidden after a few minutes of browsing:
   *   1. Right-click a review on letterboxd.com -> Inspect
   *   2. Find the repeating wrapper element for one review (usually an <li>)
   *   3. Add its selector to REVIEW_CONTAINER_SELECTORS below
   *   4. Same idea for the review text and star rating if needed
   *   5. Set DEBUG = true and check the console for what's being found
   * ==================================================================== */

  const DEBUG = false;

  const REVIEW_CONTAINER_SELECTORS = [
    'article.production-viewing',
    'li.film-detail',
    'li.production-viewing',
    'div.film-detail-content',
    'div.review.card',
    'li[data-review-id]',
    'div[data-review-id]',
    'article[data-viewing-id]',
  ];

  const REVIEW_TEXT_SELECTORS = [
    '.js-review-body',
    '.review.body-text',
    '.body-text',
    '.collapsible-text',
    'div[class*="body-text"]',
    'p',
  ];

  const RATING_SELECTOR = '.inline-rating, span.rating, span[class*="rated-"], svg.-rating';
  const AUTHOR_SELECTORS = ['strong.displayname', '.attribution .name', 'a.avatar img[alt]', '.name'];

  /* ======================================================================
   * DEFAULT CONFIG — persisted to Tampermonkey storage and editable via
   * the in-page settings panel (strictness + custom phrases). Individual
   * signal weights auto-tune slightly whenever you flag a correction.
   * ==================================================================== */

  const DEFAULTS = {
    threshold: 10, // conservative: needs several signals to agree before hiding
    weights: {
      shortText: 4,
      ratingOnly: 5,
      internetVoice: 2,
      emojiHeavy: 2,
      memeEmoji: 3,
      allCaps: 2,
      punchlineEnding: 2,
      twitterPhrase: 3,
      filmVocab: 2,      // subtracted per hit (keep-signal)
      substantialLength: 3, // subtracted flat (keep-signal)
    },
    phrases: [
      'understood the assignment', 'so real for this', 'he was so back',
      'she was so back', 'mother is mothering', 'it’s giving', 'its giving',
      'no thoughts just', 'rent free', 'delulu', 'villain era',
      'unemployed behavior', 'not me ', 'core memory',
      'ate and left no crumbs', 'said what she said', 'said what he said',
      'main character energy', 'i fear', 'the audacity', 'bestie', 'slay',
      'fr fr', 'no cap', 'on god', 'lowkey', 'highkey',
    ],
    keepWords: [
      'cinematography', 'performance', 'perform', 'direction', 'directing',
      'director', 'pacing', 'screenplay', 'score', 'soundtrack', 'editing',
      'narrative', 'character', 'plot', 'theme', 'themes', 'visually',
      'visual', 'acting', 'dialogue', 'shot', 'framing', 'composition',
      'tone', 'structure', 'symbolism', 'metaphor', 'runtime',
    ],
    usernameWhitelist: [],
  };

  const MEME_EMOJI = ['💀', '🧍', '😭'];
  const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

  /* ======================================================================
   * STORAGE
   * ==================================================================== */

  function loadJSON(key, fallback) {
    try {
      const raw = GM_getValue(key, null);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  let config = loadJSON('lbrf_config', DEFAULTS);
  // merge in any new default keys without clobbering user edits
  config.weights = Object.assign({}, DEFAULTS.weights, config.weights);
  config.phrases = config.phrases || DEFAULTS.phrases.slice();
  config.keepWords = config.keepWords || DEFAULTS.keepWords.slice();
  config.usernameWhitelist = (config.usernameWhitelist || DEFAULTS.usernameWhitelist.slice()).map((u) => u.toLowerCase());

  let allowlist = new Set(loadJSON('lbrf_allow', []));  // review IDs to never hide
  let denylist = new Set(loadJSON('lbrf_deny', []));    // review IDs to always hide
  let stats = loadJSON('lbrf_stats', { hidden: 0, corrections: 0 });

  function persistAll() {
    saveJSON('lbrf_config', config);
    saveJSON('lbrf_allow', Array.from(allowlist));
    saveJSON('lbrf_deny', Array.from(denylist));
    saveJSON('lbrf_stats', stats);
  }

  /* ======================================================================
   * FRIEND LIST IMPORT
   * ----------------------------------------------------------------------
   * Fetches the given user's "following" pages (same-origin, so your
   * existing Letterboxd session cookie is used automatically) and pulls
   * usernames from every profile link found. Pagination is discovered by
   * scanning each page's HTML for "/following/page/N/" links rather than
   * assuming a fixed page count or a specific "next" button class, since
   * that markup wasn't independently verified here.
   * ==================================================================== */

  async function importFollowing(username) {
    const clean = username.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) throw new Error('No username provided');
    const base = `https://letterboxd.com/${clean}/following/`;
    const collected = new Set();
    let maxPage = 1;

    for (let page = 1; page <= maxPage && page <= 25; page++) {
      const url = page === 1 ? base : `${base}page/${page}/`;
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        if (page === 1) throw new Error('Could not load that profile (check the username / privacy settings)');
        break;
      }
      const html = await res.text();

      const pageNums = [...html.matchAll(/\/following\/page\/(\d+)\//g)].map((m) => Number(m[1]));
      if (pageNums.length) maxPage = Math.max(maxPage, ...pageNums);

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const links = doc.querySelectorAll('a.avatar[href]');
      if (!links.length && page === 1) throw new Error('No profiles found — is the username right?');
      links.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const slug = href.replace(/^\/+|\/+$/g, '').split('/')[0];
        if (slug && slug.toLowerCase() !== clean.toLowerCase()) collected.add(slug.toLowerCase());
      });
    }

    return Array.from(collected);
  }

  /* ======================================================================
   * SCORING
   * ==================================================================== */

  function hashId(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (h * 33) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  function scoreReview(text, hasRating) {
    const trimmed = text.trim();
    const len = trimmed.length;
    const words = trimmed.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const lower = trimmed.toLowerCase();
    const hits = [];
    const w = config.weights;

    if (len === 0) return { score: -999, hits: [] }; // nothing to judge, leave alone

    if (len < 50) hits.push(['shortText', w.shortText]);
    if (len < 12 && hasRating) hits.push(['ratingOnly', w.ratingOnly]);

    const startsLower = /^[a-z]/.test(trimmed);
    const endsNoPunct = !/[.!?"')]$/.test(trimmed);
    if (startsLower && endsNoPunct && wordCount > 2) {
      hits.push(['internetVoice', w.internetVoice]);
    }

    const emojiMatches = trimmed.match(EMOJI_REGEX) || [];
    if (emojiMatches.length >= 2 && emojiMatches.length / Math.max(wordCount, 1) > 0.15) {
      hits.push(['emojiHeavy', w.emojiHeavy]);
    }
    if (MEME_EMOJI.some((e) => trimmed.includes(e))) {
      hits.push(['memeEmoji', w.memeEmoji]);
    }

    const capsWords = words.filter((word) => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word));
    if (capsWords.length >= 2) hits.push(['allCaps', w.allCaps]);

    if (/(\.\.\.|—|--)\s*$/.test(trimmed)) hits.push(['punchlineEnding', w.punchlineEnding]);

    let phraseHits = 0;
    for (const phrase of config.phrases) {
      if (phrase && lower.includes(phrase.toLowerCase())) phraseHits++;
    }
    if (phraseHits > 0) hits.push(['twitterPhrase', w.twitterPhrase * Math.min(phraseHits, 3)]);

    let keepHits = 0;
    for (const word of config.keepWords) {
      if (lower.includes(word)) keepHits++;
    }
    if (keepHits > 0) hits.push(['filmVocab', -w.filmVocab * Math.min(keepHits, 4)]);

    if (wordCount > 40) hits.push(['substantialLength', -w.substantialLength]);

    const score = hits.reduce((sum, [, val]) => sum + val, 0);
    return { score, hits };
  }

  function nudgeWeights(hits, direction) {
    // direction: +1 reinforces (weights that fired should count more),
    // -1 corrects (weights that fired were wrong, count less)
    const step = 0.5;
    for (const [signal] of hits) {
      if (signal === 'filmVocab' || signal === 'substantialLength') continue; // don't erode keep-signals
      const cur = config.weights[signal] ?? 0;
      const next = direction > 0 ? cur + step : Math.max(0, cur - step);
      config.weights[signal] = Math.min(next, DEFAULTS.weights[signal] * 3);
    }
  }

  /* ======================================================================
   * DOM SCANNING
   * ==================================================================== */

  function findReviewNodes(root) {
    for (const sel of REVIEW_CONTAINER_SELECTORS) {
      const found = root.querySelectorAll(sel);
      if (found.length) {
        if (DEBUG) console.log('[LBRF] matched container selector:', sel, found.length);
        return Array.from(found);
      }
    }
    // heuristic fallback: elements with a rating span nearby a text block
    const ratingSpans = root.querySelectorAll(RATING_SELECTOR);
    const candidates = new Set();
    ratingSpans.forEach((span) => {
      const container = span.closest('li, div.review, article');
      if (container) candidates.add(container);
    });
    if (DEBUG) console.log('[LBRF] heuristic fallback candidates:', candidates.size);
    return Array.from(candidates);
  }

  function extractText(node) {
    for (const sel of REVIEW_TEXT_SELECTORS) {
      const el = node.querySelector(sel);
      if (el && el.textContent.trim().length > 0) {
        return el.textContent.trim();
      }
    }
    return '';
  }

  function extractAuthor(node) {
    for (const sel of AUTHOR_SELECTORS) {
      const el = node.querySelector(sel);
      if (el) return (el.getAttribute('alt') || el.textContent || '').trim();
    }
    return '';
  }

  function extractUsername(node) {
    // The visible display name can be styled/decorated (emoji, symbols, etc.),
    // so pull the real username slug from a profile link's href instead.
    const link = node.querySelector('a.avatar[href], a.context[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const slug = href.replace(/^\/+|\/+$/g, '').split('/')[0];
      if (slug) return slug.toLowerCase();
    }
    return '';
  }

  function processNode(node) {
    if (node.dataset.lbrfProcessed) return;
    node.dataset.lbrfProcessed = '1';

    const text = extractText(node);
    if (!text) return;

    const username = extractUsername(node);
    if (username && config.usernameWhitelist.includes(username)) {
      annotateShown(node);
      return;
    }

    const hasRating = !!node.querySelector(RATING_SELECTOR);
    const author = extractAuthor(node);
    const nativeId = node.dataset.viewingId || node.getAttribute('data-viewing-id');
    const id = nativeId ? 'v' + nativeId : hashId(author + '::' + text.slice(0, 80));

    if (allowlist.has(id)) {
      annotateShown(node);
      return;
    }

    const { score, hits } = scoreReview(text, hasRating);
    const shouldHide = denylist.has(id) || score >= config.threshold;

    if (shouldHide) {
      collapseReview(node, id, hits);
    } else {
      annotateShown(node);
    }
  }

  /* ======================================================================
   * UI — collapsed bar + inline "hide this" affordance
   * ==================================================================== */

  function collapseReview(node, id, hits) {
    if (node.dataset.lbrfCollapsed) return;
    node.dataset.lbrfCollapsed = '1';
    node.classList.add('lbrf-host');
    stats.hidden++;
    persistAll();

    const reasons = hits.filter(([, v]) => v > 0).map(([k]) => k).join(', ') || 'pattern match';

    // Hide each original top-level child IN PLACE rather than moving them into
    // a wrapper — Letterboxd's own flex/grid row styling depends on the avatar
    // and body being direct children of this element, so wrapping them breaks
    // the layout the moment they're shown again. Toggling this element's own
    // display mode (via the lbrf-host class) is safe either way since it
    // doesn't change which elements are direct children of what.
    const originalChildren = Array.from(node.children).filter(
      (c) => !c.classList.contains('lbrf-bar') && !c.classList.contains('lbrf-hide-toggle')
    );
    originalChildren.forEach((c) => {
      c.dataset.lbrfPrevDisplay = c.style.display;
      c.style.display = 'none';
    });

    const restoreOriginal = () => {
      node.classList.remove('lbrf-host');
      originalChildren.forEach((c) => {
        c.style.display = c.dataset.lbrfPrevDisplay || '';
        delete c.dataset.lbrfPrevDisplay;
      });
    };

    const bar = document.createElement('div');
    bar.className = 'lbrf-bar';
    bar.title = 'Signals: ' + reasons;
    bar.innerHTML = `
      <span class="lbrf-bar-label">Review hidden — looked like a joke/tweet</span>
      <span class="lbrf-bar-actions">
        <button class="lbrf-btn lbrf-btn-ghost" data-action="show">Show</button>
        <button class="lbrf-btn lbrf-btn-primary" data-action="wrong">Not a joke</button>
      </span>
    `;
    node.appendChild(bar);

    bar.querySelector('[data-action="show"]').addEventListener('click', () => {
      restoreOriginal();
      bar.style.display = 'none';
      annotateShown(node); // so it can still be flagged/re-hidden after showing
    });

    bar.querySelector('[data-action="wrong"]').addEventListener('click', () => {
      allowlist.add(id);
      denylist.delete(id);
      nudgeWeights(hits, -1);
      stats.corrections++;
      persistAll();
      restoreOriginal();
      bar.remove();
      annotateShown(node, true);
    });
  }

  function annotateShown(node, corrected) {
    if (node.querySelector('.lbrf-hide-toggle')) return;
    const toggle = document.createElement('button');
    toggle.className = 'lbrf-hide-toggle' + (corrected ? ' lbrf-hide-toggle-corrected' : '');
    toggle.textContent = corrected ? 'learned ✓' : 'hide this';
    toggle.title = 'Manually hide this review and teach the filter';
    toggle.style.opacity = corrected ? '1' : '0';
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const text = extractText(node);
      const author = extractAuthor(node);
      const nativeId = node.dataset.viewingId || node.getAttribute('data-viewing-id');
      const id = nativeId ? 'v' + nativeId : hashId(author + '::' + text.slice(0, 80));
      const { hits } = scoreReview(text, !!node.querySelector(RATING_SELECTOR));
      denylist.add(id);
      allowlist.delete(id);
      nudgeWeights(hits, +1);
      stats.corrections++;
      persistAll();
      collapseReview(node, id, hits);
      toggle.remove();
    });
    node.style.position = node.style.position || 'relative';
    node.addEventListener('mouseenter', () => { toggle.style.opacity = '1'; });
    node.addEventListener('mouseleave', () => {
      if (!toggle.classList.contains('lbrf-hide-toggle-corrected')) toggle.style.opacity = '0';
    });
    node.appendChild(toggle);
  }

  /* ======================================================================
   * SCAN + OBSERVE
   * ==================================================================== */

  function scan(root) {
    const nodes = findReviewNodes(root);
    nodes.forEach(processNode);
  }

  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) scan(n);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  /* ======================================================================
   * SETTINGS PANEL — Letterboxd-styled
   * ==================================================================== */

  GM_addStyle(`
    :root {
      --lbrf-bg: #14181c;
      --lbrf-panel: #2c3440;
      --lbrf-panel-alt: #1d252e;
      --lbrf-border: #3d4854;
      --lbrf-text: #9ab;
      --lbrf-text-bright: #ffffff;
      --lbrf-text-dim: #67788c;
      --lbrf-green: #00e054;
      --lbrf-orange: #ff8000;
    }
    .lbrf-host { display: block !important; }
    .lbrf-bar {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      box-sizing: border-box;
      background: var(--lbrf-panel);
      border-left: 3px solid var(--lbrf-green);
      border-radius: 3px;
      padding: 8px 14px;
      margin: 4px 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .lbrf-bar-label {
      font-size: 12px;
      line-height: 1.4;
      color: var(--lbrf-text-dim);
      letter-spacing: 0.02em;
    }
    .lbrf-bar-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .lbrf-btn {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: 3px;
      padding: 5px 10px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .lbrf-btn-ghost {
      background: transparent;
      color: var(--lbrf-text);
      border-color: var(--lbrf-border);
    }
    .lbrf-btn-ghost:hover { color: var(--lbrf-text-bright); border-color: var(--lbrf-text); }
    .lbrf-btn-primary {
      background: var(--lbrf-green);
      color: #04140a;
    }
    .lbrf-btn-primary:hover { filter: brightness(1.1); }
    .lbrf-hide-toggle {
      position: absolute;
      top: 4px;
      right: 4px;
      z-index: 50;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--lbrf-panel-alt);
      color: var(--lbrf-text);
      border: 1px solid var(--lbrf-border);
      border-radius: 3px;
      padding: 3px 7px;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .lbrf-hide-toggle-corrected { color: var(--lbrf-green); opacity: 1; }

    #lbrf-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--lbrf-panel);
      border: 1px solid var(--lbrf-border);
      color: var(--lbrf-green);
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    #lbrf-panel {
      position: fixed;
      bottom: 74px;
      right: 20px;
      width: 300px;
      background: var(--lbrf-bg);
      border: 1px solid var(--lbrf-border);
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: none;
      overflow: hidden;
    }
    #lbrf-panel.open { display: block; }
    #lbrf-panel-header {
      background: var(--lbrf-panel);
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--lbrf-border);
    }
    #lbrf-panel-header span {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--lbrf-text-bright);
    }
    #lbrf-panel-header button {
      background: none; border: none; color: var(--lbrf-text-dim);
      cursor: pointer; font-size: 14px;
    }
    .lbrf-section { padding: 12px; border-bottom: 1px solid var(--lbrf-border); }
    .lbrf-section:last-child { border-bottom: none; }
    .lbrf-section-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--lbrf-text-dim);
      margin-bottom: 8px;
    }
    .lbrf-strictness { display: flex; gap: 6px; }
    .lbrf-strictness button {
      flex: 1;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 6px 4px;
      background: var(--lbrf-panel-alt);
      color: var(--lbrf-text);
      border: 1px solid var(--lbrf-border);
      border-radius: 3px;
      cursor: pointer;
    }
    .lbrf-strictness button.active {
      background: var(--lbrf-green);
      color: #04140a;
      border-color: var(--lbrf-green);
    }
    .lbrf-stats { font-size: 12px; color: var(--lbrf-text); line-height: 1.6; }
    .lbrf-stats b { color: var(--lbrf-orange); }
    textarea.lbrf-phrases {
      width: 100%;
      height: 80px;
      background: var(--lbrf-panel-alt);
      color: var(--lbrf-text);
      border: 1px solid var(--lbrf-border);
      border-radius: 3px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 6px;
      resize: vertical;
      box-sizing: border-box;
    }
    input.lbrf-input {
      width: 100%;
      background: var(--lbrf-panel-alt);
      color: var(--lbrf-text);
      border: 1px solid var(--lbrf-border);
      border-radius: 3px;
      font-size: 11px;
      padding: 7px 8px;
      box-sizing: border-box;
      margin-bottom: 6px;
    }
    .lbrf-save {
      margin-top: 6px;
      width: 100%;
    }
    .lbrf-reset {
      width: 100%;
      background: transparent;
      color: var(--lbrf-text-dim);
      border: 1px solid var(--lbrf-border);
      border-radius: 3px;
      padding: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      cursor: pointer;
    }
    .lbrf-reset:hover { color: var(--lbrf-orange); border-color: var(--lbrf-orange); }
    .lbrf-hint { font-size: 11px; color: var(--lbrf-text-dim); line-height: 1.5; }
  `);

  const fab = document.createElement('div');
  fab.id = 'lbrf-fab';
  fab.textContent = '⟁';
  fab.title = 'Review Filter settings';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'lbrf-panel';
  panel.innerHTML = `
    <div id="lbrf-panel-header">
      <span>Review Filter</span>
      <button id="lbrf-close">✕</button>
    </div>
    <div class="lbrf-section">
      <div class="lbrf-section-title">Strictness</div>
      <div class="lbrf-strictness">
        <button data-threshold="10">Conservative</button>
        <button data-threshold="6">Balanced</button>
        <button data-threshold="3">Aggressive</button>
      </div>
    </div>
    <div class="lbrf-section">
      <div class="lbrf-section-title">This session</div>
      <div class="lbrf-stats">
        <div><b id="lbrf-stat-hidden">0</b> reviews hidden</div>
        <div><b id="lbrf-stat-corrections">0</b> corrections learned</div>
      </div>
    </div>
    <div class="lbrf-section">
      <div class="lbrf-section-title">Custom phrases to catch</div>
      <textarea class="lbrf-phrases" id="lbrf-phrases"></textarea>
      <button class="lbrf-btn lbrf-btn-primary lbrf-save" id="lbrf-save">Save phrases</button>
    </div>
    <div class="lbrf-section">
      <div class="lbrf-section-title">Always show these users</div>
      <textarea class="lbrf-phrases" id="lbrf-users" placeholder="one username per line"></textarea>
      <button class="lbrf-btn lbrf-btn-primary lbrf-save" id="lbrf-save-users">Save usernames</button>
      <div style="height: 10px"></div>
      <input class="lbrf-input" id="lbrf-own-username" type="text" placeholder="Your Letterboxd username" />
      <button class="lbrf-btn lbrf-btn-ghost" id="lbrf-import" style="width: 100%;">Import following list</button>
      <div class="lbrf-hint" id="lbrf-import-status" style="margin-top: 6px;"></div>
    </div>
    <div class="lbrf-section">
      <button class="lbrf-reset" id="lbrf-reset">Reset all learning</button>
    </div>
    <div class="lbrf-section">
      <div class="lbrf-hint">Hover any review for a "hide this" button. Click "Not a joke" on a hidden one to teach the filter.</div>
    </div>
  `;
  document.body.appendChild(panel);

  fab.addEventListener('click', () => {
    panel.classList.toggle('open');
    refreshPanel();
  });
  panel.querySelector('#lbrf-close').addEventListener('click', () => panel.classList.remove('open'));

  panel.querySelectorAll('.lbrf-strictness button').forEach((btn) => {
    btn.addEventListener('click', () => {
      config.threshold = Number(btn.dataset.threshold);
      persistAll();
      refreshPanel();
    });
  });

  panel.querySelector('#lbrf-save').addEventListener('click', () => {
    const raw = panel.querySelector('#lbrf-phrases').value;
    config.phrases = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    persistAll();
  });

  panel.querySelector('#lbrf-save-users').addEventListener('click', () => {
    const raw = panel.querySelector('#lbrf-users').value;
    config.usernameWhitelist = raw.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    persistAll();
  });

  panel.querySelector('#lbrf-import').addEventListener('click', async () => {
    const btn = panel.querySelector('#lbrf-import');
    const status = panel.querySelector('#lbrf-import-status');
    const uname = panel.querySelector('#lbrf-own-username').value.trim();
    if (!uname) {
      status.textContent = 'Enter your username first.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';
    try {
      const imported = await importFollowing(uname);
      const merged = new Set([...config.usernameWhitelist, ...imported]);
      config.usernameWhitelist = Array.from(merged);
      persistAll();
      panel.querySelector('#lbrf-users').value = config.usernameWhitelist.join('\n');
      status.textContent = `Imported ${imported.length} usernames (${config.usernameWhitelist.length} total whitelisted).`;
    } catch (e) {
      status.textContent = e.message || 'Import failed.';
    }
    btn.disabled = false;
    btn.textContent = 'Import following list';
  });

  panel.querySelector('#lbrf-reset').addEventListener('click', () => {
    if (!confirm('Reset weights, phrase list, and all learned corrections?')) return;
    config = JSON.parse(JSON.stringify(DEFAULTS));
    allowlist = new Set();
    denylist = new Set();
    stats = { hidden: 0, corrections: 0 };
    persistAll();
    refreshPanel();
    location.reload();
  });

  function refreshPanel() {
    panel.querySelectorAll('.lbrf-strictness button').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.threshold) === config.threshold);
    });
    panel.querySelector('#lbrf-stat-hidden').textContent = stats.hidden;
    panel.querySelector('#lbrf-stat-corrections').textContent = stats.corrections;
    panel.querySelector('#lbrf-phrases').value = config.phrases.join('\n');
    panel.querySelector('#lbrf-users').value = config.usernameWhitelist.join('\n');
  }
  refreshPanel();

  if (DEBUG) console.log('[LBRF] initialized', config);
})();
