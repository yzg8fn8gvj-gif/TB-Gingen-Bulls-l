import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const root = process.cwd();
const teams = JSON.parse(await readFile(resolve(root, 'bulls/teams.json'), 'utf8'));
const configDir = resolve(tmpdir(), 'tb-gingen-bulls-team-configs');
await mkdir(configDir, { recursive: true });
const failures = [];
for (const team of teams) {
  const config = {
    sourceUrl: 'https://dvos.de/liga.php?a_liga=' + team.leagueId + '&p=0',
    baseUrl: 'https://dvos.de/',
    leagueId: team.leagueId,
    leagueName: team.leagueName,
    season: team.season,
    teamName: team.teamName,
    teamAliases: [team.teamName],
    eventDurationMinutes: 120
  };
  const configPath = resolve(configDir, team.id + '.json');
  const outputDir = resolve(root, 'bulls/data', team.id);
  await mkdir(outputDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log('\n=== Aktualisiere ' + team.teamName + ' · ' + team.leagueName + ' · DVOS-ID ' + team.leagueId + ' ===');
  const child = spawnSync(process.execPath, [resolve(root, 'scripts/update-bulls-team-calendar.mjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, BULLS_CONFIG_PATH: configPath, BULLS_OUTPUT_DIR: outputDir }
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.status !== 0) {
    failures.push(team.teamName + ': ' + (child.error?.message || 'Updater exit ' + child.status));
    console.error('FEHLER bei ' + team.teamName);
  }
}
if (failures.length) throw new Error('Nicht alle Mannschaftsdaten konnten aktualisiert werden: ' + failures.join('; '));
console.log('\nAlle vier Mannschaften wurden erfolgreich aktualisiert.');
