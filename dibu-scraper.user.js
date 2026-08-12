// ==UserScript==
// @name         Dibu Scraper (CS2)
// @namespace    https://github.com/Stiztz/tampermonkey-scripts-gg
// @version      1.3.0
// @description  bb scraper
// @author       GG
// @match        https://betboom.ru/esport/*
// @run-at       document-start
// @grant        none
// @updateURL    https://github.com/Stiztz/tampermonkey-scripts-gg/raw/refs/heads/main/dibu-scraper.user.js
// @downloadURL  https://github.com/Stiztz/tampermonkey-scripts-gg/raw/refs/heads/main/dibu-scraper.user.js
// ==/UserScript==

/* eslint-disable no-bitwise */

// IMPORTANT: this script must run in the PAGE context, not in Tampermonkey's
// sandbox. Any @grant other than `none` makes TM wrap the script so that
// `window` is an isolated proxy — assigning window.WebSocket there does NOT
// patch the real one and no frames are ever intercepted. Keep @grant none.

(function () {
    'use strict';

    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

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

    const SFX = {
        // Home kills ring bright and upward, away kills land low and dull, so
        // you can tell who got the frag without looking at the panel.
        killHome() { beep(1046, 0.09, 'triangle', 0.16); beep(1568, 0.08, 'triangle', 0.11, 0.045); },
        killAway() { beep(392, 0.11, 'sawtooth', 0.11); beep(262, 0.12, 'sawtooth', 0.09, 0.05); },
        roundStart() { beep(523, 0.08, 'sine', 0.13); beep(659, 0.08, 'sine', 0.13, 0.085); beep(784, 0.14, 'sine', 0.14, 0.17); },
        bomb() { for (let i = 0; i < 3; i++) beep(1180, 0.055, 'square', 0.14, i * 0.13); },
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
        subscribed: new Set(),
        noData: new Set(),
        waiting: new Map(),
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

    // 8489 = match winner. 8494 / 8595 = map winner (8494 is the plain 2-way,
    // 8595 is regulation-time and may carry a draw, so 8494 wins when both show up).
    const MARKET_MATCH = 8489;
    const MARKET_MAP = [8494, 8595];

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
                };
                if (JSON.stringify(prev) !== JSON.stringify(rec)) { S.matches.set(id, rec); changed = true; }
            }

            // market: {1:"od:match:...", 2:matchId, 6:code, 10:odds, 13:marketId, 22:scopeSlug}
            if (typeof node[1] === 'string' && node[1].indexOf('od:match:') === 0 &&
                typeof node[10] === 'number' && typeof node[2] === 'number') {
                const mid = node[13];
                let scope = null;
                if (mid === MARKET_MATCH) scope = 'match';
                else if (MARKET_MAP.indexOf(mid) >= 0 && typeof node[22] === 'string' &&
                    /^map-\d+$/.test(node[22])) scope = node[22];
                if (!scope) return;

                const id = String(node[2]);
                const o = S.odds.get(id) || { scopes: {} };
                let e = o.scopes[scope];
                if (!e || (e.mid === 8595 && mid === 8494)) {
                    e = { mid, p1: null, p2: null, history: [] };
                    o.scopes[scope] = e;
                } else if (e.mid !== mid) {
                    return; // a lesser market for a scope we already track
                }
                if (node[6] === 'П1') e.p1 = node[10];
                if (node[6] === 'П2') e.p2 = node[10];
                if (e.p1 > 1 && e.p2 > 1) {
                    const p = (1 / e.p1) / ((1 / e.p1) + (1 / e.p2));
                    const last = e.history[e.history.length - 1];
                    // Keep the decimal odds too — that is what the feed actually
                    // sends, and it is what the history log shows.
                    if (!last || last.o1 !== e.p1 || last.o2 !== e.p2) {
                        e.history.push({ t: Date.now(), o1: e.p1, o2: e.p2, p });
                        if (e.history.length > 500) e.history.shift();
                        changed = true;
                    }
                }
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
        const idx = g.teams.indexOf(team);
        const c = idx === 0 ? m.home : (idx === 1 ? m.away : null);
        return c ? c.logo : '';
    }

    // =====================================================================
    // 7. GRID_WIDGET_WS — game state
    // =====================================================================

    const SIDE = { 'terrorists': 'T', 'counter-terrorists': 'CT' };

    function handleGrid(msg) {
        const payload = msg[4] || msg[5];
        if (!payload || typeof payload !== 'object') return;
        const gs = payload[4] && payload[4][1];
        if (!gs) return;

        const matchId = String(payload[1] || '');
        if (!matchId) return;

        if (S.waiting.has(matchId)) { clearTimeout(S.waiting.get(matchId)); S.waiting.delete(matchId); }
        S.noData.delete(matchId);

        let g = S.games.get(matchId);
        if (!g) { g = newGame(matchId); S.games.set(matchId, g); }
        if (!S.active || !S.games.has(S.active)) S.active = matchId;

        // NOTE: team field 3 is NOT maps won. It stayed 1/0 across a whole
        // series whose real score went 0:1 -> 1:1 -> 1:2, so it reads as an
        // is-home flag. Series score is derived from the maps instead.
        g.teams = arr(gs[3]).map(t => ({
            id: t[1], name: t[2], flag3: t[3] || 0, slot: t[4] || 0,
            players: arr(t[5]).map(p => ({ steam: p[1], nick: p[2] })),
        })).sort((a, b) => a.slot - b.slot);

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

        // round history from score deltas
        if (liveMap) {
            const mn = liveMap.num;
            if (!g.prevRounds[mn]) g.prevRounds[mn] = {};
            if (!g.roundHistory[mn]) g.roundHistory[mn] = [];
            let total = Object.values(g.prevRounds[mn]).reduce((a, b) => a + b, 0);
            for (const tid in liveMap.sides) {
                const now = liveMap.sides[tid].rounds;
                const before = g.prevRounds[mn][tid];
                if (before !== undefined && now > before) {
                    for (let n = before; n < now; n++) {
                        total += 1;
                        g.roundHistory[mn].push({ round: total, teamId: tid, side: liveMap.sides[tid].side });
                        const tName = (g.teams.find(t => t.id === tid) || {}).name || tid;
                        logEvent(g, 'round', `ROUND ${total} — ${tName} wins`);
                    }
                }
                g.prevRounds[mn][tid] = now;
            }
        }

        const timer = gs[2] || {};
        const newPhase = gs[1];
        if (newPhase !== g.phase) {
            const hadPhase = g.phase !== null;
            g.phase = newPhase;
            g.phaseStart = timer[1] || null;
            g.phaseDur = timer[4] || null;
            if (newPhase === 'bomb_has_been_planted') {
                g.bombPlanted = true; logEvent(g, 'bomb', 'BOMB PLANTED'); play('bomb');
            } else if (newPhase === 'bomb_has_been_exploded') {
                g.bombPlanted = false; logEvent(g, 'bomb', 'BOMB EXPLODED');
            } else if (newPhase === 'bomb_has_been_defused') {
                g.bombPlanted = false; logEvent(g, 'bomb', 'BOMB DEFUSED');
            } else if (newPhase === 'round') {
                g.bombPlanted = false;
                if (hadPhase) play('roundStart');
            } else if (newPhase === 'round_end' || newPhase === 'await_round' || newPhase === 'freezetime') {
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

        const kill = gs[5];
        if (kill && kill[6] && !g.seenKills.has(kill[6])) {
            g.seenKills.add(kill[6]);
            processKill(g, kill, liveMap);
        }

        g.lastUpdate = Date.now();
        if (!S.soundReady) setTimeout(() => { S.soundReady = true; }, 2500);
        S.dirty = true;
    }

    function nickOf(g, steamId) {
        for (let i = 0; i < g.teams.length; i++) {
            const p = g.teams[i].players.find(p => p.steam === steamId);
            if (p) return { nick: p.nick, team: g.teams[i].name, teamId: g.teams[i].id, idx: i };
        }
        return { nick: steamId ? steamId.slice(-5) : '?', team: '', teamId: null, idx: -1 };
    }

    function processKill(g, kill, liveMap) {
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
        S.selectedMapNum = null;
        S.expandedPlayer = null;
        S.wpScope = 'match';
        S.dirty = true;
        if (S.games.has(matchId)) return;

        const sock = S.gridSockets.find(s => s.readyState === 1);
        if (!sock) { S.noData.add(matchId); return; }
        if (S.subscribed.has(matchId)) return;
        S.subscribed.add(matchId);
        if (!sendSub(sock, matchId)) { S.noData.add(matchId); return; }

        S.waiting.set(matchId, setTimeout(() => {
            if (!S.games.has(matchId)) { S.noData.add(matchId); S.dirty = true; }
            S.waiting.delete(matchId);
        }, 8000));
    }

    // The site drops game-state pushes between maps (its own widgets go blank
    // too). Rather than needing a page reload, re-assert the subscription when
    // the feed goes quiet — a fresh snapshot is exactly what we want anyway.
    const STALE_MS = 20000;
    function watchdog() {
        if (!S.active) return;
        const sock = S.gridSockets.find(s => s.readyState === 1);
        if (!sock) return;
        const g = S.games.get(S.active);
        const since = g ? Date.now() - g.lastUpdate : Infinity;
        if (since < STALE_MS) return;
        if (Date.now() - S.lastResub < STALE_MS) return;
        S.lastResub = Date.now();
        sendSub(sock, S.active);
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
.mh-empty{padding:10px 8px;color:#41536c;font-size:10.5px;text-align:center;line-height:1.55}

/* ---------- match list ---------- */
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
.mh-bars{display:flex;align-items:flex-end;gap:1.5px;height:38px;padding:5px 7px}
.mh-bar{flex:1;min-width:2px;border-radius:1px 1px 0 0;background:#22334c}
.mh-bar.home{background:#4a9eff}
.mh-bar.away{background:#d4a340}
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
        <div class="mh-led" id="mh-led"></div>
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
            <div class="mh-h"><span class="grow">Live matches</span></div>
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
          <div class="mh-card" style="flex:1"><div class="mh-h" id="mh-sh1"><span class="grow">Home</span></div>
            <div class="mh-scroll" id="mh-s1"></div></div>
          <div class="mh-card" style="flex:1"><div class="mh-h" id="mh-sh2"><span class="grow">Away</span></div>
            <div class="mh-scroll" id="mh-s2"></div></div>
        </div>
      </div>`;
        document.body.appendChild(root);

        root.querySelector('#mh-close').addEventListener('click', toggle);
        root.querySelector('#mh-max').addEventListener('click', toggleMax);
        root.querySelector('#mh-tl').addEventListener('click', () => togglePane('nol', 'hideLeft'));
        root.querySelector('#mh-tr').addEventListener('click', () => togglePane('nor', 'hideRight'));
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
        box.textContent = '';
        const now = Date.now();
        const list = Array.from(S.matches.values()).sort((a, b) => {
            const la = S.games.has(a.id) ? 0 : 1, lb = S.games.has(b.id) ? 0 : 1;
            if (la !== lb) return la - lb;
            return String(a.start).localeCompare(String(b.start));
        });
        if (!list.length) {
            box.appendChild(el('div', 'mh-empty',
                S.rx.tree ? 'No matches in the feed yet.' : 'No frames intercepted — reload the page.'));
            return;
        }
        list.forEach(m => {
            const row = el('div', 'mh-mrow' + (m.id === S.active ? ' mh-sel' : '') +
                (S.noData.has(m.id) ? ' mh-nod' : ''));
            const wrap = el('div');
            wrap.style.cssText = 'flex:1;min-width:0';
            wrap.appendChild(el('div', 'mh-mname', `${m.home.short} vs ${m.away.short}`));
            wrap.appendChild(el('div', 'mh-mmeta',
                [S.tournaments.get(m.tournamentId), m.format].filter(Boolean).join(' · ') || '—'));
            row.appendChild(wrap);

            let tag;
            if (S.noData.has(m.id)) tag = el('div', 'mh-tag nod', 'No data');
            else if (S.games.has(m.id)) tag = el('div', 'mh-tag live', 'LIVE');
            else if (m.start && Date.parse(m.start) <= now) tag = el('div', 'mh-tag live', 'LIVE');
            else tag = el('div', 'mh-tag up', (m.start || '').slice(11, 16) || '—');
            row.appendChild(tag);

            row.addEventListener('click', () => { subscribeMatch(m.id); render(); });
            box.appendChild(row);
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
            const role = el('div', 'mh-ta', i === 0 ? 'Home' : 'Away');
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
            fg.appendChild(el('div', 'mh-empty',
                S.active && S.noData.has(S.active)
                    ? 'No data — no game-state feed for this match.'
                    : (S.rx.grid ? 'Pick a match.'
                        : 'No frames yet. Reload the page so the hook installs before the sockets open.')));
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
        const t1 = g.teams[0];
        hist.forEach(r => {
            const b = el('div', 'mh-bar ' + (t1 && r.teamId === t1.id ? 'home' : 'away'));
            b.style.height = (r.side === 'counter-terrorists' ? 100 : 62) + '%';
            b.title = `Round ${r.round} · ${(g.teams.find(t => t.id === r.teamId) || {}).name || ''}` +
                ` (${SIDE[r.side] || ''})`;
            box.appendChild(b);
        });
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
            b.title = sc === 'match' ? 'Match winner' : 'Map ' + sc.replace('map-', '') + ' winner';
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
        const l = el('span'); l.appendChild(mk(`HOME ${(last.p * 100).toFixed(0)}%`, g.teams[0]));
        const r = el('span'); r.appendChild(mk(`${((1 - last.p) * 100).toFixed(0)}% AWAY`, g.teams[1]));
        lbl.appendChild(l); lbl.appendChild(r);
        lbl.title = `${(g.teams[0] || {}).name} ${last.o1} · ${last.o2} ${(g.teams[1] || {}).name}`;
        box.appendChild(lbl);

        renderOddsLog(e);
    }

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
        head.innerHTML = '<time>time</time><span>home</span><span>away</span>';
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
        head.textContent = t ? `${idx === 0 ? 'Home' : 'Away'} · ${t.name}` : (idx === 0 ? 'Home' : 'Away');
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
        } else if (S.active && S.noData.has(S.active)) {
            title.textContent = (meta ? `${meta.home.short} vs ${meta.away.short}` : S.active) + ' — No data';
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
        if (m && !S.active) S.active = m[1];

        setInterval(() => { if (S.open && S.dirty) { S.dirty = false; render(); } }, 350);
        setInterval(watchdog, 5000);

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
        addEventListener('resize', () => { if (root && S.open) applyBox(store('box') || DEFAULT_BOX); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
