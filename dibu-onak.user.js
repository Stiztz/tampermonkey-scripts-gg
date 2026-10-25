// ==UserScript==
// @name         Dibu Onak (bb + Polymarket → Raiden)
// @namespace    https://github.com/Stiztz/tampermonkey-scripts-gg
// @version      3.3.0
// @description  Feeds Dibu Scraper's betboom state and Polymarket's live score into Raiden's CS2 trader inputs
// @icon         https://www.google.com/s2/favicons?sz=64&domain=oddin.gg
// @author       GG
// @match        https://betboom.ru/esport/*
// @match        https://betboom.ru/sport/*
// @match        https://polymarket.com/*
// @match        https://raiden.oddin.gg/*
// @match        https://raiden-test.oddin.dev/*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      polymarket.com
// @connect      gamma-api.polymarket.com
// @updateURL    https://raw.githubusercontent.com/Stiztz/tampermonkey-scripts-gg/main/dibu-onak.user.js
// @downloadURL  https://raw.githubusercontent.com/Stiztz/tampermonkey-scripts-gg/main/dibu-onak.user.js
// ==/UserScript==

/*
 * Two halves in one script, because Tampermonkey storage is per script: the
 * betboom half writes and the Raiden half listens, so they must be the same
 * script for GM_addValueChangeListener to fire across tabs.
 *
 *   betboom tab  : Dibu Scraper (@grant none) posts a snapshot on window ->
 *                  this script stores it under 'onak:bb'.
 *   polymarket   : this script polls the event's series-state (the score
 *                  Polymarket shows in real time) and stores it under
 *                  'onak:pm'. Only the map score is used.
 *   Raiden tab   : this script hooks the page's fetch/WebSocket to read the
 *                  live clean data and borrow the session's credentials, then
 *                  sends the same GraphQL mutations the trader panel sends.
 *
 * Everything is keyed by SIDE, not by screen position: LIGHT = CT and
 * DARK = T in Raiden, betboom names CT/T per team, and "Switch teams" in
 * Raiden only reorders the columns. Team names are used to CHECK that both
 * tabs agree on who is where, never to decide where an input goes.
 */

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const HOST = location.hostname;

    // Chrome throttles timers in tabs that are not in front: after a few
    // minutes a 1s setInterval can drop to once a minute. That is what made
    // Polymarket "disconnect" until the tab was clicked. A Worker's timer is
    // not throttled the same way, so it drives the clock; a plain interval
    // runs alongside in case the page's CSP refuses blob workers. Callers must
    // tolerate extra calls (both clocks, plus event-driven calls).
    function everyMs(ms, fn) {
        setInterval(fn, ms);
        try {
            const code = `setInterval(() => postMessage(0), ${ms});`;
            const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            const wk = new Worker(url);
            wk.onmessage = () => { try { fn(); } catch (e) { /* keep ticking */ } };
            wk.onerror = () => { /* CSP refused it: the interval above remains */ };
        } catch (e) { /* no Worker: the interval above remains */ }
    }

    // =====================================================================
    // 1. BETBOOM HALF — relay Dibu's snapshot
    // =====================================================================

    if (/(^|\.)betboom\.ru$/.test(HOST)) {
        if (window.top !== window.self) return;
        const BB_TAB = Math.random().toString(36).slice(2, 10);
        window.addEventListener('message', ev => {
            const d = ev.data;
            // 'dibu-link:v1' is the message tag Dibu Scraper posts. It is a
            // protocol id, not the product name, so it stays as is.
            if (!d || d.tag !== 'dibu-link:v1' || ev.origin !== location.origin) return;
            // Every betboom tab writes the same key; the tab id lets Raiden
            // tell them apart instead of taking whichever wrote last.
            try { GM_setValue('onak:bb', { at: d.at || Date.now(), tab: BB_TAB, snap: d.snap }); }
            catch (e) { /* storage full or TM restarting: next heartbeat retries */ }
        });
        return;
    }

    // =====================================================================
    // 1b. POLYMARKET HALF — publish the live map score
    // =====================================================================
    // series-state is what Polymarket's own scoreboard reads and it moves in
    // real time, ahead of betboom's ~8s buffer. It carries the score per team
    // and map, nothing else: no sides, no reason, no kills. The Raiden half
    // turns a +1 into a round result; everything else stays with betboom.
    if (/(^|\.)polymarket\.com$/.test(HOST)) {
        if (window.top !== window.self) return;
        const pmFetch = W.fetch.bind(W);
        const PM = { slug: null, seriesId: null, title: '', busy: false };
        const slugNow = () => {
            const parts = location.pathname.split('/').filter(Boolean);
            return parts.indexOf('esports') >= 0 && parts.length ? parts[parts.length - 1] : null;
        };
        async function resolveSeries(slug) {
            PM.slug = slug; PM.seriesId = null; PM.title = '';
            try {
                const r = await pmFetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
                const arr = await r.json();
                const ev = Array.isArray(arr) ? arr[0] : arr;
                if (!ev || PM.slug !== slug) return;
                PM.title = ev.title || slug;
                PM.seriesId = ev.eventMetadata && ev.eventMetadata.gridSeriesId ? String(ev.eventMetadata.gridSeriesId) : null;
            } catch (e) { PM.slug = null; /* retried on the next poll */ }
        }
        // The game being played: the started-not-finished one, else the last.
        const gameOf = j => (j.games || []).find(g => g.started && !g.finished) || (j.games || [])[(j.games || []).length - 1];
        let lastPoll = 0;
        async function poll() {
            if (PM.busy || Date.now() - lastPoll < 900) return;
            lastPoll = Date.now();
            PM.busy = true;
            try {
                const slug = slugNow();
                if (slug && slug !== PM.slug) await resolveSeries(slug);
                if (!PM.seriesId) return;
                const r = await pmFetch(`/api/esports/series-state?seriesId=${PM.seriesId}`, { credentials: 'include' });
                if (!r.ok) return;
                const j = await r.json();
                const g = j && gameOf(j);
                if (!g || !Array.isArray(g.teams)) return;
                GM_setValue('onak:pm', {
                    at: Date.now(), slug: PM.slug, title: PM.title, seriesId: PM.seriesId,
                    started: !!j.started, finished: !!j.finished,
                    map: { seq: g.sequenceNumber, started: !!g.started, finished: !!g.finished,
                        teams: g.teams.map(t => ({ name: t.name || '', score: t.score || 0 })) },
                });
            } catch (e) { /* next poll retries */ }
            finally { PM.busy = false; }
        }
        everyMs(1000, poll);
        return;
    }

    // Production and the test environment run the same app against
    // different hosts; everything below only differs in the jade URL and in
    // how strict the safety checks are (see `relaxed` in decide()).
    const ENVS = {
        'raiden.oddin.gg': {
            name: 'PROD', test: false,
            jade: 'https://jade-production.oddin.gg/jade/query',
            scorpion: 'https://scorpion-production.oddin.gg/scorpion/query',
        },
        'raiden-test.oddin.dev': {
            name: 'TEST', test: true,
            jade: 'https://jade-test.oddin.dev/jade/query',
            scorpion: 'https://scorpion-test.oddin.dev/scorpion/query',
        },
    };
    const ENV = ENVS[HOST];
    if (!ENV) return;

    // =====================================================================
    // 2. CORE — pure decisions (kept free of DOM and network so it can be
    //    replayed against captures in node)
    // =====================================================================
    /*CORE-START*/

    // Phases in which a round is being played and Raiden should be live.
    const LIVE_PHASES = new Set(['round', 'bomb_has_been_planted']);
    // Phases whose alive list still belongs to the round being played. The
    // last kill and round_end can arrive in the same frame, so round_end has
    // to be allowed or an elimination's final death would be dropped.
    const ROUND_PHASES = new Set(['round', 'bomb_has_been_planted', 'bomb_has_been_exploded',
        'bomb_has_been_defused', 'round_end']);
    // Once the bomb has gone off or been defused the round is decided; players
    // the explosion kills afterwards must NOT become deaths, or a full wipe
    // makes Raiden close the round as an elimination instead of an explode.
    const DECIDED_PHASES = new Set(['bomb_has_been_exploded', 'bomb_has_been_defused']);
    // How long to wait for Raiden to close a round on its own after our deaths
    // took a side to 0, before sending betboom's verdict ourselves.
    const AUTO_CLOSE_GRACE = 2500;
    // How long Raiden's and betboom's scores may disagree before it counts as
    // a wrong score (production only; test mode never matches scores).
    const SCORE_MISMATCH_MS = 30000;
    const SIDE_OF = { CT: 'LIGHT', T: 'DARK' };
    const ROUND_TIME = 115;

    const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // "de_inferno", "Inferno", "INFERNO" -> "inferno"
    const mapNameKey = s => normName(String(s || '').replace(/^(de|cs|ar|dz)_/i, ''));

    // Same rule the HUD uses for its "ROUND n" label: during round_end the
    // score already counts the round that just finished.
    function bbRoundOf(bb) {
        return bb.phase === 'round_end' ? bb.total : bb.total + 1;
    }

    // bb team -> 'home' | 'away' by name. Exact match on name or shortcut
    // first, then containment for "Martians" vs "Martians Esports". Returns
    // null unless BOTH teams land on different roles: a half-match is worse
    // than none, because it would look like a mapping.
    function autoMap(bbTeams, rt) {
        if (!rt || !rt.home || !rt.away || !bbTeams || bbTeams.length !== 2) return null;
        const keys = r => [normName(rt[r].name), normName(rt[r].short)].filter(Boolean);
        const score = (t, r) => {
            const n = normName(t.name);
            if (!n) return 0;
            if (keys(r).indexOf(n) >= 0) return 2;
            if (keys(r).some(k => k.length >= 3 && n.length >= 3 && (k.indexOf(n) >= 0 || n.indexOf(k) >= 0))) return 1;
            return 0;
        };
        const [a, b] = bbTeams;
        const straight = score(a, 'home') + score(b, 'away');
        const crossed = score(a, 'away') + score(b, 'home');
        if (straight === crossed) return null;
        const out = {};
        if (straight > crossed) { if (!score(a, 'home') && !score(b, 'away')) return null; out[a.id] = 'home'; out[b.id] = 'away'; }
        else { if (!score(a, 'away') && !score(b, 'home')) return null; out[a.id] = 'away'; out[b.id] = 'home'; }
        return out;
    }

    // Polymarket names -> betboom teams, exact then containment, same rule as
    // autoMap. Both teams must resolve, to different bb teams.
    function pmTeamMap(pmTeams, bbTeams) {
        if (!pmTeams || pmTeams.length !== 2 || !bbTeams || bbTeams.length !== 2) return null;
        const sc = (a, b) => {
            const x = normName(a), y = normName(b);
            if (!x || !y) return 0;
            if (x === y) return 2;
            return (x.length >= 3 && y.length >= 3 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) ? 1 : 0;
        };
        const [p0, p1] = pmTeams, [b0, b1] = bbTeams;
        const straight = sc(p0.name, b0.name) + sc(p1.name, b1.name);
        const crossed = sc(p0.name, b1.name) + sc(p1.name, b0.name);
        if (straight > crossed && sc(p0.name, b0.name) && sc(p1.name, b1.name)) return { [p0.name]: b0, [p1.name]: b1 };
        if (crossed > straight && sc(p0.name, b1.name) && sc(p1.name, b0.name)) return { [p0.name]: b1, [p1.name]: b0 };
        return null;
    }

    // Polymarket only says WHO won a round. The type is inferred at that
    // instant:
    //   CT + bomb planted -> defuse (the only way CT wins once it is down)
    //   T  + no bomb      -> elimination (T cannot win on time)
    //   T  + bomb planted -> explode when the real bomb clock is out, else the
    //                        CTs were wiped
    //   CT + no bomb      -> timeout when the real round clock is out, else
    //                        elimination
    // When betboom later says otherwise, decide() raises a warning.
    // 2.2.0: the clocks come from betboom's phase timer, which is stamped at
    // the source, so "seconds left" is the real figure even though betboom
    // shows it 8s late. Raiden's clock was the 2.0 source and it is not
    // reliable for this (Raiden parks it at 10). It is only the fallback.
    function sourceLeft(bb, phase, now) {
        if (!bb || bb.phase !== phase || !bb.phaseStart || !bb.phaseDur) return null;
        const t0 = Date.parse(bb.phaseStart);
        return t0 ? bb.phaseDur - (now - t0) / 1000 : null;
    }
    function pmResultType(side, rd, bb, now) {
        const planted = rd.bomb === 'PLANTED' || (bb && bb.phase === 'bomb_has_been_planted');
        if (side === 'CT') {
            if (planted) return 'CT_WIN_DEFUSE';
            const left = sourceLeft(bb, 'round', now);
            const timeUp = left !== null ? left <= 4 : rd.roundTime <= 5;
            return timeUp ? 'CT_WIN_TIMEOUT' : 'CT_WIN_ELIMINATION';
        }
        if (side === 'T') {
            if (!planted) return 'T_WIN_ELIMINATION';
            const left = sourceLeft(bb, 'bomb_has_been_planted', now);
            const boom = left !== null ? left <= 4 : rd.roundTime <= 12;
            return boom ? 'T_WIN_EXPLODE' : 'T_WIN_ELIMINATION';
        }
        return null;
    }

    /*
     * Polymarket's verdict for the round Raiden has live, or null. Needs
     * nothing from betboom in production: the winner's side comes from
     * Raiden's own teams (name + homeIsDark, DARK = T), the map from Raiden's
     * route, the round number from Raiden. betboom is only a fallback for the
     * side, and the only source in relaxed mode, where the test map's sides
     * do not follow the real match. This is what lets Polymarket close a
     * round while betboom is quiet or frozen (2.4.0).
     * Returns { win: { side, type, round, bbRound } | null, warn: string|null }.
     */
    function pmVerdict(ctx, st, now) {
        const res = { win: null, warn: null };
        const { pm, rd, bb, opts, rt } = ctx;
        const relaxed = !!ctx.relaxed;
        if (!opts.pm || !pm || !pm.snap || !pm.snap.map || !rd) return res;
        const R = rd.round;
        const wantRound = relaxed ? st.bbRoundFor[R] : R;
        if (wantRound === undefined) return res;
        if (now - pm.at > 5000) {
            res.warn = `Polymarket data ${Math.round((now - pm.at) / 1000)}s old — using betboom only` +
                (pm.snap.via === 'tab' ? ' (Polymarket tab in background? set a link instead)' : '');
            return res;
        }
        const mapNo = relaxed ? (bb && bb.mapNum) : (ctx.raidenMapOrder || (bb && bb.mapNum));
        if (mapNo && pm.snap.map.seq !== mapNo) {
            res.warn = `Polymarket is on map ${pm.snap.map.seq}, ${relaxed ? 'bb' : 'Raiden'} on map ${mapNo} — ignoring Polymarket`;
            return res;
        }
        // The point must have happened while this Raiden round was live: one
        // scored before it started belongs to an earlier round.
        const since = Math.min(st.start[R] || Infinity, st.seenAt[R] || Infinity);
        const w = (pm.wins || []).find(x => x.round === wantRound && x.map === pm.snap.map.seq && x.at >= since - 1000);
        if (!w) return res;
        const pmLoser = Object.keys(w.scores).find(n => n !== w.winner);

        // Winner's side. Production: Raiden's teams. Relaxed or no Raiden
        // names: betboom's current sides.
        let side = null;
        if (!relaxed && rt && rt.home && rt.away) {
            const roles = [{ name: rt.home.name, role: 'home' }, { name: rt.away.name, role: 'away' }];
            const shorts = [{ name: rt.home.short, role: 'home' }, { name: rt.away.short, role: 'away' }];
            const m = pmTeamMap(pm.snap.map.teams, roles) || pmTeamMap(pm.snap.map.teams, shorts);
            if (m && m[w.winner]) side = (m[w.winner].role === 'home') === rd.homeIsDark ? 'T' : 'CT';
        }
        if (!side && bb && bb.teams && bb.teams.length === 2) {
            const m = pmTeamMap(pm.snap.map.teams, bb.teams);
            if (m && m[w.winner]) side = m[w.winner].side || null;
        }
        if (!side) { res.warn = 'cannot tell which side won on Polymarket (team names do not match) — ignoring'; return res; }

        // Production: the point must land on Raiden's current score - the
        // winner's side one ahead, the loser equal.
        if (!relaxed) {
            const rdOf = sd => (sd === 'CT' ? rd.light.score : rd.dark.score);
            const other = side === 'CT' ? 'T' : 'CT';
            if (rdOf(side) + 1 !== w.scores[w.winner] || rdOf(other) !== w.scores[pmLoser]) {
                res.warn = `Polymarket score ${w.scores[w.winner]}-${w.scores[pmLoser]} does not follow Raiden's — ignoring`;
                return res;
            }
        }
        res.win = { side, type: pmResultType(side, rd, bb, now), round: R, bbRound: wantRound };
        return res;
    }

    // Completed-round counts after which CS2 switches sides: the half (12),
    // then inside each overtime of 6 (MR3) after its third round - 27, 33,
    // 39... Between overtimes (24, 30, 36...) the sides stay.
    function isSideSwitch(done) {
        return done === 12 || (done > 24 && (done - 24) % 6 === 3);
    }

    // betboom reason + winner side -> Raiden RoundResult type. Combinations
    // CS cannot produce (T winning on time, CT on explode) return null so the
    // round is left to the trader instead of being typed wrong.
    function resultType(entry) {
        if (!entry || !entry.side) return null;
        const w = entry.side;
        switch (entry.reason) {
            case 'bomb': return w === 'T' ? 'T_WIN_EXPLODE' : null;
            case 'defuse': return w === 'CT' ? 'CT_WIN_DEFUSE' : null;
            case 'time': return w === 'CT' ? 'CT_WIN_TIMEOUT' : null;
            case 'elim': return w + '_WIN_ELIMINATION';
            default: return null;
        }
    }

    // Seconds left on the real round clock. phaseStart is stamped at the
    // source, so this already discounts betboom's ~8s buffer; outside a sane
    // range fall back to what the trader button sends.
    function roundTimeFrom(bb, now) {
        if (bb.phase !== 'round' || !bb.phaseStart || !bb.phaseDur) return ROUND_TIME;
        const t0 = Date.parse(bb.phaseStart);
        if (!t0) return ROUND_TIME;
        const left = Math.round(bb.phaseDur - (now - t0) / 1000);
        return (left >= 5 && left <= ROUND_TIME) ? left : ROUND_TIME;
    }

    /*
     * ctx: { armed, leader, auth, wsOpen, error, bb, bbAt, rd, mapping,
     *        raidenMapOrder, opts, relaxed, pm, oldLink, rdWatchedMs, rt, rdMapName }
     * rt : Raiden's teams { home:{name,short}, away:{name,short} } or null
     * pm : { at, snap, wins:[{ map, round, winner, scores:{name:score}, at }] }
     *
     * relaxed (test environment only): the test map is a copy that starts at
     * round 1, 0-0, on whatever map number, while betboom is mid-map. Every
     * check that proves "same map, same round, same teams" would hold forever
     * there, so relaxed mode drops them and follows betboom round by round,
     * routing purely by side (CT -> LIGHT, T -> DARK). Never on production.
     * st : per-arming latches { start, plant, result, resultSeen, confirm,
     *        pending, seen, seenAt, bbRoundFor, bbDone, autoClose, refused, pmGuess, pmChecked,
     *        switchRound }
     * Returns { hold, info, warn, actions }. Only resultSeen, bbRoundFor,
     * pmChecked and switchRound are written here: they are observations, not decisions, and keeping
     * them next to their only reader is what stops the two from drifting.
     */
    function decide(ctx, st, now) {
        const out = { hold: null, info: [], warn: [], actions: [], alerts: [] };
        const hold = r => { out.hold = r; return out; };
        // Irregularities. level 'suspend': markets are suspended and the
        // trader notified; 'notify': notified only. A state alert is re-raised
        // every tick while it holds and clears when it stops; a sticky one is
        // an event, raised once, kept until dismissed in the panel.
        const alarm = (key, level, msg, sticky) => { out.alerts.push({ key, level, msg, sticky: !!sticky }); };
        // For holds caused by betboom (silent, frozen, paused, unpaired...):
        // betboom's inputs stop, but Polymarket can still close the round
        // Raiden has live. betboom being quiet is not betboom being wrong, and
        // the score does not need it.
        const bbHold = r => {
            out.hold = r;
            const v = pmVerdict(ctx, st, now);
            const R = ctx.rd.round;
            const grace = st.autoClose[R] ? AUTO_CLOSE_GRACE - (now - st.autoClose[R]) : 0;
            if (v.win && ctx.opts.result && !ctx.rd.paused && st.seen[R] && !st.result[R] && grace <= 0 &&
                !st.bbDone[v.win.bbRound]) {
                out.actions.push({ op: 'result', type: v.win.type, round: R, source: 'pm', bbRound: v.win.bbRound });
            } else if (v.warn) out.warn.push(v.warn);
            return out;
        };

        if (!ctx.armed) return hold('OFF');
        if (ctx.oldLink) return hold('old Dibu Link is also installed — remove it from Tampermonkey (both would send inputs)');
        if (ctx.error) return hold('error: ' + ctx.error + ' — switch off and on to retry');
        const rd = ctx.rd;
        if (!rd) return hold('no Raiden clean data (open the map)');
        if (!ctx.wsOpen) return hold('Raiden socket closed');
        if (!ctx.auth) return hold('waiting for Raiden credentials');
        if (!ctx.leader) return hold('another Raiden tab controls this map');

        const bb = ctx.bb;
        if (!bb || now - ctx.bbAt > 4000) return bbHold('no signal from betboom (is the Dibu tab open?)');
        if (!bb.teams || bb.teams.length !== 2) return bbHold('betboom has no teams');
        // betboom goes quiet between rounds and maps (freezetime, warmup), so
        // silence there is normal. Mid-round it means the data is not live.
        if (!bb.lastUpdate || (ROUND_PHASES.has(bb.phase) && now - bb.lastUpdate > 20000)) {
            // Quiet is not broken: a round with no kills sends no frames. No
            // alert, no notification (3.0.0 notified and it was noise); the
            // status line shows it and Polymarket can still close the round.
            return bbHold(`betboom quiet (no frames ${Math.round((now - bb.lastUpdate) / 1000)}s)`);
        }
        if (bb.phase === 'finished') return bbHold('map finished on bb');
        if (bb.phase === 'timeout') return bbHold('pause on bb (timeout)');
        // An incomplete lineup still pauses betboom's inputs (as since 1.0),
        // but is not a reason to suspend (3.1.0): telling a disconnect from a
        // lost kill is not reliable from this feed. The Dibu's own "NO KILL"
        // lines stay as information for the trader.
        for (const t of bb.teams) {
            if (t.n !== 5 || t.alive + t.dead !== 5) {
                const why = t.n !== 5 ? `${t.n}/5 players on the server` : 'unknown player state';
                return hold(`possible disconnect on ${t.name} (${why})`);
            }
        }
        const relaxed = !!ctx.relaxed;
        if (!relaxed && ctx.raidenMapOrder && bb.mapNum && ctx.raidenMapOrder !== bb.mapNum) {
            return bbHold(`different map: Raiden map ${ctx.raidenMapOrder}, bb map ${bb.mapNum}`);
        }
        // Same map number, so compare THIS map's name on both: Raiden's
        // prematch table for the map open here, betboom's live map. Never a
        // name from another map of the series.
        // Test mode skips round/score matching but keeps this check (option
        // "check map & sides"): it is where suspending gets tried out.
        const checks = !relaxed || ctx.opts.checks !== false;
        if (checks && ctx.rdMapName && bb.mapName && mapNameKey(ctx.rdMapName) !== mapNameKey(bb.mapName)) {
            const msg = `map ${bb.mapNum} is ${bb.mapName} on bb but ${ctx.rdMapName} in Raiden's prematch table`;
            alarm(`mapname:${bb.mapNum}:${mapNameKey(ctx.rdMapName)}:${mapNameKey(bb.mapName)}`, 'suspend', msg);
            return hold(msg);
        }

        const map = ctx.mapping;
        if (!relaxed && (!map || !map[bb.teams[0].id] || !map[bb.teams[1].id] || map[bb.teams[0].id] === map[bb.teams[1].id])) {
            return bbHold('teams not paired');
        }
        const bySide = {};
        // Side switch window. Raiden swaps sides the moment the switching
        // round is scored (even unconfirmed); betboom relabels its teams only
        // when its data says they switched, which can take a technical pause
        // or longer. In that window every team reads the opposite side on the
        // two tabs. If that inversion is total AND Raiden's completed rounds
        // sit exactly on a switch point, it is the known lag, not a pairing
        // error: follow Raiden's sides and keep going. Anywhere else a side
        // disagreement still holds.
        const rdSideOf = t => ((map[t.id] === 'home') === rd.homeIsDark ? 'DARK' : 'LIGHT');
        const done = rd.round - 1;
        const switching = !relaxed && isSideSwitch(done) &&
            bb.teams.every(t => SIDE_OF[t.side] && SIDE_OF[t.side] !== rdSideOf(t));
        // Test mode routes by betboom's side, but still checks it against the
        // test map when the teams can be paired by name. The test map and bb
        // can be in different halves, so a switch point on either score
        // excuses an inversion there.
        const relaxedMap = relaxed && checks ? (autoMap(bb.teams, ctx.rt) || null) : null;
        const relaxedSwitch = isSideSwitch(rd.round - 1) || isSideSwitch(bb.total);
        for (const t of bb.teams) {
            const bbSide = SIDE_OF[t.side];
            if (!bbSide) return bbHold(`bb gives no side for ${t.name}`);
            if (relaxed) {
                if (relaxedMap && relaxedMap[t.id] && !relaxedSwitch) {
                    const rs = (relaxedMap[t.id] === 'home') === rd.homeIsDark ? 'DARK' : 'LIGHT';
                    if (rs !== bbSide) {
                        const msg = `sides inverted: ${t.name} is ${t.side} on bb but ${rs === 'LIGHT' ? 'LIGHT (CT)' : 'DARK (T)'} in Raiden — check the side picked for this map`;
                        alarm(`sides:${rd.key}:${rd.round}`, 'suspend', msg);
                        return hold(msg);
                    }
                }
                bySide[bbSide] = t;
                continue;
            }
            const rdSide = rdSideOf(t);
            if (rdSide !== bbSide && !switching) {
                const msg = `sides inverted: ${t.name} is ${t.side} on bb but ${rdSide === 'LIGHT' ? 'LIGHT (CT)' : 'DARK (T)'} in Raiden — check the side picked for this map`;
                alarm(`sides:${rd.key}:${rd.round}`, 'suspend', msg);
                return hold(msg);
            }
            // Keyed by Raiden's side: in the switch window that is the side
            // the team is really playing.
            bySide[rdSide] = t;
        }
        if (switching) {
            st.switchRound[rd.round] = true;
            out.info.push(`sides switched after round ${done} in Raiden, not yet on bb — following Raiden`);
        }
        if (!bySide.LIGHT || !bySide.DARK) return bbHold('both teams on the same side');
        if (rd.paused) return hold('Raiden paused');

        const R = rd.round;
        const bbR = bbRoundOf(bb);
        // In relaxed mode betboom's round number cannot match the test map's;
        // "same round" then means "the round betboom is on now", and the
        // Raiden-side latches (keyed by R) keep each input to once per round.
        const sameRound = relaxed || bbR === R;
        const opts = ctx.opts;
        // Right after a start the clock has not ticked yet; without this the
        // first kill of a round would wait for Raiden's second update.
        const running = rd.running || (st.start[R] && now - st.start[R] < 3000);
        const scoresMatch = relaxed ||
            (rd.light.score === bySide.LIGHT.rounds && rd.dark.score === bySide.DARK.rounds);
        // Wrong score. A disagreement is normal for a few seconds around every
        // round end (Polymarket closes before bb shows it, bb's verdict lands
        // before Raiden's echo); one that lasts SCORE_MISMATCH_MS is not.
        if (!scoresMatch) {
            if (!st.scoreBadSince) st.scoreBadSince = now;
            if (now - st.scoreBadSince >= SCORE_MISMATCH_MS) {
                alarm(`score:${rd.key}:${rd.light.score}-${rd.dark.score}:${bySide.LIGHT.rounds}-${bySide.DARK.rounds}`, 'suspend',
                    `wrong score: Raiden ${rd.light.score}-${rd.dark.score} (CT-T), bb ${bySide.LIGHT.rounds}-${bySide.DARK.rounds} for ${Math.round((now - st.scoreBadSince) / 1000)}s`);
            }
        } else st.scoreBadSince = 0;
        const unconfirmed = rd.light.score !== rd.light.confirmed || rd.dark.score !== rd.dark.confirmed;

        // --- the verdict ----------------------------------------------------
        // The entry for the round being played, once betboom has finished it
        // (the HUD's "ROUND n — X wins (bomb)" line). Looked up by round
        // number, never by phase: an explode or defuse goes from the bomb
        // phase straight to freezetime with no round_end.
        // Relaxed: tie each test round to the betboom round that was being
        // played when it started, the first time we see both live together.
        // A betboom round that already closed a Raiden round is spent: it may
        // never be tied to, start or close another one. In 2.1.0 test mode,
        // Polymarket closed round 27, Raiden moved to 28 while betboom (8s
        // behind) was still playing that same round, so 28 was started, tied
        // to it, and closed again by the same Polymarket point - twice, until
        // the map hit 13:16.
        if (relaxed && running && LIVE_PHASES.has(bb.phase) && st.bbRoundFor[R] === undefined && !st.bbDone[bbR]) {
            st.bbRoundFor[R] = bbR;
        }
        const wantRound = relaxed ? st.bbRoundFor[R] : R;
        const entry = wantRound === undefined ? null
            : (bb.history || []).find(h => h.round === wantRound) || null;
        // An irregular verdict (impossible timing, unknown reason, or a round
        // with a death the feed never explained) is not applied, by betboom or
        // by Polymarket. Markets are suspended until the trader sorts it out.
        const irregular = entry && entry.suspect;
        if (irregular) {
            alarm(`suspect:${bb.mapNum}:${entry.round}`, 'suspend', `bb round ${entry.round} looks irregular (${irregular}) — not applied`);
            return hold(`irregular round ${entry.round}: ${irregular}`);
        }
        // Once betboom has a verdict, or we already closed the round, or our
        // deaths took a side to 0 (Raiden closes that itself), the round is
        // over for Raiden. Anything betboom shows after that point - kills
        // after the round ends, a bomb planted during the round-end delay - is
        // CS noise and must never become an input: in 1.4.0 a post-round
        // plant started a round that never existed, and a post-round kill hit
        // "The round isn't live".
        // --- Polymarket's verdict -------------------------------------------
        // The same round's +1 on Polymarket, if it came first. Its round number
        // is the map's score sum after the point, the same numbering betboom
        // uses, so it lines up with `wantRound` in both modes.
        const pmV = pmVerdict(ctx, st, now);
        if (pmV.warn) out.warn.push(pmV.warn);
        const pmWin = pmV.win;

        const over = !!entry || !!pmWin || !!st.result[R] || !!st.autoClose[R] || !!st.refused[R] || DECIDED_PHASES.has(bb.phase);

        // --- deaths: state sync, never event replay -----------------------
        if (opts.deaths && running && sameRound && ROUND_PHASES.has(bb.phase) && !over) {
            for (const side of ['LIGHT', 'DARK']) {
                const want = bySide[side].alive;
                const have = side === 'LIGHT' ? rd.light.alive : rd.dark.alive;
                const p = st.pending[side];
                // Deaths already sent but not yet echoed by the clean data
                // count as done for 3s, so one kill is never sent twice.
                const base = (p && p.round === R && now - p.at < 3000 && have > p.target) ? p.target : have;
                const n = base - want;
                if (n > 0) out.actions.push({ op: 'death', side, n: Math.min(n, base), target: want, round: R, bbRound: wantRound });
                else if (want > have) out.warn.push(`bb has more players alive than Raiden on ${side} (no revives)`);
            }
        }
        // A death that takes a side to 0 closes the round in Raiden, and any
        // input after it is refused. Send it last.
        out.actions.sort((x, y) => (x.op === 'death' && x.target === 0) - (y.op === 'death' && y.target === 0));

        // --- bomb ----------------------------------------------------------
        if (opts.bomb && running && sameRound && bb.phase === 'bomb_has_been_planted' && !over &&
            rd.bomb !== 'PLANTED' && !st.plant[R]) {
            out.actions.push({ op: 'plant', round: R });
        }

        // --- round result ---------------------------------------------------
        // Only for a round Raiden actually had live: if nobody started it,
        // the tool was not running it and the trader owns it.
        // betboom's verdict is final, so every reason is sent at once,
        // elimination included: once the verdict exists no more deaths are
        // synced, so the result is what closes the round.
        // After our deaths took a side to 0, Raiden USUALLY closes the round
        // itself - but not always: with the bomb planted, wiping the Ts does
        // not end a CS round (the CTs still have to defuse), and Raiden keeps
        // it open. 1.5.0 assumed the close and never sent CT_WIN_DEFUSE. So
        // wait a short grace for Raiden to move on, then send the verdict;
        // the executor's round check skips it if Raiden did close.
        const graceLeft = st.autoClose[R] ? AUTO_CLOSE_GRACE - (now - st.autoClose[R]) : 0;
        if (opts.result && !entry && pmWin && st.seen[R] && !st.result[R] && graceLeft <= 0) {
            // Polymarket first: close now with the inferred type.
            out.actions.push({ op: 'result', type: pmWin.type, round: R, source: 'pm', bbRound: wantRound });
        } else if (opts.result && (entry || pmWin) && st.seen[R] && !st.result[R] && graceLeft > 0) {
            out.info.push(`round ${R} over — waiting ${Math.ceil(graceLeft / 1000)}s for Raiden to close it`);
        } else if (opts.result && entry && st.seen[R] && !st.result[R]) {
            // Production: take the winner's side from Raiden through the
            // paired team (entry.teamId), not from betboom's label, which is
            // stale in a side switch window.
            const wt = !relaxed && bb.teams.find(t => t.id === entry.teamId);
            const type = resultType(wt ? Object.assign({}, entry, { side: rdSideOf(wt) === 'LIGHT' ? 'CT' : 'T' }) : entry);
            if (!type) {
                out.warn.push(`round ${R} end not recognised (${entry.side} / ${entry.reason})`);
            } else {
                if (!st.resultSeen[R]) st.resultSeen[R] = now;
                // Half a second lets a death-to-0 sent in the frame before echo
                // back as a new round, so the executor's round check sees it.
                if (now - st.resultSeen[R] >= 500) out.actions.push({ op: 'result', type, round: R, bbRound: wantRound });
                else out.info.push(`round ${R} over (${type})`);
            }
        }

        // A result typed from Polymarket is a guess; say so when betboom's
        // verdict disagrees, so the trader can fix the type by hand.
        // Checked per guessed round, not the current one: by the time betboom
        // speaks, Raiden has already moved to the next round. Once each.
        for (const g of Object.keys(st.pmGuess)) {
            if (st.pmChecked[g]) continue;
            // In a side switch window betboom's label for that round may be
            // the old side; no reliable comparison, so no warning.
            if (st.switchRound[g]) { st.pmChecked[g] = true; continue; }
            const br = relaxed ? st.bbRoundFor[g] : Number(g);
            const e = (bb.history || []).find(h => h.round === br);
            const t = e && resultType(e);
            if (!t) continue;
            st.pmChecked[g] = true;
            const sideOf = x => String(x).split('_')[0];
            if (e.suspect) {
                alarm(`pmsuspect:${bb.mapNum}:${br}`, 'suspend',
                    `Polymarket closed Raiden round ${g}, but bb flags that round as irregular (${e.suspect}) — check it`, true);
            } else if (sideOf(t) !== sideOf(st.pmGuess[g])) {
                alarm(`pmwinner:${bb.mapNum}:${br}`, 'notify',
                    `round ${g}: Polymarket gave it to ${sideOf(st.pmGuess[g])}, bb says ${sideOf(t)} won — check the score`, true);
            } else if (t !== st.pmGuess[g]) {
                out.warn.push(`R${g}: sent ${st.pmGuess[g]} from Polymarket, bb says ${t} — fix the type by hand if it matters`);
            }
        }

        // --- confirm score ---------------------------------------------------
        // Confirm only what this tool itself just did: exactly one new point,
        // from a result we sent (or a wipe we caused) for the previous round.
        // In relaxed mode scoresMatch is always true, which is how 2.1.0
        // confirmed points that never happened.
        const pending = (rd.light.score - rd.light.confirmed) + (rd.dark.score - rd.dark.confirmed);
        const ours = !!(st.result[R - 1] || st.autoClose[R - 1]);
        if (opts.confirm && !running && unconfirmed && scoresMatch && pending === 1 && ours) {
            const key = `${R}:${rd.light.score}:${rd.dark.score}`;
            if (!st.confirm[key]) out.actions.push({ op: 'confirm', key });
        } else if (opts.confirm && !running && unconfirmed && (pending !== 1 || !ours)) {
            out.warn.push(`score ${rd.light.score}-${rd.dark.score} not confirmed: ${pending !== 1 ? pending + ' unconfirmed points' : 'not set by this tool'} — confirm by hand`);
        }

        // --- start round -----------------------------------------------------
        // Only on betboom's 'round' phase. A bomb planted in the round-end
        // delay also reads as a live phase, and starting on it is exactly the
        // phantom round of 1.4.0.
        if (opts.start && bb.phase === 'round' && sameRound && !running && !st.start[R] && !st.bbDone[bbR]) {
            // "Not running" is only an inference from the clock, so it needs
            // proof before a start is sent: Raiden's idle state is a clock
            // parked at exactly 20, and that has to have been watched for a
            // moment. A round whose clock is held still (Raiden parks it at 10)
            // or that we have not seen tick yet is live; restarting it resets
            // the clock under the trader.
            const idleClock = rd.roundTime === 20;
            const watched = (ctx.rdWatchedMs || 0) >= 2600;
            // The score is the cheapest proof that both tabs are on the same
            // map of the same match. Never start a round on a disagreement.
            if (!idleClock) {
                out.info.push(`Raiden clock at ${rd.roundTime}s, not idle — round not started`);
            } else if (!watched) {
                out.info.push('reading Raiden clock…');
            } else if (!scoresMatch) {
                out.warn.push(`score mismatch (Raiden ${rd.light.score}-${rd.dark.score} CT-T, ` +
                    `bb ${bySide.LIGHT.rounds}-${bySide.DARK.rounds}): round not started`);
            } else {
                out.actions.push({ op: 'start', roundTime: roundTimeFrom(bb, now), round: R });
            }
        }

        if (!out.actions.length && !out.info.length) {
            if (st.bbDone[bbR] && !running) out.info.push(`round already closed — waiting for bb to finish it (${bb.phase || '—'})`);
            else if (!sameRound) out.info.push(`bb round ${bbR}, Raiden round ${R}`);
            else if (!running && !LIVE_PHASES.has(bb.phase)) out.info.push(`waiting for round ${R} to start (${bb.phase || '—'})`);
        }
        return out;
    }

    // Raiden's clock sits at 20 while no round is running (after a round ends
    // and after a history edit). A round is running when the clock ticks: a
    // small decrease, or a jump UP to a real value (start = 115, plant = 40).
    function isTick(prevTime, time) {
        if (prevTime === time) return false;
        if (time < prevTime) return prevTime - time <= 3;
        return time !== 20;
    }

    /*CORE-END*/

    // =====================================================================
    // 3. RAIDEN STATE — sniffed from the page's own traffic
    // =====================================================================

    const L = {
        me: Math.random().toString(36).slice(2, 10),
        frameActive: false,
        onMap: null,
        auth: null,                 // { authorization, apiKey }
        jadeUrl: ENV.jade,
        ws: null,
        homeIsDark: {},             // clean-data key -> bool
        rd: null,                   // normalized clean data of the current map
        tickAt: 0,
        liveRound: null,            // 'key#round' whose clock has ticked
        routes: {},                 // matchId -> { home, away, maps }
        prematch: {},               // matchId -> { at, maps: { mapId: { order, name, homeIsDark } } }
        prematchTry: 0,
        alerts: {},                 // key -> { msg, level, sticky, since, lastSeen }
        alertFired: {},             // key -> last time it notified (cooldown)
        suspended: {},              // key -> time markets were suspended for it
        audio: null,
        indicator: null,            // { title, icon } saved while the tab shows an alert
        routeTry: 0,
        bb: null, bbAt: 0, bbTabs: {}, bbTab: null, bbOpen: 0, bbMatches: 0,
        trace: [], traceSig: null,
        pm: null, pmAt: 0, pmLast: null, pmWins: [],
        armed: false,
        error: null,
        busy: false,
        last: null,                 // last decide() result, for the panel
        log: [],
        leader: false,
    };
    let ST = freshState();
    // Declared up here, before anything can run: the GM listener below and
    // the hooks may fire during load, and a `let` touched before its line is
    // a ReferenceError that takes the whole script down.
    let root = null, dirty = true;
    // relaxed only has an effect on the test host; production ignores it.
    const OPT_DEFAULTS = { start: true, deaths: true, bomb: true, result: true, confirm: false, relaxed: true, pm: true, suspend: true, checks: true };
    const OPTS = Object.assign({}, OPT_DEFAULTS, GM_getValue('onak:opts', {}) || {});
    // Validate on read: a stored key that no longer exists is dropped.
    Object.keys(OPTS).forEach(k => { if (!(k in OPT_DEFAULTS)) delete OPTS[k]; });

    function freshState() {
        return { start: {}, plant: {}, result: {}, resultSeen: {}, confirm: {}, pending: {}, seen: {}, seenAt: {}, bbRoundFor: {}, bbDone: {}, autoClose: {}, refused: {}, pmGuess: {}, pmChecked: {}, switchRound: {} };
    }

    function logLine(msg, kind) {
        L.log.push({ t: new Date(), msg, kind: kind || 'info' });
        if (L.log.length > 1000) L.log.shift();
        dirty = true;
    }

    // The route lives on the TOP window's hash; the app itself runs in an
    // app.html iframe of the same origin, which is where its traffic is.
    // Production: Onak lives only on a map's clean-data page
    // (#/matches/<match>/maps/<map>). Raiden keeps several tabs open on the
    // same match (timeline, trading stream, kiki...) and the panel on all of
    // them was clutter. Test: any page, until its URLs are known.
    const MAP_PAGE_RE = /^#\/matches\/[^/?#]+\/maps\/[^/?#]+\/?(\?.*)?$/;
    function onMapPage() {
        if (ENV.test) return true;
        let hash = '';
        try { hash = W.top.location.hash || ''; } catch (e) { hash = location.hash || ''; }
        return MAP_PAGE_RE.test(hash);
    }

    function currentRoute() {
        let hash = '';
        try { hash = W.top.location.hash || ''; } catch (e) { hash = location.hash || ''; }
        const dec = s => { try { return atob(decodeURIComponent(s)); } catch (e) { return ''; } };
        const mm = hash.match(/matches\/([^/?#]+)/);
        const mp = hash.match(/maps\/([^/?#]+)/);
        const matchId = mm ? decodeURIComponent(mm[1]) : null;
        const mapId = mp ? decodeURIComponent(mp[1]) : null;
        const matchNum = mm ? (dec(mm[1]).match(/^match-(\d+)$/) || [])[1] || null : null;
        const mapNum = mp ? (dec(mp[1]).match(/^map-(\d+)$/) || [])[1] || null : null;
        return { matchId, mapId, matchNum, mapNum };
    }

    function readHeaders(h) {
        if (!h) return null;
        let auth = null, key = null;
        try {
            if (typeof h.get === 'function') { auth = h.get('authorization'); key = h.get('x-api-key'); }
            else if (Array.isArray(h)) {
                h.forEach(([k, v]) => {
                    if (/^authorization$/i.test(k)) auth = v;
                    if (/^x-api-key$/i.test(k)) key = v;
                });
            } else {
                for (const k in h) {
                    if (/^authorization$/i.test(k)) auth = h[k];
                    if (/^x-api-key$/i.test(k)) key = h[k];
                }
            }
        } catch (e) { return null; }
        return (auth && key) ? { authorization: auth, apiKey: key } : null;
    }

    function setJadeAuth(a) {
        if (!a) return;
        if (!L.auth) logLine('Raiden credentials captured');
        L.auth = a;
    }

    function onRoute(json) {
        const m = json && json.data && json.data.match;
        if (!m || !m.id || !m.teamsConnection) return;
        const nodes = (m.teamsConnection.edges || []).map(e => e.node).filter(Boolean);
        const homeId = m.homeTeam && m.homeTeam.id;
        const h = nodes.find(n => n.id === homeId);
        const a = nodes.find(n => n.id !== homeId);
        if (!h || !a) return;
        L.routes[m.id] = {
            home: { id: h.id, name: h.name, short: h.shortcut },
            away: { id: a.id, name: a.name, short: a.shortcut },
            maps: (m.maps || []).map(x => ({ id: x.id, order: x.order })),
        };
        dirty = true;
    }

    function teamOf(t) {
        t = t || {};
        return { score: t.score, confirmed: t.scoreConfirmed, alive: t.numAlive };
    }

    function onClean(d) {
        if (!d || d.__typename !== 'CsgoCleanData' || !d.key) return;
        if (typeof d.homeIsDark === 'boolean') L.homeIsDark[d.key] = d.homeIsDark;
        if (d.round === null || d.round === undefined) return;     // the homeIsDark-only subscription
        const route = currentRoute();
        if (route.mapNum && String(d.key).split('-')[1] !== route.mapNum) return;
        const now = Date.now();
        const prev = L.rd;
        if (prev && prev.key === d.key && prev.round === d.round && isTick(prev.roundTime, d.roundTime)) {
            L.tickAt = now;
            L.liveRound = d.key + '#' + d.round;
        }
        if (!prev || prev.key !== d.key || prev.round !== d.round) { L.tickAt = 0; L.liveRound = null; L.rdSince = now; }
        // A round that closed in Raiden without ever running is the shape of
        // the INOX-ACES round 16: a point nobody played. Onak never does that
        // (it only closes rounds it saw live), so it came from somewhere else.
        if (L.armed && prev && prev.key === d.key && d.round === prev.round + 1 &&
            !ST.seen[prev.round] && !ST.result[prev.round] && !ST.autoClose[prev.round]) {
            (L.pendingAlerts = L.pendingAlerts || []).push({
                key: `phantom:${d.key}:${prev.round}`, level: 'notify', sticky: true,
                msg: `Raiden round ${prev.round} was closed without being played (now ${teamOf(d.lightTeam).score}-${teamOf(d.darkTeam).score} CT-T) — check it`,
            });
        }
        L.rd = {
            key: d.key,
            mapId: btoa('map-' + String(d.key).split('-')[1]),
            round: d.round, roundTime: d.roundTime, bomb: d.bomb, paused: !!d.paused,
            homeIsDark: L.homeIsDark[d.key] !== undefined ? L.homeIsDark[d.key] : !!d.homeIsDark,
            light: teamOf(d.lightTeam), dark: teamOf(d.darkTeam),
            at: now, running: false,
        };
        refreshRunning(now);
        dirty = true;
        tick();
    }

    // A round is running once its clock has ticked, and stays running until
    // the round number changes or the clock goes back to Raiden's idle 20 and
    // stays there. 2.1.0 needed a tick in the last 2.6s, so when Raiden holds
    // the clock still (it parks it at 10) the round read as stopped and every
    // input stopped with it.
    function refreshRunning(now) {
        if (!L.rd) return;
        const latched = L.liveRound === L.rd.key + '#' + L.rd.round;
        const idle = L.rd.roundTime === 20 && now - L.tickAt > 2600;
        L.rd.running = latched && !idle && !L.rd.paused;
        if (L.rd.running) {
            ST.seen[L.rd.round] = true;
            if (!ST.seenAt[L.rd.round]) ST.seenAt[L.rd.round] = now;
        }
    }

    function onJadeMessage(raw) {
        let j;
        try { j = JSON.parse(raw); } catch (e) { return; }
        if (!j || j.type !== 'next' || !j.payload || !j.payload.data) return;
        const d = j.payload.data.onCreateCleanData;
        if (d) onClean(d);
    }

    // =====================================================================
    // 4. HOOKS — fetch and WebSocket of the page
    // =====================================================================

    const origFetch = W.fetch;
    if (typeof origFetch === 'function') {
        W.fetch = function (input, init) {
            let url = '', body = null;
            try {
                url = typeof input === 'string' ? input : (input && input.url) || String(input);
                if (/\/jade\/query/.test(url)) {
                    markActive();
                    if (!/[?&]op=/.test(url)) L.jadeUrl = url.split('?')[0];
                    setJadeAuth(readHeaders(init && init.headers));
                    if (input && typeof input !== 'string' && input.headers) setJadeAuth(readHeaders(input.headers));
                }
                if (/\/scorpion\/query/.test(url)) {
                    const sa = readHeaders(init && init.headers) ||
                        (input && typeof input !== 'string' && input.headers ? readHeaders(input.headers) : null);
                    if (sa) L.scorpionAuth = sa;
                }
                if (init && typeof init.body === 'string') body = init.body;
            } catch (e) { /* never break the page */ }
            const p = origFetch.apply(this, arguments);
            try {
                if (/\/scorpion\/query/.test(url) && body && body.indexOf('matchRouteInfo') >= 0) {
                    p.then(r => r.clone().json()).then(onRoute).catch(() => { });
                }
            } catch (e) { /* noop */ }
            return p;
        };
    }

    const OrigWS = W.WebSocket;
    if (typeof OrigWS === 'function') {
        const HookedWS = function (url, protocols) {
            const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
            if (/jade/.test(String(url))) {
                markActive();
                L.ws = ws;
                ws.addEventListener('message', ev => { if (typeof ev.data === 'string') onJadeMessage(ev.data); });
                // connection_init carries the same credentials as the HTTP
                // calls; reading them here means Onak is ready even before
                // the page has sent any HTTP request of its own.
                const send = ws.send;
                ws.send = function (data) {
                    try {
                        if (typeof data === 'string' && data.indexOf('connection_init') >= 0) {
                            const j = JSON.parse(data);
                            const pl = j && j.payload;
                            if (pl && pl.Authorization && pl['X-Api-Key'] && !L.auth) {
                                setJadeAuth({ authorization: pl.Authorization, apiKey: pl['X-Api-Key'] });
                            }
                        }
                    } catch (e) { /* noop */ }
                    return send.apply(this, arguments);
                };
            }
            return ws;
        };
        HookedWS.prototype = OrigWS.prototype;
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { HookedWS[k] = OrigWS[k]; });
        try { W.WebSocket = HookedWS; } catch (e) { console.error('[Dibu Onak] could not patch WebSocket:', e); }
    }

    // The page asks for matchRouteInfo as its very first scorpion call, often
    // before Tampermonkey has injected into the app iframe, so the sniffer
    // misses it and team names never arrive. Ask for it ourselves with the
    // page's OWN query and operation name: 1.2.0 used a trimmed query under a
    // new name, which scorpion rejected. Credentials come from the page's
    // scorpion calls when we see one, else from jade (same header set).
    const ROUTE_QUERY = "query matchRouteInfo($id: ID!) {\n  match(id: $id) {\n    id\n    name\n    datePlannedStart\n    prematchOnly\n    winTeam {\n      id\n      __typename\n    }\n    state {\n      id\n      key\n      __typename\n    }\n    tournament {\n      id\n      shortcut\n      sport {\n        id\n        key\n        iconUrl\n        shortcut\n        __typename\n      }\n      otsRiskTier {\n        name\n        id\n        __typename\n      }\n      __typename\n    }\n    maps {\n      id\n      order\n      state {\n        id\n        key\n        __typename\n      }\n      winTeam {\n        id\n        __typename\n      }\n      __typename\n    }\n    homeTeam {\n      id\n      __typename\n    }\n    teamsConnection {\n      edges {\n        node {\n          id\n          name\n          shortcut\n          iconUrl\n          __typename\n        }\n        avatar {\n          name\n          url\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    marketGroup {\n      id\n      __typename\n    }\n    type {\n      id\n      format {\n        id\n        key\n        __typename\n      }\n      __typename\n    }\n    showScoreboard\n    disabledResulting\n    __typename\n  }\n}";
    const ROUTE_BACKOFF = [0, 10000, 30000, 60000, 120000, 300000];

    async function fetchRoute(matchId) {
        L.routeTry = Date.now();
        L.routeFails = (L.routeFails || 0);
        const auth = L.scorpionAuth || L.auth;
        let why = null;
        try {
            const res = await origFetch.call(W, ENV.scorpion, {
                method: 'POST',
                headers: {
                    'accept': 'application/graphql-response+json,application/json;q=0.9',
                    'content-type': 'application/json',
                    'authorization': auth.authorization,
                    'x-api-key': auth.apiKey,
                    'x-graphql-operation': 'matchRouteInfo',
                    'x-graphql-operation-type': 'query',
                },
                body: JSON.stringify({ operationName: 'matchRouteInfo', variables: { id: matchId }, query: ROUTE_QUERY }),
            });
            let j = null;
            try { j = await res.json(); } catch (e) { /* non-JSON error page */ }
            if (j) onRoute(j);
            if (!L.routes[matchId]) {
                why = !res.ok ? `HTTP ${res.status}`
                    : (j && j.errors && j.errors[0] ? j.errors[0].message : 'empty response');
            }
        } catch (e) {
            why = (e && e.message) || String(e);
        }
        if (L.routes[matchId]) {
            L.routeFails = 0; L.routeWhy = null;
            logLine('Raiden teams: ' + L.routes[matchId].home.name + ' / ' + L.routes[matchId].away.name);
        } else {
            L.routeFails++;
            // One log line per distinct reason, not one every retry.
            if (why !== L.routeWhy) logLine(`could not read Raiden teams (${why}) — retrying with backoff`, 'warn');
            L.routeWhy = why;
        }
        dirty = true;
    }

    // Raiden's prematch table: the map name configured for each map of the
    // match (and the side preset). Read with the page's own query, refreshed
    // every minute, faster while a map alert is up so a fix clears it soon.
    const PREMATCH_QUERY = "query prematch($id: ID!) {\n  match(id: $id) {\n    ...MatchWithPrematch\n    __typename\n  }\n}\n\nfragment MatchWithPrematch on Match {\n  id\n  datePlannedStart\n  allowDraw\n  state {\n    id\n    key\n    __typename\n  }\n  type {\n    id\n    numberOfMaps\n    format {\n      id\n      key\n      __typename\n    }\n    __typename\n  }\n  teams {\n    id\n    name\n    shortcut\n    __typename\n  }\n  homeTeam {\n    id\n    __typename\n  }\n  tournament {\n    id\n    shortcut\n    sport {\n      id\n      key\n      __typename\n    }\n    tier {\n      key\n      __typename\n    }\n    __typename\n  }\n  prematch {\n    home\n    away\n    draw\n    __typename\n  }\n  prematchRaw {\n    home\n    away\n    draw\n    __typename\n  }\n  providers {\n    id\n    home\n    away\n    draw\n    __typename\n  }\n  externalAutoUpdateInfo {\n    matchId\n    enabled\n    providers {\n      sourceId\n      providerId\n      marketType\n      __typename\n    }\n    __typename\n  }\n  maps {\n    id\n    order\n    prematch {\n      home\n      away\n      draw\n      __typename\n    }\n    winTeam {\n      id\n      __typename\n    }\n    modelSettings {\n      asymmetryProbLight\n      asymmetryProbLightHome\n      asymmetryProbLightAway\n      mapLengthAdjust\n      totalRoundsThreshold\n      totalRoundsProbUnder\n      pistolProbLightHome\n      pistolProbLightAway\n      mapName\n      homeIsDark\n      mapDuration\n      totalKills\n      totalTurrets\n      totalTowers\n      winRatio\n      top10Ratio\n      top25Ratio\n      totalGoals\n      goalsDiff\n      nLastMatches\n      totalPoints\n      firstHalfPrematchHome\n      firstHalfPrematchDraw\n      totalGoalsThreshold\n      totalGoalsOddsUnder\n      firstHalfHomeRatio\n      firstHalfAwayRatio\n      goalScoreReaction\n      firstHalfDecayParam\n      secondHalfDecayParam\n      nLastMatchesForce\n      killsDiff\n      intervalKillsMedian\n      intervalKillsHandicapMedian\n      totalRuns\n      serveAdvHome\n      serveAdvAway\n      prematchHomeFirstToBatHome\n      prematchAwayFirstToBatHome\n      totalRunsFirstToBatHome\n      prematchHomeFirstToBatAway\n      prematchAwayFirstToBatAway\n      totalRunsFirstToBatAway\n      firstInningsRunsFirstToBatHome\n      firstInningsRunsFirstToBatAway\n      playerEstimates {\n        playerId\n        mapTotalKillsMedian\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}";
    async function fetchPrematch(matchId) {
        const auth = L.scorpionAuth || L.auth;
        L.prematchTry = Date.now();
        try {
            const res = await origFetch.call(W, ENV.scorpion, {
                method: 'POST',
                headers: {
                    'accept': 'application/graphql-response+json,application/json;q=0.9',
                    'content-type': 'application/json',
                    'authorization': auth.authorization,
                    'x-api-key': auth.apiKey,
                    'x-graphql-operation': 'prematch',
                    'x-graphql-operation-type': 'query',
                },
                body: JSON.stringify({ operationName: 'prematch', variables: { id: matchId }, query: PREMATCH_QUERY }),
            });
            const j = await res.json();
            const m = j && j.data && j.data.match;
            if (!m || !Array.isArray(m.maps)) return;
            const maps = {};
            m.maps.forEach(x => {
                const ms = x.modelSettings || {};
                maps[x.id] = { order: x.order, name: ms.mapName || null, homeIsDark: ms.homeIsDark };
            });
            L.prematch[matchId] = { at: Date.now(), maps };
            dirty = true;
        } catch (e) { /* retried on the next interval */ }
    }

    // =====================================================================
    // 5. MUTATIONS — byte-for-byte what the trader panel sends
    // =====================================================================

    const Q = {
        death: ['jadeUpdateTraderInputCsgoDeath', 'CommonTraderInput', 'updateTraderInputCsgoDeath'],
        start: ['jadeUpdateTraderInputCsgoStartRoundManually', 'CsgoStartRoundManuallyTraderInput', 'updateTraderInputCsgoStartRoundManually'],
        plant: ['jadeUpdateTraderInputCsgoPlantBomb', 'CsgoPlantBombTraderInput', 'updateTraderInputCsgoPlantBomb'],
        result: ['jadeUpdateTraderInputCsgoRoundResult', 'CsgoRoundResultTraderInput', 'updateTraderInputCsgoRoundResult'],
        confirm: ['jadeUpdateTraderInputCsgoConfirmScore', 'CsgoConfirmScoreTraderInput', 'updateTraderInputCsgoConfirmScore'],
    };

    async function mutate(kind, input) {
        const [op, type, field] = Q[kind];
        const query = `mutation ${op}($input: ${type}!) {\n  ${field}(input: $input) {\n    success\n    error\n    __typename\n  }\n}`;
        const res = await origFetch.call(W, L.jadeUrl, {
            method: 'POST',
            headers: {
                'accept': 'application/graphql-response+json,application/json;q=0.9',
                'content-type': 'application/json',
                'authorization': L.auth.authorization,
                'x-api-key': L.auth.apiKey,
                'x-graphql-operation': op,
                'x-graphql-operation-type': 'mutation',
            },
            body: JSON.stringify({ operationName: op, variables: { input }, query }),
        });
        if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
        const j = await res.json();
        if (j.errors && j.errors.length) throw new Error(`${kind}: ${j.errors[0].message}`);
        const r = j.data && j.data[field];
        if (!r || r.success !== true) throw new Error(`${kind}: ${(r && r.error) || 'success=false'}`);
        return r;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Raiden refusing an input because its round already ended is a race with
    // the round's end, not a fault: log it, stop inputs for that round, keep
    // running. Anything else stops the tool until it is re-armed.
    const NOT_LIVE_RE = /round isn'?t live|cannot set any game events/i;

    async function execute(actions) {
        const mapId = L.rd.mapId;
        for (const a of actions) {
            if (!L.armed) return;
            try {
                await executeOne(a, mapId);
            } catch (e) {
                const msg = (e && e.message) || String(e);
                if (!NOT_LIVE_RE.test(msg)) throw e;
                // Stops deaths and plants for the round, NOT the result: a
                // refused death is no proof Raiden closed the round.
                ST.refused[a.round] = ST.refused[a.round] || Date.now();
                logLine(`R${a.round} ${a.op} refused: round no longer live in Raiden`, 'warn');
            }
        }
    }

    async function executeOne(a, mapId) {
        const now = Date.now();
        {
            if (a.op === 'death') {
                ST.pending[a.side] = { round: a.round, target: a.target, at: now };
                for (let i = 0; i < a.n; i++) {
                    await mutate('death', { mapId, side: a.side, value: 1 });
                    if (i < a.n - 1) await sleep(40);
                }
                // A side at 0 makes Raiden close the round itself.
                if (a.target === 0) {
                    ST.autoClose[a.round] = now;
                    if (a.bbRound !== undefined) ST.bbDone[a.bbRound] = now;
                }
                logLine(`R${a.round} death ${a.side === 'LIGHT' ? 'CT' : 'T'} ×${a.n} → ${a.target} alive`, 'death');
            } else if (a.op === 'start') {
                ST.start[a.round] = now;
                await mutate('start', { mapId, roundTime: a.roundTime });
                logLine(`R${a.round} started (${a.roundTime}s)`, 'start');
            } else if (a.op === 'plant') {
                ST.plant[a.round] = now;
                await mutate('plant', { mapId });
                logLine(`R${a.round} bomb planted`, 'bomb');
            } else if (a.op === 'result') {
                // Last check against the freshest clean data: if Raiden closed
                // the round on its own meanwhile, this result would close the
                // next one.
                if (a.bbRound !== undefined) ST.bbDone[a.bbRound] = now;
                if (!L.rd || L.rd.round !== a.round) { ST.result[a.round] = now; return; }
                ST.result[a.round] = now;
                if (a.source === 'pm') ST.pmGuess[a.round] = a.type;
                await mutate('result', { mapId, type: a.type });
                logLine(`R${a.round} result ${a.type}${a.source === 'pm' ? ' (Polymarket)' : ''}`, 'result');
            } else if (a.op === 'confirm') {
                ST.confirm[a.key] = now;
                await mutate('confirm', { mapId });
                logLine(`score confirmed (${a.key.split(':').slice(1).join('-')} CT-T)`, 'confirm');
            }
        }
    }

    // =====================================================================
    // 6. LOOP
    // =====================================================================

    const mapKey = (bb, route) => `onak:map:${bb.matchId}:${route.matchNum}`;

    function mappingFor(bb, route) {
        if (!bb || !bb.teams || bb.teams.length !== 2) return null;
        const rt = L.routes[route.matchId];
        const manual = GM_getValue(mapKey(bb, route), null);
        if (manual && manual[bb.teams[0].id] && manual[bb.teams[1].id]) return manual;
        return autoMap(bb.teams, rt);
    }

    function claimLeader(now) {
        if (!L.rd) { L.leader = false; return; }
        const key = 'onak:leader:' + L.rd.key;
        const rec = GM_getValue(key, null);
        if (!rec || rec.id === L.me || now - rec.at > 3000) {
            GM_setValue(key, { id: L.me, at: now });
            L.leader = true;
        } else L.leader = false;
    }

    function tick() {
        if (!L.frameActive) return;
        // Off the map page: hidden, and never acting. Leaving the page while
        // ON switches it off, so coming back never resumes sending by surprise.
        const here = onMapPage();
        if (here !== L.onMap) {
            L.onMap = here;
            if (root) root.style.display = here ? '' : 'none';
            if (!here && L.armed) { setArmed(false); logLine('left the map page — Onak switched off', 'warn'); }
            dirty = true;
        }
        if (!here) return;
        const now = Date.now();
        // Events (Raiden's clean data every second while a round runs, every
        // betboom frame) are never throttled, unlike timers. Riding them keeps
        // Polymarket polled even in a background tab. pollPmLink dedupes.
        pollPmLink();
        refreshRunning(now);
        if (L.armed) claimLeader(now);
        const route = currentRoute();
        const rt = L.routes[route.matchId];
        if (!rt && route.matchId && (L.scorpionAuth || L.auth)) {
            const gap = ROUTE_BACKOFF[Math.min(L.routeFails || 0, ROUTE_BACKOFF.length - 1)];
            if (!L.routeInFlight && now - L.routeTry >= Math.max(gap, 3000)) {
                L.routeInFlight = true;
                fetchRoute(route.matchId).finally(() => { L.routeInFlight = false; });
            }
        }
        const mapOrder = rt && route.mapId ? ((rt.maps.find(m => m.id === route.mapId) || {}).order || null) : null;
        const pre = L.prematch[route.matchId];
        const mapAlertUp = Object.keys(L.alerts).some(k => k.startsWith('mapname:'));
        if (route.matchId && (L.scorpionAuth || L.auth) && now - L.prematchTry > (mapAlertUp ? 20000 : 60000)) {
            fetchPrematch(route.matchId);
        }
        const rdMapName = pre && route.mapId && pre.maps[route.mapId] ? pre.maps[route.mapId].name : null;
        const ctx = {
            armed: L.armed, leader: L.leader, auth: !!L.auth, error: L.error,
            wsOpen: !!(L.ws && L.ws.readyState === 1),
            bb: L.bb, bbAt: L.bbAt, rd: L.rd,
            mapping: mappingFor(L.bb, route), raidenMapOrder: mapOrder, opts: OPTS,
            relaxed: ENV.test && OPTS.relaxed,
            pm: L.pm ? { at: L.pmAt, snap: L.pm, wins: L.pmWins } : null,
            rt: rt || null,
            rdMapName,
            // 1.x panels used this id; if one is on the page, the old script
            // is still installed and would send inputs alongside this one.
            oldLink: !!document.getElementById('dl-root'),
            // How long this Raiden round has been watched (since it appeared
            // or since arming, whichever is later).
            rdWatchedMs: L.rd ? now - Math.max(L.rdSince || 0, L.armedAt || 0) : 0,
        };
        const res = decide(ctx, ST, now);
        // Each hold and each warning is logged when it starts, and again only
        // after it has been gone for 5s. Flickering states (a source that
        // comes and goes every second) no longer fill the log; the status
        // line always shows the current state anyway.
        if (L.armed) {
            const seen = L.logSeen || (L.logSeen = {});
            const cur = [];
            if (res.hold && res.hold !== 'OFF') cur.push(['HOLD · ' + res.hold, 'hold']);
            res.warn.forEach(w => cur.push([w, 'warn']));
            // Keyed with numbers masked: "no frames 31s" and "no frames 32s"
            // are the same state, and 3.0.2 logged one line per second of it.
            for (const [msg, kind] of cur) {
                const key = msg.replace(/\d+/g, '#');
                if (!seen[key] || now - seen[key] > 5000) logLine(msg, kind);
                seen[key] = now;
            }
            for (const k of Object.keys(seen)) if (now - seen[k] > 60000) delete seen[k];
        }
        L.last = res;
        // Decision trace for the JSON export: one entry each time what Onak
        // decides (hold, actions, alerts) changes, with the inputs it saw.
        const tsig = JSON.stringify([res.hold && res.hold.replace(/\d+/g, '#'), res.actions, res.alerts.map(a => a.key)]);
        if (tsig !== L.traceSig) {
            L.traceSig = tsig;
            L.trace.push({
                t: new Date(now).toISOString(), armed: L.armed, hold: res.hold, info: res.info, warn: res.warn,
                actions: res.actions, alerts: res.alerts,
                rd: L.rd && { key: L.rd.key, round: L.rd.round, roundTime: L.rd.roundTime, running: L.rd.running, bomb: L.rd.bomb,
                    homeIsDark: L.rd.homeIsDark, light: L.rd.light, dark: L.rd.dark },
                bb: L.bb && { matchId: L.bb.matchId, mapNum: L.bb.mapNum, mapName: L.bb.mapName, phase: L.bb.phase, total: L.bb.total,
                    teams: L.bb.teams, history: L.bb.history, unexplained: L.bb.unexplained, age: Math.round((now - (L.bb.lastUpdate || now)) / 1000) },
                pm: L.pm && L.pm.map ? { map: L.pm.map, age: Math.round((now - L.pmAt) / 1000), via: L.pm.via } : null,
            });
            if (L.trace.length > 1500) L.trace.shift();
        }
        if (L.armed) processAlerts(res.alerts || [], now);
        dirty = true;
        // A hold can still carry an action: Polymarket closing a round while
        // betboom holds. decide() only does that for betboom-side holds.
        if (!res.actions.length || L.busy) return;
        L.busy = true;
        execute(res.actions)
            .catch(e => { L.error = e.message || String(e); logLine('ERROR ' + L.error, 'error'); })
            .finally(() => { L.busy = false; dirty = true; });
    }

    // ---- alerts -------------------------------------------------------------
    const ALERT_COOLDOWN = 5 * 60000;     // same alert: notify again at most every 5 min
    function processAlerts(list, now) {
        for (const a of list.concat(L.pendingAlerts || [])) {
            const cur = L.alerts[a.key];
            if (!cur) {
                L.alerts[a.key] = { msg: a.msg, level: a.level, sticky: a.sticky, since: now, lastSeen: now };
                fireAlert(a, now);
            } else { cur.lastSeen = now; cur.msg = a.msg; }
        }
        L.pendingAlerts = [];
        for (const k of Object.keys(L.alerts)) {
            const a = L.alerts[k];
            if (!a.sticky && now - a.lastSeen > 3000) {
                logLine('resolved · ' + a.msg, 'info');
                delete L.alerts[k];
            }
        }
        showIndicator(Object.keys(L.alerts).length > 0);
    }

    function fireAlert(a, now) {
        logLine((a.level === 'suspend' ? 'ALERT · ' : 'NOTICE · ') + a.msg, 'error');
        if (a.level === 'suspend' && OPTS.suspend && L.leader && L.rd && !L.suspended[a.key]) suspendMarkets(a);
        if (L.alertFired[a.key] && now - L.alertFired[a.key] < ALERT_COOLDOWN) return;
        L.alertFired[a.key] = now;
        beep(a.level === 'suspend');
        osNotify(`Dibu Onak — ${a.level === 'suspend' ? 'markets suspended' : 'check Raiden'}`, a.msg);
    }

    function osNotify(title, text) {
        try {
            if (typeof GM_notification !== 'function') { logLine('OS notification unavailable: GM_notification not granted', 'warn'); return; }
            GM_notification({
                title, text,
                silent: true,
                timeout: 20000,
                onclick: () => { try { W.top.focus(); } catch (e) { /* noop */ } },
            });
        } catch (e) {
            logLine('OS notification failed: ' + (e.message || e), 'warn');
        }
    }

    // Everything an alert does except suspending: to check that the sound,
    // the Windows notification and the tab mark reach the trader.
    function testAlert() {
        try {
            if (!L.audio) L.audio = new (W.AudioContext || W.webkitAudioContext)();
            if (L.audio.state === 'suspended') L.audio.resume();
        } catch (e) { logLine('sound unavailable: ' + (e.message || e), 'warn'); }
        beep(true);
        osNotify('Dibu Onak — test', 'If you can read this outside the browser, Windows notifications work.');
        L.testMark = Date.now();
        showIndicator(true, true);
        setTimeout(() => { L.testMark = 0; showIndicator(Object.keys(L.alerts).length > 0); }, 5000);
        logLine('test alert sent: sound + Windows notification + tab mark for 5s', 'info');
    }

    // Only suspends, never reopens: reopening stays with the trader (Shift+Space).
    async function suspendMarkets(a) {
        L.suspended[a.key] = Date.now();
        const op = 'jadeUpdateMapWithMatchMarketsState';
        try {
            const res = await origFetch.call(W, L.jadeUrl, {
                method: 'POST',
                headers: {
                    'accept': 'application/graphql-response+json,application/json;q=0.9',
                    'content-type': 'application/json',
                    'authorization': L.auth.authorization,
                    'x-api-key': L.auth.apiKey,
                    'x-graphql-operation': op,
                    'x-graphql-operation-type': 'mutation',
                },
                body: JSON.stringify({
                    operationName: op,
                    variables: { input: { mapId: L.rd.mapId, state: 'SUSPENDED' } },
                    query: 'mutation jadeUpdateMapWithMatchMarketsState($input: MapMarketsStateUpdateInput!) {\n  updateMapWithMatchMarketsState(input: $input)\n}',
                }),
            });
            const j = await res.json();
            if (j && j.data && j.data.updateMapWithMatchMarketsState === 'SUSPENDED') logLine('markets SUSPENDED', 'error');
            else logLine('could not suspend markets: ' + ((j && j.errors && j.errors[0] && j.errors[0].message) || 'HTTP ' + res.status), 'error');
        } catch (e) {
            logLine('could not suspend markets: ' + (e.message || e), 'error');
        }
    }

    function beep(urgent) {
        try {
            const ac = L.audio;
            if (!ac) return;
            if (ac.state === 'suspended') ac.resume();
            const tones = urgent ? [880, 660, 880] : [740, 740];
            tones.forEach((f, i) => {
                const o = ac.createOscillator(), g = ac.createGain();
                o.frequency.value = f; o.type = 'sine';
                const t0 = ac.currentTime + i * 0.18;
                g.gain.setValueAtTime(0.0001, t0);
                g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
                o.connect(g).connect(ac.destination);
                o.start(t0); o.stop(t0 + 0.16);
            });
        } catch (e) { /* no audio */ }
    }

    // "⚠" in the title and a red favicon, only on the tab where Onak is on,
    // kept until every alert is cleared. Raiden rewrites its title on
    // navigation, so the mark is re-applied on every pass.
    const ALERT_ICON = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#e5383b"/>' +
        '<rect x="14" y="6" width="4" height="13" rx="2" fill="#fff"/><circle cx="16" cy="24" r="2.4" fill="#fff"/></svg>');
    function showIndicator(on, force) {
        let doc;
        try { doc = W.top.document; } catch (e) { return; }
        on = (on && L.armed) || !!force || !!L.testMark;
        const links = () => Array.from(doc.querySelectorAll('link[rel~="icon"]'));
        if (on) {
            if (!L.indicator) L.indicator = { icons: links().map(l => [l, l.href]) };
            if (!doc.title.startsWith('⚠ ')) doc.title = '⚠ ' + doc.title;
            let ls = links();
            if (!ls.length) {
                const l = doc.createElement('link'); l.rel = 'icon'; doc.head.appendChild(l); ls = [l];
                L.indicator.added = l;
            }
            ls.forEach(l => { if (l.href !== ALERT_ICON) l.href = ALERT_ICON; });
        } else if (L.indicator) {
            if (doc.title.startsWith('⚠ ')) doc.title = doc.title.slice(2);
            L.indicator.icons.forEach(([l, href]) => { l.href = href; });
            if (L.indicator.added) L.indicator.added.remove();
            L.indicator = null;
        }
    }

    // Everything needed to replay an incident afterwards, in one file.
    function exportJson() {
        const route = currentRoute();
        const dump = {
            script: 'dibu-onak', version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?',
            env: ENV.name, exportedAt: new Date().toISOString(), route,
            armed: L.armed, leader: L.leader, error: L.error, options: OPTS,
            raidenTeams: L.routes[route.matchId] || null, prematch: L.prematch[route.matchId] || null,
            raiden: L.rd, betboom: L.bb, betboomTabs: Object.keys(L.bbTabs).length,
            polymarket: { link: getPmLink(), snapshot: L.pm, wins: L.pmWins }, // eslint-disable-line no-use-before-define
            alerts: L.alerts, suspended: L.suspended,
            state: ST, lastDecision: L.last,
            log: L.log.map(l => ({ t: l.t.toISOString(), kind: l.kind, msg: l.msg })),
            trace: L.trace,
        };
        try {
            const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `dibu-onak-${ENV.name.toLowerCase()}-${Date.now()}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            logLine(`exported ${L.trace.length} decisions and ${L.log.length} log lines`, 'info');
        } catch (e) { logLine('export failed: ' + (e.message || e), 'warn'); }
    }

    function dismissAlert(key) {
        delete L.alerts[key];
        showIndicator(Object.keys(L.alerts).length > 0);
        dirty = true;
    }

    function setArmed(on) {
        L.armed = !!on;
        L.armedAt = Date.now();
        // The switch click is a user gesture: the only moment a page may start
        // audio, so the alert sound's context is created (or resumed) here.
        try {
            if (!L.audio) L.audio = new (W.AudioContext || W.webkitAudioContext)();
            if (L.audio.state === 'suspended') L.audio.resume();
        } catch (e) { /* no audio */ }
        if (!on) { L.alerts = {}; showIndicator(false); }
        L.error = null;
        ST = freshState();
        L.logSeen = {};
        if (!on && L.rd) {
            const key = 'onak:leader:' + L.rd.key;
            const rec = GM_getValue(key, null);
            if (rec && rec.id === L.me) GM_setValue(key, null);
            L.leader = false;
        }
        logLine(on ? 'Onak ON' : 'Onak off', on ? 'start' : 'info');
        tick();
    }

    // bb snapshot relay from the betboom tab.
    // One entry per betboom tab. With two tabs open (one on the match, one on
    // a page with no match, or on another match), 2.5.0 took whichever wrote
    // last, so the state flipped every second - the "betboom has no teams"
    // spam. Now each tab is kept apart and the right one is chosen:
    //   1. only tabs heard from in the last 4s with a two-team match;
    //   2. among those, the match whose teams pair with Raiden's;
    //   3. then the tab already in use (no flapping between equals);
    //   4. then the most recent.
    // A tab with no match is never chosen over one with a match.
    function pickBB(now) {
        const live = Object.values(L.bbTabs).filter(x => now - x.at < 4000);
        const withMatch = live.filter(x => x.snap && x.snap.teams && x.snap.teams.length === 2);
        const route = currentRoute();
        const rt = L.routes[route.matchId];
        const score = x => (autoMap(x.snap.teams, rt) ? 4 : 0) + (x.tab === L.bbTab ? 2 : 0);
        const pool = withMatch.length ? withMatch : live;
        pool.sort((a, b) => (withMatch.length ? score(b) - score(a) : 0) || b.at - a.at);
        return { pick: pool[0] || null, open: live.length, matches: withMatch.length };
    }

    function onBB(v) {
        if (!v || !v.snap) return;
        const now = Date.now();
        const tab = v.tab || 'legacy';
        L.bbTabs[tab] = { tab, at: v.at || now, snap: v.snap };
        for (const k of Object.keys(L.bbTabs)) if (now - L.bbTabs[k].at > 30000) delete L.bbTabs[k];
        const { pick, open, matches } = pickBB(now);
        L.bbOpen = open; L.bbMatches = matches;
        if (!pick) return;
        if (pick.tab !== L.bbTab) {
            const title = pick.snap.title || (pick.snap.teams || []).map(t => t.name).join(' vs ') || 'no match';
            if (L.bbTab) logLine(`betboom source: ${title}${open > 1 ? ` (${open} betboom tabs open)` : ''}`, 'info');
            L.bbTab = pick.tab;
        }
        L.bb = pick.snap; L.bbAt = pick.at;
        dirty = true;
        tick();
    }
    // Polymarket score stream -> list of round wins. A win is a change where
    // exactly one team gained exactly one point on the same map; anything else
    // (first sample, a missed poll that skipped points, a correction) only
    // resets the baseline, because it cannot say who won which round.
    function onPM(v) {
        if (!v || !v.map) return;
        const m = v.map;
        const key = `${v.seriesId}:${m.seq}`;
        const prev = L.pmLast && L.pmLast.key === key ? L.pmLast : null;
        const scores = {};
        m.teams.forEach(t => { scores[t.name] = t.score; });
        if (prev) {
            const diffs = m.teams.map(t => t.score - (prev.scores[t.name] ?? t.score));
            const up = diffs.filter(d => d === 1).length, other = diffs.filter(d => d !== 0 && d !== 1).length;
            if (up === 1 && !other) {
                const winner = m.teams[diffs.indexOf(1)].name;
                const round = m.teams.reduce((a, t) => a + t.score, 0);
                L.pmWins.push({ map: m.seq, round, winner, scores, at: Date.now() });
                if (L.pmWins.length > 40) L.pmWins.shift();
                logLine(`Polymarket: ${winner} takes round ${round} (${m.teams.map(t => t.score).join('-')})`, 'pm');
            }
        }
        L.pmLast = { key, scores };
        L.pm = v; L.pmAt = v.at || Date.now();
        dirty = true;
        tick();
    }

    // ---- Polymarket source --------------------------------------------------
    // With a link set for this Raiden match, Onak asks Polymarket itself
    // (GM_xmlhttpRequest is not bound by CORS, so no Polymarket tab is needed)
    // and ignores any open Polymarket tab: two sources a second apart would
    // read as a score going down and up again. Without a link it falls back to
    // whatever event page is open, and the panel says which one that is.
    const pmLinkKey = () => `onak:pmlink:${ENV.name}:${currentRoute().matchNum || '?'}`;
    const getPmLink = () => GM_getValue(pmLinkKey(), null);

    function slugFrom(text) {
        const t = String(text || '').trim();
        if (!t) return null;
        try {
            const u = new URL(t);
            if (!/(^|\.)polymarket\.com$/.test(u.hostname)) return null;
            const parts = u.pathname.split('/').filter(Boolean);
            return parts.length ? parts[parts.length - 1] : null;
        } catch (e) {
            return /^[a-z0-9-]+$/i.test(t) ? t : null;   // a bare slug
        }
    }

    function gmJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 6000,
                headers: { accept: 'application/json' },
                onload: r => {
                    if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
                    try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('bad JSON')); }
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    const PMD = { slug: null, seriesId: null, title: '', err: null, errSlug: null, busy: false, okAt: 0, startedAt: 0, retryAt: 0 };
    const pmGameOf = j => (j.games || []).find(g => g.started && !g.finished) || (j.games || [])[(j.games || []).length - 1];

    async function pollPmLink() {
        const link = getPmLink();
        if (!link || PMD.busy || Date.now() - PMD.startedAt < 900) return;
        if (Date.now() < PMD.retryAt) return;
        PMD.startedAt = Date.now();
        PMD.busy = true;
        try {
            if (PMD.slug !== link.slug) {
                // PMD.err is kept across retries of the same link: clearing it
                // here is what logged "no GRID series" every second in 2.4.0.
                if (PMD.errSlug !== link.slug) { PMD.err = null; PMD.errSlug = link.slug; }
                PMD.slug = link.slug; PMD.seriesId = null; PMD.title = '';
                const arr = await gmJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(link.slug)}`);
                const ev = Array.isArray(arr) ? arr[0] : arr;
                if (!ev) throw new Error('event not found');
                PMD.title = ev.title || link.slug;
                PMD.seriesId = ev.eventMetadata && ev.eventMetadata.gridSeriesId ? String(ev.eventMetadata.gridSeriesId) : null;
                if (!PMD.seriesId) throw new Error('event has no live score (no GRID series)');
                logLine(`Polymarket link: ${PMD.title}`, 'pm');
            }
            if (!PMD.seriesId) return;
            const j = await gmJson(`https://polymarket.com/api/esports/series-state?seriesId=${PMD.seriesId}`);
            const g = j && pmGameOf(j);
            if (!g || !Array.isArray(g.teams)) throw new Error('no game in series-state');
            if (PMD.err) logLine('Polymarket link: receiving the live score again', 'pm');
            PMD.err = null; PMD.okAt = Date.now();
            onPM({
                at: Date.now(), via: 'link', slug: PMD.slug, title: PMD.title, seriesId: PMD.seriesId,
                started: !!j.started, finished: !!j.finished,
                map: { seq: g.sequenceNumber, started: !!g.started, finished: !!g.finished,
                    teams: g.teams.map(t => ({ name: t.name || '', score: t.score || 0 })) },
            });
        } catch (e) {
            const msg = (e && e.message) || String(e);
            // One log line per distinct reason and link; the panel keeps
            // showing the current reason next to the link.
            if (msg !== PMD.err) logLine(`Polymarket link: ${msg}`, 'warn');
            PMD.err = msg;
            if (!PMD.seriesId) {
                // A failed lookup is retried from scratch, but not every second:
                // an event without GRID data stays that way for a while.
                PMD.slug = null;
                PMD.retryAt = Date.now() + (/no GRID/.test(msg) ? 30000 : 10000);
            }
        } finally {
            PMD.busy = false;
            dirty = true;
        }
    }

    function setPmLink(text) {
        const slug = slugFrom(text);
        if (text && !slug) { logLine('not a Polymarket event link', 'warn'); return; }
        GM_setValue(pmLinkKey(), slug ? { url: String(text).trim(), slug } : null);
        PMD.slug = null; PMD.seriesId = null; PMD.title = ''; PMD.err = null; PMD.errSlug = null; PMD.retryAt = 0;
        L.pm = null; L.pmLast = null; L.pmWins = [];
        logLine(slug ? `Polymarket link set: ${slug}` : 'Polymarket link cleared — using an open Polymarket tab', 'pm');
        dirty = true;
    }

    function onPMTab(v) {
        if (!v) return;
        if (getPmLink()) return;          // a link is set: only that source counts
        onPM(Object.assign({}, v, { via: 'tab' }));
    }

    try {
        onPMTab(GM_getValue('onak:pm', null));
        GM_addValueChangeListener('onak:pm', (k, o, v) => onPMTab(v));
    } catch (e) { /* noop */ }

    try {
        onBB(GM_getValue('onak:bb', null));
        GM_addValueChangeListener('onak:bb', (k, o, v) => onBB(v));
    } catch (e) { /* noop */ }

    function markActive() {
        if (L.frameActive) return;
        L.frameActive = true;
        everyMs(250, tick);
        everyMs(1000, pollPmLink);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
        else buildPanel();
    }

    // =====================================================================
    // 7. PANEL
    // =====================================================================

    const CSS = `
#do-root{position:fixed;z-index:2147483000;width:316px;font:12px/1.4 "JetBrains Mono",Consolas,ui-monospace,monospace;
  color:#d6dde6;background:#141a21;border:1px solid #2b3540;border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.55);user-select:none}
#do-root *{box-sizing:border-box}
#do-root button{font:inherit}
#do-root.min{width:auto;min-width:210px}
#do-root.min #dl-body{display:none}
#do-root.min #dl-head{border-bottom:0;border-radius:8px}
#dl-head{display:flex;align-items:center;gap:8px;padding:7px 9px;cursor:move;border-bottom:1px solid #2b3540;background:#10151b;border-radius:8px 8px 0 0}
#dl-title{font-weight:700;letter-spacing:.12em;font-size:11px;color:#8fa3b8;white-space:nowrap}
#dl-title b{color:#e8a87c}
.dl-env{display:inline-block;margin-left:4px;padding:0 5px;border-radius:3px;background:#2a3d6b;color:#b9cdfc;font-size:9px;letter-spacing:.08em}
.dl-pill{flex:1;display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;font-weight:700;letter-spacing:.06em;color:#6c7e91}
.dl-pill i{width:8px;height:8px;border-radius:50%;background:#4a5562;flex:none}
.dl-pill.ok{color:#7fe0a8}.dl-pill.ok i{background:#3ecf7d;box-shadow:0 0 6px #3ecf7d}
.dl-pill.hold{color:#f0c46a}.dl-pill.hold i{background:#f0b43c}
.dl-pill.alert{color:#ff8f95}.dl-pill.alert i{background:#e5383b;box-shadow:0 0 6px #e5383b;animation:dlpulse 1.2s infinite}
@keyframes dlpulse{50%{opacity:.35}}
.dl-sw{position:relative;width:46px;height:22px;border-radius:11px;background:#3a2326;border:1px solid #6b3a3f;cursor:pointer;flex:none}
.dl-sw::after{content:"OFF";position:absolute;top:3px;left:22px;font-size:9px;font-weight:700;color:#c98a8f}
.dl-sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#c98a8f;transition:left .12s}
.dl-sw.on{background:#173a2a;border-color:#2f7a52}
.dl-sw.on::after{content:"ON";left:6px;color:#6fd39b}
.dl-sw.on i{left:26px;background:#6fd39b}
#dl-min{cursor:pointer;color:#6c7e91;padding:0 3px;font-size:13px}
#dl-min:hover{color:#d6dde6}
#dl-body{padding:8px 9px 9px}
#dl-status{padding:6px 8px;border-radius:5px;margin-bottom:6px;font-weight:600;font-size:11px;background:#1d242c;color:#8fa3b8}
#dl-status.ok{background:#14301f;color:#7fe0a8}
#dl-status.hold{background:#3a2e14;color:#f0c46a}
#dl-status.err{background:#3d1a1d;color:#ff8f95}
.dl-alert{display:flex;gap:6px;align-items:flex-start;padding:5px 7px;margin-bottom:6px;border-radius:5px;background:#3a2e14;color:#f0c46a;font-size:11px;font-weight:600}
.dl-alert.sus{background:#4a1518;color:#ffb3b6;border:1px solid #e5383b}
.dl-alert span{flex:1}.dl-alert b{cursor:pointer;padding:0 3px}
.dl-tabs{display:flex;gap:2px;margin:2px 0 8px;border-bottom:1px solid #2b3540}
.dl-tab{position:relative;flex:1;background:none;border:0;border-bottom:2px solid transparent;color:#6c7e91;cursor:pointer;padding:5px 0 6px;font-size:10px;font-weight:700;letter-spacing:.08em}
.dl-tab:hover{color:#b9c6d4}
.dl-tab.on{color:#e8a87c;border-bottom-color:#e8a87c}
.dl-tab .dot{position:absolute;top:4px;margin-left:3px;width:6px;height:6px;border-radius:50%;background:#f0b43c}
.dl-tab .dot.red{background:#e5383b}
.dl-pane{display:none}.dl-pane.on{display:block}
.dl-grid{display:grid;grid-template-columns:30px 1fr 56px 56px;gap:3px 6px;align-items:center;margin-bottom:6px}
.dl-grid .h{font-size:9px;color:#5f7286;letter-spacing:.08em}
.dl-side{font-weight:700;font-size:10px;text-align:center;border-radius:3px;padding:1px 0}
.dl-ct{background:#1c3550;color:#7db4e6}.dl-t{background:#4a2b22;color:#eb9a7a}
.dl-num{text-align:center;font-variant-numeric:tabular-nums}
.dl-bad{color:#ff8f95;font-weight:700}
.dl-good{color:#6fd39b}
.dl-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-meta{display:flex;justify-content:space-between;gap:6px;color:#7b8ea3;font-size:11px;margin-bottom:5px}
.dl-meta span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-meta span:last-child{flex:none}
.dl-sec{font-size:9px;letter-spacing:.1em;color:#5f7286;margin:8px 0 4px}
.dl-sec:first-child{margin-top:2px}
.dl-sec em{font-style:normal;color:#45556a;letter-spacing:0;margin-left:4px}
.dl-map{display:flex;gap:6px;align-items:center;margin-bottom:3px}
.dl-map span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-map select{background:#1d242c;color:#d6dde6;border:1px solid #2b3540;border-radius:3px;font:inherit;font-size:11px;max-width:150px}
.dl-note{color:#7b8ea3;font-size:11px}
.dl-opt{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-radius:5px;padding:5px 6px;cursor:pointer;color:inherit}
.dl-opt:hover,.dl-opt:focus-visible{background:#1b222a;outline:none}
.dl-opt .tx{flex:1;min-width:0}
.dl-opt .lb{display:block;font-size:11.5px;font-weight:600;color:#c9d4df}
.dl-opt .ds{display:block;font-size:10px;color:#6c7e91;line-height:1.3}
.dl-opt.off .lb{color:#7b8a99}
.dl-mini{position:relative;width:28px;height:16px;border-radius:8px;background:#2a3038;border:1px solid #3a4450;flex:none;transition:background .12s}
.dl-mini i{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#6c7e91;transition:left .12s}
.dl-opt.on .dl-mini{background:#173a2a;border-color:#2f7a52}
.dl-opt.on .dl-mini i{left:14px;background:#6fd39b}
.dl-filters{display:flex;gap:4px;margin-bottom:5px}
.dl-chip{padding:2px 8px;border-radius:10px;border:1px solid #2b3540;background:none;color:#5f7286;cursor:pointer;font-size:10px}
.dl-chip.on{border-color:#2f7a52;color:#7fe0a8;background:#14261c}
#dl-log{max-height:230px;overflow:auto;background:#0f1318;border:1px solid #222b34;border-radius:5px;padding:4px 6px;font-size:10.5px}
#dl-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dl-log .death{color:#eb9a7a}#dl-log .start{color:#7fe0a8}#dl-log .bomb{color:#f0c46a}
#dl-log .result{color:#9cc4ff}#dl-log .hold,#dl-log .warn{color:#c9a75a}#dl-log .error{color:#ff8f95}
#dl-log .confirm{color:#b4a0f0}#dl-log .pm{color:#7ad0d6}
.dl-btns{display:flex;gap:6px;margin-top:7px}
.dl-test{background:#1d242c;color:#f0c46a;border:1px solid #5a4a22;border-radius:4px;font-size:10px;cursor:pointer;padding:3px 9px}
.dl-test:hover{border-color:#f0c46a}
.dl-src{font-size:11px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-src b{color:#7ad0d6;font-weight:600}.dl-src a{color:#9cc4ff;text-decoration:none}.dl-src a:hover{text-decoration:underline}
.dl-link{display:flex;gap:4px}
.dl-link input{flex:1;min-width:0;background:#1d242c;color:#d6dde6;border:1px solid #2b3540;border-radius:3px;font:inherit;font-size:11px;padding:2px 5px;user-select:text}
.dl-link button{background:#1d242c;color:#7ad0d6;border:1px solid #2b3540;border-radius:3px;font-size:11px;cursor:pointer;padding:1px 7px}
.dl-link button:hover{border-color:#7ad0d6}
`;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    // Tabs: Live is what is watched during a match; Setup is used once per
    // match; Options and Log are occasional. The status line and the alerts
    // sit above the tabs, so they are visible whichever tab is open.
    const TABS = [['live', 'LIVE'], ['setup', 'SETUP'], ['options', 'OPTIONS'], ['log', 'LOG']];
    const UI = { tab: 'live', logFilter: 'all', logSeen: 0 };

    function buildPanel() {
        if (root || !document.body) return;
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        UI.tab = GM_getValue('onak:tab', 'live');
        if (!TABS.some(([k]) => k === UI.tab)) UI.tab = 'live';
        UI.logFilter = GM_getValue('onak:logf', 'all');

        root = el('div');
        root.id = 'do-root';
        const pos = GM_getValue('onak:pos', null) || { x: 12, y: 80 };
        root.style.left = Math.min(pos.x, innerWidth - 120) + 'px';
        root.style.top = Math.min(pos.y, innerHeight - 40) + 'px';
        if (GM_getValue('onak:min', false)) root.classList.add('min');
        L.onMap = onMapPage();
        if (!L.onMap) root.style.display = 'none';

        const head = el('div'); head.id = 'dl-head';
        const title = el('div'); title.id = 'dl-title';
        title.append('DIBU ', el('b', '', 'ONAK'));
        if (ENV.test) {
            const badge = el('span', 'dl-env', 'TEST');
            badge.title = 'raiden-test.oddin.dev';
            title.append(' ', badge);
        }
        // At-a-glance state, also what stays visible when minimised.
        const pill = el('div', 'dl-pill');
        pill.append(el('i'), el('span', '', 'OFF'));
        const sw = el('div', 'dl-sw'); sw.appendChild(el('i'));
        sw.title = 'Switch on / off (Alt+L)';
        sw.addEventListener('click', e => { e.stopPropagation(); setArmed(!L.armed); });
        const min = el('div', '', root.classList.contains('min') ? '▸' : '▾'); min.id = 'dl-min';
        min.title = 'Minimise / expand';
        min.addEventListener('click', e => {
            e.stopPropagation();
            root.classList.toggle('min');
            min.textContent = root.classList.contains('min') ? '▸' : '▾';
            GM_setValue('onak:min', root.classList.contains('min'));
        });
        head.append(title, pill, sw, min);

        const body = el('div'); body.id = 'dl-body';
        const top = el('div', 'dl-top');
        const tabs = el('div', 'dl-tabs');
        TABS.forEach(([k, label]) => {
            const b = el('button', 'dl-tab' + (UI.tab === k ? ' on' : ''), label);
            b.dataset.tab = k;
            b.addEventListener('click', () => setTab(k));
            tabs.appendChild(b);
        });
        const panes = {};
        TABS.forEach(([k]) => {
            panes[k] = el('div', 'dl-pane' + (UI.tab === k ? ' on' : ''));
            panes[k].dataset.pane = k;
        });
        body.append(top, tabs, ...TABS.map(([k]) => panes[k]));
        root.append(head, body);
        document.body.appendChild(root);

        // drag by the header (not by its controls)
        head.addEventListener('mousedown', e => {
            if (e.target.closest('.dl-sw') || e.target.id === 'dl-min') return;
            const sx = e.clientX, sy = e.clientY, ox = root.offsetLeft, oy = root.offsetTop;
            const mv = ev => {
                root.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
                root.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
            };
            const up = () => {
                removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
                GM_setValue('onak:pos', { x: root.offsetLeft, y: root.offsetTop });
            };
            addEventListener('mousemove', mv); addEventListener('mouseup', up);
        });

        addEventListener('keydown', e => {
            if (e.altKey && (e.key === 'l' || e.key === 'L') && L.onMap) { e.preventDefault(); setArmed(!L.armed); }
        });

        setInterval(() => { if (dirty) { dirty = false; render(); } }, 300);
        render();
    }

    function setTab(k) {
        UI.tab = k;
        GM_setValue('onak:tab', k);
        root.querySelectorAll('.dl-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
        root.querySelectorAll('.dl-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === k));
        if (k === 'log') UI.logSeen = L.log.length;
        dirty = true;
    }

    // The panel is rebuilt in sections. The live numbers repaint on every
    // pass, but the pairing selects, the link box and the option rows are only
    // rebuilt when what they show changes: rebuilding a <select> or an <input>
    // while it is in use closes it under the cursor (the 1.1.0 pairing bug).
    const sec = {};
    function section(parent, name) {
        if (!sec[name] || sec[name].parentNode !== parent) {
            sec[name] = el('div');
            sec[name].dataset.sec = name;
            parent.appendChild(sec[name]);
            sec[name]._sig = null;
        }
        return sec[name];
    }
    function rebuildIf(box, sig, build) {
        if (box._sig === sig) return;
        const a = document.activeElement;
        if (a && box.contains(a) && (a.tagName === 'SELECT' || a.tagName === 'INPUT')) return;   // user is in it
        box._sig = sig;
        box.textContent = '';
        build(box);
    }

    // Options, grouped. Each row is its own switch; the ON/OFF in the header
    // is the only master switch.
    const OPTION_GROUPS = [
        ['INPUTS', 'what Onak writes in Raiden', [
            ['start', 'Start round', 'Starts the round when bb goes live'],
            ['deaths', 'Deaths', 'Marks each side\u2019s deaths'],
            ['bomb', 'Bomb', 'Plants the bomb'],
            ['result', 'Round end', 'Closes the round with its type'],
            ['confirm', 'Confirm score', 'Confirms the point Onak just set'],
        ]],
        ['SOURCES', '', [
            ['pm', 'Polymarket score', 'Closes the round as soon as Polymarket scores it'],
        ]],
        ['SAFETY', '', [
            ['suspend', 'Auto-suspend', 'Suspends on wrong map, sides or score; never reopens'],
        ]],
    ];
    const TEST_GROUP = ['TEST', 'raiden-test only', [
        ['relaxed', 'Follow bb without matching score', 'A test map follows a live match round by round'],
        ['checks', 'Check map & sides', 'Still suspends on wrong map or sides in test'],
    ]];
    const LOG_KINDS = {
        actions: ['death', 'start', 'bomb', 'result', 'confirm', 'pm'],
        alerts: ['error', 'warn', 'hold'],
    };

    function render() {
        if (!root) return;
        root.querySelector('.dl-sw').classList.toggle('on', L.armed);
        const now = Date.now();
        const res = L.last || { hold: 'OFF', info: [], warn: [], actions: [] };
        const bb = L.bb, rd = L.rd;
        const route = currentRoute();
        const rt = L.routes[route.matchId];
        const alertCount = Object.keys(L.alerts).length;
        const top = root.querySelector('.dl-top');
        const pane = k => root.querySelector(`.dl-pane[data-pane="${k}"]`);

        // ---- header pill
        const pill = root.querySelector('.dl-pill');
        let pk = '', pt = 'OFF';
        if (L.armed) {
            if (L.error || alertCount) { pk = 'alert'; pt = L.error ? 'ERROR' : (alertCount > 1 ? `${alertCount} ALERTS` : 'ALERT'); }
            else if (res.hold) { pk = 'hold'; pt = 'HOLD'; }
            else { pk = 'ok'; pt = 'ACTIVE'; }
        }
        pill.className = 'dl-pill' + (pk ? ' ' + pk : '');
        pill.lastChild.textContent = pt;
        pill.title = root.classList.contains('min') ? (res.hold || res.info[0] || '') : '';

        // ---- status line
        const status = section(top, 'status');
        status.id = 'dl-status';
        status.className = '';
        if (!L.armed) status.textContent = 'OFF — sending nothing';
        else if (L.error) { status.className = 'err'; status.textContent = 'ERROR · ' + L.error; }
        else if (res.hold) {
            status.className = 'hold';
            status.textContent = 'HOLD · ' + res.hold + (OPTS.pm && L.pm ? ' · Polymarket still closes rounds' : '');
        }
        else { status.className = 'ok'; status.textContent = 'ACTIVE · ' + (res.info[0] || 'in sync'); }

        // ---- alerts (persist until fixed; events until dismissed)
        const alBox = section(top, 'alerts');
        const alSig = JSON.stringify(Object.entries(L.alerts).map(([k, a]) => [k, a.msg]));
        rebuildIf(alBox, alSig, box => {
            for (const [k, a] of Object.entries(L.alerts)) {
                const row = el('div', 'dl-alert' + (a.level === 'suspend' ? ' sus' : ''));
                row.appendChild(el('span', '', (a.level === 'suspend' ? '⚠ SUSPENDED · ' : '⚠ ') + a.msg));
                if (a.sticky) {
                    const x = el('b', '', '×');
                    x.title = 'Dismiss';
                    x.addEventListener('click', () => dismissAlert(k));
                    row.appendChild(x);
                }
                box.appendChild(row);
            }
        });

        // ---- tab dots
        const relaxedNow = ENV.test && OPTS.relaxed;
        const unpaired = !relaxedNow && bb && bb.teams && bb.teams.length === 2 && !mappingFor(bb, route);
        const noPm = OPTS.pm && !getPmLink() && !(L.pm && L.pm.map);
        if (UI.tab === 'log') UI.logSeen = L.log.length;
        const unseen = L.log.slice(UI.logSeen).some(l => LOG_KINDS.alerts.indexOf(l.kind) >= 0);
        root.querySelectorAll('.dl-tab').forEach(b => {
            let dot = b.querySelector('.dot');
            const want = b.dataset.tab === 'setup' ? (unpaired ? 'red' : (noPm ? 'amber' : ''))
                : b.dataset.tab === 'log' ? (unseen ? 'red' : '') : '';
            if (!want) { if (dot) dot.remove(); return; }
            if (!dot) { dot = el('span', 'dot'); b.appendChild(dot); }
            dot.className = 'dot' + (want === 'red' ? ' red' : '');
            dot.title = b.dataset.tab === 'setup' ? (unpaired ? 'teams not paired' : 'no Polymarket source') : 'new warnings in the log';
        });

        // ================= LIVE =================
        const live = pane('live');
        const grid = section(live, 'grid');
        grid.className = 'dl-grid';
        grid.textContent = '';
        ['', 'team', 'alive R/bb', 'score R/bb'].forEach(h => grid.appendChild(el('div', 'h', h)));
        const bbBySide = {};
        if (bb && bb.teams) bb.teams.forEach(t => { if (t.side) bbBySide[t.side] = t; });
        [['CT', 'LIGHT', 'dl-ct'], ['T', 'DARK', 'dl-t']].forEach(([s, rs, cls]) => {
            const r = rd ? (rs === 'LIGHT' ? rd.light : rd.dark) : null;
            const b = bbBySide[s];
            let rName = '';
            if (rd && rt) rName = ((rs === 'DARK') === rd.homeIsDark ? rt.home : rt.away).name;
            grid.appendChild(el('div', 'dl-side ' + cls, s));
            const nm = el('div', 'dl-name', rName || (b ? b.name : '—'));
            nm.title = `Raiden: ${rName || '?'} · bb: ${b ? b.name : '?'}`;
            grid.appendChild(nm);
            const alive = el('div', 'dl-num', `${r ? r.alive : '·'}/${b ? b.alive : '·'}`);
            if (r && b && r.alive !== b.alive) alive.classList.add('dl-bad');
            const score = el('div', 'dl-num', `${r ? r.score : '·'}/${b ? b.rounds : '·'}`);
            if (r && b && r.score !== b.rounds && !relaxedNow) score.classList.add('dl-bad');
            grid.append(alive, score);
        });

        const meta = section(live, 'meta');
        meta.textContent = '';
        const line = (left, right, rightCls) => {
            const m = el('div', 'dl-meta');
            m.appendChild(el('span', '', left));
            const r = el('span', rightCls || '', right || '');
            m.appendChild(r);
            meta.appendChild(m);
            return m;
        };
        line(rd ? `Raiden R${rd.round} · ${rd.roundTime}s${rd.running ? ' ▶' : ' ■'}${rd.bomb === 'PLANTED' ? ' 💣' : ''}` : 'Raiden —',
            rt ? '' : (L.routeWhy ? 'teams unavailable' : 'teams loading…'));
        if (bb && bb.teams && bb.teams.length) {
            const quiet = bb.lastUpdate ? Math.round((now - bb.lastUpdate) / 1000) : null;
            line(`bb map ${bb.mapNum || '?'} · R${bbRoundOf(bb)} · ${bb.phase || '—'}` + (L.bbOpen > 1 ? ` · ${L.bbOpen} bb tabs` : ''),
                `${bb.latency ? bb.latency.toFixed(1) + 's' : ''}${quiet !== null && quiet >= 5 ? ` · quiet ${quiet}s` : ''}`);
        } else line('bb —', '');
        // Map check, always on screen: Raiden's prematch name for the map open
        // here vs betboom's live map, so a later override can be eyeballed.
        const pre = L.prematch[route.matchId];
        const rdName = pre && route.mapId && pre.maps[route.mapId] ? pre.maps[route.mapId].name : null;
        const rdOrder = pre && route.mapId && pre.maps[route.mapId] ? pre.maps[route.mapId].order : null;
        const bbName = bb && bb.mapName ? bb.mapName : null;
        let mapMark = pre ? '' : 'reading…', mapCls = '';
        if (rdName && bbName) {
            const ok = mapNameKey(rdName) === mapNameKey(bbName) && (!rdOrder || !bb.mapNum || rdOrder === bb.mapNum);
            mapMark = ok ? '✓' : '✗ mismatch'; mapCls = ok ? 'dl-good' : 'dl-bad';
        }
        line(`map ${rdOrder || '?'} · Raiden ${rdName || '?'} · bb ${bbName ? (bb.mapNum ? bb.mapNum + ' ' : '') + bbName : '?'}`, mapMark, mapCls);
        if (!OPTS.pm) line('Polymarket off', '');
        else if (L.pm && L.pm.map) {
            const age = Math.round((now - L.pmAt) / 1000);
            line(`PM map ${L.pm.map.seq} · ${L.pm.map.teams.map(t => `${t.name} ${t.score}`).join(' – ')}`, `${age}s`, age > 5 ? 'dl-bad' : '');
        } else line('Polymarket —', '');

        const warn = section(live, 'warn');
        warn.textContent = '';
        if (res.warn && res.warn.length && L.armed) {
            warn.appendChild(el('div', 'dl-sec', 'WARNINGS'));
            res.warn.forEach(w => warn.appendChild(el('div', 'dl-bad', w)));
        }

        // ================= SETUP =================
        const setup = pane('setup');
        const pair = section(setup, 'pair');
        const key = bb ? mapKey(bb, route) : '';
        const manual = (bb && GM_getValue(key, null)) || {};
        const auto = (bb && autoMap(bb.teams, rt)) || {};
        const pairSig = JSON.stringify([relaxedNow, key, bb && bb.teams && bb.teams.map(t => [t.id, t.name]),
            rt && [rt.home.name, rt.away.name], manual, auto]);
        rebuildIf(pair, pairSig, box => {
            if (relaxedNow) {
                box.appendChild(el('div', 'dl-sec', 'PAIRING'));
                box.appendChild(el('div', 'dl-note', 'Test mode: inputs go by side only (CT→LIGHT, T→DARK).'));
                return;
            }
            box.appendChild(el('div', 'dl-sec', 'PAIRING bb → RAIDEN'));
            if (!bb || !bb.teams || bb.teams.length !== 2) {
                box.appendChild(el('div', 'dl-note', 'Waiting for the Dibu tab…'));
                return;
            }
            bb.teams.forEach(t => {
                const row = el('div', 'dl-map');
                row.appendChild(el('span', '', t.name));
                const sel = document.createElement('select');
                const optA = el('option', '', `auto${auto[t.id] && rt ? ' → ' + rt[auto[t.id]].name : ' (no match)'}`);
                optA.value = '';
                sel.appendChild(optA);
                ['home', 'away'].forEach(r => {
                    const o = el('option', '', rt ? rt[r].name : r);
                    o.value = r;
                    sel.appendChild(o);
                });
                sel.value = manual[t.id] || '';
                sel.addEventListener('change', () => {
                    const cur = GM_getValue(key, null) || {};
                    if (sel.value) {
                        cur[t.id] = sel.value;
                        // Picking one side fixes the other: two teams cannot
                        // share a role, so set the counterpart explicitly.
                        const other = bb.teams.find(x => x.id !== t.id);
                        if (other) cur[other.id] = sel.value === 'home' ? 'away' : 'home';
                        GM_setValue(key, cur);
                    } else GM_setValue(key, null);
                    sel.blur();
                    dirty = true; tick();
                });
                row.appendChild(sel);
                box.appendChild(row);
            });
        });

        const pmBox = section(setup, 'pmsrc');
        const link = getPmLink();
        const via = L.pm ? L.pm.via : null;
        const pmSig = JSON.stringify([OPTS.pm, link, via, L.pm && L.pm.slug, L.pm && L.pm.title, PMD.err, PMD.title]);
        rebuildIf(pmBox, pmSig, box => {
            box.appendChild(el('div', 'dl-sec', 'POLYMARKET SOURCE'));
            if (!OPTS.pm) { box.appendChild(el('div', 'dl-note', 'Polymarket score is off (Options).')); return; }
            const src = el('div', 'dl-src');
            if (link) {
                src.append(el('b', '', 'link'), ' · ');
                const a = el('a', '', PMD.title || link.slug);
                a.href = link.url.startsWith('http') ? link.url : `https://polymarket.com/event/${link.slug}`;
                a.target = '_blank'; a.rel = 'noopener';
                a.title = link.slug;
                src.appendChild(a);
                if (PMD.err) src.append(' · ', el('span', 'dl-bad', PMD.err));
            } else if (L.pm && L.pm.slug) {
                src.append(el('b', '', 'open tab'), ' · ');
                const a = el('a', '', L.pm.title || L.pm.slug);
                a.href = `https://polymarket.com/event/${L.pm.slug}`;
                a.target = '_blank'; a.rel = 'noopener';
                a.title = L.pm.slug + ' — set a link to pin this match';
                src.appendChild(a);
            } else {
                src.textContent = 'none — paste the event link below';
            }
            box.appendChild(src);
            const row = el('div', 'dl-link');
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = 'polymarket.com/…/event link';
            inp.value = link ? link.url : '';
            const save = el('button', '', link ? 'Save' : 'Set');
            save.addEventListener('click', () => { setPmLink(inp.value); inp.blur(); });
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { setPmLink(inp.value); inp.blur(); } });
            row.append(inp, save);
            if (link) {
                const clr = el('button', '', '×');
                clr.title = 'Clear the link (use an open Polymarket tab instead)';
                clr.addEventListener('click', () => setPmLink(''));
                row.appendChild(clr);
            }
            box.appendChild(row);
        });

        // ================= OPTIONS =================
        const opts = section(pane('options'), 'opts');
        rebuildIf(opts, JSON.stringify(OPTS), box => {
            OPTION_GROUPS.concat(ENV.test ? [TEST_GROUP] : []).forEach(([name, hint, rows]) => {
                const h = el('div', 'dl-sec', name);
                if (hint) h.appendChild(el('em', '', '— ' + hint));
                box.appendChild(h);
                rows.forEach(([k, label, desc]) => {
                    const on = !!OPTS[k];
                    const b = el('button', 'dl-opt ' + (on ? 'on' : 'off'));
                    b.setAttribute('role', 'switch');
                    b.setAttribute('aria-checked', String(on));
                    const tx = el('span', 'tx');
                    tx.append(el('span', 'lb', label), el('span', 'ds', desc));
                    const sw = el('span', 'dl-mini'); sw.appendChild(el('i'));
                    b.append(tx, sw);
                    b.addEventListener('click', () => {
                        OPTS[k] = !OPTS[k];
                        GM_setValue('onak:opts', OPTS);
                        dirty = true; tick();
                    });
                    box.appendChild(b);
                });
            });
        });

        // ================= LOG =================
        const logPane = pane('log');
        const filt = section(logPane, 'logfilt');
        rebuildIf(filt, UI.logFilter, box => {
            const wrap = el('div', 'dl-filters');
            [['all', 'all'], ['actions', 'actions'], ['alerts', 'alerts']].forEach(([k, label]) => {
                const c = el('button', 'dl-chip' + (UI.logFilter === k ? ' on' : ''), label);
                c.addEventListener('click', () => { UI.logFilter = k; GM_setValue('onak:logf', k); dirty = true; });
                wrap.appendChild(c);
            });
            box.appendChild(wrap);
        });
        const logBox = section(logPane, 'log');
        const last = L.log.length ? L.log[L.log.length - 1] : null;
        rebuildIf(logBox, UI.logFilter + '|' + L.log.length + (last ? last.t.getTime() + last.msg : ''), box => {
            const log = el('div'); log.id = 'dl-log';
            const keep = UI.logFilter === 'all' ? null : LOG_KINDS[UI.logFilter];
            const rows = L.log.filter(l => !keep || keep.indexOf(l.kind) >= 0).slice(-80).reverse();
            if (!rows.length) log.appendChild(el('div', '', 'nothing yet'));
            rows.forEach(l => log.appendChild(el('div', l.kind, `${l.t.toTimeString().slice(0, 8)}  ${l.msg}`)));
            box.appendChild(log);
        });
        const btns = section(logPane, 'logbtns');
        rebuildIf(btns, 'static', box => {
            const wrap = el('div', 'dl-btns');
            const tb = el('button', 'dl-test', 'test alert');
            tb.title = 'Sound + Windows notification + tab mark, without suspending anything';
            tb.addEventListener('click', testAlert);
            const xb = el('button', 'dl-test', 'export JSON');
            xb.title = 'Download the log, the decision trace and the current state';
            xb.addEventListener('click', exportJson);
            wrap.append(tb, xb);
            box.appendChild(wrap);
        });
    }
})();
