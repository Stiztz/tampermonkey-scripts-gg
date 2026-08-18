// ==UserScript==
// @name         Dibu Scraper (CS2)
// @namespace    https://github.com/Stiztz/tampermonkey-scripts-gg
// @version      1.6.6
// @description  bb scraper
// @icon         https://betboom.ru/favicon.ico
// @author       GG
// @match        https://betboom.ru/esport/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Stiztz/tampermonkey-scripts-gg/main/dibu-scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/Stiztz/tampermonkey-scripts-gg/main/dibu-scraper.user.js
// ==/UserScript==

/* eslint-disable no-bitwise */

// IMPORTANT: this script must run in the PAGE context, not in Tampermonkey's
// sandbox. Any @grant other than `none` makes TM wrap the script so that
// `window` is an isolated proxy — assigning window.WebSocket there does NOT
// patch the real one and no frames are ever intercepted. Keep @grant none.

(function () {
    'use strict';

    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    // Read from the metadata block so it can never drift from @version.
    const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.6.0';

    if (window.top !== window.self) return;
    if (PAGE.__dibuLoaded) return;
    PAGE.__dibuLoaded = true;

    // =====================================================================
    // 1. PROTOBUF — schemaless decoder
    // =====================================================================

    function decodePB(buf, depth) {
        depth = depth || 0;
        const out = {};
        let i = 0;
        let bad = false;

        function readVarint() {
            let r = 0, s = 0;
            while (i < buf.length) {
                const b = buf[i++];
                r += (b & 0x7f) * Math.pow(2, s);
                if (!(b & 0x80)) return r;
                s += 7;
                if (s > 63) { bad = true; return 0; }
            }
            bad = true; // truncated varint -> wrong header offset
            return 0;
        }

        function push(field, val) {
            if (out[field] === undefined) out[field] = val;
            else if (Array.isArray(out[field])) out[field].push(val);
            else out[field] = [out[field], val];
        }

        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        while (i < buf.length) {
            const key = readVarint();
            if (bad) return null;
            const field = key >> 3;
            const wire = key & 7;
            if (field === 0) return null;

            if (wire === 0) {
                const v = readVarint();
                if (bad) return null;
                push(field, v);
            } else if (wire === 1) {
                if (i + 8 > buf.length) return null;
                push(field, dv.getFloat64(i, true)); i += 8;
            } else if (wire === 5) {
                if (i + 4 > buf.length) return null;
                push(field, dv.getFloat32(i, true)); i += 4;
            } else if (wire === 2) {
                const len = readVarint();
                if (bad || i + len > buf.length) return null;
                const sub = buf.subarray(i, i + len);
                i += len;
                push(field, decodeLenDelim(sub, depth));
            } else {
                return null;
            }
        }
        return out;
    }

    // A length-delimited block can be a submessage, a string or raw bytes.
    // Some short strings are ALSO valid protobuf: "mac10" starts with 'm' (0x6D)
    // = field 13 / wire 5 (float32) followed by exactly 4 bytes. Tie-breaker:
    // printable text with no control chars wins. Real submessages almost always
    // start with a control key byte (0x08, 0x0A, 0x12...).
    function decodeLenDelim(sub, depth) {
        if (sub.length === 0) return '';
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(sub); }
        catch (e) { text = null; }
        if (text !== null) {
            let printable = true;
            for (let n = 0; n < text.length; n++) {
                const c = text.charCodeAt(n);
                if (c < 0x20 || c === 0x7f) { printable = false; break; }
            }
            if (printable) return text;
        }
        if (depth < 10) {
            const msg = decodePB(sub, depth + 1);
            if (msg && Object.keys(msg).length > 0) return msg;
        }
        if (text !== null) return text;
        return Array.from(sub).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function parseFrame(arrayBuffer) {
        const buf = new Uint8Array(arrayBuffer);
        for (const off of [3, 4, 0, 5]) {
            if (off >= buf.length) continue;
            const d = decodePB(buf.subarray(off));
            if (d && Object.keys(d).length > 1) return d;
        }
        return null;
    }

    // --- minimal encoder, only for the grid_widget subscription ---
    function varintBytes(n) {
        const b = [];
        do { let x = n & 0x7f; n = Math.floor(n / 128); if (n > 0) x |= 0x80; b.push(x); } while (n > 0);
        return b;
    }
    function concatBytes(arrs) {
        const total = arrs.reduce((s, a) => s + a.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const a of arrs) { out.set(a, o); o += a.length; }
        return out;
    }
    function pbStr(field, str) {
        const bytes = new TextEncoder().encode(str);
        return concatBytes([
            new Uint8Array(varintBytes((field << 3) | 2)),
            new Uint8Array(varintBytes(bytes.length)),
            bytes,
        ]);
    }
    function encodeGridSub(subId, matchId) {
        const inner = concatBytes([pbStr(1, subId), pbStr(2, String(matchId))]);
        return concatBytes([
            new Uint8Array(varintBytes((2 << 3) | 2)),
            new Uint8Array(varintBytes(inner.length)),
            inner,
        ]);
    }
    const randomSubId = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');

    // =====================================================================
    // 2. STORAGE
    // =====================================================================

    function store(key, val) {
        try {
            if (val === undefined) {
                const v = localStorage.getItem('dibu:' + key);
                return v === null ? undefined : JSON.parse(v);
            }
            localStorage.setItem('dibu:' + key, JSON.stringify(val));
        } catch (e) { /* private mode, quota */ }
        return undefined;
    }

    // =====================================================================
    // 3. SOUND
    // =====================================================================

    let AC = null;
    function audioCtx() {
        if (AC) return AC;
        try {
            const Ctor = PAGE.AudioContext || PAGE.webkitAudioContext;
            if (Ctor) AC = new Ctor();
        } catch (e) { AC = null; }
        return AC;
    }

    function beep(freq, dur, type, gain, delay) {
        const ac = audioCtx();
        if (!ac || S.mute) return;
        if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* noop */ } }
        const t0 = ac.currentTime + (delay || 0);
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g); g.connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
    }

    // Dry percussive hit: filtered noise burst plus a low body thump.
    function thud() {
        const ac = audioCtx();
        if (!ac || S.mute) return;
        if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* noop */ } }
        const dur = 0.16;
        const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2);
        }
        const src = ac.createBufferSource();
        src.buffer = buf;
        const filt = ac.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(460, ac.currentTime);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.34, ac.currentTime);
        src.connect(filt); filt.connect(g); g.connect(ac.destination);
        src.start();
        beep(88, 0.13, 'sine', 0.2);
    }

    const SFX = {
        // Home kills ring bright and upward, away kills land low and dull, so
        // you can tell who got the frag without looking at the panel.
        killHome() { beep(1046, 0.09, 'triangle', 0.16); beep(1568, 0.08, 'triangle', 0.11, 0.045); },
        killAway() { beep(392, 0.11, 'sawtooth', 0.11); beep(262, 0.12, 'sawtooth', 0.09, 0.05); },
        roundStart() { beep(523, 0.08, 'sine', 0.13); beep(659, 0.08, 'sine', 0.13, 0.085); beep(784, 0.14, 'sine', 0.14, 0.17); },
        bomb() { for (let i = 0; i < 3; i++) beep(1180, 0.055, 'square', 0.14, i * 0.13); },
        roundEnd() { thud(); },
    };

    function play(name) {
        if (S.mute || !S.soundReady) return;
        const fn = SFX[name];
        if (fn) { try { fn(); } catch (e) { /* noop */ } }
    }

    // =====================================================================
    // 4. STATE
    // =====================================================================

    const arr = v => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));

    const S = {
        gridSockets: [],
        matches: new Map(),
        tournaments: new Map(),
        games: new Map(),
        odds: new Map(),
        active: null,
        activePinned: false,
        userPicked: false,
        retries: new Map(),
        probe: new Map(),
        lastProbe: 0,
        lat: [],
        latByMatch: new Map(),
        clockOffset: null,
        sessionStart: Date.now(),
        onlyReadable: true,
        mktDebug: false,
        mktSeen: new Map(),
        codeSeen: new Map(),
        gridUrl: null,
        ownSocket: null,
        lastOwnOpen: 0,
        selectedMapNum: null,
        expandedPlayer: null,
        wpScope: 'match',
        oddsLogOpen: false,
        open: false,
        dirty: true,
        mute: store('mute') === true,
        soundReady: false,
        lastResub: 0,
        rx: { tree: 0, grid: 0, bad: 0, sockets: 0 },
    };

    function newGame(matchId) {
        return {
            matchId,
            phase: null, phaseStart: null, phaseDur: null,
            teams: [], maps: [], liveMapNum: null,
            stats: {}, roundHistory: {}, prevRounds: {},
            events: [], seenKills: new Set(),
            bombPlanted: false, lastUpdate: 0,
        };
    }

    const EMPTY_STAT = { k: 0, d: 0, a: 0, hs: 0, h1: 0, h2: 0, ot: 0, weapons: {} };

    function statFor(g, mapNum, steamId) {
        if (!g.stats[mapNum]) g.stats[mapNum] = {};
        if (!g.stats[mapNum][steamId]) {
            g.stats[mapNum][steamId] = { k: 0, d: 0, a: 0, hs: 0, h1: 0, h2: 0, ot: 0, weapons: {} };
        }
        return g.stats[mapNum][steamId];
    }

    // =====================================================================
    // 5. WEBSOCKET HOOK
    // =====================================================================

    const OrigWS = PAGE.WebSocket;

    function sendSub(sock, matchId) {
        try { sock.send(encodeGridSub(randomSubId(), matchId)); return true; }
        catch (e) { return false; }
    }

    function HookedWS(url, protocols) {
        const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
        const isGrid = /grid_widget_ws/.test(url);
        const isTree = /tree_ws/.test(url);

        if (isGrid) {
            S.gridUrl = url;
            S.gridSockets.push(ws);
            // The site tears this socket down and rebuilds it between maps. When
            // a fresh one opens, re-assert our own subscription instead of
            // relying on the page to re-subscribe for us.
            ws.addEventListener('open', () => {
                if (S.active) setTimeout(() => sendSub(ws, S.active), 400);
            });
            ws.addEventListener('close', () => {
                S.gridSockets = S.gridSockets.filter(s => s !== ws);
            });
        }
        if (isTree && !S.gridUrl) {
            // Same host and API version, different path — lets us open our own
            // grid socket if the page never opens one.
            S.gridUrl = url.replace('/api/tree_ws/', '/api/grid_widget_ws/');
        }
        if (isGrid || isTree) {
            S.rx.sockets++;
            ws.addEventListener('message', async ev => {
                try {
                    let ab = null;
                    if (ev.data instanceof ArrayBuffer) ab = ev.data;
                    else if (ev.data && typeof ev.data.arrayBuffer === 'function') ab = await ev.data.arrayBuffer();
                    else return; // pings are plain text
                    const msg = parseFrame(ab);
                    if (!msg) { S.rx.bad++; return; }
                    if (isGrid) { S.rx.grid++; handleGrid(msg); }
                    else { S.rx.tree++; handleTree(msg); }
                } catch (e) { /* never break the page */ }
            });
        }
        return ws;
    }
    HookedWS.prototype = OrigWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { HookedWS[k] = OrigWS[k]; });
    try { PAGE.WebSocket = HookedWS; }
    catch (e) { console.error('[Dibu] could not patch WebSocket:', e); }

    // =====================================================================
    // 6. TREE_WS — matches, tournaments, odds, logos
    // =====================================================================

    function walkObjects(node, fn, depth) {
        depth = depth || 0;
        if (depth > 14 || !node || typeof node !== 'object' || Array.isArray(node)) return;
        fn(node);
        for (const k in node) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(x => walkObjects(x, fn, depth + 1));
            else walkObjects(v, fn, depth + 1);
        }
    }

    // Market winner is 8489. Map-winner market IDs are NOT stable across
    // matches (the CS2 capture showed 8494/8595, but other events use different
    // IDs), so map markets are detected by their scope SLUG instead — that is
    // semantic and consistent. We only need a two-way market (home/away), which
    // any "winner" scope provides.
    const MARKET_MATCH = 8489;

    // Selection codes, written as escapes ON PURPOSE. The draw arrives as \u0425,
    // the CYRILLIC Х — a different character from the Latin X (\u0058) that
    // renders identically, so a `=== 'X'` typed with the wrong keyboard layout
    // drops every draw price in silence and looks like the feed never sent one.
    // Same trap for \u041F (П) versus a Latin P. Both spellings are accepted.
    const SEL = {
        '\u041F1': 'home', 'P1': 'home',
        '\u041F2': 'away', 'P2': 'away',
        '\u0425': 'draw', 'X': 'draw', '\u041F3': 'draw', 'P3': 'draw',
    };
    const selOf = code => SEL[code] || null;

    // A scope that names a single map, matched from the slug or the human label.
    // Covers "map-1", "map1", "Карта 2", "Карта 3 — Победитель", and the
    // number-first Russian form "2-я карта" seen on the page itself.
    // The gap between the word and the number is BOUNDED: with an unbounded
    // [^0-9]* the label "Победитель 1-й половины карты 2" read as map-1.
    const MAP_SLUG_RE = /(?:(?:map|karta|карт[а-яё]*)[^0-9]{0,3}([1-9])|([1-9])[^0-9]{0,3}(?:map|karta|карт[а-яё]*))/i;

    // Several DIFFERENT markets legitimately name the same map and all of them
    // carry П1/П2 selections: map winner, round winner, half winner, handicap…
    // They are kept apart by marketId (see handleTree); these two patterns only
    // decide WHICH of them is the plain winner line the win-prob chart uses.
    const WINNER_RE = /(победител|исход|1x2|\bwinner\b|\bmoneyline\b)/i;
    const NOT_WINNER_RE = /(раунд|половин|тотал|фора|чётн|четн|нечёт|нечет|пистолет|бомб|убийств|овертайм|игрок|\bround\b|\bhalf\b|\btotal\b|\bhandicap\b|\bodd\b|\beven\b|\bpistol\b|\bbomb\b|\bkills?\b|\bfrags?\b|\bovertime\b|\bplayer\b)/i;

    function scopeOf(node) {
        const mid = node[13];
        if (mid === MARKET_MATCH) return 'match';
        const slug = typeof node[22] === 'string' ? node[22] : '';
        const label = typeof node[18] === 'string' ? node[18] : '';
        const m = MAP_SLUG_RE.exec(slug) || MAP_SLUG_RE.exec(label);
        if (m) return 'map-' + (m[1] || m[2]);
        return null;
    }

    // A complete two-way book MUST sum to more than 100% — that surplus is the
    // bookmaker's margin. So if our П1/П2 pair sums to LESS, we are not looking
    // at a whole market: some selection we ignored carries the rest, in practice
    // the draw on a map that can finish 12-12. Observed live: market 8494 quoted
    // 1.5/2.4 = 108.3% (a normal 8.3% margin, matching the match winner) while
    // 8595 quoted 1.65/2.8 = 96.3%, i.e. a 3.7% NEGATIVE margin, which no house
    // offers. This test needs no label, no market id, no language and no
    // assumption about the margin, so it is the most reliable signal we have for
    // finding the clean home/away line.
    function overround(e) {
        if (!(e.p1 > 1) || !(e.p2 > 1)) return null;
        return 1 / e.p1 + 1 / e.p2;
    }
    function marginPct(e) {
        const ov = overround(e);
        return ov === null ? null : Number(((ov - 1) * 100).toFixed(2));
    }

    // Rank, do not reject: if the ONLY market found for a scope looks like a
    // derivative we still plot it (better than an empty chart), but a real
    // winner market outranks it and takes over the moment it shows up.
    function marketRank(e) {
        const txt = `${e.slug || ''} ${e.label || ''}`;
        let r = 0;
        if (e.mid === String(MARKET_MATCH)) r += 8;
        if (WINNER_RE.test(txt)) r += 4;
        if (NOT_WINNER_RE.test(txt)) r -= 6;
        if (e.history.length) r += 1;              // it actually quotes two ways
        if (e.p3 > 1) r -= 3;                      // three-way: draw priced apart
        const ov = overround(e);
        if (ov !== null) {
            if (ov >= 1.005 && ov <= 1.30) r += 3;      // a complete two-way book
            else if (ov < 1.005) r -= 4;                // under 100%: incomplete
        }
        return r;
    }

    // Deterministic pick per scope: a manual pin wins, then the highest rank,
    // ties broken by insertion order. Only ever an upgrade, so the chart never
    // ping-pongs between two markets mid-match.
    function electMarket(o, scope) {
        if (!o || !o.markets) return false;
        const cands = Object.keys(o.markets).map(k => o.markets[k]).filter(e => e.scope === scope);
        if (!cands.length) return false;
        const forced = store('mkt:' + scope);
        let best = forced ? (cands.find(e => e.mid === String(forced)) || null) : null;
        if (!best) cands.forEach(e => { if (!best || marketRank(e) > marketRank(best)) best = e; });
        if (!best || o.scopes[scope] === best) return false;
        o.scopes[scope] = best;
        return true;
    }

    function handleTree(msg) {
        let changed = false;

        walkObjects(msg, node => {
            // tournament: {1:id, 4:name, 12:name}
            if (typeof node[1] === 'number' && typeof node[4] === 'string' &&
                node[4] === node[12] && node[4].length > 2) {
                if (!S.tournaments.has(node[1])) { S.tournaments.set(node[1], node[4]); changed = true; }
            }

            // match: {1:matchId, 5:"od:match:xxx", 16:{1:home,3:away}}
            if (typeof node[5] === 'string' && node[5].indexOf('od:match:') === 0 &&
                node[16] && typeof node[1] === 'number') {
                const a = node[16][1], b = node[16][3];
                if (!a || !b) return;
                const id = String(node[1]);
                const prev = S.matches.get(id) || {};
                const comp = c => ({
                    name: c[3] || c[4] || '?',
                    short: c[4] || c[3] || '?',
                    logo: typeof c[7] === 'string' && c[7].indexOf('http') === 0 ? c[7] : '',
                });
                const rec = {
                    id, home: comp(a), away: comp(b),
                    tournamentId: node[10],
                    format: node[17] || prev.format || '',
                    start: node[13] || prev.start || '',
                    // Field 3: 1 = live, 2 = upcoming. Far more reliable than
                    // comparing the start time against the clock.
                    live: node[3] === 1,
                };
                if (JSON.stringify(prev) !== JSON.stringify(rec)) { S.matches.set(id, rec); changed = true; }
            }

            // market: {1:"od:match:...", 2:matchId, 6:code, 10:odds, 13:marketId, 18:label, 22:slug}
            if (typeof node[1] === 'string' && node[1].indexOf('od:match:') === 0 &&
                typeof node[10] === 'number' && typeof node[2] === 'number' &&
                typeof node[6] === 'string') {

                // Census of EVERY selection code the feed uses, understood or
                // not. When a price we expect never shows up, __dibu.codes()
                // answers whether the feed sent it at all and under what name,
                // instead of leaving us to guess. Cheap: one Map write per
                // selection.
                const seen = S.codeSeen.get(node[6]) || { code: node[6], n: 0, sample: '' };
                seen.n++;
                if (!seen.sample) seen.sample = `${node[13]}|${node[18] || ''}|${node[22] || ''}`;
                S.codeSeen.set(node[6], seen);

                if (S.mktDebug) {
                    const key = `${node[13]}|${node[18] || ''}|${node[22] || ''}`;
                    S.mktSeen.set(key, (S.mktSeen.get(key) || 0) + 1);
                }

                const sel = selOf(node[6]);
                if (!sel) return;

                const scope = scopeOf(node);
                if (!scope) return;

                // Some map-winner markets carry a draw (Х / П3) because a map can
                // tie on rounds. We still plot only the two-way home/away line,
                // but the draw price is RECORDED rather than discarded: it is
                // what tells a three-way line apart from a two-way one, and
                // without it a three-way market looks like a two-way book priced
                // below 100%. Note this never gates the scope on arrival order —
                // an early version dropped a whole scope when the draw arrived
                // before П1/П2, which is why some maps showed and others didn't.
                const id = String(node[2]);
                const mid = String(node[13] === undefined ? '?' : node[13]);
                const label = typeof node[18] === 'string' ? node[18] : '';
                const slug = typeof node[22] === 'string' ? node[22] : '';

                const o = S.odds.get(id) || { scopes: {}, markets: {} };
                if (!o.markets) o.markets = {};

                // ONE BUCKET PER MARKET, never per scope alone. betboom quotes
                // several П1/П2 markets that all name the same map, and folding
                // them into a single {p1,p2} pair made П1 from one market pair
                // up with П2 from another: a home price flip-flopping against a
                // frozen away price, and a plotted probability built from two
                // different books. Keyed by marketId they can no longer
                // overwrite each other; electMarket then decides which one the
                // chart shows.
                const mkey = scope + '#' + mid;
                let e = o.markets[mkey];
                if (!e) {
                    e = { mid, scope, label, slug, p1: null, p2: null, p3: null, history: [] };
                    o.markets[mkey] = e;
                }
                if (label) e.label = label;
                if (slug) e.slug = slug;

                if (sel === 'draw') {
                    e.p3 = node[10];
                    if (electMarket(o, scope)) changed = true;
                    S.odds.set(id, o);
                    return;                        // never plotted, only recorded
                }

                if (sel === 'home') e.p1 = node[10];
                if (sel === 'away') e.p2 = node[10];
                if (e.p1 > 1 && e.p2 > 1) {
                    const p = (1 / e.p1) / ((1 / e.p1) + (1 / e.p2));
                    const last = e.history[e.history.length - 1];
                    if (!last || last.o1 !== e.p1 || last.o2 !== e.p2) {
                        e.history.push({ t: Date.now(), o1: e.p1, o2: e.p2, p });
                        if (e.history.length > 500) e.history.shift();
                        changed = true;
                    }
                }
                if (electMarket(o, scope)) changed = true;
                S.odds.set(id, o);
            }
        });

        if (changed) S.dirty = true;
    }

    // The grid feed has no logos, so match its team names against the tree
    // competitors for the same match.
    function logoFor(g, team) {
        const m = S.matches.get(g.matchId);
        if (!m || !team) return '';
        const want = String(team.name || '').toLowerCase();
        for (const c of [m.home, m.away]) {
            if (!c) continue;
            if (String(c.name).toLowerCase() === want || String(c.short).toLowerCase() === want) return c.logo;
        }
        if (!g.orderKnown) return '';
        const idx = g.teams.indexOf(team);
        const c = idx === 0 ? m.home : (idx === 1 ? m.away : null);
        return c ? c.logo : '';
    }

    // =====================================================================
    // 7. GRID_WIDGET_WS — game state
    // =====================================================================

    const SIDE = { 'terrorists': 'T', 'counter-terrorists': 'CT' };

    const REASON = { bomb: 'bomb', defuse: 'defuse', elim: 'elimination', time: 'time' };

    // Round-history glyphs. currentColor everywhere so the side class tints them.
    const RICON = {
        elim: '<path d="M5.5 1C3.1 1 1.3 2.7 1.3 5.1c0 1.3.6 2.2 1.3 2.7v1.2c0 .5.4.9.9.9h4c.5 0 .9-.4.9-.9V7.8' +
            'c.7-.5 1.3-1.4 1.3-2.7C9.7 2.7 7.9 1 5.5 1z" fill="currentColor"/>' +
            '<circle cx="3.8" cy="5" r="1.15" fill="#0e1728"/><circle cx="7.2" cy="5" r="1.15" fill="#0e1728"/>' +
            '<path d="M4.7 7.6h1.6v2.3H4.7z" fill="#0e1728"/>',
        bomb: '<path d="M5.5.5l1.15 2.5L9.2 2l-1 2.5 2.3 1.1-2.3 1.1 1 2.5-2.55-1L5.5 10.7 4.35 8.2l-2.55 1 ' +
            '1-2.5L.5 5.6l2.3-1.1-1-2.5 2.55 1z" fill="currentColor"/>',
        defuse: '<path d="M2.2 1.2l4.1 4.4M8.8 1.2L4.7 5.6" fill="none" stroke="currentColor" ' +
            'stroke-width="1.35" stroke-linecap="round"/>' +
            '<circle cx="2.7" cy="8.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
            '<circle cx="8.3" cy="8.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/>',
        time: '<circle cx="5.5" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
            '<path d="M5.5 3.6V6l1.9 1.1" fill="none" stroke="currentColor" stroke-width="1.3" ' +
            'stroke-linecap="round"/><path d="M4.1.8h2.8" stroke="currentColor" stroke-width="1.3" ' +
            'stroke-linecap="round"/>',
    };

    // Home/away is a betting concept: it is defined by the odds feed, where
    // competitor 16.1 is П1 (home). The game feed has its own slot order, and
    // the two DO NOT always agree — trusting the slot once made the win
    // probability attribute П1's number to the wrong team. So map the game
    // feed's teams onto the odds feed by name, and only fall back when we
    // cannot verify the mapping.
    const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    function orderTeams(matchId, teams) {
        if (teams.length !== 2) return { teams, known: false };
        const meta = S.matches.get(matchId);
        if (meta && meta.home && meta.away) {
            const homeKeys = [normName(meta.home.name), normName(meta.home.short)];
            const awayKeys = [normName(meta.away.name), normName(meta.away.short)];
            const a = normName(teams[0].name), b = normName(teams[1].name);
            const aHome = homeKeys.indexOf(a) >= 0, bHome = homeKeys.indexOf(b) >= 0;
            const aAway = awayKeys.indexOf(a) >= 0, bAway = awayKeys.indexOf(b) >= 0;
            if ((aHome && !bHome) || (bAway && !aAway)) return { teams, known: true };
            if ((bHome && !aHome) || (aAway && !bAway)) return { teams: [teams[1], teams[0]], known: true };
        }
        // Secondary signal: team field 3 behaved like an is-home flag in the
        // captured series. Weaker than a name match, but better than the slot.
        if (teams[0].flag3 === 1 && teams[1].flag3 !== 1) return { teams, known: false };
        if (teams[1].flag3 === 1 && teams[0].flag3 !== 1) return { teams: [teams[1], teams[0]], known: false };
        return { teams, known: false };
    }

    function handleGrid(msg) {
        const payload = msg[4] || msg[5];
        if (!payload || typeof payload !== 'object') return;
        const gs = payload[4] && payload[4][1];
        if (!gs) return;

        const matchId = String(payload[1] || '');
        if (!matchId) return;

        S.retries.delete(matchId);
        S.probe.set(matchId, { status: 'ok', sentAt: Date.now() });

        // We stay subscribed to every match we have probed, so frames keep
        // arriving for matches the user is no longer looking at. Sounds must
        // follow the selection, not the feed.
        const isActive = matchId === S.active;

        let g = S.games.get(matchId);
        if (!g) { g = newGame(matchId); S.games.set(matchId, g); }
        // Never let a frame for some other match steal the selection. Before
        // this, a prematch pick with no feed yet would be silently replaced by
        // whatever match the page happened to be subscribed to, and the
        // watchdog would then keep retrying the wrong id forever.
        if (!S.active || !S.activePinned) S.active = matchId;

        // NOTE: team field 3 is NOT maps won. It stayed 1/0 across a whole
        // series whose real score went 0:1 -> 1:1 -> 1:2, so it reads as an
        // is-home flag. Series score is derived from the maps instead.
        const rawTeams = arr(gs[3]).map(t => ({
            id: t[1], name: t[2], flag3: t[3] || 0, slot: t[4] || 0,
            players: arr(t[5]).map(p => ({ steam: p[1], nick: p[2] })),
        })).sort((a, b) => a.slot - b.slot);
        const ord = orderTeams(matchId, rawTeams);
        g.teams = ord.teams;
        g.orderKnown = ord.known;

        g.maps = arr(gs[4]).map(m => {
            const sides = {};
            arr(m[6]).forEach(ts => {
                const alive = {};
                arr(ts[5]).forEach(p => { alive[p[1]] = p[2]; });
                sides[ts[1]] = { side: ts[2], rounds: ts[3] || 0, alive };
            });
            return {
                uuid: m[1], num: m[2], name: m[3],
                minimap: m[4], live: m[5] === 1, photo: m[7], sides,
            };
        }).sort((a, b) => a.num - b.num);

        const liveMap = g.maps.find(m => m.live) || g.maps[g.maps.length - 1];
        if (liveMap) g.liveMapNum = liveMap.num;

        // Phase first: bomb explode/defuse arrives before (or with) the score
        // bump, and the round-history block below needs it to label the win.
        const timer = gs[2] || {};
        const newPhase = gs[1];
        if (newPhase !== g.phase) {
            const hadPhase = g.phase !== null;
            if (hadPhase) sampleLatency(timer[1], matchId, isActive);
            g.phase = newPhase;
            g.phaseStart = timer[1] || null;
            g.phaseDur = timer[4] || null;
            if (newPhase === 'bomb_has_been_planted') {
                g.bombPlanted = true; logEvent(g, 'bomb', 'BOMB PLANTED');
                if (isActive) play('bomb');
            } else if (newPhase === 'bomb_has_been_exploded') {
                g.bombPlanted = false; g.lastSpecial = 'exploded'; logEvent(g, 'bomb', 'BOMB EXPLODED');
            } else if (newPhase === 'bomb_has_been_defused') {
                g.bombPlanted = false; g.lastSpecial = 'defused'; logEvent(g, 'bomb', 'BOMB DEFUSED');
            } else if (newPhase === 'round') {
                g.bombPlanted = false; g.lastSpecial = null;
                if (hadPhase && isActive) play('roundStart');
            } else if (newPhase === 'freezetime' || newPhase === 'await_round') {
                g.bombPlanted = false; g.lastSpecial = null;
            } else if (newPhase === 'round_end') {
                g.bombPlanted = false;
            } else if (newPhase === 'finished') {
                g.bombPlanted = false; logEvent(g, 'phase', 'MATCH FINISHED');
            } else if (newPhase === 'timeout') {
                logEvent(g, 'phase', 'TIMEOUT');
            }
        } else {
            g.phaseStart = timer[1] || g.phaseStart;
            g.phaseDur = timer[4] || g.phaseDur;
        }

        // round history from score deltas
        if (liveMap) {
            const mn = liveMap.num;
            if (!g.prevRounds[mn]) g.prevRounds[mn] = {};
            if (!g.roundHistory[mn]) g.roundHistory[mn] = [];
            // Snapshot the score BEFORE this frame's updates. The absolute round
            // number a win produces is (total score once that win is counted),
            // computed from the real scoreboard — never a running counter seeded
            // from wherever we happened to connect. Connecting mid-map used to
            // seed `total` from the current score yet start the history empty, so
            // the first recorded win was numbered one too high and could collide
            // with the next one ("round 2" twice).
            const scoreBefore = {};
            let sumBefore = 0;
            for (const tid in liveMap.sides) {
                scoreBefore[tid] = g.prevRounds[mn][tid];
                if (scoreBefore[tid] !== undefined) sumBefore += scoreBefore[tid];
            }
            for (const tid in liveMap.sides) {
                const now = liveMap.sides[tid].rounds;
                const before = scoreBefore[tid];
                if (before !== undefined && now > before) {
                    // How the round was won: the bomb phases say so outright,
                    // otherwise a wiped loser means elimination and survivors
                    // mean the clock ran out.
                    const loserId = Object.keys(liveMap.sides).find(x => x !== tid);
                    const loserAlive = loserId
                        ? Object.values(liveMap.sides[loserId].alive).filter(v => v === 1).length : 0;
                    let reason;
                    if (g.lastSpecial === 'exploded') reason = 'bomb';
                    else if (g.lastSpecial === 'defused') reason = 'defuse';
                    else if (loserAlive === 0) reason = 'elim';
                    else reason = 'time';

                    // Anchor the half boundary to the home team's side: it is
                    // defined every round, unlike the winner's side, which only
                    // appears on rounds that team actually won.
                    const homeTeam = g.teams[0];
                    const homeSide = (homeTeam && liveMap.sides[homeTeam.id])
                        ? liveMap.sides[homeTeam.id].side : null;

                    // Other team's score is fixed within this frame, so each
                    // increment for `tid` maps to a concrete absolute round.
                    const otherNow = loserId !== undefined && liveMap.sides[loserId]
                        ? liveMap.sides[loserId].rounds : 0;
                    for (let n = before + 1; n <= now; n++) {
                        const roundNo = n + otherNow;
                        // Guard against a duplicate if the same win is somehow
                        // seen twice (re-subscribe replaying a snapshot).
                        if (g.roundHistory[mn].some(r => r.round === roundNo)) continue;
                        g.roundHistory[mn].push({
                            round: roundNo, teamId: tid, side: liveMap.sides[tid].side,
                            homeSide, reason,
                        });
                        const tName = (g.teams.find(t => t.id === tid) || {}).name || tid;
                        logEvent(g, 'round', `ROUND ${roundNo} — ${tName} wins (${REASON[reason]})`);
                        if (isActive) play('roundEnd');
                    }
                    g.lastSpecial = null;
                }
                g.prevRounds[mn][tid] = now;
            }
            // keep history ordered by absolute round number
            g.roundHistory[mn].sort((a, b) => a.round - b.round);
            void sumBefore;
        }

        const kill = gs[5];
        if (kill && kill[6] && !g.seenKills.has(kill[6])) {
            g.seenKills.add(kill[6]);
            sampleLatency(kill[6], matchId, isActive);
            processKill(g, kill, liveMap, isActive);
        }

        g.lastUpdate = Date.now();
        if (!S.soundReady) setTimeout(() => { S.soundReady = true; }, 2500);
        reconcileActive();
        S.dirty = true;
    }

    // The feed stamps each event at the source, so receivedAt - eventTime is a
    // direct read of how far behind live we are. Measured across one captured
    // session this sat at 7.84s +/- 0.094s — a fixed buffer applied upstream,
    // not network jitter, so it cannot be reduced from here. Worth surfacing so
    // a change in the buffer is visible rather than silent.
    function sampleLatency(iso, matchId, isActive) {
        if (typeof iso !== 'string') return;
        const t = Date.parse(iso);
        if (!t) return;
        const d = (Date.now() - t) / 1000;
        if (d < 0 || d > 120) return;          // stale snapshot after a re-subscribe
        if (isActive) {
            S.lat.push(d);
            if (S.lat.length > 25) S.lat.shift();
        }
        // Per match as well: if every live match shows the same figure the delay
        // is a betboom-wide buffer; if they differ it comes from the upstream
        // data provider and picking tournaments would actually matter.
        let a = S.latByMatch.get(matchId);
        if (!a) { a = []; S.latByMatch.set(matchId, a); }
        a.push({ t: Date.now(), d });
        if (a.length > 400) a.shift();
    }
    function medianOf(v) {
        if (!v || v.length < 3) return null;
        const s2 = v.slice().sort((a, b) => a - b);
        return s2[Math.floor(s2.length / 2)];
    }
    const latencyMedian = () => medianOf(S.lat);
    const latencyOf = id => medianOf((S.latByMatch.get(id) || []).map(x => x.d));

    // HTTP Date gives the server's clock to the second, which bounds how much of
    // the measured delay could just be a wrong local clock.
    async function checkClock() {
        try {
            const t0 = Date.now();
            const res = await fetch(location.origin + '/', { method: 'HEAD', cache: 'no-store' });
            const t1 = Date.now();
            const hdr = res.headers.get('date');
            if (!hdr) return;
            const server = Date.parse(hdr);
            if (!server) return;
            S.clockOffset = ((t0 + t1) / 2 - server) / 1000;   // + means our clock is ahead
            S.dirty = true;
        } catch (e) { /* blocked or offline */ }
    }

    function nickOf(g, steamId) {
        for (let i = 0; i < g.teams.length; i++) {
            const p = g.teams[i].players.find(p => p.steam === steamId);
            if (p) return { nick: p.nick, team: g.teams[i].name, teamId: g.teams[i].id, idx: i };
        }
        return { nick: steamId ? steamId.slice(-5) : '?', team: '', teamId: null, idx: -1 };
    }

    function processKill(g, kill, liveMap, isActive) {
        const killer = kill[1] && kill[1][1];
        const assist = kill[2] && kill[2][1];
        let weapon = kill[3] && kill[3][1];
        if (typeof weapon !== 'string') weapon = null;
        const flags = kill[4] || {};
        const hs = flags[1] === 1;
        const world = flags[2] === 1;
        const victim = kill[5] && kill[5][1];
        const mn = liveMap ? liveMap.num : g.liveMapNum;
        if (mn === null || mn === undefined) return;

        const total = liveMap ? Object.values(liveMap.sides).reduce((a, s) => a + s.rounds, 0) : 0;
        const round = total + 1;
        const halfKey = round <= 12 ? 'h1' : (round <= 24 ? 'h2' : 'ot');
        const v = nickOf(g, victim);

        // Last-seen weapon is per round; wipe it as soon as the round number moves.
        if (g.weapRound !== round) { g.weapRound = round; g.roundWeapons = {}; }

        if (world || !weapon) {
            statFor(g, mn, victim).d += 1;
            logEvent(g, 'suicide', `SUICIDE: ${v.nick} (world kill)`);
            return;
        }

        const k = nickOf(g, killer);
        const sk = statFor(g, mn, killer);
        sk.k += 1;
        sk[halfKey] += 1;
        if (hs) sk.hs += 1;
        if (!sk.weapons[weapon]) sk.weapons[weapon] = { k: 0, hs: 0 };
        sk.weapons[weapon].k += 1;
        if (hs) sk.weapons[weapon].hs += 1;

        statFor(g, mn, victim).d += 1;
        if (assist) statFor(g, mn, assist).a += 1;
        g.roundWeapons[killer] = weapon;

        const aTxt = assist ? ` +${nickOf(g, assist).nick}` : '';
        logEvent(g, 'kill', `${k.nick} (${weaponName(weapon)}) killed ${v.nick}${hs ? ' · HS' : ''}${aTxt}`,
            k.idx);

        if (!isActive) return;
        if (k.idx === 0) play('killHome');
        else if (k.idx === 1) play('killAway');
    }

    function logEvent(g, type, text, teamIdx) {
        g.events.push({ type, text, t: new Date(), teamIdx });
        if (g.events.length > 300) g.events.shift();
    }

    // =====================================================================
    // 8. WEAPON NAMES
    // =====================================================================

    const WEAPONS = {
        ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', awp: 'AWP', ssg08: 'SSG 08',
        aug: 'AUG', sg556: 'SG 553', famas: 'FAMAS', galilar: 'Galil AR', scar20: 'SCAR-20',
        g3sg1: 'G3SG1', deagle: 'Desert Eagle', revolver: 'R8 Revolver', glock: 'Glock-18',
        usp_silencer: 'USP-S', hkp2000: 'P2000', p250: 'P250', fiveseven: 'Five-SeveN',
        tec9: 'Tec-9', cz75a: 'CZ75-Auto', elite: 'Dual Berettas', mp9: 'MP9', mac10: 'MAC-10',
        mp7: 'MP7', mp5sd: 'MP5-SD', ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon',
        nova: 'Nova', xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off',
        m249: 'M249', negev: 'Negev',
        hegrenade: 'HE Grenade', molotov: 'Molotov', incgrenade: 'Incendiary',
        inferno: 'Fire', flashbang: 'Flashbang', smokegrenade: 'Smoke', decoy: 'Decoy',
        taser: 'Zeus x27', knife: 'Knife', bayonet: 'Knife', world: 'World',
    };
    const TRACKED = new Set(['hegrenade', 'molotov', 'incgrenade', 'inferno', 'taser', 'knife', 'bayonet']);

    // The feed carries NO inventory or economy — a weapon is only ever revealed
    // by a kill. These categories exist so the roster can show what a player was
    // last seen killing with this round, colour-coded by buy tier.
    const WCAT = {
        awp: 'sniper', ssg08: 'sniper', scar20: 'sniper', g3sg1: 'sniper',
        ak47: 'rifle', m4a1: 'rifle', m4a1_silencer: 'rifle', aug: 'rifle', sg556: 'rifle',
        famas: 'rifle', galilar: 'rifle', m249: 'rifle', negev: 'rifle',
        mp9: 'smg', mac10: 'smg', mp7: 'smg', mp5sd: 'smg', ump45: 'smg', p90: 'smg',
        bizon: 'smg', nova: 'smg', xm1014: 'smg', mag7: 'smg', sawedoff: 'smg',
        deagle: 'pistol', revolver: 'pistol', glock: 'pistol', usp_silencer: 'pistol',
        hkp2000: 'pistol', p250: 'pistol', fiveseven: 'pistol', tec9: 'pistol',
        cz75a: 'pistol', elite: 'pistol',
        hegrenade: 'util', molotov: 'util', incgrenade: 'util', inferno: 'util',
        flashbang: 'util', smokegrenade: 'util', decoy: 'util', taser: 'util',
        knife: 'util', bayonet: 'util',
    };
    const WICON = {
        rifle: '<path d="M0 4.4h12v2.1H8.6l-1 2.1H5.6V6.5H0z"/>',
        sniper: '<rect x="4" y="1.6" width="5.2" height="1.7" rx=".6"/>' +
            '<path d="M0 5h12v2.1H8.6l-1 2.1H5.6V7.1H0z"/>',
        smg: '<path d="M1.4 4.4h8.4v2.1H7.6l-1 2.1H4.6V6.5H1.4z"/>',
        pistol: '<path d="M2.4 3h6v2.1H6.3l-1 4.1H3.2V5.1H2.4z"/>',
        util: '<circle cx="6" cy="6.6" r="3.3"/><path d="M5.1 1.9h1.8v1.7H5.1z"/>',
    };
    function weaponCat(w) {
        if (typeof w !== 'string') return null;
        if (WCAT[w]) return WCAT[w];
        if (w.indexOf('knife') >= 0) return 'util';
        return 'rifle';
    }

    function weaponName(w) {
        if (!w || typeof w !== 'string') return 'World';
        if (WEAPONS[w]) return WEAPONS[w];
        if (w.indexOf('knife') >= 0) return 'Knife';
        return w.replace(/_/g, ' ').toUpperCase();
    }
    const isTracked = w => typeof w === 'string' && (TRACKED.has(w) || w.indexOf('knife') >= 0);

    // =====================================================================
    // 9. MATCH SWITCHING + VETO
    // =====================================================================

    function subscribeMatch(matchId) {
        S.active = matchId;
        S.activePinned = true;
        S.userPicked = true;
        S.selectedMapNum = null;
        S.expandedPlayer = null;
        S.wpScope = 'match';
        S.retries.set(matchId, 0);
        S.dirty = true;
        if (S.games.has(matchId)) return;

        const sock = S.gridSockets.find(s => s.readyState === 1);
        if (sock) sendSub(sock, matchId);
        // No 8s verdict any more — the watchdog keeps retrying. A match that is
        // still in prematch simply has no feed *yet*.
    }

    // The site drops game-state pushes between maps and before a match goes
    // live (its own widgets go blank too). Rather than needing a page reload,
    // re-assert the subscription whenever the feed is quiet — a fresh snapshot
    // is exactly what we want anyway.
    const STALE_MS = 20000;

    // A pin taken from the URL is only a guess about which path segment holds
    // the match id. If the tree feed lists every live match and ours is not
    // among them, the guess was wrong — drop it rather than showing an empty
    // panel forever. A match the user actually clicked is never dropped.
    function reconcileActive() {
        if (!S.active || !S.activePinned || S.userPicked) return;
        if (S.matches.size === 0 || S.games.size === 0) return;
        if (S.matches.has(S.active)) return;
        S.activePinned = false;
        S.active = S.games.keys().next().value;
        S.dirty = true;
    }

    // If the page never opened a grid socket (no live widget on screen), open
    // one ourselves. The endpoint takes no handshake beyond the subscription.
    function ensureGridSocket() {
        if (S.gridSockets.some(s => s.readyState === 0 || s.readyState === 1)) return;
        if (!S.gridUrl) return;
        if (S.ownSocket && (S.ownSocket.readyState === 0 || S.ownSocket.readyState === 1)) return;
        if (Date.now() - S.lastOwnOpen < STALE_MS) return;
        S.lastOwnOpen = Date.now();
        try { S.ownSocket = new HookedWS(S.gridUrl); }
        catch (e) { S.ownSocket = null; }
    }

    // Nothing in the tree feed says whether a match has GRID game-state
    // coverage — the one match that did and the ones that never will carry an
    // identical set of fields. The only way to know is to subscribe and see who
    // answers, so probe live matches one at a time and remember the verdict.
    const PROBE_TIMEOUT = 12000;
    const PROBE_RETRY = 120000;

    function probeMatches() {
        const sock = S.gridSockets.find(s => s.readyState === 1);
        if (!sock) return;
        const now = Date.now();

        S.probe.forEach(pr => {
            if (pr.status === 'pending' && now - pr.sentAt > PROBE_TIMEOUT) pr.status = 'none';
        });
        if (now - S.lastProbe < 700) return;

        for (const m of S.matches.values()) {
            if (!m.live) continue;
            if (S.games.has(m.id)) {
                if (!S.probe.has(m.id)) S.probe.set(m.id, { status: 'ok', sentAt: now });
                continue;
            }
            const pr = S.probe.get(m.id);
            if (pr && pr.status === 'pending') continue;
            // A match that answered nothing may simply not have started its feed
            // yet, so give it another go much later.
            if (pr && pr.status === 'none' && now - pr.sentAt < PROBE_RETRY) continue;
            S.probe.set(m.id, { status: 'pending', sentAt: now });
            S.lastProbe = now;
            sendSub(sock, m.id);
            S.dirty = true;
            return;                       // one per tick keeps it gentle
        }
    }

    function readable(id) {
        const pr = S.probe.get(id);
        return S.games.has(id) || (pr && pr.status === 'ok');
    }

    function watchdog() {
        if (!S.active) return;

        reconcileActive();
        ensureGridSocket();
        const sock = S.gridSockets.find(s => s.readyState === 1);
        if (!sock) return;
        const g = S.games.get(S.active);
        const since = g ? Date.now() - g.lastUpdate : Infinity;
        if (since < STALE_MS) return;
        if (Date.now() - S.lastResub < STALE_MS) return;
        S.lastResub = Date.now();
        S.retries.set(S.active, (S.retries.get(S.active) || 0) + 1);
        sendSub(sock, S.active);
        S.dirty = true;
    }
    function staleSeconds() {
        const g = S.active ? S.games.get(S.active) : null;
        if (!g || !g.lastUpdate) return null;
        const s = Math.floor((Date.now() - g.lastUpdate) / 1000);
        return s >= 15 ? s : null;
    }

    const vetoKey = (matchId, mapNum) => `veto:${matchId}:${mapNum}`;
    const getVeto = (matchId, mapNum) => store(vetoKey(matchId, mapNum)) || '';

    function cycleVeto(matchId, mapNum, teams) {
        const opts = [''].concat(teams.map(t => t.id)).concat(['decider']);
        const cur = getVeto(matchId, mapNum);
        store(vetoKey(matchId, mapNum), opts[(opts.indexOf(cur) + 1) % opts.length]);
        S.dirty = true;
    }
    function vetoLabel(matchId, mapNum, teams) {
        const v = getVeto(matchId, mapNum);
        if (!v) return 'pick —';
        if (v === 'decider') return 'decider';
        const t = teams.find(t => t.id === v);
        return 'pick ' + (t ? t.name : v);
    }

    // =====================================================================
    // 10. UI
    // =====================================================================

    const C4_SVG = `<svg class="mh-c4" viewBox="0 0 18 22" aria-hidden="true">
  <path class="c4-wire" d="M5.5 5V2.5h7V5" fill="none" stroke-width="1.1" stroke-linecap="round"/>
  <rect class="c4-body" x="1.5" y="5" width="15" height="15.5" rx="1.8"/>
  <rect class="c4-screen" x="4" y="7.5" width="10" height="4.6" rx="0.8"/>
  <circle class="c4-led" cx="9" cy="16.6" r="1.9"/>
</svg>`;

    const CSS = `
#mh-launch{position:fixed;right:14px;bottom:14px;z-index:2147483000;background:#132033;color:#cfe0f5;
  border:1px solid #2a3d57;border-radius:7px;padding:7px 12px;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.08em;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5)}
#mh-launch:hover{background:#1b2c45;color:#fff}

#mh-root{position:fixed;z-index:2147483001;background:#080d15;color:#cbd6e6;
  font:12px/1.35 ui-sans-serif,"Inter","Segoe UI",system-ui,sans-serif;display:none;
  font-variant-numeric:tabular-nums;overflow:hidden;resize:both;
  min-width:400px;min-height:290px;border:1px solid #22334c;border-radius:9px;
  box-shadow:0 16px 50px rgba(0,0,0,.7)}
#mh-root.mh-on{display:grid;grid-template-rows:30px 1fr}
#mh-root.mh-max{inset:0!important;width:auto!important;height:auto!important;resize:none;border-radius:0}
#mh-root *,#mh-root *::before,#mh-root *::after{box-sizing:border-box;margin:0;padding:0}
#mh-root ::-webkit-scrollbar{width:6px;height:6px}
#mh-root ::-webkit-scrollbar-thumb{background:#26374f;border-radius:3px}
#mh-root ::-webkit-scrollbar-track{background:transparent}

/* ---------- header ---------- */
.mh-top{display:flex;align-items:center;gap:6px;padding:0 8px;background:#0c1421;
  border-bottom:1px solid #1b2942;cursor:grab;user-select:none}
.mh-top.mh-drag{cursor:grabbing}
.mh-brand{font-weight:700;letter-spacing:.13em;text-transform:uppercase;font-size:9.5px;color:#dfe9f7;flex:none}
.mh-brand b{color:#4a9eff}
.mh-title{flex:1;font-size:11.5px;font-weight:600;color:#e8f0fb;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.mh-stale{flex:none;font-size:9px;font-weight:700;color:#0d1420;background:#d4a340;
  padding:1px 5px;border-radius:3px;letter-spacing:.04em}
.mh-flash{flex:none;font-size:9px;font-weight:600;color:#0d1420;background:#3ddc84;
  padding:1px 5px;border-radius:3px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:210px}
.mh-lat{flex:none;font-size:9px;font-weight:700;color:#7f93ad;background:#132033;
  padding:1px 4px;border-radius:3px;cursor:help;letter-spacing:.02em}
.mh-lat.warn{color:#e0a441;background:#241d0e}
.mh-led{width:7px;height:7px;border-radius:50%;flex:none;background:#3ddc84;cursor:help}
.mh-led.warn{background:#d4a340}
.mh-led.err{background:#e0544f}

/* flat glyph buttons: triangles point at the pane they control */
.mh-gl{background:none;border:none;color:#4b5d75;cursor:pointer;font-size:9px;line-height:1;
  padding:3px 2px;flex:none;font-family:inherit}
.mh-gl:hover{color:#9fb4cd}
.mh-gl.on{color:#4a9eff}
.mh-gl.snd{font-size:11px}
.mh-gl.snd.off{color:#4b5d75;text-decoration:line-through}
.mh-gl.snd.on{color:#3ddc84}

/* macOS-style traffic lights */
.mh-lights{display:flex;gap:6px;align-items:center;flex:none;margin-left:2px}
.mh-tl{width:11px;height:11px;border-radius:50%;border:none;padding:0;cursor:pointer;position:relative;
  display:grid;place-items:center;font-size:8px;line-height:1;color:#00000000;font-weight:900}
.mh-tl.green{background:#28c840}
.mh-tl.red{background:#ff5f57}
.mh-lights:hover .mh-tl{color:#00000099}
.mh-tl:active{filter:brightness(.8)}

/* ---------- body grid + collapsible sides ---------- */
.mh-body{display:grid;grid-template-columns:146px minmax(0,1fr) 172px;gap:6px;padding:6px;overflow:hidden}
#mh-root.mh-nol .mh-body{grid-template-columns:minmax(0,1fr) 172px}
#mh-root.mh-nol #mh-left{display:none}
#mh-root.mh-nor .mh-body{grid-template-columns:146px minmax(0,1fr)}
#mh-root.mh-nor #mh-right{display:none}
#mh-root.mh-nol.mh-nor .mh-body{grid-template-columns:minmax(0,1fr)}
.mh-col{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:hidden}
.mh-card{background:#0e1728;border:1px solid #1c2b44;border-radius:7px;min-height:0;
  display:flex;flex-direction:column}
.mh-h{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#61758f;
  padding:5px 7px;border-bottom:1px solid #17243a;flex:none;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}
.mh-h span.grow{flex:1;overflow:hidden;text-overflow:ellipsis}
.mh-scroll{overflow-y:auto;min-height:0}
.mh-empty{padding:10px 8px;color:#41536c;font-size:10.5px;text-align:center;line-height:1.55;white-space:pre-line}

/* ---------- match list ---------- */
.mh-grp{font-size:8.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  color:#5f7390;background:#0b1422;padding:4px 7px 3px;position:sticky;top:0;
  border-bottom:1px solid #17243a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-mrow{display:flex;gap:5px;align-items:center;padding:5px 7px;border-bottom:1px solid #13203399;cursor:pointer}
.mh-mrow:hover{background:#152238}
.mh-mrow.mh-sel{background:#152a49;box-shadow:inset 2px 0 0 #4a9eff}
.mh-mrow.mh-nod{opacity:.42}
.mh-mname{font-size:11px;color:#c6d5e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-mmeta{font-size:9px;color:#5f7390;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-tag{font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;flex:none}
.mh-tag.live{background:#3a1220;color:#ff5a72}
.mh-tag.nod{background:#1b2434;color:#6b7d95}
.mh-tag.up{background:#152134;color:#6b7d95}

/* ---------- team strip ---------- */
.mh-strip{display:flex;align-items:center;gap:6px;flex:none;background:#0e1728;
  border:1px solid #1c2b44;border-radius:7px;padding:5px 7px}
.mh-team{display:flex;align-items:center;gap:5px;min-width:0;flex:1}
.mh-team.away{flex-direction:row-reverse;text-align:right}
.mh-logo{width:19px;height:19px;object-fit:contain;flex:none;border-radius:3px}
.mh-logo.ph{background:#182640}
.mh-tn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;font-weight:600;color:#e6eefb}
.mh-ta{font-size:8.5px;color:#5f7390;letter-spacing:.1em;text-transform:uppercase}
.mh-side{font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;flex:none}
.mh-side.CT{background:#12233d;color:#6bb0ff}
.mh-side.T{background:#2e2312;color:#e0a441}
.mh-series{font-size:15px;font-weight:700;color:#f0f6ff;flex:none;padding:0 3px}

/* ---------- map pills ---------- */
.mh-maps{display:flex;gap:5px;flex:none}
.mh-map{flex:1;min-width:0;background:#0e1728;border:1px solid #1c2b44;border-radius:6px;
  padding:4px 6px;position:relative;cursor:pointer;overflow:hidden;text-align:center}
.mh-map.on{border-color:#4a9eff;box-shadow:0 0 0 1px #4a9eff33}
.mh-map .mh-mn{font-size:8.5px;letter-spacing:.09em;text-transform:uppercase;color:#61758f;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 15px}
.mh-map .mh-msc{font-size:14px;font-weight:700;color:#f0f6ff;line-height:1.15}
.mh-veto{font-size:8.5px;color:#6d8099;cursor:pointer;border-bottom:1px dashed #26374f;
  display:inline-block;max-width:100%;overflow:hidden;user-select:none;
  text-overflow:ellipsis;white-space:nowrap}
.mh-veto:hover{color:#cfe0f5;border-color:#4a9eff}
.mh-map .mh-badge{position:absolute;top:3px;right:4px;font-size:7.5px;font-weight:700;
  padding:1px 3px;border-radius:2px}
.mh-badge.live{background:#3a1220;color:#ff5a72}
.mh-badge.up{background:#152134;color:#6b7d95}
.mh-badge.dec{background:#2a2413;color:#d4a340}

/* ---------- mid row ---------- */
.mh-mid{display:grid;grid-template-columns:1fr minmax(120px,1.15fr) 1fr;gap:6px;flex:none}
.mh-plist{padding:2px 0}
.mh-p{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-left:2px solid transparent}
.mh-p:hover{background:#152238}
.mh-p.mh-open{background:#152a49;border-left-color:#4a9eff}
.mh-dot{width:5px;height:5px;border-radius:50%;flex:none;background:#3ddc84}
.mh-dot.dead{background:#41506a}
.mh-nick{flex:1;min-width:0;font-size:11px;color:#d3e0f0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.mh-plist.ct .mh-nick{color:#7fc0ff}
.mh-plist.tt .mh-nick{color:#e0a441}
.mh-p.dead .mh-nick{color:#8c4249;text-decoration:line-through;
  text-decoration-color:#e0544f;text-decoration-thickness:1.5px}
.mh-plist.ct .mh-p.dead .mh-nick,.mh-plist.tt .mh-p.dead .mh-nick{color:#8c4249}
.mh-dot.dead{background:#e0544f}
.mh-w{width:13px;height:13px;flex:none;opacity:.95}
.mh-w.ph{width:13px;height:13px}
.mh-w.rifle{fill:#5fd08a}
.mh-w.sniper{fill:#b98cff}
.mh-w.smg{fill:#6bb0ff}
.mh-w.pistol{fill:#78899e}
.mh-w.util{fill:#e0a441}
.mh-p.dead .mh-w{opacity:.35}

/* odds history */
.mh-oddslog{border-top:1px solid #17243a;min-height:0}
.mh-ol{display:flex;align-items:center;gap:5px;padding:2px 7px;font-size:9.5px;
  border-bottom:1px solid #101b2c;color:#93a7c1}
.mh-ol time{color:#4e6180;flex:none;font-size:9px}
.mh-ol span{flex:1;text-align:right}
.mh-ol span.up{color:#5fd08a}
.mh-ol span.down{color:#e0544f}
.mh-ol.head{color:#4e6180;text-transform:uppercase;letter-spacing:.08em;
  font-weight:700;position:sticky;top:0;background:#0e1728}
.mh-kda{font-size:10px;color:#93a7c1;flex:none}
.mh-kda b{color:#e9f1fc;font-weight:600}

/* centre: the map photo sits BEHIND the round/timer block */
.mh-centre{position:relative;overflow:hidden;border-radius:7px;border:1px solid #1c2b44;background:#0e1728}
.mh-bg{position:absolute;inset:0;background-size:cover;background-position:center;
  opacity:.42;filter:saturate(.75) contrast(1.05)}
.mh-veil{position:absolute;inset:0;
  background:radial-gradient(ellipse at center,rgba(8,13,21,.42) 0%,rgba(8,13,21,.9) 78%)}
.mh-fg{position:relative;height:100%;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:1px;padding:4px}
.mh-round{font-size:13px;font-weight:700;letter-spacing:.04em;color:#f0f6ff;line-height:1.1;
  text-shadow:0 1px 3px #000}
.mh-pname{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:#93a7c1;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px #000}
.mh-clock{font-size:21px;font-weight:700;color:#4a9eff;line-height:1.05;text-shadow:0 1px 4px #000}
.mh-clock.bomb{color:#ff6b3d}
.mh-mapname{position:absolute;left:6px;bottom:4px;font-size:8px;letter-spacing:.12em;
  text-transform:uppercase;color:#8ba0bb;text-shadow:0 1px 3px #000}

/* ---------- C4 ---------- */
.mh-c4{width:15px;height:19px;flex:none;margin-top:1px}
.c4-body{fill:#26313f;stroke:#3c4b5e;stroke-width:.9}
.c4-screen{fill:#0d1a14;stroke:#35513f;stroke-width:.7}
.c4-led{fill:#3a4453}
.c4-wire{stroke:#4a5769}
.mh-c4.armed .c4-body{fill:#4a1d10;stroke:#8a3a1c}
.mh-c4.armed .c4-screen{fill:#2a0d05;stroke:#8a3a1c}
.mh-c4.armed .c4-wire{stroke:#c4512a}
.mh-c4.armed .c4-led{fill:#ff3b0e;animation:mh-led .55s steps(1,end) infinite}
@keyframes mh-led{0%,49%{fill:#5c1607;filter:none}
  50%,100%{fill:#ff3b0e;filter:drop-shadow(0 0 3px #ff3b0e)}}
@media (prefers-reduced-motion:reduce){.mh-c4.armed .c4-led{animation:none;fill:#ff3b0e}}

/* ---------- log ---------- */
.mh-log{flex:1;min-height:56px}
.mh-ev{padding:2px 7px;font-size:10.5px;border-bottom:1px solid #101b2c;display:flex;gap:6px}
.mh-ev time{color:#4e6180;flex:none;font-size:9.5px;padding-top:1px}
.mh-ev span{min-width:0;overflow-wrap:anywhere}
.mh-ev.kill span{color:#c6d5e8}
.mh-ev.kill.home span{color:#8fc4ff}
.mh-ev.kill.away span{color:#e5bd75}
.mh-ev.bomb span{color:#ff8a5c;font-weight:600}
.mh-ev.round span{color:#4a9eff;font-weight:600}
.mh-ev.suicide span{color:#c76b8a}
.mh-ev.phase span{color:#8ba0bb}

/* ---------- analytics ---------- */
.mh-bars{display:flex;gap:5px;padding:5px 6px;align-items:center}
.mh-rhg{display:flex;flex-direction:column;gap:2px;flex:none}
.mh-rhs{font-size:8px;font-weight:700;height:15px;min-width:17px;border-radius:2px;
  display:grid;place-items:center;letter-spacing:.03em}
.mh-rhs.CT{background:#12233d;color:#6bb0ff}
.mh-rhs.T{background:#2e2312;color:#e0a441}
.mh-rhs.none{background:#182640;color:#5f7390}
.mh-rhscroll{overflow-x:auto;overflow-y:hidden;min-width:0;flex:1;padding-bottom:2px}
.mh-rhgrid{display:grid;grid-auto-flow:column;grid-auto-columns:15px;
  grid-template-rows:15px 15px;gap:2px;width:max-content}
.mh-rhc{display:grid;place-items:center;border-radius:2px;background:#101c2e}
.mh-rhc.half{box-shadow:inset 2px 0 0 #3c5273}
.mh-ri{width:11px;height:11px}
.mh-ri.CT{color:#6bb0ff}
.mh-ri.T{color:#e0a441}
.mh-ri.none{color:#7f93ad}
.mh-sc{background:#142033;border:1px solid #23364f;color:#7f93ad;border-radius:3px;
  font:700 8px/1 inherit;padding:2px 4px;cursor:pointer;letter-spacing:.05em}
.mh-sc:hover{color:#cfe0f5}
.mh-sc.on{background:#1d3554;border-color:#33507a;color:#7fc0ff}
.mh-wp{padding:5px 7px}
.mh-wp svg{width:100%;height:30px;display:block}
.mh-wplbl{display:flex;justify-content:space-between;font-size:9.5px;margin-top:2px;
  font-weight:700;letter-spacing:.05em}
.mh-wplbl b{font-weight:700;padding:1px 4px;border-radius:3px}
.mh-wplbl b.CT{background:#12233d;color:#6bb0ff}
.mh-wplbl b.T{background:#2e2312;color:#e0a441}
.mh-wplbl b.none{background:#182640;color:#8ba0bb}
.mh-strow{display:flex;align-items:center;gap:4px;padding:3px 7px;font-size:10px;cursor:pointer;
  border-bottom:1px solid #101b2c}
.mh-strow:hover{background:#152238}
.mh-strow.mh-open{background:#152a49}
.mh-stn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d3e0f0}
.mh-stv{color:#93a7c1;flex:none;font-size:9.5px}
.mh-stv.hs{color:#d4a340;min-width:24px;text-align:right}
.mh-wpn{background:#0a121f;border-bottom:1px solid #101b2c;max-height:108px;overflow-y:auto}
.mh-wpn div{display:flex;justify-content:space-between;gap:5px;padding:2px 7px 2px 14px;
  font-size:9.5px;color:#8ba0bb}
.mh-wpn div.hi{color:#e0a441;background:#1a150b}
.mh-wpn div i{font-style:normal;color:#5f7390;font-size:9px;flex:none}
.mh-wpn div span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

    let root = null;
    const DEFAULT_BOX = { x: null, y: null, w: 760, h: 430 };

    function buildShell() {
        const style = document.createElement('style');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'mh-launch';
        btn.textContent = 'Dibu';
        btn.addEventListener('click', toggle);
        document.body.appendChild(btn);

        root = document.createElement('div');
        root.id = 'mh-root';
        root.innerHTML = `
      <div class="mh-top" id="mh-top">
        <div class="mh-brand">Dibu <b>Scraper</b></div>
        <div class="mh-title" id="mh-title">Waiting for data…</div>
        <div class="mh-stale" id="mh-stale" style="display:none"></div>
        <div class="mh-flash" id="mh-flash" style="display:none"></div>
        <div class="mh-lat" id="mh-lat" style="display:none"></div>
        <div class="mh-led" id="mh-led"></div>
        <button class="mh-gl" id="mh-exp" title="Export latency diagnostics">&#8615;</button>
        <button class="mh-gl snd" id="mh-snd" title="Sounds">&#9834;</button>
        <button class="mh-gl" id="mh-tl" title="Toggle match list (left)">&#9664;</button>
        <button class="mh-gl" id="mh-tr" title="Toggle stats panel (right)">&#9654;</button>
        <div class="mh-lights">
          <button class="mh-tl green" id="mh-max" title="Maximize">+</button>
          <button class="mh-tl red" id="mh-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="mh-body">
        <div class="mh-col" id="mh-left">
          <div class="mh-card" style="flex:1">
            <div class="mh-h"><span class="grow">Live matches</span>
              <button class="mh-gl" id="mh-filt" title="Filter">&#9673;</button></div>
            <div class="mh-scroll" id="mh-matches"></div>
          </div>
        </div>
        <div class="mh-col">
          <div class="mh-maps" id="mh-maps"></div>
          <div class="mh-strip" id="mh-strip"></div>
          <div class="mh-mid">
            <div class="mh-card"><div class="mh-scroll mh-plist" id="mh-t1"></div></div>
            <div class="mh-centre">
              <div class="mh-bg" id="mh-bg"></div><div class="mh-veil"></div>
              <div class="mh-fg" id="mh-fg"></div>
              <div class="mh-mapname" id="mh-mapname"></div>
            </div>
            <div class="mh-card"><div class="mh-scroll mh-plist" id="mh-t2"></div></div>
          </div>
          <div class="mh-card mh-log">
            <div class="mh-h"><span class="grow">Event log &amp; kill feed</span></div>
            <div class="mh-scroll" id="mh-log"></div>
          </div>
        </div>
        <div class="mh-col" id="mh-right">
          <div class="mh-card"><div class="mh-h"><span class="grow">Round history</span></div>
            <div class="mh-bars" id="mh-bars"></div></div>
          <div class="mh-card" id="mh-wpcard"><div class="mh-h"><span class="grow">Win prob</span>
            <span id="mh-wpsc" style="display:flex;gap:3px"></span>
            <button class="mh-gl" id="mh-wplog" title="Show odds history">&#9662;</button></div>
            <div class="mh-wp" id="mh-wp"></div>
            <div class="mh-scroll mh-oddslog" id="mh-oddslog" style="display:none"></div></div>
          <div class="mh-card" style="flex:1"><div class="mh-h" id="mh-sh1"><span class="grow">Team 1</span></div>
            <div class="mh-scroll" id="mh-s1"></div></div>
          <div class="mh-card" style="flex:1"><div class="mh-h" id="mh-sh2"><span class="grow">Team 2</span></div>
            <div class="mh-scroll" id="mh-s2"></div></div>
        </div>
      </div>`;
        document.body.appendChild(root);

        root.querySelector('#mh-close').addEventListener('click', toggle);
        root.querySelector('#mh-max').addEventListener('click', toggleMax);
        root.querySelector('#mh-tl').addEventListener('click', () => togglePane('nol', 'hideLeft'));
        root.querySelector('#mh-tr').addEventListener('click', () => togglePane('nor', 'hideRight'));
        root.querySelector('#mh-exp').addEventListener('click', ev => {
            ev.stopPropagation();
            exportDiagnostics();
        });
        root.querySelector('#mh-filt').addEventListener('click', ev => {
            ev.stopPropagation();
            S.onlyReadable = !S.onlyReadable;
            store('onlyReadable', S.onlyReadable);
            render();
        });
        root.querySelector('#mh-wplog').addEventListener('click', ev => {
            ev.stopPropagation();
            S.oddsLogOpen = !S.oddsLogOpen;
            store('oddsLog', S.oddsLogOpen);
            render();
        });
        root.querySelector('#mh-snd').addEventListener('click', () => {
            S.mute = !S.mute;
            store('mute', S.mute);
            syncSoundButton();
            if (!S.mute) { audioCtx(); S.soundReady = true; play('roundStart'); }
        });

        S.oddsLogOpen = store('oddsLog') === true;
        if (store('onlyReadable') === false) S.onlyReadable = false;
        if (store('hideLeft')) root.classList.add('mh-nol');
        if (store('hideRight')) root.classList.add('mh-nor');
        syncPaneButtons();
        syncSoundButton();

        applyBox(store('box') || DEFAULT_BOX);
        makeDraggable();
        persistSize();
    }

    function togglePane(cls, key) {
        const on = root.classList.toggle('mh-' + cls);
        store(key, on);
        syncPaneButtons();
        S.dirty = true;
        render();
    }
    function syncPaneButtons() {
        root.querySelector('#mh-tl').classList.toggle('on', !root.classList.contains('mh-nol'));
        root.querySelector('#mh-tr').classList.toggle('on', !root.classList.contains('mh-nor'));
    }
    function syncSoundButton() {
        const b = root.querySelector('#mh-snd');
        b.classList.toggle('off', S.mute);
        b.classList.toggle('on', !S.mute);
        b.title = S.mute ? 'Sounds off — click to enable' : 'Sounds on — click to mute';
    }

    // ---------- geometry ----------
    function applyBox(b) {
        const w = Math.min(b.w || DEFAULT_BOX.w, innerWidth - 16);
        const h = Math.min(b.h || DEFAULT_BOX.h, innerHeight - 16);
        const x = (b.x === null || b.x === undefined) ? Math.max(8, innerWidth - w - 16) : b.x;
        const y = (b.y === null || b.y === undefined) ? Math.max(8, innerHeight - h - 60) : b.y;
        root.style.width = w + 'px';
        root.style.height = h + 'px';
        root.style.left = Math.max(0, Math.min(x, innerWidth - 70)) + 'px';
        root.style.top = Math.max(0, Math.min(y, innerHeight - 34)) + 'px';
    }
    function saveBox() {
        if (root.classList.contains('mh-max')) return;
        store('box', {
            x: parseInt(root.style.left, 10) || 0, y: parseInt(root.style.top, 10) || 0,
            w: root.offsetWidth, h: root.offsetHeight,
        });
    }
    function toggleMax() {
        const max = root.classList.toggle('mh-max');
        root.querySelector('#mh-max').textContent = max ? '\u2212' : '+';
        root.querySelector('#mh-max').title = max ? 'Restore' : 'Maximize';
        if (!max) applyBox(store('box') || DEFAULT_BOX);
        S.dirty = true;
    }
    function makeDraggable() {
        const bar = root.querySelector('#mh-top');
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        bar.addEventListener('pointerdown', e => {
            if (e.target.closest('.mh-gl,.mh-tl')) return;
            if (root.classList.contains('mh-max')) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            ox = parseInt(root.style.left, 10) || 0;
            oy = parseInt(root.style.top, 10) || 0;
            bar.classList.add('mh-drag');
            bar.setPointerCapture(e.pointerId);
        });
        bar.addEventListener('pointermove', e => {
            if (!dragging) return;
            root.style.left = Math.max(0, Math.min(ox + e.clientX - sx, innerWidth - 70)) + 'px';
            root.style.top = Math.max(0, Math.min(oy + e.clientY - sy, innerHeight - 34)) + 'px';
        });
        const stop = () => { if (dragging) { dragging = false; bar.classList.remove('mh-drag'); saveBox(); } };
        bar.addEventListener('pointerup', stop);
        bar.addEventListener('pointercancel', stop);
    }
    function persistSize() {
        if (typeof ResizeObserver === 'undefined') return;
        let t = null;
        new ResizeObserver(() => { clearTimeout(t); t = setTimeout(saveBox, 400); }).observe(root);
    }

    function toggle() {
        S.open = !S.open;
        root.classList.toggle('mh-on', S.open);
        S.dirty = true;
        if (S.open) { audioCtx(); render(); }   // opening counts as the user gesture that unlocks audio
    }

    // ---------- helpers ----------
    function el(tag, cls, txt) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt !== undefined) e.textContent = txt;
        return e;
    }
    const hhmmss = d => d.toTimeString().slice(0, 8);

    function activeMap(g) {
        if (!g) return null;
        const num = S.selectedMapNum !== null ? S.selectedMapNum : g.liveMapNum;
        return g.maps.find(m => m.num === num) || g.maps.find(m => m.live) || g.maps[0] || null;
    }
    function sideOf(g, team) {
        const m = activeMap(g);
        return (team && m && m.sides[team.id]) ? SIDE[m.sides[team.id].side] : '';
    }
    // team.players is the INSCRIBED roster and can carry six or more (subs,
    // coach). The map's alive/dead list only ever contains the five actually on
    // the server, so that is the authoritative lineup — and it tracks per-map
    // roster changes for free.
    function activePlayers(g, team) {
        if (!team) return [];
        const m = activeMap(g);
        const alive = (m && m.sides[team.id]) ? m.sides[team.id].alive : null;
        const ids = alive ? Object.keys(alive) : [];
        if (!ids.length) return team.players.slice();
        const byId = {};
        team.players.forEach(p => { byId[p.steam] = p; });
        return ids.map(sid => byId[sid] || { steam: sid, nick: sid.slice(-5) });
    }
    function benchPlayers(g, team) {
        if (!team) return [];
        const active = new Set(activePlayers(g, team).map(p => p.steam));
        return team.players.filter(p => !active.has(p.steam));
    }

    // Only claim "Home/Away" when the odds feed actually confirmed the mapping.
    function sideLabel(g, idx) {
        if (g && g.orderKnown) return idx === 0 ? 'Home' : 'Away';
        return idx === 0 ? 'Team 1' : 'Team 2';
    }
    function sideLabelShort(g, idx) {
        if (g && g.orderKnown) return idx === 0 ? 'HOME' : 'AWAY';
        return idx === 0 ? 'T1' : 'T2';
    }

    function seriesScore(g) {
        const out = [0, 0];
        if (!g) return out;
        g.maps.forEach(m => {
            if (m.live && g.phase !== 'finished') return;
            const t1 = g.teams[0], t2 = g.teams[1];
            const r1 = t1 && m.sides[t1.id] ? m.sides[t1.id].rounds : 0;
            const r2 = t2 && m.sides[t2.id] ? m.sides[t2.id].rounds : 0;
            if (r1 + r2 === 0) return;
            if (r1 > r2) out[0]++;
            else if (r2 > r1) out[1]++;
        });
        return out;
    }

    // ---------- header ----------
    function renderLed() {
        const d = root.querySelector('#mh-led');
        d.classList.remove('warn', 'err');
        if (!S.rx.tree && !S.rx.grid) {
            d.classList.add('err');
            d.title = 'No frames intercepted. Reload the page so the hook installs before the sockets open.';
        } else if (!S.rx.grid) {
            d.classList.add('warn');
            d.title = `Odds feed only — no game state yet.\ntree ${S.rx.tree} · grid 0 · ws ${S.rx.sockets}`;
        } else {
            d.title = `ws ${S.rx.sockets} · tree ${S.rx.tree} · grid ${S.rx.grid} · ${S.rx.bad} undecoded`;
        }

        const lt = root.querySelector('#mh-lat');
        const med = latencyMedian();
        if (med === null) { lt.style.display = 'none'; }
        else {
            lt.style.display = '';
            lt.textContent = `-${med.toFixed(1)}s`;
            lt.classList.toggle('warn', med > 15);
            lt.title = 'How far behind live the game-state feed is, measured from the\n' +
                'source timestamp on each event. Around 8s is a fixed buffer applied\n' +
                'upstream and cannot be reduced. The round timer is NOT delayed —\n' +
                'it is computed against the real clock.\n' +
                `samples: ${S.lat.length}` +
                (S.clockOffset === null ? '\nclock vs server: not checked yet'
                    : `\nclock vs server: ${S.clockOffset >= 0 ? '+' : ''}${S.clockOffset.toFixed(1)}s` +
                      ` (real delay ~${(med - S.clockOffset).toFixed(1)}s)`);
        }

        const st = root.querySelector('#mh-stale');
        const secs = staleSeconds();
        if (secs === null) { st.style.display = 'none'; }
        else {
            st.style.display = '';
            st.textContent = `STALE ${secs}s`;
            st.title = 'No game-state push recently. Re-subscribing automatically.';
        }
    }

    // ---------- match list ----------
    function renderMatches() {
        const box = root.querySelector('#mh-matches');
        const btn = root.querySelector('#mh-filt');
        box.textContent = '';
        btn.classList.toggle('on', S.onlyReadable);
        btn.title = S.onlyReadable
            ? 'Showing only matches with a readable game-state feed — click for all'
            : 'Showing every match in the feed — click to filter';

        let list = Array.from(S.matches.values());
        const pending = list.filter(m => m.live && !readable(m.id) &&
            (S.probe.get(m.id) || {}).status === 'pending').length;

        if (S.onlyReadable) list = list.filter(m => readable(m.id) || m.id === S.active);

        if (!list.length) {
            box.appendChild(el('div', 'mh-empty', !S.rx.tree
                ? 'No frames intercepted — reload the page.'
                : (pending ? `Checking which matches have a feed…\n${pending} left`
                    : 'No matches with a readable feed.\nClick the filter to show all.')));
            return;
        }

        // Group by tournament so the list stops reshuffling on every update.
        const groups = new Map();
        list.forEach(m => {
            const name = S.tournaments.get(m.tournamentId) || 'Other';
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(m);
        });

        const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
        names.forEach(name => {
            const rows = groups.get(name).sort((a, b) => {
                if (a.live !== b.live) return a.live ? -1 : 1;
                const s = String(a.start).localeCompare(String(b.start));
                return s !== 0 ? s : a.home.short.localeCompare(b.home.short);
            });
            const head = el('div', 'mh-grp', name);
            head.title = `${name} · ${rows.length} match${rows.length > 1 ? 'es' : ''}`;
            box.appendChild(head);

            rows.forEach(m => {
                const waiting = m.id === S.active && !S.games.has(m.id);
                const row = el('div', 'mh-mrow' + (m.id === S.active ? ' mh-sel' : '') +
                    (waiting ? ' mh-nod' : ''));
                const wrap = el('div');
                wrap.style.cssText = 'flex:1;min-width:0';
                wrap.appendChild(el('div', 'mh-mname', `${m.home.short} vs ${m.away.short}`));
                wrap.appendChild(el('div', 'mh-mmeta', m.format || (m.live ? 'live' : '—')));
                row.appendChild(wrap);

                let tag;
                if (waiting) {
                    const n = S.retries.get(m.id) || 0;
                    tag = el('div', 'mh-tag nod', n ? `try ${n}` : 'wait');
                    tag.title = 'No game-state feed yet — retrying every 20s.';
                } else if (readable(m.id)) {
                    const lm = latencyOf(m.id);
                    tag = el('div', 'mh-tag live', lm === null ? 'LIVE' : `${lm.toFixed(1)}s`);
                    tag.title = lm === null ? 'Live' :
                        `Feed runs ${lm.toFixed(2)}s behind the source clock` +
                        ` (${(S.latByMatch.get(m.id) || []).length} samples)`;
                } else if ((S.probe.get(m.id) || {}).status === 'pending') {
                    tag = el('div', 'mh-tag up', '···');
                    tag.title = 'Checking for a game-state feed';
                } else if (m.live) {
                    tag = el('div', 'mh-tag nod', 'no feed');
                    tag.title = 'Live, but no GRID game-state feed available';
                } else {
                    tag = el('div', 'mh-tag up', (m.start || '').slice(11, 16) || '—');
                }
                row.appendChild(tag);

                row.addEventListener('click', () => { subscribeMatch(m.id); render(); });
                box.appendChild(row);
            });
        });
    }

    // ---------- team strip ----------
    function renderStrip(g) {
        const box = root.querySelector('#mh-strip');
        box.textContent = '';
        if (!g || !g.teams.length) { box.appendChild(el('div', 'mh-empty', 'No match selected.')); return; }

        [0, 1].forEach(i => {
            if (i === 1) {
                const ss = seriesScore(g);
                const sc = el('div', 'mh-series', `${ss[0]} - ${ss[1]}`);
                sc.title = 'Maps won';
                box.appendChild(sc);
            }
            const t = g.teams[i];
            const wrap = el('div', 'mh-team' + (i === 1 ? ' away' : ''));
            const logo = logoFor(g, t);
            if (logo) {
                const img = document.createElement('img');
                img.className = 'mh-logo';
                img.src = logo; img.alt = ''; img.referrerPolicy = 'no-referrer';
                img.addEventListener('error', () => img.classList.add('ph'));
                wrap.appendChild(img);
            } else {
                wrap.appendChild(el('div', 'mh-logo ph'));
            }
            const names = el('div');
            names.style.cssText = 'min-width:0';
            names.appendChild(el('div', 'mh-tn', t ? t.name : '—'));
            const bench = benchPlayers(g, t);
            const role = el('div', 'mh-ta', sideLabel(g, i));
            if (!g.orderKnown) {
                role.title = 'Could not match this match to the odds feed, so ' +
                    'home/away is unconfirmed — this is the game feed order.';
            }
            if (bench.length) {
                role.textContent += ` · +${bench.length}`;
                role.title = 'Not on the server: ' + bench.map(p => p.nick).join(', ');
            }
            names.appendChild(role);
            wrap.appendChild(names);
            const s = sideOf(g, t);
            if (s) wrap.appendChild(el('div', 'mh-side ' + s, s));
            box.appendChild(wrap);
        });
    }

    // ---------- map pills ----------
    function renderMaps(g) {
        const box = root.querySelector('#mh-maps');
        box.textContent = '';
        if (!g) return;
        const sel = activeMap(g);
        g.maps.forEach(m => {
            const card = el('div', 'mh-map' + (sel && sel.num === m.num ? ' on' : ''));
            card.appendChild(el('div', 'mh-mn', `M${m.num} · ${m.name || '—'}`));

            const t1 = g.teams[0], t2 = g.teams[1];
            const r1 = t1 && m.sides[t1.id] ? m.sides[t1.id].rounds : 0;
            const r2 = t2 && m.sides[t2.id] ? m.sides[t2.id].rounds : 0;
            card.appendChild(el('div', 'mh-msc', `${r1} — ${r2}`));

            const veto = el('div', 'mh-veto', vetoLabel(g.matchId, m.num, g.teams));
            veto.title = 'Click to set which team picked this map';
            veto.addEventListener('click', ev => {
                ev.stopPropagation();
                cycleVeto(g.matchId, m.num, g.teams);
                render();
            });
            card.appendChild(veto);

            const played = r1 + r2 > 0;
            let badge;
            if (m.live) badge = el('div', 'mh-badge live', 'LIVE');
            else if (m.num === g.maps.length && !played) badge = el('div', 'mh-badge dec', 'DEC');
            else if (!played) badge = el('div', 'mh-badge up', 'NEXT');
            else badge = el('div', 'mh-badge up', 'END');
            card.appendChild(badge);

            card.addEventListener('click', () => {
                S.selectedMapNum = (S.selectedMapNum === m.num) ? null : m.num;
                S.expandedPlayer = null;
                render();
            });
            box.appendChild(card);
        });
    }

    // ---------- centre ----------
    function renderCentre(g) {
        const bg = root.querySelector('#mh-bg');
        const fg = root.querySelector('#mh-fg');
        const nm = root.querySelector('#mh-mapname');
        fg.textContent = '';
        nm.textContent = '';
        bg.style.backgroundImage = '';

        if (!g) {
            if (!S.active) {
                fg.appendChild(el('div', 'mh-empty', S.rx.grid ? 'Pick a match.'
                    : 'No frames yet. Reload the page so the hook installs before the sockets open.'));
            } else {
                const n = S.retries.get(S.active) || 0;
                fg.appendChild(el('div', 'mh-empty',
                    'Waiting for the game-state feed.\n' +
                    (n ? `Retried ${n}\u00d7 · next in <20s` : 'Retrying every 20s')));
            }
            return;
        }

        const m = activeMap(g);
        // The map photo reads far better than the minimap PNG at low opacity.
        if (m && (m.photo || m.minimap)) bg.style.backgroundImage = `url("${m.photo || m.minimap}")`;
        if (m && m.name) nm.textContent = m.name;

        const total = m ? Object.values(m.sides).reduce((a, s) => a + s.rounds, 0) : 0;
        const roundNo = g.phase === 'round_end' ? total : total + 1;

        fg.appendChild(el('div', 'mh-round', g.phase === 'finished' ? 'FINAL' : `ROUND ${roundNo}`));
        fg.appendChild(el('div', 'mh-pname', (g.phase || '—').replace(/_/g, ' ')));
        const clock = el('div', 'mh-clock' + (g.bombPlanted ? ' bomb' : ''), remaining(g));
        clock.id = 'mh-clock';
        fg.appendChild(clock);

        const holder = document.createElement('div');
        holder.innerHTML = C4_SVG;
        const c4 = holder.firstChild;
        if (g.bombPlanted) c4.classList.add('armed');
        c4.setAttribute('title', g.bombPlanted ? 'Bomb planted' : 'Bomb not planted');
        fg.appendChild(c4);
    }

    function remaining(g) {
        if (!g || !g.phaseStart || !g.phaseDur) return '—';
        const end = Date.parse(g.phaseStart) + g.phaseDur * 1000;
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }

    // ---------- rosters ----------
    function renderRoster(g, idx, listId) {
        const list = root.querySelector(listId);
        list.textContent = '';
        const t = g && g.teams[idx];
        list.className = 'mh-scroll mh-plist';
        if (!t) return;

        const m = activeMap(g);
        const mn = m ? m.num : g.liveMapNum;
        const alive = (m && m.sides[t.id]) ? m.sides[t.id].alive : {};
        const side = sideOf(g, t);
        if (side) list.classList.add(side === 'CT' ? 'ct' : 'tt');

        const weaps = (g.roundWeapons && S.selectedMapNum === null) ? g.roundWeapons : {};

        activePlayers(g, t).forEach(p => {
            const st = (g.stats[mn] && g.stats[mn][p.steam]) || EMPTY_STAT;
            const isDead = alive[p.steam] === 0;
            const row = el('div', 'mh-p' + (isDead ? ' dead' : '') +
                (S.expandedPlayer === p.steam ? ' mh-open' : ''));
            row.appendChild(el('div', 'mh-dot' + (isDead ? ' dead' : '')));
            row.appendChild(el('div', 'mh-nick', p.nick));

            const cat = weaponCat(weaps[p.steam]);
            if (cat) {
                const holder = document.createElement('div');
                holder.innerHTML = `<svg class="mh-w ${cat}" viewBox="0 0 12 12">${WICON[cat]}</svg>`;
                const svg = holder.firstChild;
                svg.setAttribute('title', `Last kill this round: ${weaponName(weaps[p.steam])}`);
                row.appendChild(svg);
            } else {
                row.appendChild(el('div', 'mh-w ph'));
            }

            const kda = el('div', 'mh-kda');
            kda.innerHTML = `<b>${st.k}</b>/${st.d}/${st.a}`;
            row.appendChild(kda);
            row.title = p.steam;
            row.addEventListener('click', () => {
                S.expandedPlayer = S.expandedPlayer === p.steam ? null : p.steam;
                render();
            });
            list.appendChild(row);
        });
    }

    // ---------- log ----------
    function renderLog(g) {
        const box = root.querySelector('#mh-log');
        const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
        box.textContent = '';
        if (!g || !g.events.length) { box.appendChild(el('div', 'mh-empty', 'No events yet.')); return; }
        g.events.slice(-120).forEach(e => {
            const side = e.teamIdx === 0 ? ' home' : (e.teamIdx === 1 ? ' away' : '');
            const row = el('div', 'mh-ev ' + e.type + side);
            const t = document.createElement('time');
            t.textContent = hhmmss(e.t);
            row.appendChild(t);
            row.appendChild(el('span', '', e.text));
            box.appendChild(row);
        });
        if (stick) box.scrollTop = box.scrollHeight;
    }

    // ---------- round history ----------
    function renderBars(g) {
        const box = root.querySelector('#mh-bars');
        box.textContent = '';
        if (!g) return;
        const m = activeMap(g);
        if (!m) return;
        const hist = g.roundHistory[m.num] || [];
        if (!hist.length) { box.appendChild(el('div', 'mh-empty', 'Fills up from connect.')); return; }

        // Left gutter: which side each team is on right now.
        const gutter = el('div', 'mh-rhg');
        [0, 1].forEach(i => {
            const s = sideOf(g, g.teams[i]);
            const cell = el('div', 'mh-rhs ' + (s || 'none'), s || '—');
            cell.title = `${sideLabel(g, i)} · ${(g.teams[i] || {}).name || ''}`;
            gutter.appendChild(cell);
        });
        box.appendChild(gutter);

        const scroll = el('div', 'mh-rhscroll');
        const grid = el('div', 'mh-rhgrid');
        const t1 = g.teams[0];

        hist.forEach((r, i) => {
            const winnerRow = (t1 && r.teamId === t1.id) ? 0 : 1;
            // Data-driven half boundary, so overtime splits work too.
            const half = i > 0 && r.homeSide && hist[i - 1].homeSide &&
                hist[i - 1].homeSide !== r.homeSide;
            [0, 1].forEach(row => {
                const cell = el('div', 'mh-rhc' + (half ? ' half' : ''));
                if (row === winnerRow) {
                    const s = SIDE[r.side] || 'none';
                    const holder = document.createElement('div');
                    holder.innerHTML = `<svg class="mh-ri ${s}" viewBox="0 0 11 11">` +
                        `${RICON[r.reason] || RICON.elim}</svg>`;
                    cell.appendChild(holder.firstChild);
                    cell.title = `Round ${r.round} · ` +
                        `${(g.teams.find(t => t.id === r.teamId) || {}).name || ''} (${s})` +
                        ` · ${REASON[r.reason] || 'win'}`;
                }
                grid.appendChild(cell);
            });
        });

        scroll.appendChild(grid);
        box.appendChild(scroll);
        scroll.scrollLeft = scroll.scrollWidth;   // keep the latest round in view
    }

    // ---------- win probability ----------
    function wpScopes(g) {
        const o = g ? S.odds.get(g.matchId) : null;
        if (!o) return [];
        const out = [];
        if (o.scopes.match && o.scopes.match.history.length) out.push('match');
        Object.keys(o.scopes).filter(k => k !== 'match').sort().forEach(k => {
            if (o.scopes[k].history.length) out.push(k);
        });
        return out;
    }

    // Every market that claimed this scope, chosen or not — used to warn in the
    // UI when more than one does.
    function scopeMarkets(g, scope) {
        const o = g ? S.odds.get(g.matchId) : null;
        if (!o || !o.markets) return [];
        return Object.keys(o.markets).map(k => o.markets[k]).filter(e => e.scope === scope);
    }

    function renderWinProb(g) {
        const sel = root.querySelector('#mh-wpsc');
        const box = root.querySelector('#mh-wp');
        sel.textContent = '';
        box.textContent = '';
        if (!g) return;

        const scopes = wpScopes(g);
        if (!scopes.length) { box.appendChild(el('div', 'mh-empty', 'No odds.')); return; }
        if (scopes.indexOf(S.wpScope) < 0) S.wpScope = scopes[0];

        scopes.forEach(sc => {
            const b = el('button', 'mh-sc' + (sc === S.wpScope ? ' on' : ''),
                sc === 'match' ? 'MATCH' : 'M' + sc.replace('map-', ''));
            const cands = scopeMarkets(g, sc);
            const chosen = S.odds.get(g.matchId).scopes[sc];
            const mg = chosen ? marginPct(chosen) : null;
            b.title = (sc === 'match' ? 'Match winner' : 'Map ' + sc.replace('map-', '') + ' winner') +
                `\nmarket ${chosen ? chosen.mid : '?'}` +
                (chosen && chosen.label ? ` · ${chosen.label}` : '') +
                (mg === null ? '' : `\nmargin ${mg >= 0 ? '+' : ''}${mg.toFixed(2)}%` +
                    (mg < 0 ? ' — under 100%, a selection is missing' : '')) +
                (chosen && chosen.p3 > 1 ? `\ndraw priced at ${chosen.p3} (not plotted)` : '') +
                (cands.length > 1
                    ? `\n${cands.length} markets claim this scope — run __dibu.oddsMarkets()` +
                      ` to inspect, __dibu.pick('${sc}', id) to force one`
                    : '');
            // An asterisk means more than one market named this map, so the
            // chart is showing whichever ranked highest.
            if (cands.length > 1) b.textContent += '*';
            b.addEventListener('click', ev => {
                ev.stopPropagation();
                S.wpScope = sc;
                render();
            });
            sel.appendChild(b);
        });

        const e = S.odds.get(g.matchId).scopes[S.wpScope];
        const h = e.history.slice(-120);
        const w = 200, ht = 30;
        const pts = h.map((d, i) => `${(i / Math.max(1, h.length - 1)) * w},${(1 - d.p) * ht}`).join(' ');
        const holder = document.createElement('div');
        holder.innerHTML = `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none">` +
            `<line x1="0" y1="${ht / 2}" x2="${w}" y2="${ht / 2}" stroke="#1e2e46" stroke-width="1"/>` +
            `<polyline points="${pts}" fill="none" stroke="#d4a340" stroke-width="1.5" ` +
            `stroke-linejoin="round" stroke-linecap="round"/></svg>`;
        box.appendChild(holder.firstChild);

        // Team names blow out this column, so label Home/Away and colour by side.
        const last = h[h.length - 1];
        const mk = (txt, team) => {
            const b = document.createElement('b');
            b.className = sideOf(g, team) || 'none';
            b.textContent = txt;
            return b;
        };
        const lbl = el('div', 'mh-wplbl');
        const l = el('span');
        l.appendChild(mk(`${sideLabelShort(g, 0)} ${(last.p * 100).toFixed(0)}%`, g.teams[0]));
        const r = el('span');
        r.appendChild(mk(`${((1 - last.p) * 100).toFixed(0)}% ${sideLabelShort(g, 1)}`, g.teams[1]));
        lbl.appendChild(l); lbl.appendChild(r);
        lbl.title = `${(g.teams[0] || {}).name} ${last.o1} · ${last.o2} ${(g.teams[1] || {}).name}`;
        box.appendChild(lbl);

        renderOddsLog(e);
    }

    const gameOf = () => (S.active ? S.games.get(S.active) : null);

    // Full odds history, newest first, as the decimal odds the feed actually sends.
    function renderOddsLog(e) {
        const log = root.querySelector('#mh-oddslog');
        const card = root.querySelector('#mh-wpcard');
        const btn = root.querySelector('#mh-wplog');
        log.textContent = '';
        log.style.display = S.oddsLogOpen ? '' : 'none';
        card.style.flex = S.oddsLogOpen ? '1' : '';
        btn.innerHTML = S.oddsLogOpen ? '&#9652;' : '&#9662;';
        btn.classList.toggle('on', S.oddsLogOpen);
        if (!S.oddsLogOpen || !e) return;

        const rows = e.history.slice().reverse();
        const head = el('div', 'mh-ol head');
        head.innerHTML = '<time>time</time>' +
            `<span>${sideLabelShort(gameOf(), 0).toLowerCase()}</span>` +
            `<span>${sideLabelShort(gameOf(), 1).toLowerCase()}</span>`;
        log.appendChild(head);

        rows.forEach((d, i) => {
            const prev = rows[i + 1];
            const row = el('div', 'mh-ol');
            const t = document.createElement('time');
            t.textContent = new Date(d.t).toTimeString().slice(0, 8);
            row.appendChild(t);
            const cell = (val, before) => {
                const s = el('span');
                let mark = '';
                if (before !== undefined && before !== null) {
                    if (val > before) { s.classList.add('up'); mark = ' \u25B2'; }
                    else if (val < before) { s.classList.add('down'); mark = ' \u25BC'; }
                }
                s.textContent = val.toFixed(2) + mark;
                return s;
            };
            row.appendChild(cell(d.o1, prev && prev.o1));
            row.appendChild(cell(d.o2, prev && prev.o2));
            row.title = `Home ${(d.p * 100).toFixed(1)}% · Away ${((1 - d.p) * 100).toFixed(1)}%`;
            log.appendChild(row);
        });
    }

    // ---------- per-team stats ----------
    function renderTeamStats(g, idx, headId, listId) {
        const head = root.querySelector(headId).querySelector('.grow');
        const box = root.querySelector(listId);
        box.textContent = '';
        const t = g && g.teams[idx];
        head.textContent = t ? `${sideLabel(g, idx)} · ${t.name}` : sideLabel(g, idx);
        if (!t) return;

        const m = activeMap(g);
        const mn = m ? m.num : g.liveMapNum;
        const table = g.stats[mn] || {};

        const rows = activePlayers(g, t).map(p => ({ p, st: table[p.steam] || EMPTY_STAT }));
        const played = m ? Object.values(m.sides).reduce((a, s) => a + s.rounds, 0) : 0;
        const recorded = rows.reduce((a, r) => a + r.st.k, 0);
        if (played > 0 && recorded === 0) {
            box.appendChild(el('div', 'mh-empty', 'Map ended before connect. Stats count live only.'));
        }

        rows.sort((a, b) => b.st.k - a.st.k);
        rows.forEach(r => {
            const open = S.expandedPlayer === r.p.steam;
            const row = el('div', 'mh-strow' + (open ? ' mh-open' : ''));
            row.appendChild(el('div', 'mh-stn', r.p.nick));
            row.appendChild(el('div', 'mh-stv', `${r.st.k}/${r.st.d}/${r.st.a}`));
            row.appendChild(el('div', 'mh-stv hs', `${r.st.hs}hs`));
            row.title = `1st half ${r.st.h1} · 2nd half ${r.st.h2} · OT ${r.st.ot}`;
            row.addEventListener('click', () => {
                S.expandedPlayer = open ? null : r.p.steam;
                render();
            });
            box.appendChild(row);

            if (open) {
                const panel = el('div', 'mh-wpn');
                const halves = el('div');
                halves.innerHTML = `<span>Kills per half</span>` +
                    `<i>1st ${r.st.h1} · 2nd ${r.st.h2} · OT ${r.st.ot}</i>`;
                panel.appendChild(halves);

                const ws = Object.entries(r.st.weapons).sort((a, b) => b[1].k - a[1].k);
                if (!ws.length) {
                    const d = el('div');
                    d.innerHTML = '<span>No kills recorded</span><i></i>';
                    panel.appendChild(d);
                } else {
                    ws.forEach(([w, v]) => {
                        const d = el('div', isTracked(w) ? 'hi' : '');
                        d.innerHTML = `<span>${weaponName(w)}</span><i>${v.k}k · ${v.hs}hs</i>`;
                        panel.appendChild(d);
                    });
                }
                box.appendChild(panel);
            }
        });
    }

    let flashTimer = null;
    function flash(msg) {
        const t = root && root.querySelector('#mh-flash');
        if (!t) return;
        t.textContent = msg;
        t.style.display = '';
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
    }

    // Dump every latency sample so a session can be analysed offline: is the
    // delay identical across matches (betboom-wide buffer) or does it vary by
    // tournament (upstream provider)?
    function exportDiagnostics() {
        const matches = [];
        S.latByMatch.forEach((samples, id) => {
            const meta = S.matches.get(id);
            const ds = samples.map(x => x.d);
            const mean = ds.reduce((a, b) => a + b, 0) / (ds.length || 1);
            matches.push({
                matchId: id,
                teams: meta ? `${meta.home.short} vs ${meta.away.short}` : null,
                tournament: meta ? (S.tournaments.get(meta.tournamentId) || null) : null,
                samples: samples.length,
                median: medianOf(ds),
                mean: Number(mean.toFixed(3)),
                min: Math.min.apply(null, ds),
                max: Math.max.apply(null, ds),
                stdev: Number(Math.sqrt(ds.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
                    (ds.length || 1)).toFixed(4)),
                raw: samples,
            });
        });
        const report = {
            script: 'dibu-scraper',
            version: VERSION,
            exportedAt: new Date().toISOString(),
            sessionMinutes: Number(((Date.now() - S.sessionStart) / 60000).toFixed(1)),
            clockOffsetSeconds: S.clockOffset,
            clockNote: 'positive = local clock ahead of server; subtract from latencies',
            frames: S.rx,
            matches: matches.sort((a, b) => (b.samples || 0) - (a.samples || 0)),
        };
        const text = JSON.stringify(report, null, 1);
        const name = `dibu-latency-${Date.now()}.json`;
        let url = null;
        try {
            url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        } catch (e) {
            try { url = 'data:application/json;charset=utf-8,' + encodeURIComponent(text); }
            catch (e2) { url = null; }
        }
        if (!url) {
            console.error('[Dibu] export failed; report follows', report);
            flash('Export failed — report logged to console');
            return;
        }
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                if (url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
            }, 5000);
            const n = report.matches.reduce((x, m) => x + m.samples, 0);
            flash(`Exported ${n} samples from ${report.matches.length} match(es)`);
        } catch (e) {
            console.error('[Dibu] export failed; report follows', report);
            flash('Export failed — report logged to console');
        }
    }

    // ---------- master render ----------
    function render() {
        if (!root || !S.open) return;
        const g = S.active ? S.games.get(S.active) : null;
        const meta = S.active ? S.matches.get(S.active) : null;

        const title = root.querySelector('#mh-title');
        if (g && g.teams.length === 2) {
            const t = [S.tournaments.get(meta && meta.tournamentId), meta && meta.format]
                .filter(Boolean).join(' · ');
            title.textContent = t || `${g.teams[0].name} vs ${g.teams[1].name}`;
        } else if (S.active) {
            const n = S.retries.get(S.active) || 0;
            title.textContent = (meta ? `${meta.home.short} vs ${meta.away.short}` : S.active) +
                (n ? ` — waiting for feed (${n})` : ' — waiting for feed');
        } else {
            title.textContent = 'Waiting for data…';
        }

        renderLed();
        if (!root.classList.contains('mh-nol')) renderMatches();
        renderStrip(g);
        renderMaps(g);
        renderCentre(g);
        renderRoster(g, 0, '#mh-t1');
        renderRoster(g, 1, '#mh-t2');
        renderLog(g);
        if (!root.classList.contains('mh-nor')) {
            renderBars(g);
            renderWinProb(g);
            renderTeamStats(g, 0, '#mh-sh1', '#mh-s1');
            renderTeamStats(g, 1, '#mh-sh2', '#mh-s2');
        }
    }

    // =====================================================================
    // 11. BOOT
    // =====================================================================

    function boot() {
        if (root) return;             // idempotent: never build a second panel
        buildShell();

        const m = location.pathname.match(/\/(\d+)\/?$/);
        if (m && !S.active) { S.active = m[1]; S.activePinned = true; }

        setInterval(() => { if (S.open && S.dirty) { S.dirty = false; render(); } }, 350);
        setInterval(watchdog, 5000);
        setInterval(probeMatches, 700);
        checkClock();
        setInterval(checkClock, 600000);

        // Clock ticks separately so the panel isn't repainted 4x/second.
        setInterval(() => {
            if (!S.open || !root) return;
            const c = root.querySelector('#mh-clock');
            const g = S.active ? S.games.get(S.active) : null;
            if (c && g) c.textContent = remaining(g);
            const st = root.querySelector('#mh-stale');
            const secs = staleSeconds();
            if (secs === null) st.style.display = 'none';
            else { st.style.display = ''; st.textContent = `STALE ${secs}s`; }
        }, 250);

        addEventListener('keydown', e => {
            if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggle(); }
        });

        // Console diagnostics for markets: `window.__dibu.markets()` turns on
        // capture and, on the next call, prints every (marketId | label | slug)
        // combination the odds feed carried, with how each was classified. Use
        // it when a match shows fewer win-prob scopes than expected.
        try {
            Object.defineProperty(PAGE, '__dibu', {
                configurable: true,
                value: {
                    markets() {
                        if (!S.mktDebug) {
                            S.mktDebug = true; S.mktSeen.clear();
                            console.log('[Dibu] market capture ON — wait ~10s, then run __dibu.markets() again.');
                            return;
                        }
                        const rows = Array.from(S.mktSeen.entries()).map(([k, n]) => {
                            const [mid, label, slug] = k.split('|');
                            const fake = { 13: +mid, 18: label, 22: slug };
                            return { marketId: +mid, label, slug, count: n, classifiedAs: scopeOf(fake) || '(ignored)' };
                        }).sort((a, b) => b.count - a.count);
                        console.table(rows);
                        return rows;
                    },
                    scopes() {
                        const g = S.active ? S.games.get(S.active) : null;
                        const o = g ? S.odds.get(g.matchId) : (S.active ? S.odds.get(S.active) : null);
                        return o ? Object.keys(o.scopes) : [];
                    },
                    // Every odds market captured for the selected match, with the
                    // scope it was classified into and whether the chart is using
                    // it. Two rows sharing a scope is normal — that is exactly the
                    // collision that used to corrupt the history.
                    oddsMarkets() {
                        const g = S.active ? S.games.get(S.active) : null;
                        const o = S.odds.get(g ? g.matchId : S.active);
                        if (!o || !o.markets) { console.log('[Dibu] no odds captured yet'); return []; }
                        const rows = Object.keys(o.markets).map(k => {
                            const e = o.markets[k];
                            const mg = marginPct(e);
                            return {
                                scope: e.scope, marketId: e.mid, label: e.label, slug: e.slug,
                                p1: e.p1, p2: e.p2, draw: e.p3,
                                // Negative margin = a selection is missing from
                                // the pair, so this is not a two-way line.
                                marginPct: mg,
                                impliedMissing: (mg !== null && mg < 0)
                                    ? Number((-mg / 100).toFixed(4)) : null,
                                points: e.history.length,
                                rank: marketRank(e), chosen: o.scopes[e.scope] === e,
                            };
                        }).sort((a, b) => String(a.scope).localeCompare(String(b.scope)) ||
                            b.rank - a.rank);
                        console.table(rows);
                        return rows;
                    },
                    // Every selection code the feed has sent, with a sample
                    // market. Use it when a price we expect is missing: if the
                    // draw is not in this list the feed never sent one for that
                    // market; if it is, the code it uses is right here.
                    codes() {
                        const rows = Array.from(S.codeSeen.values()).map(c => {
                            const [mid, label, slug] = String(c.sample).split('|');
                            return {
                                code: c.code,
                                codePoints: Array.from(c.code)
                                    .map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
                                    .join(' '),
                                readAs: selOf(c.code) || '(ignored)',
                                count: c.n, sampleMarket: mid, sampleLabel: label, sampleSlug: slug,
                            };
                        }).sort((a, b) => b.count - a.count);
                        console.table(rows);
                        return rows;
                    },
                    // Force a scope onto a specific market id; survives reloads.
                    pick(scope, mid) {
                        store('mkt:' + scope, String(mid));
                        S.odds.forEach(o => electMarket(o, scope));
                        S.dirty = true;
                        console.log(`[Dibu] ${scope} pinned to market ${mid}`);
                    },
                    unpick(scope) {
                        store('mkt:' + scope, '');
                        S.odds.forEach(o => electMarket(o, scope));
                        S.dirty = true;
                        console.log(`[Dibu] ${scope} back to automatic`);
                    },
                    state: () => S,
                },
            });
        } catch (e) { /* noop */ }
        addEventListener('resize', () => { if (root && S.open) applyBox(store('box') || DEFAULT_BOX); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
