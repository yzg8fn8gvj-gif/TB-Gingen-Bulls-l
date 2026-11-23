import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const config = JSON.parse(await readFile(new URL('../bulls/config.json', import.meta.url), 'utf8'));
const sourceUrl = new URL(config.sourceUrl || 'https://dvos.de/liga.php');
sourceUrl.searchParams.set('a_liga', String(config.leagueId));
const response = await fetch(sourceUrl, {
  headers: { 'User-Agent': 'TB-Gingen-Bulls-I-Kalender/1.0', Accept: 'text/html,application/xhtml+xml' },
  signal: AbortSignal.timeout(30000)
});
if (!response.ok) throw new Error('DVOS HTTP ' + response.status);
const html = await response.text();
if (!html || !/TB\s+Gingen\s+Bulls\s+I/i.test(html)) throw new Error('DVOS-Seite enthält nicht die erwartete Mannschaft.');

function decode(value) {
  return String(value ?? '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function clean(value) {
  return decode(String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|span|a|td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function rowsFrom(fragment) {
  const tableRows = [];
  for (const match of fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = match[1];
    const cells = [];
    for (const cell of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(clean(cell[1]));
    tableRows.push({ html: rowHtml, cells, text: clean(rowHtml) });
  }
  if (tableRows.length) return tableRows;

  // DVOS renders this league with div.row / div.cell rather than HTML tables.
  const starts = [...fragment.matchAll(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\brow\b[^"']*["'])[^>]*>/gi)];
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i].index + starts[i][0].length;
    const end = i + 1 < starts.length ? starts[i + 1].index : fragment.length;
    const rowHtml = fragment.slice(begin, end);
    const cells = [];
    for (const cell of rowHtml.matchAll(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bcell\b[^"']*["'])[^>]*>([\s\S]*?)<\/div>/gi)) {
      cells.push(clean(cell[1]));
    }
    if (cells.length) rows.push({ html: rowHtml, cells, text: clean(rowHtml) });
  }
  return rows;
}
function fixtureRowsFrom(fragment) {
  // Matchdays use DVOS if-row1/if-row2 wrappers and ifs-feld1/ifs-feld2 cells.
  const starts = [...fragment.matchAll(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bif-row[12]\b[^"']*["'])[^>]*>/gi)];
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i].index + starts[i][0].length;
    const end = i + 1 < starts.length ? starts[i + 1].index : fragment.length;
    const rowHtml = fragment.slice(begin, end);
    const cells = [];
    for (const cell of rowHtml.matchAll(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bifs-feld[12]\b[^"']*["'])[^>]*>([\s\S]*?)<\/div>/gi)) {
      cells.push(clean(cell[1]));
    }
    rows.push({ html: rowHtml, cells, text: clean(rowHtml) });
  }
  return rows;
}
function parseCupFixtures(fragment) {
  const roundMarkers = [...fragment.matchAll(/Runde\s*(\d+)|Halbfinale|Platz\s*3|Finale/gi)];
  const dateMatches = [...fragment.matchAll(/(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*(\d{1,2}\.\d{1,2}\.\d{4})/gi)];
  const games = new Map();
  for (let i = 0; i < dateMatches.length; i++) {
    const match = dateMatches[i];
    const end = i + 1 < dateMatches.length ? dateMatches[i + 1].index : fragment.length;
    const chunk = fragment.slice(match.index, end);
    const text = decode(chunk
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/\s+/g, ' ')).trim();
    const parts = text.split('|').map(part => part.trim()).filter(Boolean);
    const date = parseDate(match[1]);
    let home = '';
    let away = '';
    let scoreNumbers = [];
    if (parts.length >= 3) {
      home = parts[1];
      away = parts[parts.findIndex((part, index) => index >= 2 && /^-+$/.test(part)) + 1] || '';
      const scoreParts = parts.slice(parts.findIndex(part => part === away) + 1);
      scoreNumbers = scoreParts.map(num).filter(value => value !== null);
    } else {
      const body = text.replace(match[0], '').replace(/DVOS-Pokal[\s\S]*$/i, '').trim();
      const pair = body.match(/^(.*?)\s+-\s+(.*?)(?:\s+(\d{1,2})\s*:\s*(\d{1,2}))?\s*$/);
      if (pair) {
        home = pair[1].trim();
        away = pair[2].trim();
        if (pair[3] !== undefined) scoreNumbers = [Number(pair[3]), Number(pair[4])];
      }
    }
    if (!date || !home || !away || /^spielfrei$/i.test(away)) continue;
    const marker = roundMarkers.filter(item => item.index < match.index).at(-1);
    const roundText = marker ? marker[0] : '';
    const round = roundText.match(/Runde\s*(\d+)/i)?.[1] || roundText;
    const stableKey = [round, home, away].join('|');
    const id = 'cup-' + createHash('sha256').update(config.season + '|' + stableKey).digest('hex').slice(0, 24);
    games.set(stableKey, {
      id, round, date, home, away,
      homeScore: scoreNumbers.length >= 2 ? scoreNumbers[0] : null,
      awayScore: scoreNumbers.length >= 2 ? scoreNumbers[1] : null,
      reportUrl: null
    });
  }
  return [...games.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function parseDate(text) {
  const s = String(text ?? '');
  let m = s.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}
const romanEnd = /(?:VIII|VII|VI|V|IV|III|II|I|X)$/;
function isTeamName(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 5 && romanEnd.test(s) && !/^spieltag/i.test(s) && !/^e\s*\d/i.test(s) && !/^d\s*\d/i.test(s);
}
function num(value) {
  const m = String(value ?? '').match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
function parseStandings(allTables) {
  const bestByTeam = new Map();
  for (const table of allTables) {
    for (const row of table) {
      const idx = row.cells.findIndex(isTeamName);
      if (idx < 1 || row.cells.length < idx + 4) continue;
      const before = row.cells.slice(0, idx).map(num).filter(v => v !== null);
      const after = row.cells.slice(idx + 1);
      const played = num(after[0]);
      const points = num(after[1]);
      if (played === null || points === null) continue;

      // DVOS visually splits a set score (e.g. 52 : 28) across divs.
      const setMatch = row.text.match(/\b(\d+)\s*:\s*(\d+)\b/);
      const numericAfter = after.slice(2).map(num).filter(v => v !== null);
      const setsFor = setMatch ? Number(setMatch[1]) : (numericAfter[0] ?? null);
      const setsAgainst = setMatch ? Number(setMatch[2]) : (numericAfter[1] ?? null);
      const statsStart = setMatch && numericAfter[0] === Number(setMatch[1]) ? 1 : 2;
      const stats = numericAfter.slice(statsStart);
      const item = {
        rank: before.length ? before[before.length - 1] : null,
        team: row.cells[idx],
        played,
        points,
        setsFor,
        setsAgainst,
        wins: stats.length > 0 ? stats[0] : null,
        draws: stats.length > 1 ? stats[1] : null,
        losses: stats.length > 2 ? stats[2] : null
      };
      const quality = [item.setsFor, item.setsAgainst, item.wins, item.draws, item.losses].filter(v => v !== null).length;
      const previous = bestByTeam.get(item.team);
      if (!previous || quality > previous.quality) bestByTeam.set(item.team, { item, quality });
    }
  }
  const rows = [...bestByTeam.values()].map(value => value.item);
  if (rows.length < 5 || !rows.some(row => row.team === config.teamName)) return [];
  return rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
}
function parseFixtures(allRows) {
  const fixtures = new Map();
  let currentRound = null;
  let currentDate = null;
  for (const row of allRows) {
    const roundMatch = row.text.match(/Spieltag\s*(\d+)/i);
    if (roundMatch) currentRound = Number(roundMatch[1]);
    const rowDate = parseDate(row.text);
    if (rowDate) currentDate = rowDate;
    const teams = row.cells.filter(isTeamName);
    if (teams.length < 2 || !currentDate) continue;
    const home = teams[0];
    const away = teams[teams.length - 1];
    if (home === away) continue;
    const scoreMatch = row.text.match(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/);
    const hrefMatch = row.html.match(/href\s*=\s*["']([^"']*spielbericht\.php[^"']*)["']/i);
    const reportUrl = hrefMatch ? new URL(decode(hrefMatch[1]).replace(/&amp;/g, '&'), config.baseUrl).href : null;
    const stableKey = currentRound + '|' + home + '|' + away;
    // Stable across date changes and the later addition of a match-report ID.
    const id = 'dvos-' + createHash('sha256').update(config.leagueId + '|' + stableKey).digest('hex').slice(0, 24);
    const game = {
      id,
      round: currentRound,
      date: currentDate,
      home,
      away,
      homeScore: scoreMatch ? Number(scoreMatch[1]) : null,
      awayScore: scoreMatch ? Number(scoreMatch[2]) : null,
      reportUrl
    };
    fixtures.set([game.date, game.home, game.away].join('|'), game);
  }
  return [...fixtures.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const tableGroups = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => rowsFrom(match[1]));
const layoutRows = rowsFrom(html);
const tables = tableGroups.length ? tableGroups : [layoutRows];
const standings = parseStandings(tables);

// DVOS zeigt in der Ligaansicht mehrere Spieltage über den Parameter p.
// Alle verfügbaren Seiten einlesen und nach Spieltag/Teams zusammenführen.
const fixtureMap = new Map();
const pageDiagnostics = [];
async function addFixturesFromPage(pageNumber, pageHtml) {
  const parsed = parseFixtures(fixtureRowsFrom(pageHtml));
  let added = 0;
  for (const game of parsed) {
    const key = [game.round, game.home, game.away].join('|');
    if (!fixtureMap.has(key)) added++;
    const previous = fixtureMap.get(key);
    fixtureMap.set(key, previous ? {
      ...previous,
      ...game,
      date: game.date || previous.date,
      reportUrl: game.reportUrl || previous.reportUrl,
      homeScore: game.homeScore ?? previous.homeScore,
      awayScore: game.awayScore ?? previous.awayScore
    } : game);
  }
  pageDiagnostics.push({ page: pageNumber, parsed: parsed.length, added });
  return added;
}
await addFixturesFromPage(0, html);
let emptyPages = 0;
for (let pageNumber = 1; pageNumber <= 12; pageNumber++) {
  const pageUrl = new URL(sourceUrl.href);
  pageUrl.searchParams.set('p', String(pageNumber));
  try {
    const pageResponse = await fetch(pageUrl, {
      headers: { 'User-Agent': 'TB-Gingen-Bulls-I-Kalender/1.0', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(30000)
    });
    if (!pageResponse.ok) break;
    const pageHtml = await pageResponse.text();
    if (!pageHtml || !pageHtml.includes(config.teamName)) break;
    const added = await addFixturesFromPage(pageNumber, pageHtml);
    if (added === 0) emptyPages++;
    else emptyPages = 0;
    if (emptyPages >= 2) break;
  } catch (error) {
    console.warn('DVOS-Ligaseite p=' + pageNumber + ' konnte nicht geladen werden:', error.message);
    break;
  }
}
const matches = [...fixtureMap.values()].sort((a, b) => a.date.localeCompare(b.date));

// Die Rückrunde wird nur dann aus der Hinrunde abgeleitet, wenn alle 9
// Hinrunden-Spieltage vollständig (je 5 Begegnungen mit 10 Teams) vorliegen.
function buildReturnFixtures(fixtures) {
  const officialReturn = fixtures
    .filter(game => Number(game.round) >= 10 && Number(game.round) <= 18)
    .sort((a, b) => Number(a.round) - Number(b.round) || (a.date || '').localeCompare(b.date || ''));
  // Die vollständigen Rückrundenspiele stehen bereits auf der aktuellen DVOS-Seite.
  // In diesem Fall ausschließlich diese Originaldaten verwenden.
  if (officialReturn.length === 45) return officialReturn;

  const teams = new Set(standings.map(row => row.team));
  if (teams.size !== 10) return officialReturn;
  const firstLeg = fixtures.filter(game => Number(game.round) >= 1 && Number(game.round) <= 9);
  const firstLegComplete = Array.from({ length: 9 }, (_, index) => index + 1).every(round => {
    const games = firstLeg.filter(game => Number(game.round) === round);
    const involved = games.flatMap(game => [game.home, game.away]);
    return games.length === 5 && involved.length === 10 && new Set(involved).size === 10;
  });
  if (!firstLegComplete) return officialReturn;

  const combined = new Map();
  for (const game of firstLeg) {
    const round = Number(game.round) + 9;
    const home = game.away;
    const away = game.home;
    const key = round + '|' + home + '|' + away;
    const id = 'dvos-' + createHash('sha256').update(config.leagueId + '|' + key).digest('hex').slice(0, 24);
    combined.set(key, {
      id, round, date: null, home, away,
      homeScore: null, awayScore: null, reportUrl: null,
      inferred: true
    });
  }
  for (const game of officialReturn) {
    const key = [game.round, game.home, game.away].join('|');
    combined.set(key, game);
  }
  return [...combined.values()].sort((a, b) => Number(a.round) - Number(b.round) || (a.date || '').localeCompare(b.date || ''));
}
const returnMatches = buildReturnFixtures(matches);

async function fetchTeamAnalysisPage() {
  const fallback = 'https://www.dvos.de/ligaauswertung.php?seite=0';
  try {
    const initial = await fetch(fallback, {
      headers: { 'User-Agent': 'TB-Gingen-Bulls-I-Kalender/1.0', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(30000)
    });
    if (!initial.ok) throw new Error('DVOS-Auswahlseite HTTP ' + initial.status);
    const page = await initial.text();
    const cookies = typeof initial.headers.getSetCookie === 'function'
      ? initial.headers.getSetCookie().map(value => value.split(';')[0]).filter(Boolean)
      : (initial.headers.get('set-cookie') ? [initial.headers.get('set-cookie').split(';')[0]] : []);

    for (const formMatch of page.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      const formAttrs = formMatch[1];
      const formHtml = formMatch[2];
      const actionMatch = formAttrs.match(/action\s*=\s*["']([^"']*)["']/i);
      const action = new URL(actionMatch?.[1] || fallback, fallback);
      const method = (formAttrs.match(/method\s*=\s*["']([^"']*)["']/i)?.[1] || 'GET').toUpperCase();
      const params = new URLSearchParams();

      // Include normal hidden fields and every select's current/default value,
      // exactly as a browser does when the user submits the DVOS form.
      for (const input of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
        const attrs = input[1];
        const name = attrs.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
        const value = attrs.match(/value\s*=\s*["']([^"']*)["']/i)?.[1];
        const type = attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] || 'text';
        if (name && value !== undefined && type.toLowerCase() === 'hidden') params.set(name, decode(value));
      }

      let foundTeam = false;
      for (const select of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
        const attrs = select[1];
        const name = attrs.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!name) continue;
        const options = [...select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(option => ({
          attrs: option[1],
          value: option[1].match(/value\s*=\s*["']([^"']*)["']/i)?.[1] ?? clean(option[2]),
          label: clean(option[2]),
          selected: /\bselected\b/i.test(option[1])
        }));
        if (!options.length) continue;
        let chosen = options.find(option => option.selected) || options[0];
        const teamOption = options.find(option => option.label.toLowerCase() === config.teamName.toLowerCase());
        console.log('DVOS-Auswahlfeld ' + name + ': ' + JSON.stringify({
          selected: options.filter(option => option.selected).map(option => ({value:option.value,label:option.label})),
          first: options.slice(0, 3).map(option => ({value:option.value,label:option.label})),
          team: teamOption ? {value:teamOption.value,label:teamOption.label} : null
        }));
        if (teamOption) {
          chosen = teamOption;
          foundTeam = true;
          console.log('DVOS-Mannschaftsauswertung: ' + config.teamName + ' über Feld ' + name + ' mit Wert ' + chosen.value);
        }
        params.set(name, decode(chosen.value));
      }
      if (!foundTeam) continue;
      const submitControls = [...formHtml.matchAll(/<(button|input)\b([^>]*)>/gi)].map(match => ({
        tag: match[1],
        name: match[2].match(/name\s*=\s*["']([^"']+)["']/i)?.[1] || null,
        type: match[2].match(/type\s*=\s*["']([^"']+)["']/i)?.[1] || null,
        value: match[2].match(/value\s*=\s*["']([^"']*)["']/i)?.[1] || null,
        attrs: match[2].slice(0,180)
      }));
      console.log('DVOS-Formularattribute:', JSON.stringify({formAttrs,submitControls,params:[...params.entries()]}));

      const headers = {
        'User-Agent': 'TB-Gingen-Bulls-I-Kalender/1.0',
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: fallback,
        Origin: 'https://www.dvos.de'
      };
      if (cookies.length) headers.Cookie = cookies.join('; ');
      let response;
      if (method === 'GET') {
        const getUrl = new URL(action.href);
        for (const [key, value] of params) getUrl.searchParams.set(key, value);
        response = await fetch(getUrl, { headers, signal: AbortSignal.timeout(30000) });
      } else {
        response = await fetch(action, {
          method,
          headers,
          body: params.toString(),
          redirect: 'follow',
          signal: AbortSignal.timeout(30000)
        });
      }
      const resultHtml = await response.text();
      const resultText = clean(resultHtml);
      const teamShortName = config.teamName.replace(/^TB\s+/i, '');
      const hasTeamName = resultText.toLowerCase().includes(config.teamName.toLowerCase())
        || resultText.toLowerCase().includes(teamShortName.toLowerCase());
      const hasPlayerTable = /Platz\s+Name\s+Punkte/i.test(resultText);
      const validResult = response.ok && hasTeamName && hasPlayerTable && !/Bitte eine Auswertung auswählen/i.test(resultText);
      const clueMarkers = ['Bitte eine Auswertung auswählen','Auswertung für','Mannschaft:','Punkte','Gesamt','starten'];
      console.log('DVOS-Ergebnis-Marker:', JSON.stringify(clueMarkers.map(marker => {
        const index = resultText.toLowerCase().indexOf(marker.toLowerCase());
        return {marker,index,snippet:index>=0?resultText.slice(Math.max(0,index-80),Math.min(resultText.length,index+240)):''};
      })));
      console.log('DVOS-Auswertung POST/GET-Prüfung:', JSON.stringify({
        method,
        action: action.href,
        status: response.status,
        finalUrl: response.url,
        fields: [...params.keys()],
        teamVerified: validResult,
        responseLength: resultHtml.length,
        title: resultText.slice(0, 260)
      }));

      if (!validResult) continue;
      const pageWithBase = /<head\b[^>]*>/i.test(resultHtml)
        ? resultHtml.replace(/<head\b[^>]*>/i, '$&<base href="https://www.dvos.de/">')
        : '<!doctype html><html lang="de"><head><meta charset="utf-8"><base href="https://www.dvos.de/"></head><body>' + resultHtml + '</body></html>';
      await writeFile(new URL('../bulls/team-analysis.html', import.meta.url), pageWithBase, 'utf8');
      return {
        url: './team-analysis.html',
        sourceUrl: response.url,
        method,
        verified: true
      };
    }
    throw new Error('DVOS-Auswertungsformular oder Mannschaftsauswahl nicht gefunden.');
  } catch (error) {
    console.warn('DVOS-Mannschaftsauswertung nicht verfügbar:', error.message);
    const fallbackHtml = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DVOS-Mannschaftsauswertung</title><style>body{font:16px system-ui;padding:24px;background:#111923;color:#eef}a{color:#9de36a}</style></head><body><h2>DVOS-Auswertung momentan nicht verfügbar</h2><p>Die Originalauswertung konnte beim letzten Datenabruf nicht geladen werden.</p><p><a href="' + fallback + '" target="_blank" rel="noopener">DVOS-Auswertung direkt öffnen</a></p></body></html>';
    await writeFile(new URL('../bulls/team-analysis.html', import.meta.url), fallbackHtml, 'utf8');
    return { url: './team-analysis.html', sourceUrl: fallback, method: 'POST', verified: false };
  }
}
const teamAnalysis = await fetchTeamAnalysisPage();
const cupResponse = await fetch('https://dvos.de/print_pokal.php', {
  headers: { 'User-Agent': 'TB-Gingen-Bulls-I-Kalender/1.0', Accept: 'text/html,application/xhtml+xml' },
  signal: AbortSignal.timeout(30000)
});
if (!cupResponse.ok) throw new Error('DVOS-Pokal HTTP ' + cupResponse.status);
const cupHtml = await cupResponse.text();
const cupMatchesAll = parseCupFixtures(cupHtml);
const cupMatches = cupMatchesAll.filter(game => game.home === config.teamName || game.away === config.teamName);
if (!standings.length && !matches.length) {
  console.log('DVOS parser diagnostics:', JSON.stringify({
    htmlLength: html.length,
    divRows: allRows.length,
    parsedStandings: standings.length,
    parsedMatches: matches.length,
    teamNameFound: html.includes(config.teamName)
  }));
  throw new Error('DVOS-Seite wurde geladen, aber Tabelle und Spielplan konnten nicht erkannt werden. Vorhandene Daten bleiben erhalten.');
}
if (standings.length && !standings.some(row => row.team === config.teamName)) {
  throw new Error('Die erwartete Mannschaft fehlt in der erkannten Tabelle. Vorhandene Daten bleiben erhalten.');
}

const now = new Date();
const teamMatches = matches.filter(game => game.home === config.teamName || game.away === config.teamName);
if (!teamMatches.length) throw new Error('Keine Spiele der Bulls I erkannt. Vorhandener Kalender bleibt erhalten.');

const data = {
  meta: {
    teamName: config.teamName,
    leagueName: config.leagueName,
    season: config.season,
    leagueId: config.leagueId,
    sourceUrl: sourceUrl.href,
    updatedAt: now.toISOString(),
    updateFrequencyHours: 0.25,
    updateFrequencyMinutes: 15,
    scrapedLeaguePages: pageDiagnostics,
    returnRoundAvailable: returnMatches.length >= 45,
    returnRoundType: returnMatches.length >= 45 && returnMatches.every(game => !game.inferred) ? 'official' : (returnMatches.length ? 'inferred' : 'unavailable'),
    teamAnalysisUrl: teamAnalysis.url,
    teamAnalysisSourceUrl: teamAnalysis.sourceUrl,
    teamAnalysisMethod: teamAnalysis.method,
    teamAnalysisVerified: teamAnalysis.verified,
    calendarNote: 'Die DVOS-Spielplanansicht veröffentlicht kein Spielbeginn-Uhrzeitfeld. Kalendertermine werden deshalb als Ganztagstermine geführt.'
  },
  standings,
  matches,
  returnMatches,
  cupMatches
};
await writeFile(new URL('../bulls/data.json', import.meta.url), JSON.stringify(data, null, 2) + '\n', 'utf8');

const pad = n => String(n).padStart(2, '0');
const dateStamp = iso => iso.replace(/-/g, '');
const esc = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
function fold(line) {
  let out = '';
  let part = '';
  for (const ch of line) {
    if (Buffer.byteLength(part + ch) > 70) { out += part + '\r\n'; part = ' ' + ch; }
    else part += ch;
  }
  return out + part;
}
const dtstamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const nextDay = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const lines = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//TB Gingen Bulls//Mannschaft I Liga und Pokal Calendar//DE',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:TB Gingen Bulls I · Liga & Pokal',
  'X-WR-TIMEZONE:Europe/Berlin',
  'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  'X-PUBLISHED-TTL:PT1H',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'X-LIC-LOCATION:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
];
for (const game of [...teamMatches.map(game => ({...game, competition:'Liga'})), ...cupMatches.map(game => ({...game, competition:'Pokal'}))]) {
  if (!game.date) continue;
  const homeGame = game.home === config.teamName;
  const opponent = homeGame ? game.away : game.home;
  const title = homeGame ? config.teamName + ' – ' + opponent : opponent + ' – ' + config.teamName;
  const score = game.homeScore === null || game.awayScore === null ? '' : 'Ergebnis: ' + game.homeScore + ':' + game.awayScore;
  const isCup = game.competition === 'Pokal';
  const details = [
    isCup ? 'DVOS-Pokal' : 'Ligaspiel',
    homeGame ? 'Heimspiel' : 'Auswärtsspiel',
    game.round ? (isCup ? 'Pokalrunde ' : 'Spieltag ') + game.round : '',
    score,
    'Uhrzeit: von der DVOS-Quelle nicht veröffentlicht; Termin daher ganztägig',
    'Quelle: ' + (isCup ? 'https://dvos.de/pokal.php' : sourceUrl.href)
  ].filter(Boolean).join('\n');
  const eventUrl = game.reportUrl || (isCup ? 'https://dvos.de/pokal.php' : sourceUrl.href);
  lines.push(
    'BEGIN:VEVENT',
    'UID:' + esc(game.id + '@tbgingenbulls1'),
    'DTSTAMP:' + dtstamp,
    'SUMMARY:' + esc((isCup ? '🏆 POKAL: ' : '') + title),
    'DTSTART;VALUE=DATE:' + dateStamp(game.date),
    'DTEND;VALUE=DATE:' + dateStamp(nextDay(game.date)),
    'DESCRIPTION:' + esc(details),
    'URL:' + eventUrl,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT'
  );
}
lines.push('END:VCALENDAR');
await writeFile(new URL('../bulls/calendar.ics', import.meta.url), lines.map(fold).join('\r\n') + '\r\n', 'utf8');
console.log('Bulls-I-Daten aktualisiert: ' + standings.length + ' Tabellenzeilen, ' + matches.length + ' Ligaspiele aus ' + pageDiagnostics.length + ' DVOS-Seiten, ' + returnMatches.length + ' abgeleitete Rückrundenspiele, ' + cupMatches.length + ' Pokalspiele. Seiten: ' + JSON.stringify(pageDiagnostics));
