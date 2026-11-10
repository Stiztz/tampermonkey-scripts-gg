// ==UserScript==
// @name         DibuPoly
// @namespace    DibuVerse
// @version      0.10.2
// @description  Polymarket scraper
// @author       Dibujito
// @icon         https://www.google.com/s2/favicons?sz=64&domain=polymarket.com
// @match        *://polymarket.com/*
// @match        *://*.polymarket.com/*
// @connect      gamma-api.polymarket.com
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/*
  Runs on polymarket.com esports event pages only. It reads what the page itself loads
  (series-state, gamma, the GRID widget sockets, the CLOB order book) and shows it as a HUD:
  real-time score and Polymarket odds, the delayed GRID widgets, and the map veto.
*/

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // Polymarket's GRID widgets live in iframes (/grid/1/widget.html?type=series-livelog...)
  // and it is THOSE frames that open the GRID sockets; the main page cannot reach GRID
  // (its own sockets never open). Inside such a frame this script only listens to the
  // frame's GRID sockets and forwards every message to the main page.
  if (W.top !== W.self) {
    if (/polymarket\.com$/.test(location.host) && /^\/grid\//.test(location.pathname)) {
      console.log('[PM-ESPORTS] widget-frame relay active in', location.href);
      try { W.top.postMessage({ tag: 'pm-grid-relay:v1', hello: location.href }, '*'); } catch (err) {}
      const FrameWS = W.WebSocket;
      const Relay = function (url, protocols) {
        const ws = protocols === undefined ? new FrameWS(url) : new FrameWS(url, protocols);
        if (/api\.grid\.gg\/widgets/.test(String(url))) {
          console.log('[PM-ESPORTS] widget frame opened a GRID socket:', String(url));
          ws.addEventListener('message', (e) => {
            const send = (data) => { try { W.top.postMessage({ tag: 'pm-grid-relay:v1', url: String(url), data }, '*'); } catch (err) {} };
            if (typeof e.data === 'string') send(e.data); else if (e.data && typeof e.data.text === 'function') e.data.text().then(send);
          });
        }
        return ws;
      };
      Relay.prototype = FrameWS.prototype; ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { Relay[k] = FrameWS[k]; });
      W.WebSocket = Relay;
    }
    return;
  }
  const TAG = '[PM-ESPORTS]';
  const HOST = location.host;
  if (!/polymarket\.com$/.test(HOST)) return;

  const now = () => Date.now();
  const fmtT = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const NativeWS = W.WebSocket, nativeFetch = W.fetch.bind(W);

  // ================================================================ shared: market normalisation
  // Returns {key,label} so the same market from different books lands in the same table.
  function normMarket(name, extra) {
    const raw = (name || ''); let n = raw.toLowerCase().replace(/\((incl\.?|including|incluy[^)]*|включая)[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); const x = (extra || '').toLowerCase(); const all = n + ' ' + x;
    const slug = (t) => t.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    let mn = null, m;
    // R6 calls its maps "games" ("Game 2 Winner"); same thing. A line like "O/U 2.5 games"
    // is not a game number, hence the no-digit-or-dot lookbehind.
    if ((m = /(?:map|mapa|карта|game)\s*(\d)(?:st|nd|rd|th)?\b/.exec(all))) mn = m[1];
    else if ((m = /(?<![\d.])(\d)(?:st|nd|rd|th|-?я|-?й)?\s*(?:map|mapa|карта|game)\b/.exec(all))) mn = m[1];
    const ctx = mn ? `map${mn}` : 'match', ctxLabel = mn ? `Map ${mn}` : 'Match';
    const other = () => ({ key: `${ctx}_${slug(n)}`, label: raw });
    // round-level / event-level props are never merged into match or map tables
    if (/round\s*(winner|\d)|\bround\s*\d|pistol|ronda\s*\d|раунд|first (kill|blood|tower|dragon|baron)|knife|ace\b|clutch/.test(all)) return other();
    if (/half|mitad|половин|correct (map )?score|marcador exacto|точный|winning margin|margen|odd|even|par\b|impar|^(will there be|habrá|будет)/.test(all)) return other();
    if (/team total|individual total|индивидуальный/.test(all)) return other();
    if (/handicap|hándicap|hápdicap|фора|spread|hcp/.test(all)) return { key: `${ctx}_handicap`, label: `${ctxLabel} handicap` };
    if (/total|тотал|o\/u|over|under|más de|menos de|больше|меньше/.test(all)) return { key: `${ctx}_total`, label: `${ctxLabel} total` };
    if (/^(ganador|winner|match winner|to win|победа|победитель|исход|moneyline|1x2|result|resultado|map winner)\b/.test(n) || /(^|[\s-])(winner|ganador|победитель|to win|match lines|lines)$/.test(n) || /to win.*(match lines|lines)/.test(n)) return { key: `${ctx}_winner`, label: `${ctxLabel} winner` };
    return other();
  }


  // ---------------------------------------------------------------- shared hooks
  function hookWS(urlTest, onMsg) {
    function Hooked(url, protocols) { const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols); if (urlTest(String(url))) ws.addEventListener('message', (e) => onMsg(e.data, String(url))); return ws; }
    Hooked.prototype = NativeWS.prototype; ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { Hooked[k] = NativeWS[k]; }); W.WebSocket = Hooked;
  }
  function hookFetch(urlTest, onJson) {
    const orig = W.fetch;
    W.fetch = async function (input, init) { const url = typeof input === 'string' ? input : (input && input.url) || ''; const res = await orig.apply(this, arguments); try { if (urlTest(url)) res.clone().json().then(j => onJson(j, url)).catch(() => {}); } catch {} return res; };
    const XO = W.XMLHttpRequest.prototype.open, XS = W.XMLHttpRequest.prototype.send;
    W.XMLHttpRequest.prototype.open = function (m, url) { this.__pm = String(url); return XO.apply(this, arguments); };
    W.XMLHttpRequest.prototype.send = function () { this.addEventListener('load', () => { try { if (urlTest(this.__pm) && (this.responseType === '' || this.responseType === 'text')) onJson(JSON.parse(this.responseText), this.__pm); } catch {} }); return XS.apply(this, arguments); };
  }

  // ================================================================ POLYMARKET MODE
  const LIVE_POLL_MS = 1000, MAX_FRAMES = 4000, MAX_STATE_SNAPSHOTS = 3000;
  const BIG_SERVICES = new Set(['series_table', 'series_comparison']);
  // Polymarket now opens three separate GRID sockets, the first two with delay=zero
  // (capture of 2 Nov). One combined socket without that parameter gets nothing
  // back, which is why 0.7.0 showed "error" and no veto. These mirror the page exactly.
  const GRID_SOCKETS = {
    main: 'delay=zero&events=series_scoreboard_v2,team_scoreboard&isCompressionEnabled=true',
    log: 'delay=zero&events=live_log&isCompressionEnabled=true',
    colors: 'events=team_colors&isCompressionEnabled=true',
  };
  const PREFS_KEY = 'pmr6_prefs';
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

  const S = {
    seriesId: null, slug: null, live: null, liveT: 0, liveChanges: [],
    scoreboard: null, teamsBoard: null, colors: {}, log: [], clock: null, delayedRound: null,
    frames: [], states: [], declaredDelay: null, delaySamples: [],
    gridOwn: null, gridStatus: 'idle', gridLastMsg: 0, gridFirstMsg: 0, gridRetryT: 0, veto: [], sockState: {}, pageLogSeen: 0,
    market: null, pmMarkets: [], clobWs: null, gamma: null, gammaT: 0, gammaLog: [], headlineKey: null,   // null: follow the map being played
    sounds: { live: true }, polling: true, pollTimer: null,
  };

  // ---------------------------------------------------------------- series-state (real time)
  function currentGame(json) { return (json.games || []).find(g => g.started && !g.finished) || (json.games || [])[json.games.length - 1]; }
  let actx; function tone(seq) { try { actx = actx || new (W.AudioContext || W.webkitAudioContext)(); let t0 = actx.currentTime; for (const [f, ms, type] of seq) { const o = actx.createOscillator(), g = actx.createGain(); o.type = type || 'sine'; o.frequency.value = f; g.gain.value = 0.09; o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + ms / 1000); t0 += ms / 1000; } } catch {} }
  const SFX = { roundEnd: () => tone([[880, 120], [660, 180]]), mapEnd: () => tone([[660, 120], [880, 120], [1100, 250]]) };
  function onSeriesState(json, via) {
    if (!json || !Array.isArray(json.teams)) return;
    const t = now(); S.states.push({ t, via, data: json }); if (S.states.length > MAX_STATE_SNAPSHOTS) S.states.shift();
    const prev = S.live; S.live = json; S.liveT = t; const game = currentGame(json); if (!game) return;
    if (prev) {
      const pg = (prev.games || []).find(g => g.sequenceNumber === game.sequenceNumber);
      const ps = pg ? pg.teams.map(x => x.score).join('-') : null, cs = game.teams.map(x => x.score).join('-');
      if (ps !== null && ps !== cs) { const winner = game.teams.find((x, i) => x.score > (pg.teams[i]?.score ?? 0)); pushLive(`ROUND ${game.teams.reduce((a, x) => a + x.score, 0)} END · map ${game.sequenceNumber} ${cs}${winner ? ' · ' + winner.name + ' wins' : ''}`, 'end'); if (S.sounds.live) SFX.roundEnd(); }
      if (pg && !pg.finished && game.finished) { pushLive(`MAP ${game.sequenceNumber} FINISHED ${cs}`, 'map'); if (S.sounds.live) SFX.mapEnd(); }
      const pser = prev.teams.map(x => x.score).join('-'), cser = json.teams.map(x => x.score).join('-'); if (pser !== cser) pushLive(`SERIES ${cser}`, 'map');
      if (!prev.finished && json.finished) pushLive('SERIES FINISHED', 'map');
      if (!prev.started && json.started) { pushLive('SERIES STARTED', 'map'); connectGrid(true); }
    } else pushLive(`connected · ${json.format} · ${json.started ? 'live' : 'not started'} · map ${game.sequenceNumber} ${game.teams.map(x => x.score).join('-')}`, 'info');
    render();
  }
  function pushLive(text, cls) { S.liveChanges.push({ t: now(), text, cls }); if (S.liveChanges.length > 80) S.liveChanges.shift(); }
  async function pollLive() { if (!S.polling || !S.seriesId) return; try { const r = await nativeFetch(`/api/esports/series-state?seriesId=${S.seriesId}`, { credentials: 'include' }); if (r.ok) onSeriesState(await r.json(), 'poll'); } catch {} }
  // The veto is kept per series in this site's storage: a reload or a late
  // opening shows it at once, and the live log only has to add what is new.
  const vetoKey = (id) => 'pm_veto_' + id;
  // A veto saved by 0.8.x may still hold R6 operator steps: filtered on the way in.
  function loadVeto(id) { try { const v = JSON.parse(localStorage.getItem(vetoKey(id)) || 'null'); if (Array.isArray(v) && v.length && !S.veto.length) S.veto = v.filter(x => x.action === 'side' || vetoIsMap(null, x.map)).map(x => ({ ...x, map: String(x.map || '').replace(/_v\d+/i, '').replace(/_mod$/i, '') })); } catch {} }
  function saveVeto() { if (!S.seriesId || !S.veto.length) return; try { localStorage.setItem(vetoKey(S.seriesId), JSON.stringify(S.veto)); } catch {} }
  function setSeries(id) {
    if (!id || S.seriesId === id) return;
    // Another series: whatever score is on screen belongs to the old one.
    S.seriesId = id; S.live = null; S.liveT = 0; S.veto = []; loadVeto(id);
    clearInterval(S.pollTimer); S.pollTimer = setInterval(pollLive, LIVE_POLL_MS); pollLive(); connectGrid();
  }
  // The page's own series-state calls. Right after navigating, the previous event's
  // component can still poll ITS series for a moment; once gamma has named this event's
  // series, states of any other series are ignored, or the old score would come back.
  hookFetch((u) => /\/api\/esports\/series-state/.test(u), (j, url) => {
    const m = /seriesId=(\d+)/.exec(url); const sid = m ? m[1] : null;
    if (sid && !acceptSeries(sid)) return;
    if (sid) setSeries(sid);
    onSeriesState(j, 'page');
  });
  // Which series ids may name this event's series. Once gamma has said which it is, only
  // that one; before that, anything but the series of the event just left. The hidden
  // widget frames and the page's own components of the previous match keep relaying its
  // live log for a while after a switch, and up to 0.9.0 the first relayed message set
  // the series straight back to the old one: old veto, old score (9 Nov).
  function acceptSeries(sid) { if (!sid) return false; if (S.seriesId) return sid === S.seriesId; return sid !== S.prevSeriesId; }

  // ---------------------------------------------------------------- Polymarket markets (gamma + CLOB)
  // gamma says what each market is in sportsMarketType (event of 8 Nov, R6 FaZe-Falcons:
  // moneyline = match winner, child_moneyline = one map's winner, totals, map_handicap).
  // Up to 0.8.2 only the title was read, and "Game 1 Winner", "Game 2 Winner" and the match
  // market all normalised to match_winner: three "Match winner" buttons, the finished map 1
  // (0.1% / 99.9%) shown as the match price. The title is still the fallback.
  function pmNorm(m, count) {
    const title = String(m.groupItemTitle || m.question || ''); const kind = String(m.sportsMarketType || '');
    const num = /(?:map|game)\s*(\d)/i.exec(title); const unit = /game/i.test(title) ? 'Game' : 'Map';
    const line = m.line != null ? `:${m.line}` : '';
    if (kind === 'moneyline') return { key: 'match_winner', label: 'Match winner' };
    if (kind === 'child_moneyline' && num) return { key: `map${num[1]}_winner`, label: `${unit} ${num[1]} winner` };
    if (kind === 'totals') return { key: `${num ? 'map' + num[1] : 'match'}_total${line}`, label: `${num ? unit + ' ' + num[1] : 'Match'} total${m.line != null ? ` (${m.line})` : ''}` };
    if (/handicap|spread/.test(kind)) return { key: `${num ? 'map' + num[1] : 'match'}_handicap${line}`, label: `${num ? unit + ' ' + num[1] : 'Match'} handicap${m.line != null ? ` (${m.line})` : ''}` };
    if (count === 1) return { key: 'match_winner', label: 'Match winner' };
    return normMarket(title, '');
  }
  function slugFromUrl() { const parts = location.pathname.split('/').filter(Boolean); return parts.length ? parts[parts.length - 1] : null; }
  const pct = (p) => p == null ? '--' : (p * 100).toFixed(1) + '%';
  const dec = (p) => p == null || p <= 0 ? '--' : (1 / p).toFixed(2);
  // Decimal odds with a bookmaker's margin on top of the fair probability (half the margin
  // on each side), the way Raiden quotes: a 49% fair price reads 1.89, not 2.04.
  const MARGIN = 0.08;
  const decM = (p) => p == null || p <= 0 ? '--' : (1 / Math.min(0.99, p + MARGIN / 2)).toFixed(2);
  async function loadMarket() {
    const slug = slugFromUrl(); if (!slug || slug === S.slug) return; S.slug = slug;
    try {
      const r = await nativeFetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`); const arr = await r.json(); const ev = Array.isArray(arr) ? arr[0] : arr; if (!ev || !ev.markets) return;
      S.pmMarkets = ev.markets.map(m => { const outcomes = JSON.parse(m.outcomes || '[]'), tokens = JSON.parse(m.clobTokenIds || '[]'), op = JSON.parse(m.outcomePrices || '[]'); return { id: m.id, question: m.question, title: m.groupItemTitle || m.question, norm: pmNorm(m, ev.markets.length), outcomes, tokens, prices: tokens.map((_, i) => ({ bid: null, ask: null, mid: Number(op[i]) || null, last: Number(op[i]) || null, bookSeen: false, quoted: false })) }; });
      S.market = S.pmMarkets.find(m => m.norm.key === 'match_winner') || S.pmMarkets[0];
      const dup = S.pmMarkets.map(m => m.norm.key).filter((k, i, a) => a.indexOf(k) !== i);
      if (dup.length) console.warn(TAG, 'markets sharing a key (the last one wins in the board):', dup, S.pmMarkets.map(m => `${m.title} → ${m.norm.key}`));
      S.gammaEventId = ev.id; onGamma(ev);
      const gsid = ev.eventMetadata && ev.eventMetadata.gridSeriesId; if (gsid) setSeries(String(gsid)); else pushLive('no GRID series linked to this event (no series-state / widgets available)', 'info');
      connectClob();
    } catch (e) { console.warn(TAG, 'market load failed', e); }
  }
  // gamma event record: Polymarket's own score/live/period fields (updated server-side even when no widgets exist)
  function onGamma(ev) {
    if (!ev) return; const t = now(); const prev = S.gamma;
    const g = { score: ev.score || '', live: !!ev.live, ended: !!ev.ended, period: ev.period || '', gridSeriesId: ev.eventMetadata?.gridSeriesId || null, pandascoreMatchId: ev.eventMetadata?.pandascoreMatchId || null, league: ev.eventMetadata?.league || '', updatedAt: ev.updatedAt };
    S.gamma = g; S.gammaT = t;
    if (prev && (prev.score !== g.score || prev.live !== g.live || prev.ended !== g.ended || prev.period !== g.period)) { S.gammaLog.push({ t, ...g }); if (S.gammaLog.length > 300) S.gammaLog.shift(); pushLive(`GAMMA score ${g.score || '—'} · period ${g.period || '—'} · ${g.ended ? 'ended' : g.live ? 'live' : 'not live'}`, 'gamma'); if (!S.seriesId && prev.score !== g.score && S.sounds.live) SFX.roundEnd(); }
    if (!prev) S.gammaLog.push({ t, ...g });
  }
  async function pollGamma() { if (!S.slug) return; try { const r = await nativeFetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(S.slug)}`); const arr = await r.json(); const ev = Array.isArray(arr) ? arr[0] : arr; if (ev) { onGamma(ev); if (!S.seriesId && ev.eventMetadata?.gridSeriesId) setSeries(String(ev.eventMetadata.gridSeriesId)); render(); } } catch {} }
  setInterval(pollGamma, 5000);
  function connectClob() {
    if (!S.pmMarkets.length || S.clobWs) return;
    try {
      const ws = new NativeWS('wss://ws-subscriptions-clob.polymarket.com/ws/market'); S.clobWs = ws;
      const assets = S.pmMarkets.flatMap(m => m.tokens);
      ws.addEventListener('open', () => { ws.send(JSON.stringify({ assets_ids: assets, type: 'market' })); S.clobPing = setInterval(() => { try { ws.send('PING'); } catch {} }, 10000); });
      ws.addEventListener('message', (e) => { if (typeof e.data !== 'string' || e.data === 'PONG') return; let j; try { j = JSON.parse(e.data); } catch { return; } (Array.isArray(j) ? j : [j]).forEach(onClob); });
      ws.addEventListener('close', () => { clearInterval(S.clobPing); S.clobWs = null; setTimeout(connectClob, 5000); });
    } catch (e) { console.warn(TAG, 'clob ws', e); }
  }
  function findTok(asset) { for (const m of S.pmMarkets) { const i = m.tokens.indexOf(String(asset)); if (i >= 0) return { m, i }; } return null; }
  function onClob(msg) {
    if (!msg) return; let changed = false;
    // A book snapshot is the truth for both sides: an empty side clears what was there.
    // Up to 0.9.1 an empty book left the old bid/ask - or gamma's placeholder - in place.
    if (msg.event_type === 'book') { const f = findTok(msg.asset_id); if (!f) return; const bb = (msg.bids || []).reduce((a, x) => Math.max(a, +x.price), 0) || null; const ba = (msg.asks || []).length ? (msg.asks || []).reduce((a, x) => Math.min(a, +x.price), 1) : null; const p = f.m.prices[f.i]; p.bid = bb; p.ask = ba; p.bookSeen = true; changed = recomputeMids(f.m); }
    else if (msg.event_type === 'price_change') { for (const ch of msg.changes || msg.price_changes || []) { const f = findTok(ch.asset_id); if (!f) continue; const p = f.m.prices[f.i]; if (ch.best_bid != null) p.bid = +ch.best_bid > 0 ? +ch.best_bid : null; if (ch.best_ask != null) p.ask = +ch.best_ask > 0 && +ch.best_ask < 1 ? +ch.best_ask : null; p.bookSeen = true; changed = recomputeMids(f.m) || changed; } }
    else if (msg.event_type === 'last_trade_price') { const f = findTok(msg.asset_id); if (f) { f.m.prices[f.i].last = +msg.price; f.m.prices[f.i].lastT = now(); changed = recomputeMids(f.m) || true; } }
    if (changed) render();
  }
  // When is the middle of the book a price? Each outcome's bid/ask is its own or the complement
  // of the other outcome's (buying B at 0.85 is selling A at 0.15: it is one book). Then:
  //   tight  bid and ask at most SPREAD_MAX apart -> the mid is the price;
  //   wide   further apart -> NOT a price. When the market makers pull their quotes (a round
  //          being played, news) only far-off resting orders are left, e.g. bids at 15% on both
  //          outcomes, which is asks at 85% on both: the mid reads 50% and Polymarket's buttons,
  //          which show the ask, read 1.18 / 1.18 (Brest-regnum4games and FaZe-LOS, 9 Nov).
  //          Polymarket itself stops using the mid past a 10-cent spread; same threshold here.
  //   none   book seen and empty (paused market): "--".
  //   gamma  book not heard from yet: gamma's outcomePrices, labelled; on a paused market they
  //          read 0.5 / 0.5 (FaZe-Falcons map 2, 9 Nov).
  // A one-sided book counts as a price only at the extremes (a decided market: bid 99.9%).
  const SPREAD_MAX = 0.10;
  function recomputeMids(m) {
    const P = m.prices; let changed = false;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], o = P.length === 2 ? P[1 - i] : null; const old = `${p.mid}|${p.q}|${p.ebid}|${p.eask}`; let bid = p.bid, ask = p.ask;
      if (o) { if ((bid == null || bid <= 0) && o.ask != null && o.ask < 1) bid = 1 - o.ask; if ((ask == null || ask >= 1) && o.bid != null && o.bid > 0) ask = 1 - o.bid; }
      const hasBid = bid != null && bid > 0, hasAsk = ask != null && ask < 1;
      const seen = p.bookSeen || (o && o.bookSeen);
      let mid = null, q = 'none';
      if (hasBid && hasAsk) { if (ask - bid <= SPREAD_MAX + 1e-9) { mid = (bid + ask) / 2; q = 'tight'; } else q = 'wide'; }
      else if (hasBid) { if (bid >= 0.9) { mid = bid; q = 'tight'; } else q = 'wide'; }
      else if (hasAsk) { if (ask <= 0.1) { mid = ask; q = 'tight'; } else q = 'wide'; }
      else if (!seen && p.last != null) { mid = p.last; q = 'gamma'; }
      p.mid = mid; p.q = q; p.ebid = hasBid ? bid : null; p.eask = hasAsk ? ask : null; p.quoted = q === 'tight';
      if (old !== `${p.mid}|${p.q}|${p.ebid}|${p.eask}`) changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- GRID (delayed)
  function connectGrid(force) {
    if (!S.seriesId) return;
    if (!force && S.live && !S.live.started && now() - S.gridRetryT < 30000) return; // prematch: retry every 30s
    S.gridRetryT = now();
    S.gridOwn = S.gridOwn || {};
    for (const [k, qs] of Object.entries(GRID_SOCKETS)) {
      if (S.gridOwn[k]) continue;
      try {
        const ws = new NativeWS(`wss://api.grid.gg/widgets-v2/live/${S.seriesId}?${qs}`); S.gridOwn[k] = ws;
        if (S.gridStatus === 'idle' || /closed|error/.test(S.gridStatus)) S.gridStatus = 'connecting';
        ws.addEventListener('open', () => { if (!S.gridLastMsg) S.gridStatus = S.live && !S.live.started ? 'connected · waiting for match start' : 'connected (no data yet)'; render(); });
        S.sockState[k] = 'connecting';
        ws.addEventListener('open', () => { S.sockState[k] = 'open'; });
        ws.addEventListener('message', (e) => { S.sockState[k] = 'data'; if (!S.gridFirstMsg) S.gridFirstMsg = now(); S.gridLastMsg = now(); S.gridStatus = 'streaming'; if (typeof e.data === 'string') onGridMessage(e.data); else if (e.data instanceof Blob) e.data.text().then(onGridMessage); });
        ws.addEventListener('close', (ev) => {
          S.sockState[k] = `closed ${ev.code}`;
          if (!S.gridOwn || S.gridOwn[k] !== ws) return;
          delete S.gridOwn[k];
          if (!Object.keys(S.gridOwn).length) { S.gridOwn = null; S.gridStatus = `closed (${ev.code})` + (S.gridLastMsg ? '' : ' — no widgets for this series?'); }
          render(); setTimeout(() => connectGrid(false), S.gridLastMsg ? 5000 : 30000);
        });
        ws.addEventListener('error', () => { if (!S.gridLastMsg) S.gridStatus = 'error'; });
      } catch (e) { S.gridStatus = 'failed'; }
    }
  }
  async function gunzipB64(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const buf = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); return JSON.parse(new TextDecoder().decode(buf)); }
  async function onGridMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; } if (!msg || !msg.service) return;
    // GRID now sends its services as "integrity_safe_<name>" (integrity_safe_live_log, ...).
    // 0.6.0 matched the bare names only, so the live log and scoreboards stayed empty.
    msg.service = String(msg.service).replace(/^integrity_safe_/, '');
    if (msg.scope && msg.scope.id) { const sid = String(msg.scope.id); if (!acceptSeries(sid)) return; setSeries(sid); }
    if (typeof msg.delay === 'number' && msg.service !== 'team_colors') S.declaredDelay = msg.delay; // team colours declare 180s; not the data delay
    for (const item of msg.data || []) { let data = item; try { if (item && item.isCompressed && item.data) data = await gunzipB64(item.data); else if (item && typeof item.data === 'string') { try { data = JSON.parse(item.data); } catch { data = item; } } } catch { continue; } recordFrame(msg.service, msg.delay, data); try { handleService(msg.service, data); } catch (e) { console.warn(TAG, e); } }
    render();
  }
  function recordFrame(service, delay, data) { S.frames.push({ t: now(), service, delay, data }); if (BIG_SERVICES.has(service)) { const big = S.frames.filter(f => BIG_SERVICES.has(f.service)); if (big.length > 20) { const idx = S.frames.indexOf(big[0]); if (idx >= 0) S.frames.splice(idx, 1); } } if (S.frames.length > MAX_FRAMES) S.frames.shift(); }
  function addDelaySample(iso) { if (!S.gridFirstMsg || now() - S.gridFirstMsg < 15000) return; const o = Date.parse(iso); if (!o) return; const dl = (now() - o) / 1000; if (dl > 0 && dl < 3600) { S.delaySamples.push(dl); if (S.delaySamples.length > 20) S.delaySamples.shift(); } }
  // ---------------------------------------------------------------- VETO (from the live log)
  // Live-log entries are structured: [team chunk (color "teams.<id>", or "Series"), action
  // (banned / picked / picked_side), map ("Map [Cache]") or side ("Counter-Terrorists [Mirage]")].
  // The whole series backlog arrives on connect, so the veto shows up even if the socket opens late.
  function parseVeto(e) {
    const ch = e && e.sentenceChunks; if (!ch || ch.length < 3) return null;
    const key = (c) => (c && c.textTranslation && c.textTranslation.key) || '';
    const act = key(ch[1]) || String(ch[1].text || '').toLowerCase().replace(/\s+/g, '_');
    const team = String(ch[0].text || '').trim(); const series = key(ch[0]) === 'series' || /^series$/i.test(team);
    const teamId = (/teams\.(\d+)/.exec(ch[0].color || '') || [])[1] || null;
    // GRID's R6 map names carry an internal suffix (Border_v2_mod, Russiancafe_mod): dropped.
    const clean = (v) => String(v || '').replace(/^Map\s*/i, '').replace(/[\[\]]/g, '').replace(/_v\d+/i, '').replace(/_mod$/i, '').trim();
    if (act === 'banned' || act === 'picked') {
      const tt = ch[2].textTranslation, vars = tt && tt.variables;
      if (!vetoIsMap(tt, ch[2].text)) return null;
      const map = clean((vars && vars.map_name) || ch[2].text);
      return { id: e.id, ts: e.timestamp, team: series ? 'Series' : team, teamId, action: act === 'banned' ? 'ban' : (series ? 'decider' : 'pick'), map };
    }
    if (act === 'picked_side') {
      const m = /^(.*?)\s*\[(.+)\]\s*$/.exec(String(ch[2].text || '')); if (!m) return null;
      const raw = m[1].trim(); const side = /counter/i.test(raw) ? 'CT' : /^terror/i.test(raw) ? 'T' : /attack/i.test(raw) ? 'ATK' : /defen/i.test(raw) ? 'DEF' : raw;
      return { id: e.id, ts: e.timestamp, team, teamId, action: 'side', side, map: clean(m[2]) };
    }
    return null;
  }
  // R6 picks and bans operators every three rounds through the same live-log sentences as the
  // map veto, and that made the veto 138 steps long (FaZe-Falcons, 8 Nov), pushing the widgets
  // out of sight. GRID labels the third chunk: a map carries textTranslation.key "map_name"
  // (with the name in variables.map_name); an operator carries its own name as the key
  // ("azami", "glaz") and a default/unknown operator "default_0x679c49b955" - export of
  // 100T-ENTERPRISE, 9 Nov. So with a translation the key decides. Without one (older
  // entries, a saved veto), the text: an internal name with its _mod / _v2 suffix is a map,
  // anything entirely in capitals is an operator, the rest ("Inferno", "Dust2") a map.
  function vetoIsMap(tt, text) {
    if (tt && typeof tt === 'object' && tt.key) return tt.key === 'map_name';
    const t = String(text || '').replace(/^Map\s*/i, '').replace(/[\[\]]/g, '').trim();
    if (!t) return false;
    if (/^default[-_]0x/i.test(t)) return false;
    if (/_mod\b|_v\d/i.test(t)) return true;
    return !/^[A-Z0-9][A-Z0-9 .'-]*$/.test(t) || !/[A-Z]/.test(t);
  }
  // Maps in play order: team picks first (in veto order), then the decider(s). Sides attach by map name.
  function vetoMaps(steps) {
    const maps = [];
    for (const s of steps) if (s.action === 'pick') maps.push({ map: s.map, by: s.team, sides: [] });
    for (const s of steps) if (s.action === 'decider') maps.push({ map: s.map, by: 'decider', sides: [] });
    for (const s of steps) if (s.action === 'side') { const m = maps.find(x => x.map.toLowerCase() === s.map.toLowerCase()); if (m) m.sides.push({ team: s.team, side: s.side }); }
    return maps.map((m, i) => ({ seq: i + 1, ...m }));
  }

  function handleService(service, d) {
    const t = now();
    if (service === 'series_scoreboard_v2') { S.scoreboard = { ...d, t }; const g = (d.games || [])[d.activeGameIndex || 0]; if (g && g.gameClock) { S.clock = { seconds: g.gameClock.currentSeconds, ticking: !!g.gameClock.isTicking, backwards: !!g.gameClock.tickingBackwards, recvT: t }; if (g.gameClock.occurredAt) addDelaySample(g.gameClock.occurredAt); } if (g && Array.isArray(g.momentum)) { const act = g.momentum.find(m => m.active && /^\d+$/.test(m.contentText || '')); if (act) S.delayedRound = +act.contentText; } }
    else if (service === 'team_scoreboard') S.teamsBoard = { ...d, t };
    else if (service === 'team_colors') { for (const tm of d.teams || []) S.colors[tm.id] = tm; }
    else if (service === 'live_log') {
      const entries = d.type === 'addEntry' && d.body?.entryToAdd ? [d.body.entryToAdd] : (d.entries || d.body?.entries || []); const fresh = d.type === 'addEntry';
      let vetoNew = false;
      for (const e of entries) { const v = parseVeto(e); if (v && !S.veto.some(x => x.id === v.id)) { S.veto.push(v); vetoNew = true; } }
      if (vetoNew) { S.veto.sort((a, b) => (a.ts || '').localeCompare(b.ts || '')); saveVeto(); }
      for (const e of entries) { if (S.log.some(x => x.id === e.id)) continue; const text = (e.sentenceChunks || []).map(c => c.text).join(' '); S.log.push({ t, ts: e.timestamp, gameTime: e.gameTime, cat: e.eventCategory, text, id: e.id }); const m = /^Round (\d+) started$/.exec(text); if (m) S.delayedRound = +m[1]; if (fresh && e.timestamp) addDelaySample(e.timestamp); }
      if (S.log.length > 800) S.log.splice(0, S.log.length - 800); if (!fresh) S.log.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    }
  }
  // The page's own GRID sockets are always read too, not only when ours are down: when
  // the page shows its Live Log tab, the veto arrives through it even if GRID ignores
  // our own connection. Log entries and veto steps are de-duplicated by id.
  const onPageGrid = (data, u) => {
    const m = /\/live\/(\d+)/.exec(u); const sid = m ? m[1] : null;
    if (sid && !acceptSeries(sid)) return;              // another series (the match just left): not ours
    if (sid) setSeries(sid);
    if (/live_log/.test(u)) S.pageLogSeen = now(); S.gridLastMsg = now(); S.gridStatus = 'streaming (via page)';
    if (typeof data === 'string') onGridMessage(data); else if (data instanceof Blob) data.text().then(onGridMessage);
  };
  hookWS((u) => /api\.grid\.gg\/widgets/.test(u), onPageGrid);
  // ... and what the widget iframes relay (that is where Polymarket's GRID sockets are).
  // Accepted only from this page's own iframes: the widget lives on vendor.polymarket.com
  // (seen on 2 Nov), so any polymarket.com origin - or "null" from a sandboxed frame - as
  // long as the sender is one of this document's iframes.
  const ownFrame = (ev) => [...document.querySelectorAll('iframe')].some(f => f.contentWindow === ev.source);
  const fromOwnFrame = (ev) => ev.origin === location.origin ||
    ((/^https:\/\/([a-z0-9-]+\.)*polymarket\.com$/.test(ev.origin) || ev.origin === 'null') && ownFrame(ev));
  W.addEventListener('message', (ev) => {
    const d = ev.data; if (!d || d.tag !== 'pm-grid-relay:v1') return;
    if (!fromOwnFrame(ev)) { S.relayRejected = (S.relayRejected || 0) + 1; S.relayRejectedOrigin = ev.origin; return; }
    S.relayFrames = S.relayFrames || {}; S.relayFrames[String(d.hello || d.url || '').slice(0, 80)] = now();
    if (d.hello) return;
    S.relayMsgs = (S.relayMsgs || 0) + 1; onPageGrid(d.data, d.url);
  });

  // ---------------------------------------------------------------- hidden GRID widgets
  // Polymarket's own tabs ("Live Log", "Map") only matter because they create the widget
  // iframe on vendor.polymarket.com, which is what connects to GRID. This creates the same
  // iframes, hidden, as soon as the series is known - unless one of that type and series
  // already exists (the page's, or another script's). The exact URL is learned the first time
  // Polymarket creates one; until then a minimal URL with the same main parameters.
  const WIDGET_TYPES = ['series-livelog', 'game-overview'];
  function allFrames() { const out = []; (function walk(root) { root.querySelectorAll('*').forEach(el => { if (el.tagName === 'IFRAME') out.push(el); if (el.shadowRoot) walk(el.shadowRoot); }); })(document); return out; }
  const auto = {};                       // type -> { el, sid, at }
  // Default: the exact URL Polymarket uses (captured 3 Nov). Its options carry
  // {"teamColorType":"team","delay":"zero"} - delay "zero" is what makes GRID send the fast
  // feed; the earlier minimal fallback lacked it, so a new user got nothing until they opened
  // the page's Live Log tab once (which taught the script the real URL). theme = colours only.
  const WIDGET_TPL = 'https://vendor.polymarket.com/grid/1/widget.html?type={TYPE}&seriesId={SID}&options=%7B%22teamColorType%22%3A%22team%22%2C%22delay%22%3A%22zero%22%7D&theme=%7B%22colourScheme%22%3A%22dark%22%2C%22colors%22%3A%7B%22primary%22%3A%5B%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%22rgba%28210%2C+213%2C+216%2C+1%29%22%5D%2C%22secondary%22%3A%5B%22rgba%28125%2C+128%2C+136%2C+1%29%22%2C%22rgba%28153%2C+158%2C+167%2C+1%29%22%2C%22rgba%28183%2C+187%2C+197%2C+1%29%22%5D%2C%22slate%22%3A%5B%22rgba%28153%2C+158%2C+167%2C+1%29%22%2C%22rgba%28183%2C+187%2C+197%2C+1%29%22%2C%22rgba%28125%2C+128%2C+136%2C+1%29%22%2C%22rgba%28125%2C+128%2C+136%2C+1%29%22%5D%2C%22dark%22%3A%5B%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%5D%2C%22light%22%3A%5B%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%22rgba%28210%2C+213%2C+216%2C+1%29%22%2C%22rgba%28183%2C+187%2C+197%2C+1%29%22%2C%22rgba%28153%2C+158%2C+167%2C+1%29%22%5D%2C%22base%22%3A%7B%220%22%3A%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%225%22%3A%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%2210%22%3A%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%2215%22%3A%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%2220%22%3A%22rgba%28210%2C+213%2C+216%2C+1%29%22%2C%2225%22%3A%22rgba%28183%2C+187%2C+197%2C+1%29%22%2C%2230%22%3A%22rgba%28153%2C+158%2C+167%2C+1%29%22%2C%2235%22%3A%22rgba%28125%2C+128%2C+136%2C+1%29%22%2C%2240%22%3A%22rgba%28125%2C+128%2C+136%2C+1%29%22%2C%2245%22%3A%22rgba%2899%2C+101%2C+106%2C+1%29%22%2C%2250%22%3A%22rgba%2868%2C+71%2C+79%2C+1%29%22%2C%2255%22%3A%22rgba%2868%2C+71%2C+79%2C+1%29%22%2C%2260%22%3A%22rgba%2844%2C+49%2C+55%2C+1%29%22%2C%2265%22%3A%22rgba%2844%2C+49%2C+55%2C+1%29%22%2C%2270%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%2275%22%3A%22rgba%2812%2C+14%2C+19%2C+1%29%22%2C%2280%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%2285%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%2290%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%2295%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22100%22%3A%22rgba%2828%2C+31%2C+39%2C+1%29%22%7D%2C%22main%22%3A%7B%22background%22%3A%5B%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%2C%22rgba%2828%2C+31%2C+39%2C+1%29%22%5D%2C%22typography%22%3A%5B%22rgba%28236%2C+238%2C+241%2C+1%29%22%2C%22rgba%28183%2C+187%2C+197%2C+1%29%22%2C%22rgba%28153%2C+158%2C+167%2C+1%29%22%2C%22rgba%28125%2C+128%2C+136%2C+1%29%22%5D%7D%7D%7D&colorScheme=dark&parentOrigin=https%3A%2F%2Fpolymarket.com';
  function widgetUrl(type, sid) {
    const tpl = (prefs.widgetTpl || {})[type];
    if (tpl) return tpl.replace('{SID}', sid);
    return WIDGET_TPL.replace('{TYPE}', type).replace('{SID}', sid);
  }
  function ensureWidgetFrames() {
    if (prefs.autoWidgets === false || !S.seriesId || !document.body) return;
    const frames = allFrames();
    // learn the real URLs from the page's own widget frames
    for (const f of frames) {
      const m = /^https:\/\/vendor\.polymarket\.com\/grid\/[^?]*\?(?:.*&)?type=([a-z-]+)/.exec(f.src || '');
      if (m && !f.dataset.autoGrid && /seriesId=\d+/.test(f.src)) {
        const tpl = f.src.replace(/seriesId=\d+/, 'seriesId={SID}');
        prefs.widgetTpl = prefs.widgetTpl || {};
        if (prefs.widgetTpl[m[1]] !== tpl) { prefs.widgetTpl[m[1]] = tpl; savePrefs(); }
      }
    }
    for (const type of WIDGET_TYPES) {
      const mine = auto[type];
      if (mine && mine.sid !== S.seriesId) { try { mine.el.remove(); } catch {} delete auto[type]; }
      const exists = frames.some(f => f !== (auto[type] && auto[type].el) && new RegExp(`type=${type}\\b`).test(f.src || '') && new RegExp(`seriesId=${S.seriesId}\\b`).test(f.src || ''));
      if (exists) continue;
      if (auto[type]) {
        // nothing came through it in 2 minutes (e.g. widgets not enabled yet): reload it
        const quiet = type === 'series-livelog' ? !S.pageLogSeen || S.pageLogSeen < auto[type].at : !S.gridLastMsg || S.gridLastMsg < auto[type].at;
        if (quiet && now() - auto[type].at > 120000) { auto[type].el.src = widgetUrl(type, S.seriesId); auto[type].at = now(); }
        continue;
      }
      const f = document.createElement('iframe');
      f.src = widgetUrl(type, S.seriesId);
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.dataset.autoGrid = 'pm';
      f.title = 'GRID ' + type + ' (hidden, Polymarket Esports Scoreboard)';
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:300px;opacity:0;pointer-events:none;border:0';
      document.body.appendChild(f);
      auto[type] = { el: f, sid: S.seriesId, at: now() };
    }
  }

  // ---------------------------------------------------------------- export
  function buildExport() { return { page: location.href, seriesId: S.seriesId, pmMarkets: S.pmMarkets, gamma: S.gamma, gammaLog: S.gammaLog, exported: now(), declaredDelay: S.declaredDelay, delaySamples: S.delaySamples, liveChanges: S.liveChanges, states: S.states, log: S.log, veto: S.veto, frames: S.frames }; }
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
  function copyText(t) { try { navigator.clipboard.writeText(t); } catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } }

  // ---------------------------------------------------------------- HUD
  let hud, visibleHud = true, renderQueued = false, logFilter = 'all', tab = 'players', logOpen = false, histOpen = false, histMarket = '', menuOpen = false, popup = null, mktOpen = false;
  const cache = {}; const setHTML = (el, html) => { if (cache[el.id] !== html) { cache[el.id] = html; el.innerHTML = html; } };
  const CSS = `
      #pm-r6{position:fixed;left:8px;bottom:8px;width:600px;min-width:400px;min-height:160px;max-height:95vh;z-index:2147483647;background:#0d1117;color:#c9d1d9;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;border:1px solid #30363d;border-radius:6px;box-shadow:0 4px 24px #000a;overflow:auto;display:flex;flex-direction:column}
      #pm-r6.popped{position:static;width:auto;height:100vh;max-height:none;resize:none;border:0;border-radius:0}
      #pm-r6 .hd{display:flex;gap:8px;align-items:center;padding:4px 8px;background:#161b22;border-bottom:1px solid #30363d;cursor:move;position:sticky;top:0;z-index:2}
      #pm-r6.popped .hd{cursor:default}#pm-r6 .hd b{color:#f78166}#pm-r6 .sp{flex:1}
      #pm-r6 button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:1px 7px;font:inherit;cursor:pointer}#pm-r6 button.on{background:#1f6feb;color:#fff}#pm-r6 button.sm{padding:0 5px;font-size:10px}
      #pm-r6 input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font:inherit}
      #pm-r6 .menu{position:relative}#pm-r6 .dd{display:none;position:absolute;right:0;top:22px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:4px;min-width:220px;box-shadow:0 4px 16px #000a}
      #pm-r6 .dd.open{display:block}#pm-r6 .dd button{display:block;width:100%;text-align:left;margin:2px 0;border:0;background:transparent}#pm-r6 .dd button:hover{background:#21262d}#pm-r6 .dd button.on{background:#1f6feb33;color:#79c0ff}
      #pm-r6 .blk{margin:6px;border-radius:6px;border:1px solid;transition:transform .18s ease}
      #pm-r6 #pm-blocks{position:relative}
      #pm-r6 .blk.dragging{transition:none;z-index:5;position:absolute;left:0;right:0;box-shadow:0 10px 28px #000d;opacity:.96;pointer-events:none}
      #pm-r6 .blk.dropping{transition:top .16s ease}
      #pm-r6 .blk-ph{margin:6px;border:1px dashed #30363d;border-radius:6px;background:#ffffff06}
      #pm-r6 .bt{cursor:pointer;user-select:none}#pm-r6 .bt .grip{cursor:grab;padding:0 6px 0 0;opacity:.75}#pm-r6 .bt .grip:active{cursor:grabbing}#pm-r6 .bt .chev{display:inline-block;width:12px}
      #pm-r6 .blk.collapsed .bb{display:none}
      #pm-r6 .rz{position:absolute;z-index:6}#pm-r6 .rz.e{top:0;right:0;width:6px;height:100%;cursor:ew-resize}#pm-r6 .rz.w{top:0;left:0;width:6px;height:100%;cursor:ew-resize}#pm-r6 .rz.n{top:0;left:0;height:6px;width:100%;cursor:ns-resize}#pm-r6 .rz.s{bottom:0;left:0;height:6px;width:100%;cursor:ns-resize}#pm-r6 .rz.ne{top:0;right:0;width:12px;height:12px;cursor:nesw-resize}#pm-r6 .rz.se{bottom:0;right:0;width:12px;height:12px;cursor:nwse-resize}#pm-r6 .rz.nw{top:0;left:0;width:12px;height:12px;cursor:nwse-resize}#pm-r6 .rz.sw{bottom:0;left:0;width:12px;height:12px;cursor:nesw-resize}
      #pm-r6.popped .rz{display:none}
      #pm-r6 .blk-live{border-color:#2ea043;background:#0f1a12}#pm-r6 .blk-del{border-color:#d29922;background:#1a150b}#pm-r6 .blk-veto{border-color:#a371f7;background:#150f22}
      #pm-r6 .bt{display:flex;justify-content:space-between;align-items:center;padding:3px 8px;font-weight:bold;font-size:11px;letter-spacing:.5px}
      #pm-r6 .blk-live .bt{background:#2ea043;color:#fff}#pm-r6 .blk-del .bt{background:#d29922;color:#000}#pm-r6 .blk-veto .bt{background:#a371f7;color:#fff}#pm-r6 .veto-sid{margin-bottom:4px}#pm-r6 .veto-sid b{color:#d2a8ff;font-size:13px;letter-spacing:.5px}#pm-r6 .veto-steps div{padding:1px 0}#pm-r6 .va{font-weight:bold}#pm-r6 .va-ban{color:#f85149}#pm-r6 .va-pick{color:#3fb950}#pm-r6 .va-decider{color:#d29922}#pm-r6 .va-side{color:#a371f7}#pm-r6 .vct{color:#58a6ff;font-weight:bold}#pm-r6 .vt{color:#e3b341;font-weight:bold}#pm-r6 table.veto-maps{width:100%;margin-top:6px;border-collapse:collapse}#pm-r6 table.veto-maps th,#pm-r6 table.veto-maps td{text-align:left;padding:2px 4px;border-bottom:1px solid #30363d}
      #pm-r6 .bb{padding:6px 8px}
      #pm-r6 .score{display:grid;grid-template-columns:1fr 110px 1fr;align-items:center;gap:6px}
      #pm-r6 .score .tn{font-weight:bold;white-space:normal;word-break:break-word;line-height:1.15;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      #pm-r6 .score .tn.r{text-align:right}#pm-r6 .score .tn.long{font-size:11px}#pm-r6 .score .tn.xlong{font-size:10px}
      #pm-r6 .num{font-size:26px;font-weight:bold;color:#3fb950;text-align:center;white-space:nowrap}#pm-r6 .blk-del .num{color:#ffa657}
      #pm-r6 .round{text-align:center;font-size:12px;color:#8b949e;margin:2px 0}#pm-r6 .round b{color:#c9d1d9;font-size:15px}
      #pm-r6 .pmodds{display:grid;grid-template-columns:1fr 1fr;margin-top:4px;padding-top:4px;border-top:1px dashed #30363d}#pm-r6 .pmodds .o{text-align:center}#pm-r6 .pmodds .o b{font-size:16px}#pm-r6 .pmodds .o small{color:#8b949e}
      #pm-r6 .side{font-size:10px;padding:0 4px;border-radius:3px;margin:0 4px;vertical-align:middle}.side-DEF{background:#1f6feb;color:#fff}.side-ATK{background:#d29922;color:#000}
      #pm-r6 .dim{color:#8b949e}#pm-r6 .ok{color:#3fb950}#pm-r6 .bad{color:#ff7b72}
      #pm-r6 .ev{max-height:80px;overflow:auto;margin-top:4px;padding-top:4px;border-top:1px dashed #30363d}#pm-r6 .ev .end{color:#3fb950;font-weight:bold}.ev .map{color:#d2a8ff;font-weight:bold}.ev .info{color:#8b949e}.ev .gamma{color:#79c0ff}
      #pm-r6 .tabs{display:flex;gap:4px;margin:4px 0}#pm-r6 .tabs button{font-size:11px}
      #pm-r6 table{width:100%;border-collapse:collapse;table-layout:fixed}#pm-r6 td,#pm-r6 th{padding:2px 4px;border-bottom:1px dashed #21262d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      #pm-r6 th{color:#8b949e;font-weight:normal;text-align:left}#pm-r6 .c{text-align:center}#pm-r6 .rr{text-align:right}#pm-r6 tr.team td{font-weight:bold;background:#ffffff08}
      #pm-r6 .dead{color:#6e7681}#pm-r6 .hpw{display:inline-flex;align-items:center;gap:4px;justify-content:flex-end;width:100%}#pm-r6 .hp{display:inline-block;width:36px;height:6px;background:#21262d;border-radius:3px;overflow:hidden}#pm-r6 .hp i{display:block;height:100%}#pm-r6 .hpn{display:inline-block;width:26px;text-align:right}
      #pm-r6 .fold{display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding:3px 6px;background:#ffffff0a;border-radius:4px;cursor:pointer;user-select:none}
      #pm-r6 .log{max-height:160px;overflow:auto;margin-top:4px}#pm-r6 .log .Kills{color:#ff7b72}.log .General{color:#3fb950;font-weight:bold}.log .Other{color:#8b949e}.log .Objectives{color:#ffa657}
      #pm-r6 .cap{display:flex;justify-content:space-between;color:#8b949e}
      `;
  function buildHud() {
    if (hud || !document.body) return;
    hud = document.createElement('div'); hud.id = 'pm-r6';
    hud.innerHTML = `<style>${CSS}</style>
    <div class="hd"><b>PM</b><span id="pm-sum"></span><span class="sp"></span>
      <span class="menu"><button id="pm-menu">☰</button><div class="dd" id="pm-dd">
        <button id="pm-snd-live" class="on">🔊 sound on real-time round end</button>
        <button id="pm-poll" class="on">⟳ poll series-state every 1s</button>
        <button id="pm-export">⬇ Export JSON (everything)</button>
        <button id="pm-pop">⧉ Pop-out window</button>
        <button id="pm-reset">↺ Reset size/position</button>
        <button id="pm-auto">${prefs.autoWidgets === false ? '☐' : '☑'} open GRID widgets hidden (no need for the Live Log / Map tabs)</button>
        <button id="pm-x">× Hide (Ctrl+Shift+R)</button></div></span></div>
    <div id="pm-blocks">
    <div class="blk blk-live" data-blk="live"><div class="bt"><span><span class="grip" title="Drag to move this section">⠿</span><span class="chev"></span>⚡ REAL-TIME — series-state + Polymarket odds</span><span id="pm-live-t"></span></div><div class="bb" id="pm-live">waiting for series-state…</div></div>
    <div class="blk blk-del" data-blk="del"><div class="bt"><span><span class="grip" title="Drag to move this section">⠿</span><span class="chev"></span>⏳ DELAYED — GRID widgets</span><span id="pm-del-t"></span></div><div class="bb" id="pm-del"><div id="pm-del-head"></div><div id="pm-del-tabs"></div><div id="pm-del-table"></div></div></div>
    <div class="blk blk-veto" data-blk="veto"><div class="bt"><span><span class="grip" title="Drag to move this section">⠿</span><span class="chev"></span>🗳 VETO · LIVE LOG — GRID</span><span id="pm-veto-t"></span></div><div class="bb"><div class="tabs" id="pm-vtabs"></div><div id="pm-veto"></div><div id="pm-vlog"></div></div></div>
    </div>
    <div class="rz n"></div><div class="rz s"></div><div class="rz e"></div><div class="rz w"></div><div class="rz ne"></div><div class="rz nw"></div><div class="rz se"></div><div class="rz sw"></div>`;
    document.body.appendChild(hud); applyPrefs();
    const q = (id) => hud.querySelector('#' + id);
    q('pm-menu').onclick = (e) => { e.stopPropagation(); menuOpen = !menuOpen; q('pm-dd').classList.toggle('open', menuOpen); };
    hud.addEventListener('click', (e) => { if (menuOpen && !e.target.closest('.menu')) { menuOpen = false; q('pm-dd').classList.remove('open'); } });
    q('pm-x').onclick = () => toggle(false);
    q('pm-auto').onclick = (e) => { prefs.autoWidgets = prefs.autoWidgets === false; savePrefs(); e.target.textContent = `${prefs.autoWidgets === false ? '☐' : '☑'} open GRID widgets hidden (no need for the Live Log / Map tabs)`; if (prefs.autoWidgets === false) Object.keys(auto).forEach(k => { try { auto[k].el.remove(); } catch {} delete auto[k]; }); };
    q('pm-snd-live').onclick = (e) => { S.sounds.live = !S.sounds.live; e.target.classList.toggle('on', S.sounds.live); };
    q('pm-poll').onclick = (e) => { S.polling = !S.polling; e.target.classList.toggle('on', S.polling); };
    q('pm-export').onclick = () => download(`pm-esports_${S.seriesId || 'series'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(buildExport()));
    q('pm-pop').onclick = () => popOut();
    q('pm-reset').onclick = () => { delete prefs.w; delete prefs.h; delete prefs.mh; delete prefs.x; delete prefs.y; delete prefs.order; delete prefs.collapsed; savePrefs(); hud.style.cssText = ''; applySections(); };
    hud.addEventListener('click', (e) => {
      const t = e.target; const b = t.closest('button, .fold'); if (!b) return;
      const d = b.dataset || {};
      if (d.vtab) { prefs.vetoTab = d.vtab; savePrefs(); paint(); return; }
      if (d.head) { S.headlineKey = d.head; paint(); return; }
      if (d.f) { logFilter = d.f; paint(); return; } if (d.tab) { tab = d.tab; paint(); return; }
      if (d.copysid) { copyText(d.copysid); b.textContent = '✓ copied'; setTimeout(() => render(), 1200); return; }
      if (d.copyveto) {
        const verb = { ban: 'banned', pick: 'picked', decider: 'decider', side: 'chose' };
        copyText(S.veto.map(v => `${v.ts ? new Date(v.ts).toTimeString().slice(0, 5) + ' ' : ''}${v.team} ${verb[v.action] || v.action} ${v.action === 'side' ? `${v.side} on ${v.map}` : v.map}`).join('\n'));
        b.textContent = '✓ copied'; setTimeout(() => render(), 1200); return;
      }
    });
    // A click on a section's title (not on its grip) folds or unfolds it.
    hud.querySelectorAll('#pm-blocks > .blk > .bt').forEach(bt => bt.addEventListener('click', (e) => {
      if (e.target.closest('.grip') || e.target.closest('button')) return;
      const key = bt.parentElement.dataset.blk; prefs.collapsed = prefs.collapsed || {}; prefs.collapsed[key] = !prefs.collapsed[key]; savePrefs(); applySections();
    }));
    drag(hud, hud.querySelector('.hd'));
    sectionDrag(); resizeFrame(); applySections();
    render();
  }
  // Size: width and a MAXIMUM height (prefs.mh). The panel is as tall as its content up to
  // that maximum, so folding a section shortens it.
  function applyPrefs() { if (prefs.w) hud.style.width = prefs.w + 'px'; hud.style.height = ''; hud.style.maxHeight = prefs.mh ? prefs.mh + 'px' : ''; if (prefs.x != null) { hud.style.left = prefs.x + 'px'; hud.style.top = prefs.y + 'px'; hud.style.bottom = 'auto'; } }
  const BLOCKS = ['live', 'del', 'veto'];
  function applySections() {
    const box = hud.querySelector('#pm-blocks'); if (!box) return;
    const order = (prefs.order || []).filter(k => BLOCKS.includes(k)); BLOCKS.forEach(k => { if (!order.includes(k)) order.push(k); });
    order.forEach(k => box.appendChild(box.querySelector(`[data-blk="${k}"]`)));
    box.querySelectorAll('.blk').forEach(el => { const c = !!(prefs.collapsed || {})[el.dataset.blk]; el.classList.toggle('collapsed', c); el.querySelector('.chev').textContent = c ? '▸' : '▾'; });
  }
  // Drag a section by its grip. While dragged it floats above the others (taken out of the
  // flow, exactly where it was) and a dashed placeholder holds its slot; the placeholder moves
  // as the pointer crosses the middle of another section, and the others slide (FLIP). On
  // release the section glides into the placeholder. The order is kept.
  function sectionDrag() {
    const box = hud.querySelector('#pm-blocks');
    box.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip'); if (!grip || e.button > 0) return;
      const blk = grip.closest('.blk'); e.preventDefault();
      const mt = parseFloat(getComputedStyle(blk).marginTop) || 0;
      const startTop = blk.offsetTop - mt, startY = e.clientY;
      const ph = document.createElement('div'); ph.className = 'blk-ph'; ph.style.height = blk.offsetHeight + 'px';
      blk.before(ph);
      blk.classList.add('dragging'); blk.style.top = startTop + 'px';
      const others = () => [...box.children].filter(x => x !== blk && x !== ph);
      const flip = (fn) => { const first = new Map(others().map(x => [x, x.getBoundingClientRect().top])); fn(); others().forEach(x => { const dy = first.get(x) - x.getBoundingClientRect().top; if (!dy) return; x.style.transition = 'none'; x.style.transform = `translateY(${dy}px)`; requestAnimationFrame(() => { x.style.transition = ''; x.style.transform = ''; }); }); };
      const move = (ev) => {
        blk.style.top = (startTop + ev.clientY - startY) + 'px';
        const y = ev.clientY;
        for (const x of others()) {
          const r = x.getBoundingClientRect(); const mid = r.top + r.height / 2;
          const xBeforePh = !!(ph.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING);
          if (xBeforePh && y < mid) { flip(() => x.before(ph)); break; }
          if (!xBeforePh && y > mid) { flip(() => x.after(ph)); break; }
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        blk.classList.add('dropping'); blk.style.top = (ph.offsetTop - mt) + 'px';
        setTimeout(() => {
          blk.classList.remove('dragging', 'dropping'); blk.style.top = '';
          ph.replaceWith(blk);
          prefs.order = [...box.querySelectorAll('.blk')].map(x => x.dataset.blk); savePrefs();
        }, 170);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }
  // Resize from any edge or corner (the browser's own grip sat in a corner the page edge hid).
  function resizeFrame() {
    hud.querySelectorAll('.rz').forEach(h => h.addEventListener('pointerdown', (e) => {
      if (hud.classList.contains('popped')) return; e.preventDefault(); e.stopPropagation();
      const d = [...h.classList].find(c => c !== 'rz'); const r = hud.getBoundingClientRect();
      // anchor by top-left while resizing, whatever it was before
      hud.style.left = r.left + 'px'; hud.style.top = r.top + 'px'; hud.style.bottom = 'auto';
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy; let { left, top, width, height } = r;
        if (d.includes('e')) width = r.width + dx;
        if (d.includes('w')) { width = r.width - dx; left = r.left + dx; }
        if (d.includes('s')) height = r.height + dy;
        if (d.includes('n')) { height = r.height - dy; top = r.top + dy; }
        width = Math.max(360, Math.min(width, innerWidth)); height = Math.max(120, Math.min(height, innerHeight));
        hud.style.width = width + 'px'; hud.style.maxHeight = height + 'px'; hud.style.left = Math.max(0, left) + 'px'; hud.style.top = Math.max(0, top) + 'px';
        Object.assign(prefs, { w: Math.round(width), mh: Math.round(height), x: Math.max(0, Math.round(left)), y: Math.max(0, Math.round(top)) });
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); savePrefs(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }));
  }
  function toggle(v) { visibleHud = v === undefined ? !visibleHud : v; if (hud) hud.style.display = visibleHud ? 'flex' : 'none'; }
  function drag(el, handle) { let sx, sy, ox, oy, on = false; handle.addEventListener('mousedown', (e) => { if (el.classList.contains('popped') || e.target.closest('button,.dd,input')) return; on = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); }); window.addEventListener('mousemove', (e) => { if (!on) return; const x = Math.max(0, ox + e.clientX - sx), y = Math.max(0, oy + e.clientY - sy); el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.bottom = 'auto'; prefs.x = x; prefs.y = y; }); window.addEventListener('mouseup', () => { if (on) savePrefs(); on = false; }); }
  function popOut() {
    if (popup && !popup.closed) { popup.focus(); return; }
    const w = W.open('', 'pmr6_popup', `popup=yes,width=${Math.max(460, hud.offsetWidth)},height=${Math.max(600, hud.offsetHeight + 40)}`); if (!w) { alert('Popup blocked — allow popups for polymarket.com'); return; }
    popup = w; w.document.open(); w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Polymarket Esports Scoreboard</title><style>html,body{margin:0;background:#0d1117;height:100%;overflow:hidden}</style></head><body></body></html>'); w.document.close();
    menuOpen = false; hud.querySelector('#pm-dd').classList.remove('open'); hud.classList.add('popped'); hud.style.cssText = ''; w.document.body.appendChild(w.document.adoptNode(hud));
    w.addEventListener('beforeunload', () => { if (!hud.classList.contains('popped')) return; hud.classList.remove('popped'); document.body.appendChild(document.adoptNode(hud)); applyPrefs(); popup = null; render(); });
    window.addEventListener('beforeunload', () => { try { w.close(); } catch {} }); render();
  }
  function render() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; paint(); }); }
  const sideTag = (txt) => txt ? `<span class="side side-${/DEF/i.test(txt) ? 'DEF' : 'ATK'}">${/DEF/i.test(txt) ? 'DEF' : 'ATK'}</span>` : '';
  const colorOf = (id) => (S.colors[id] && S.colors[id].sideColor) || '#c9d1d9';
  const nameCls = (n) => (n || '').length > 20 ? 'xlong' : (n || '').length > 13 ? 'long' : '';
  const shortName = (n) => (n || '').replace(/\s+(Alienware|Esports|E-?sports|Gaming|Team)$/i, '').slice(0, 14);

  let paintAllKeys = [];
  function paint() {
    if (!hud || !visibleHud) return;
    const L = S.live; const game = L ? (currentGame(L) || { teams: L.teams, sequenceNumber: '-' }) : null;
    hud.querySelector('#pm-sum').textContent = (!game && S.gamma && S.market) ? `${S.market.outcomes.map(shortName).join(' vs ')} · gamma ${S.gamma.score.split('|')[0] || '—'} · ${S.gamma.live ? 'live' : 'not live'}` : game ? `${shortName(game.teams[0].name)} ${game.teams[0].score}:${game.teams[1].score} ${shortName(game.teams[1].name)} · R${game.finished ? '—' : game.teams[0].score + game.teams[1].score + 1} · map ${game.sequenceNumber} · series ${L.teams.map(x => x.score).join(':')}${L.started ? '' : ' · not started'}` : `series ${S.seriesId || '?'}`;
    // ---- real-time
    hud.querySelector('#pm-live-t').textContent = L ? `updated ${fmtT(S.liveT)}` : '';
    let html = '';
    if (!L && !S.gamma) html += '<div class="dim">waiting for series-state / gamma…</div>';
    if (L) { const [a, b] = game.teams; const roundNo = game.finished ? '—' : (a.score + b.score + 1); html += `<div class="score"><span class="tn r ${nameCls(a.name)}" style="color:${colorOf(a.id)}">${esc(a.name)}</span><span class="num">${a.score} : ${b.score}</span><span class="tn ${nameCls(b.name)}" style="color:${colorOf(b.id)}">${esc(b.name)}</span></div><div class="round"><b>ROUND ${roundNo}</b> · map ${game.sequenceNumber}${game.finished ? ' finished' : ''} · ${esc(L.format)} · series ${L.teams.map(x => x.score).join(':')}${L.finished ? ' · SERIES FINISHED' : L.started ? '' : ' · NOT STARTED'}</div>`; }
    if (S.gamma) { const sc = S.gamma.score.split('|'); html += `<div class="round" style="margin-top:${L ? 0 : 6}px"><span class="dim">Polymarket (gamma):</span> <b>${esc(sc[0] || '—')}</b>${sc[1] ? ` <span class="dim">series</span> <b>${esc(sc[1])}</b>` : ''}${sc[2] ? ` <span class="dim">${esc(sc[2])}</span>` : ''} · ${S.gamma.ended ? 'ended' : S.gamma.live ? '<span class="ok">live</span>' : '<span class="dim">not live</span>'}${S.gamma.period ? ` · period ${esc(S.gamma.period)}` : ''}${S.gamma.gridSeriesId ? '' : ' · <span class="bad">no GRID feed</span>'} <span class="dim">· ${fmtT(S.gammaT)}</span></div>`; }
    // A map already played (finished in series-state, or a side priced at 99%+) has nothing
    // left to show: its market goes away.
    const mapDone = (m) => { const n = (/^map(\d)_winner$/.exec(m.norm.key) || [])[1]; if (!n) return false; const gm = L && (L.games || []).find(x => x.sequenceNumber === +n); if (gm && gm.finished) return true; return (m.prices || []).some(p => p && p.mid != null && (p.mid >= 0.99 || p.mid <= 0.01)); };
    const winnerMkts = S.pmMarkets.filter(m => /^(match|map\d)_winner$/.test(m.norm.key) && !mapDone(m)).sort((a, b) => a.norm.key.localeCompare(b.norm.key));
    // Headline: the button the user pressed; otherwise the map being played (series-state,
    // else gamma's period "2/3"), then the match winner, then whatever is left.
    const periodMap = (/^(\d+)\//.exec((S.gamma && S.gamma.period) || '') || [])[1];
    const liveMap = game && game.sequenceNumber !== '-' && !game.finished ? game.sequenceNumber : (periodMap ? +periodMap : null);
    const headline = winnerMkts.find(m => m.norm.key === S.headlineKey) || (liveMap && winnerMkts.find(m => m.norm.key === `map${liveMap}_winner`)) || (S.market && !mapDone(S.market) ? S.market : null) || winnerMkts[0];
    if (winnerMkts.length > 1) html += `<div style="display:flex;gap:4px;justify-content:center;margin-top:4px">${winnerMkts.map(m => `<button class="sm ${headline && m.norm.key === headline.norm.key ? 'on' : ''}" data-head="${esc(m.norm.key)}">${esc(m.norm.label)}</button>`).join('')}</div>`;
    if (headline) {
      const P = headline.prices;
      const seen = P.some(p => p.bookSeen), tight = P.some(p => p.q === 'tight'), wide = !tight && P.some(p => p.q === 'wide');
      // The decimal carries a bookmaker's margin (MARGIN, split evenly over the two sides), so
      // it reads like a Raiden / kiki price; hovering it shows the raw fair odds (1 / mid).
      html += `<div class="pmodds">${headline.outcomes.map((o, i) => { const p = P[i]; const live = p.q === 'tight' || !seen; return `<div class="o"><div class="dim">${esc(o)}</div><b class="${live ? '' : 'dim'}">${live ? pct(p.mid) : '--'}</b> <span title="${live ? `fair ${dec(p.mid)} (no margin) · shown with ${Math.round(MARGIN * 100)}% margin` : 'no price'}" style="cursor:help;border-bottom:1px dotted #8b949e">→ ${live ? decM(p.mid) : '--'}</span><br><small>bid ${pct(p.ebid ?? p.bid)} · ask ${pct(p.eask ?? p.ask)}${live ? ` · fair ${dec(p.mid)}` : ''}</small></div>`; }).join('')}</div>`;
      // Say it in words too: a market that is not being priced must never read as a price.
      if (wide) {
        const lt = P.filter(p => p.lastT).sort((x, y) => y.lastT - x.lastT)[0];
        html += `<div class="round"><span class="bad">WIDE SPREAD — no real price right now</span><br><span class="dim">only far-off orders are left in the book, so its middle is not a price · Polymarket's buttons show the ask: ${P.map(p => p.eask ? (1 / p.eask).toFixed(2) : '--').join(' / ')}${lt ? ` · last trade: ${esc(headline.outcomes[P.indexOf(lt)])} ${pct(lt.last)} at ${fmtT(lt.lastT)}` : ''}</span></div>`;
      }
      else if (seen && !tight) html += `<div class="round"><span class="bad">NO QUOTES — Polymarket is not offering a price on this market right now</span></div>`;
      else if (!seen) html += `<div class="round"><span class="dim">last price from gamma · waiting for the order book</span></div>`;
    }
    else html += `<div class="dim" style="margin-top:4px">market: loading…</div>`;
    html += `<div class="ev">${S.liveChanges.slice().reverse().map(e => `<div><span class="dim">${fmtT(e.t)}</span> <span class="${e.cls || ''}">${esc(e.text)}</span></div>`).join('')}</div>`;
    setHTML(hud.querySelector('#pm-live'), html);

    // ---- veto
    const vst = !S.seriesId ? 'no GRID series for this event' : S.veto.length ? `${S.veto.length} steps${S.gridLastMsg ? '' : ' · saved'}`
      : S.gridLastMsg ? 'Connected — no veto yet' : /open/.test(S.sockState.log || '') ? 'Connected — GRID has sent nothing yet' : 'Not connected yet — waiting for GRID';
    hud.querySelector('#pm-veto-t').textContent = vst;
    // GRID series id, with a copy button.
    let vh = S.seriesId ? `<div class="veto-sid">GRID series <b>${esc(S.seriesId)}</b> <button class="sm" data-copysid="${esc(S.seriesId)}" title="Copy the GRID series id">⧉ copy</button>${S.veto.length ? ' <button class="sm" data-copyveto="1" title="Copy the veto as text, one step per line">⧉ copy veto</button>' : ''}</div>` : '';
    if (!S.veto.length) {
      const st = S.sockState.log || 'not opened';
      vh += `<div class="dim">${esc(vst)}</div><div class="dim">page live log: ${S.pageLogSeen ? 'seen ' + fmtT(S.pageLogSeen) : 'not seen — open the page’s "Live Log" tab (Polymarket shows it once the match is live)'} · our own socket: ${esc(st)}</div>`;
      const frames = Object.keys(S.relayFrames || {});
      vh += `<div class="dim">widget frames heard: ${frames.length ? frames.length + ' · ' + (S.relayMsgs || 0) + ' GRID msgs relayed' : 'none (the script is not running inside the widget iframe)'}${S.relayRejected ? ` · ${S.relayRejected} rejected from origin ${esc(S.relayRejectedOrigin)}` : ''}</div>`;
    }
    else {
      const sideCls = (s) => s === 'CT' ? 'vct' : s === 'T' ? 'vt' : '';
      const act = { ban: 'banned', pick: 'picked', decider: 'decider', side: 'side' };
      vh += '<div class="veto-steps">' + S.veto.map(v => `<div><span class="dim">${v.ts ? fmtT(Date.parse(v.ts)) : ''}</span> <b${v.teamId ? ` style="color:${(S.colors[v.teamId] && S.colors[v.teamId].teamColor) || '#c9d1d9'}"` : ''}>${esc(v.team)}</b> <span class="va va-${v.action}">${act[v.action]}</span> ${v.action === 'side' ? `<span class="${sideCls(v.side)}">${esc(v.side)}</span> <span class="dim">on</span> ` : ''}${esc(v.map)}</div>`).join('') + '</div>';
      const maps = vetoMaps(S.veto);
      if (maps.length) vh += '<table class="veto-maps"><tr><th>#</th><th>map</th><th>picked by</th><th>side choice</th></tr>' + maps.map(m => `<tr><td>${m.seq}</td><td><b>${esc(m.map)}</b></td><td>${m.by === 'decider' ? '<span class="dim">decider</span>' : esc(m.by)}</td><td>${m.sides.length ? m.sides.map(x => `${esc(x.team)} <span class="${sideCls(x.side)}">${esc(x.side)}</span>`).join(', ') : '<span class="dim">—</span>'}</td></tr>`).join('') + '</table>';
    }
    const vtab = prefs.vetoTab === 'log' ? 'log' : 'veto';
    setHTML(hud.querySelector('#pm-vtabs'), `<button class="sm ${vtab === 'veto' ? 'on' : ''}" data-vtab="veto">Veto${S.veto.length ? ' · ' + S.veto.length : ''}</button><button class="sm ${vtab === 'log' ? 'on' : ''}" data-vtab="log">Live log · ${S.log.length}</button>`);
    hud.querySelector('#pm-veto').style.display = vtab === 'veto' ? '' : 'none';
    hud.querySelector('#pm-vlog').style.display = vtab === 'log' ? '' : 'none';
    setHTML(hud.querySelector('#pm-veto'), vh);
    if (vtab === 'log') {
      const rows = S.log.filter(e => logFilter === 'all' || e.cat === logFilter || (logFilter === 'rounds' && /^Round|won Round|Game \d|Series/.test(e.text))).slice(-200).reverse();
      setHTML(hud.querySelector('#pm-vlog'), `<div class="log" style="max-height:none"><div class="cap"><span class="dim">${S.log.length} entries · newest first</span><span>${['all', 'rounds', 'Kills', 'Objectives', 'Other'].map(f => `<button class="sm ${logFilter === f ? 'on' : ''}" data-f="${f}">${f}</button>`).join(' ')}</span></div>` +
        (rows.length ? rows.map(e => `<div><span class="dim">${esc(e.gameTime || '')} ${e.ts ? fmtT(Date.parse(e.ts)) : ''}</span> <span class="${esc(e.cat)}">${esc(e.text)}</span></div>`).join('') : '<div class="dim">no live log yet</div>') + '</div>');
    }

    // ---- delayed (split: head / tabs / table / log)
    const measured = S.delaySamples.length ? Math.round(S.delaySamples.reduce((x, y) => x + y, 0) / S.delaySamples.length) : null;
    hud.querySelector('#pm-del-t').textContent = `${S.gridStatus} · declared ${S.declaredDelay ?? '?'}s${measured != null ? ` · measured ${measured}s` : ''}`;
    const sb = S.scoreboard, tb = S.teamsBoard; let dHead = '', dTabs = '', dTable = '';
    if (!sb && !tb) dHead = `<div class="dim">${S.gridStatus === 'idle' ? 'waiting for seriesId…' : 'no widget data yet (' + esc(S.gridStatus) + ')'}</div>`;
    else {
      const g = sb && (sb.games || [])[sb.activeGameIndex || 0]; let clockTxt = '';
      if (S.clock) { let sec = S.clock.seconds; if (S.clock.ticking) { const el = (now() - S.clock.recvT) / 1000; sec = S.clock.backwards ? sec - el : sec + el; } clockTxt = `⏱ ${mmss(sec)}${S.clock.ticking ? '' : ' (paused)'}`; }
      if (g) { const [a, b] = g.teams; const nm = (id) => (S.teamsBoard?.teams || sb.series?.teams || []).find(x => x.id === id)?.name || id; dHead = `<div class="score"><span class="tn r ${nameCls(nm(a.id))}" style="color:${colorOf(a.id)}">${esc(nm(a.id))}${sideTag(a.infoText?.text)}</span><span class="num">${a.score} : ${b.score}</span><span class="tn ${nameCls(nm(b.id))}" style="color:${colorOf(b.id)}">${sideTag(b.infoText?.text)}${esc(nm(b.id))}</span></div><div class="round"><b>ROUND ${S.delayedRound ?? (a.score + b.score + 1)}</b> · ${esc(g.centeredInfoText || g.mapName || '')} · <b>${clockTxt}</b> · ${esc(g.status || '')}</div>`; }
      if (tb) {
        dTabs = `<div class="tabs"><button data-tab="players" class="${tab === 'players' ? 'on' : ''}">Players</button><button data-tab="loadout" class="${tab === 'loadout' ? 'on' : ''}">Loadout</button></div>`;
        dTable = tab === 'players' ? '<table><colgroup><col style="width:38%"><col style="width:22%"><col style="width:18%"><col style="width:22%"></colgroup><tr><th>player</th><th>side/operator</th><th class="c">K/D/A</th><th class="rr">HP</th></tr>' : '<table><colgroup><col style="width:30%"><col style="width:18%"><col style="width:52%"></colgroup><tr><th>player</th><th>side/operator</th><th>loadout</th></tr>';
        for (const team of tb.teams || []) {
          const side = g ? g.teams.find(x => x.id === team.id)?.infoText?.text : ''; const kda = (team.dataPoints || []).find(d => d.label === 'K/D/A')?.value || '';
          dTable += `<tr class="team"><td colspan="${tab === 'players' ? 4 : 3}" style="color:${colorOf(team.id)}">${esc(team.name)}${sideTag(side)} <span class="dim">${esc(kda)}</span></td></tr>`;
          for (const p of team.players || []) { const hp = p.primaryFillBar ? Math.round((p.primaryFillBar.fillFraction || 0) * 100) : null; const dead = hp === 0; const op = p.character?.label || ''; if (tab === 'players') dTable += `<tr class="${dead ? 'dead' : ''}"><td title="${esc(p.name)}">${esc(p.name)}</td><td>${esc(op)}</td><td class="c">${esc((p.dataPoints || []).find(d => d.label === 'K/D/A')?.value || '')}</td><td class="rr"><span class="hpw">${hp != null ? `<span class="hp"><i style="width:${hp}%;background:${hp > 50 ? '#3fb950' : hp > 20 ? '#d29922' : '#ff7b72'}"></i></span><span class="hpn">${hp}</span>` : ''}</span></td></tr>`; else { const items = (p.items || []).map(i => i.label).filter(Boolean); dTable += `<tr class="${dead ? 'dead' : ''}"><td title="${esc(p.name)}">${esc(p.name)}</td><td>${esc(op)}</td><td class="dim" title="${esc(items.join(', '))}">${esc(items.join(', '))}</td></tr>`; } }
        }
        dTable += '</table>';
      }
    }
    setHTML(hud.querySelector('#pm-del-head'), dHead); setHTML(hud.querySelector('#pm-del-tabs'), dTabs); setHTML(hud.querySelector('#pm-del-table'), dTable);
  }

  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); toggle(); } }, true);
  function resetForNewEvent() {
    try { if (S.clobWs) S.clobWs.close(); } catch {} S.clobWs = null;
    try { if (S.gridOwn) Object.values(S.gridOwn).forEach(ws => ws.close()); } catch {} S.gridOwn = null; S.gridStatus = 'idle'; S.gridLastMsg = 0; S.gridFirstMsg = 0;
    // Remember the series just left (its frames keep talking for a while) and take down our
    // own hidden widget frames for it right away.
    S.prevSeriesId = S.seriesId || S.prevSeriesId || null;
    Object.keys(auto).forEach(k => { try { auto[k].el.remove(); } catch {} delete auto[k]; });
    S.market = null; S.pmMarkets = []; S.seriesId = null; S.gamma = null; S.gammaT = 0;
    // The real-time score too: up to 0.8.2 it stayed on screen after a switch, so the
    // previous match's score was shown until the new series-state arrived (or a reload).
    S.live = null; S.liveT = 0; S.headlineKey = null; S.pageLogSeen = 0; S.sockState = {}; S.declaredDelay = null;
    S.scoreboard = null; S.teamsBoard = null; S.colors = {}; S.log = []; S.veto = []; S.clock = null; S.delayedRound = null;
    S.frames = []; S.states = []; S.liveChanges = []; S.gammaLog = []; S.delaySamples = []; S.b365T = 0;
    Object.keys(cache).forEach(k => delete cache[k]);
    clearInterval(S.pollTimer); S.pollTimer = null;
    loadMarket();
    pushLive('switched event — board reset', 'info'); render();
  }
  function onReady() {
    buildHud(); loadMarket();
    setInterval(render, 1000);
    setInterval(ensureWidgetFrames, 5000);
    // Polymarket is a single-page app: a new match is a pushState, not a load. React to the
    // navigation itself, and keep a 1s check for anything that changes the URL some other way.
    const checkSlug = () => { if (slugFromUrl() !== S.slug) resetForNewEvent(); };
    setInterval(() => { checkSlug(); if (S.live && !S.live.started) connectGrid(false); }, 1000);
    try {
      for (const k of ['pushState', 'replaceState']) { const orig = W.history[k]; W.history[k] = function () { const r = orig.apply(this, arguments); setTimeout(checkSlug, 0); return r; }; }
      W.addEventListener('popstate', () => setTimeout(checkSlug, 0));
    } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();
  W.__pmR6 = { state: S, export: buildExport };
  console.log(TAG, 'v0.10.2 installed (Ctrl+Shift+R toggles)');
})();
