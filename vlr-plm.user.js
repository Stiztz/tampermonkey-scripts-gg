// ==UserScript==
// @name         VLR.gg PLM Stats DibuExtractor
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Stats extractor + Duels
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vlr.gg
// @match        https://www.vlr.gg/*
// @match        https://raiden.oddin.gg/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      vlr.gg
// @connect      www.vlr.gg
// ==/UserScript==

(function() {
    'use strict';

    const ROUND_ICONS = { elim: '💀', defuse: '🔧', boom: '💣', time: '⏱' };
    const ROUND_LABELS = { elim: 'Elimination', defuse: 'Defuse', boom: 'Bomb', time: 'Time' };

    const style = document.createElement('style');
    style.textContent = `
        #plm-btn {
            position: fixed; bottom: 20px; right: 175px; z-index: 99999;
            background: #4ecdc4; color: #1a1a1a; border: none; padding: 10px 16px;
            border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }
        #plm-btn:hover { background: #3bb5ac; }
        #plm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 99998; }
        #plm-modal {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #1a1a1a; color: #fff; padding: 20px; border-radius: 8px;
            max-width: 720px; width: 92%; max-height: 88vh; overflow-y: auto;
            z-index: 100000; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        #plm-modal h3 { margin: 0 0 15px 0; color: #4ecdc4; }
        #plm-modal .close-btn {
            position: absolute; top: 10px; right: 15px; background: none;
            border: none; color: #999; font-size: 22px; cursor: pointer;
        }
        .plm-input {
            width: 100%; padding: 8px 10px; background: #2a2a2a; color: #fff;
            border: 1px solid #444; border-radius: 4px; font-size: 13px;
            margin-bottom: 8px; box-sizing: border-box;
        }
        .plm-btn-primary {
            background: #4ecdc4; color: #1a1a1a; border: none; padding: 8px 14px;
            border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 13px;
        }
        .plm-btn-primary:hover { background: #3bb5ac; }
        .plm-status { color: #ff9500; font-style: italic; font-size: 12px; margin: 8px 0; }
        .plm-error { color: #ff4655; }
        .plm-map-picker { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
        .plm-map-btn {
            background: #2a2a2a; color: #ccc; border: 1px solid #444;
            padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;
        }
        .plm-map-btn:hover { background: #333; color: #fff; }
        .plm-map-btn.active { background: #4ecdc4; color: #1a1a1a; border-color: #4ecdc4; }
        .plm-controls-row {
            display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
            margin: 8px 0;
        }
        .plm-toggle {
            display: inline-flex; background: #2a2a2a; border-radius: 6px;
            padding: 3px; gap: 2px;
        }
        .plm-toggle button {
            background: transparent; color: #999; border: none;
            padding: 5px 14px; border-radius: 4px; cursor: pointer;
            font-size: 12px; font-weight: bold;
        }
        .plm-toggle button.active { background: #4ecdc4; color: #1a1a1a; }
        .plm-toggle button:hover:not(.active) { color: #fff; }
        .plm-toggle.mod-mode button.active { background: #ff9500; color: #1a1a1a; }
        .plm-team-block {
            background: #222; border-radius: 6px; padding: 12px; margin-bottom: 12px;
        }
        .plm-team-header {
            display: flex; align-items: center; gap: 10px;
            margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #333;
        }
        .plm-team-header img { width: 32px; height: 32px; object-fit: contain; }
        .plm-team-name { font-weight: bold; font-size: 15px; }
        .plm-team-score { margin-left: auto; font-size: 22px; font-weight: bold; color: #4ecdc4; }
        .plm-player {
            display: grid; grid-template-columns: 1fr auto auto;
            gap: 10px; align-items: center;
            padding: 8px 0; border-bottom: 1px solid #2a2a2a;
        }
        .plm-player:last-child { border-bottom: none; }
        .plm-player-name { color: #eee; font-weight: 500; }
        .plm-player-kda { color: #888; font-size: 11px; }
        .plm-player-kills {
            color: #4ecdc4; font-weight: bold; font-size: 22px;
            min-width: 45px; text-align: right;
        }
        .plm-player-kills-label { color: #666; font-size: 10px; margin-left: 3px; }
        .plm-rounds-strip {
            display: flex; flex-wrap: wrap; gap: 3px; margin: 12px 0;
            padding: 10px; background: #222; border-radius: 6px;
        }
        .plm-round {
            width: 28px; height: 34px; border-radius: 3px;
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; font-size: 9px; font-weight: bold;
            color: #fff; gap: 1px;
        }
        .plm-round.win-t1 { background: #4ecdc4; color: #1a1a1a; }
        .plm-round.win-t2 { background: #ff4655; }
        .plm-round .icon { font-size: 13px; line-height: 1; }
        .plm-map-meta { color: #999; font-size: 12px; margin: 8px 0; }
        .plm-copy-btn {
            background: #383838; color: #fff; border: 1px solid #555;
            padding: 6px 12px; border-radius: 4px; cursor: pointer;
            font-size: 12px; margin-top: 10px;
        }
        .plm-copy-btn:hover { background: #555; }
        .plm-copy-btn.copied { background: #4CAF50; }
        .plm-legend {
            display: flex; gap: 12px; font-size: 11px; color: #888;
            margin-top: 8px; flex-wrap: wrap;
        }
        .plm-legend span { display: inline-flex; align-items: center; gap: 4px; }
        .plm-empty-warn { color: #ff9500; font-size: 12px; padding: 10px; }
        /* Duels */
        .plm-duels-info {
            color: #999; font-size: 12px; margin-bottom: 10px;
            padding: 8px 12px; background: #2a2a2a; border-radius: 4px;
            border-left: 3px solid #ff9500;
        }
        .plm-duel-row {
            display: grid;
            grid-template-columns: 30px 1fr auto auto auto 1fr;
            gap: 8px; align-items: center;
            background: #222; padding: 10px 12px; margin-bottom: 8px;
            border-radius: 6px;
        }
        .plm-duel-idx {
            color: #666; font-size: 11px; font-weight: bold;
        }
        .plm-duel-select {
            width: 100%; padding: 6px 8px; background: #2a2a2a;
            color: #eee; border: 1px solid #444; border-radius: 4px;
            font-size: 12px;
        }
        .plm-duel-kills {
            font-weight: bold; font-size: 20px; min-width: 32px; text-align: center;
            color: #888;
        }
        .plm-duel-kills.winner { color: #4ecdc4; }
        .plm-duel-kills.winner-t2 { color: #ff4655; }
        .plm-duel-vs {
            color: #666; font-size: 10px; font-weight: bold; letter-spacing: 1px;
        }
        .plm-duel-row.tied .plm-duel-kills { color: #ff9500; }
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'plm-btn';
    btn.textContent = '📊 PLM';
    document.body.appendChild(btn);

    function fetchHTML(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                onload: (r) => resolve(r.responseText),
                onerror: () => reject(new Error('Network error'))
            });
        });
    }

    function getKDAStat(kdaCell, col) {
        if (!kdaCell) return { all: '?', t: '?', ct: '?' };
        const wrapper = kdaCell.querySelector(`[data-col="${col}"]`);
        if (!wrapper) return { all: '?', t: '?', ct: '?' };
        const clean = (el) => el?.textContent?.trim() || '?';
        return {
            all: clean(wrapper.querySelector('.side.mod-both')),
            t: clean(wrapper.querySelector('.side.mod-t')),
            ct: clean(wrapper.querySelector('.side.mod-ct'))
        };
    }

    function parseMatchData(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const teamEls = doc.querySelectorAll('.match-header-vs .match-header-link');
        const teams = { t1: { name: 'Team 1', logo: '' }, t2: { name: 'Team 2', logo: '' } };
        if (teamEls.length >= 2) {
            const parseTeam = (el) => {
                const nm = el.querySelector('.wf-title-med')?.textContent?.trim();
                let lg = el.querySelector('img')?.src;
                if (lg && lg.startsWith('//')) lg = 'https:' + lg;
                return { name: nm || 'Team', logo: lg || '' };
            };
            teams.t1 = parseTeam(teamEls[0]);
            teams.t2 = parseTeam(teamEls[1]);
        }

        const maps = [];
        let mapIdx = 0;

        doc.querySelectorAll('.vm-stats-game[data-game-id]').forEach(container => {
            const gameId = container.getAttribute('data-game-id');
            if (gameId === 'all') return;

            let mapName = 'Unknown';
            const mapNameEl = container.querySelector('.map span[style], .map div span');
            if (mapNameEl) mapName = mapNameEl.textContent.trim().replace(/PICK$/i, '').trim();
            if (!mapName || mapName === 'PICK') {
                const mapDiv = container.querySelector('.map');
                if (mapDiv) mapName = mapDiv.textContent.trim().replace(/PICK/gi, '').trim().split(/\s+/)[0] || 'Unknown';
            }

            const scoreEls = container.querySelectorAll('.vm-stats-game-header .score');
            const t1Score = scoreEls[0]?.textContent?.trim() || '?';
            const t2Score = scoreEls[1]?.textContent?.trim() || '?';
            const duration = container.querySelector('.map-duration')?.textContent?.trim() || '';

            let rounds = [];
            container.querySelectorAll('.vlr-rounds-row-col').forEach(rEl => {
                const rNumEl = rEl.querySelector('.rnd-num');
                if (!rNumEl) return;
                const rNum = rNumEl.textContent.trim();
                if (!rNum || isNaN(parseInt(rNum))) return;
                const sqs = rEl.querySelectorAll('.rnd-sq');
                let winner = null, winType = null;
                sqs.forEach((sq, i) => {
                    if (sq.classList.contains('mod-win')) {
                        winner = i === 0 ? 't1' : 't2';
                        const img = sq.querySelector('img');
                        if (img) {
                            const m = (img.getAttribute('src') || '').match(/round\/(\w+)\./);
                            if (m) winType = m[1];
                        }
                    }
                });
                rounds.push({ num: rNum, winner, winType });
            });
            let lastPlayed = -1;
            rounds.forEach((r, i) => { if (r.winner) lastPlayed = i; });
            rounds = rounds.slice(0, lastPlayed + 1);

            const allRows = container.querySelectorAll('.ovw-row');
            const players = [];
            allRows.forEach(row => {
                const nameEl = row.querySelector('.ovw-player-name');
                if (!nameEl) return;
                const name = nameEl.textContent.trim();
                if (!name) return;
                const kdaCell = row.querySelector('.ovw-cell.mod-kda');
                players.push({
                    name,
                    kills: getKDAStat(kdaCell, 'kills'),
                    deaths: getKDAStat(kdaCell, 'deaths'),
                    assists: getKDAStat(kdaCell, 'assists')
                });
            });

            mapIdx++;
            maps.push({
                index: mapIdx, gameId, name: mapName,
                t1Score, t2Score, duration, rounds,
                team1Players: players.slice(0, 5),
                team2Players: players.slice(5, 10)
            });
        });

        return { teams, maps };
    }

    function copyToClipboard(text, buttonEl) {
        if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(text);
        else navigator.clipboard.writeText(text);
        if (buttonEl) {
            const orig = buttonEl.textContent;
            buttonEl.textContent = '✓ Copied';
            buttonEl.classList.add('copied');
            setTimeout(() => {
                buttonEl.textContent = orig;
                buttonEl.classList.remove('copied');
            }, 1500);
        }
    }

    function renderStatsMode(map, teams, state) {
        const side = state.side;

        const roundsHtml = map.rounds.length > 0 ? `
            <div class="plm-rounds-strip">
                ${map.rounds.map(r => {
                    const cls = r.winner === 't1' ? 'win-t1' : 'win-t2';
                    const icon = r.winType ? ROUND_ICONS[r.winType] || '' : '';
                    const tip = r.winType ? `Round ${r.num}: ${ROUND_LABELS[r.winType] || r.winType}` : `Round ${r.num}`;
                    return `<div class="plm-round ${cls}" title="${tip}">
                        <div>${r.num}</div>
                        ${icon ? `<div class="icon">${icon}</div>` : ''}
                    </div>`;
                }).join('')}
            </div>
            <div class="plm-legend">
                ${Object.entries(ROUND_ICONS).map(([k, v]) => `<span>${v} ${ROUND_LABELS[k]}</span>`).join('')}
            </div>` : '';

        const teamBlock = (team, players, score) => `
            <div class="plm-team-block">
                <div class="plm-team-header">
                    ${team.logo ? `<img src="${team.logo}" alt="">` : ''}
                    <div class="plm-team-name">${team.name}</div>
                    <div class="plm-team-score">${score}</div>
                </div>
                ${players.length === 0
                    ? '<div class="plm-empty-warn">No player data found for this map.</div>'
                    : players.map(p => `
                        <div class="plm-player">
                            <div class="plm-player-name">${p.name}</div>
                            <div class="plm-player-kda">${p.kills[side]}/${p.deaths[side]}/${p.assists[side]} K/D/A</div>
                            <div class="plm-player-kills">${p.kills[side]}<span class="plm-player-kills-label">K</span></div>
                        </div>
                    `).join('')
                }
            </div>`;

        return teamBlock(teams.t1, map.team1Players, map.t1Score)
             + roundsHtml
             + teamBlock(teams.t2, map.team2Players, map.t2Score);
    }

    function renderDuelsMode(map, teams, state) {
        const side = state.side;
        const opt = (players, selectedIdx) =>
            `<option value="">— select —</option>` +
            players.map((p, i) => `<option value="${i}" ${i===selectedIdx?'selected':''}>${p.name} (${p.kills[side]}K)</option>`).join('');

        const rows = state.duels.map((duel, i) => {
            const t1P = duel.t1 !== null ? map.team1Players[duel.t1] : null;
            const t2P = duel.t2 !== null ? map.team2Players[duel.t2] : null;
            const k1 = t1P ? parseInt(t1P.kills[side]) : NaN;
            const k2 = t2P ? parseInt(t2P.kills[side]) : NaN;

            let cls = '', winner1 = '', winner2 = '';
            if (!isNaN(k1) && !isNaN(k2)) {
                if (k1 > k2) winner1 = 'winner';
                else if (k2 > k1) winner2 = 'winner-t2';
                else cls = 'tied';
            }

            return `
                <div class="plm-duel-row ${cls}">
                    <div class="plm-duel-idx">#${i+1}</div>
                    <select class="plm-duel-select" data-duel="${i}" data-team="t1">
                        ${opt(map.team1Players, duel.t1)}
                    </select>
                    <div class="plm-duel-kills ${winner1}">${t1P ? t1P.kills[side] : '—'}</div>
                    <div class="plm-duel-vs">VS</div>
                    <div class="plm-duel-kills ${winner2}">${t2P ? t2P.kills[side] : '—'}</div>
                    <select class="plm-duel-select" data-duel="${i}" data-team="t2">
                        ${opt(map.team2Players, duel.t2)}
                    </select>
                </div>`;
        }).join('');

        return `
            <div class="plm-duels-info">
                Select up to 5 duels. Kills shown for <strong>${{all:'All',t:'Attack',ct:'Defend'}[side]}</strong>.
                Winner is highlighted; ties in orange.
            </div>
            ${rows}
        `;
    }

    function renderContent(map, teams, mapContentEl, state, rerender) {
        const sideLabel = { all: 'All', t: 'Attack', ct: 'Defend' }[state.side];

        mapContentEl.innerHTML = `
            <div class="plm-map-meta">
                Map ${map.index}: <strong style="color:#fff">${map.name}</strong>
                ${map.duration ? ` · ${map.duration}` : ''}
                · Showing: <strong style="color:#4ecdc4">${sideLabel}</strong>
            </div>
            <div class="plm-controls-row">
                <div class="plm-toggle mod-mode">
                    <button class="${state.mode==='stats'?'active':''}" data-mode="stats">📊 Stats</button>
                    <button class="${state.mode==='duels'?'active':''}" data-mode="duels">⚔️ Duels</button>
                </div>
                <div class="plm-toggle">
                    <button class="${state.side==='all'?'active':''}" data-side="all">All</button>
                    <button class="${state.side==='t'?'active':''}" data-side="t">Attack</button>
                    <button class="${state.side==='ct'?'active':''}" data-side="ct">Defend</button>
                </div>
            </div>
            <div id="plm-body">${state.mode === 'stats' ? renderStatsMode(map, teams, state) : renderDuelsMode(map, teams, state)}</div>
            <button class="plm-copy-btn">Copy as text</button>
        `;

        // Handlers
        mapContentEl.querySelectorAll('.plm-toggle.mod-mode button').forEach(b => {
            b.onclick = () => { state.mode = b.dataset.mode; rerender(); };
        });
        mapContentEl.querySelectorAll('.plm-toggle:not(.mod-mode) button').forEach(b => {
            b.onclick = () => { state.side = b.dataset.side; rerender(); };
        });
        mapContentEl.querySelectorAll('.plm-duel-select').forEach(sel => {
            sel.onchange = () => {
                const di = parseInt(sel.dataset.duel);
                const team = sel.dataset.team;
                state.duels[di][team] = sel.value === '' ? null : parseInt(sel.value);
                rerender();
            };
        });

        mapContentEl.querySelector('.plm-copy-btn').onclick = (e) => {
            const side = state.side;
            let lines;
            if (state.mode === 'stats') {
                lines = [
                    `${teams.t1.name} ${map.t1Score} - ${map.t2Score} ${teams.t2.name}`,
                    `Map: ${map.name}${map.duration ? ' (' + map.duration + ')' : ''} [${sideLabel}]`,
                    '',
                    `[${teams.t1.name}]`,
                    ...map.team1Players.map(p => `  ${p.name}: ${p.kills[side]}K / ${p.deaths[side]}D / ${p.assists[side]}A`),
                    '',
                    `[${teams.t2.name}]`,
                    ...map.team2Players.map(p => `  ${p.name}: ${p.kills[side]}K / ${p.deaths[side]}D / ${p.assists[side]}A`)
                ];
            } else {
                lines = [`Duels — ${map.name} [${sideLabel}]`, ''];
                state.duels.forEach((d, i) => {
                    if (d.t1 === null && d.t2 === null) return;
                    const p1 = d.t1 !== null ? map.team1Players[d.t1] : null;
                    const p2 = d.t2 !== null ? map.team2Players[d.t2] : null;
                    const n1 = p1 ? `${p1.name} (${p1.kills[side]}K)` : '—';
                    const n2 = p2 ? `${p2.name} (${p2.kills[side]}K)` : '—';
                    let result = '';
                    if (p1 && p2) {
                        const k1 = parseInt(p1.kills[side]), k2 = parseInt(p2.kills[side]);
                        if (k1 > k2) result = ` → ${p1.name} wins (+${k1-k2})`;
                        else if (k2 > k1) result = ` → ${p2.name} wins (+${k2-k1})`;
                        else result = ` → Tied`;
                    }
                    lines.push(`Duel ${i+1}: ${n1} vs ${n2}${result}`);
                });
            }
            copyToClipboard(lines.join('\n'), e.target);
        };
    }

    function renderMap(map, teams, mapListEl, mapContentEl) {
        mapListEl.querySelectorAll('.plm-map-btn').forEach(b => b.classList.remove('active'));
        mapListEl.querySelector(`[data-idx="${map.index}"]`)?.classList.add('active');

        const state = {
            side: 'all',
            mode: 'stats',
            duels: Array.from({ length: 5 }, () => ({ t1: null, t2: null }))
        };
        const rerender = () => renderContent(map, teams, mapContentEl, state, rerender);
        rerender();
    }

    function showModal() {
        document.getElementById('plm-modal')?.remove();
        document.getElementById('plm-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'plm-overlay';
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'plm-modal';
        modal.innerHTML = `
            <button class="close-btn">×</button>
            <h3>PLM Match Stats</h3>
            <input type="text" class="plm-input" id="plm-url-input"
                placeholder="Paste vlr.gg match URL"
                value="${window.location.href.match(/vlr\.gg\/\d+/) ? window.location.href : ''}">
            <button class="plm-btn-primary" id="plm-load-btn">Load Match</button>
            <div class="plm-status" id="plm-status"></div>
            <div id="plm-map-picker" class="plm-map-picker"></div>
            <div id="plm-map-content"></div>
        `;
        document.body.appendChild(modal);

        const close = () => { overlay.remove(); modal.remove(); };
        modal.querySelector('.close-btn').onclick = close;
        overlay.onclick = close;

        const urlInput = modal.querySelector('#plm-url-input');
        const loadBtn = modal.querySelector('#plm-load-btn');
        const statusEl = modal.querySelector('#plm-status');
        const mapListEl = modal.querySelector('#plm-map-picker');
        const mapContentEl = modal.querySelector('#plm-map-content');

        loadBtn.onclick = async () => {
            const url = urlInput.value.trim();
            if (!url || !url.includes('vlr.gg/')) {
                statusEl.className = 'plm-status plm-error';
                statusEl.textContent = 'Please paste a valid vlr.gg match URL.';
                return;
            }
            statusEl.className = 'plm-status';
            statusEl.textContent = 'Loading match...';
            mapListEl.innerHTML = '';
            mapContentEl.innerHTML = '';

            try {
                const html = await fetchHTML(url);
                const data = parseMatchData(html);

                if (data.maps.length === 0) {
                    statusEl.className = 'plm-status plm-error';
                    statusEl.textContent = 'No played maps found.';
                    return;
                }

                statusEl.textContent = `Loaded: ${data.teams.t1.name} vs ${data.teams.t2.name} — ${data.maps.length} map(s)`;

                data.maps.forEach(m => {
                    const b = document.createElement('button');
                    b.className = 'plm-map-btn';
                    b.dataset.idx = m.index;
                    b.textContent = `${m.index}. ${m.name}`;
                    b.onclick = () => renderMap(m, data.teams, mapListEl, mapContentEl);
                    mapListEl.appendChild(b);
                });
                renderMap(data.maps[0], data.teams, mapListEl, mapContentEl);
            } catch (err) {
                statusEl.className = 'plm-status plm-error';
                statusEl.textContent = 'Error loading match: ' + err.message;
            }
        };
    }

    btn.onclick = showModal;
})();