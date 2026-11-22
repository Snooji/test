import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { FileStore, PgStore } from '../server/store.js';

function fileStore() { return new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'))); }
async function pgStore() {
  const { Pool } = newDb().adapters.createPg();
  const s = new PgStore(new Pool());
  await s.init();
  return s;
}

for (const [label, make] of [['file', fileStore], ['postgres', pgStore]]) {
  test(`${label}: signing up twice keeps one row and updates the name`, async () => {
    const s = await make();
    await s.upsertSignup({ name: 'Ada', email: 'ada@x.io', marketing: true });
    await s.upsertSignup({ name: 'Ada L', email: 'ada@x.io', marketing: false });
    const rows = await s.listSignups();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Ada L');
    assert.equal(rows[0].marketing, true, 'consent once given is kept until they unsubscribe');
  });

  test(`${label}: unsubscribe and confirm flags`, async () => {
    const s = await make();
    await s.upsertSignup({ name: 'Bo', email: 'bo@x.io', marketing: true });
    await s.confirm('bo@x.io');
    await s.unsubscribe('bo@x.io');
    const [r] = await s.listSignups();
    assert.equal(r.confirmed, true);
    assert.equal(r.unsubscribed, true);
    assert.equal(r.marketing, false);
  });

  test(`${label}: funnel events count per day`, async () => {
    const s = await make();
    await s.event('visit'); await s.event('visit'); await s.event('signup');
    const f = await s.funnel(7);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(f.find(r => r.day === today && r.name === 'visit').n, 2);
  });

  test(`${label}: daily leaderboard keeps each player's best score`, async () => {
    const s = await make();
    await s.addScore({ day: '2026-11-22', email: 'a@x.io', name: 'Ada', score: 50, detail: 'Full load' });
    await s.addScore({ day: '2026-11-22', email: 'a@x.io', name: 'Ada', score: 80, detail: 'Full load' });
    await s.addScore({ day: '2026-11-22', email: 'b@x.io', name: 'Bo', score: 60, detail: '' });
    await s.addScore({ day: '2026-11-21', email: 'c@x.io', name: 'Cy', score: 999, detail: '' });
    const top = await s.topScores('2026-11-22', 10);
    assert.deepEqual(top.map(t => [t.name, t.score]), [['Ada', 80], ['Bo', 60]]);
  });

  test(`${label}: profiles track games, wins and unlocked suits`, async () => {
    const s = await make();
    let p = await s.getProfile('a@x.io');
    assert.equal(p.games, 0);
    await s.recordGame('a@x.io', { won: true, loaded: 12 });
    await s.recordGame('a@x.io', { won: false, loaded: 3 });
    p = await s.getProfile('a@x.io');
    assert.deepEqual([p.games, p.wins, p.loaded], [2, 1, 15]);
  });

  test(`${label}: errors are kept (most recent first, capped)`, async () => {
    const s = await make();
    for (let i = 0; i < 5; i++) await s.logError({ where: 'client', message: 'boom ' + i, stack: '', ua: 'test' });
    const errs = await s.recentErrors(3);
    assert.equal(errs.length, 3);
    assert.equal(errs[0].message, 'boom 4');
  });
}

test('file store survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'));
  const a = new FileStore(dir);
  await a.upsertSignup({ name: 'Ada', email: 'ada@x.io', marketing: true });
  await a.flush();
  const b = new FileStore(dir);
  assert.equal((await b.listSignups()).length, 1);
});

test('file store imports the old signups.jsonl once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'));
  fs.writeFileSync(path.join(dir, 'signups.jsonl'), ['{"name":"Old","email":"old@x.io","ts":"2026-11-21T00:00:00Z"}', '{"name":"Old2","email":"old@x.io","ts":"2026-11-21T01:00:00Z"}'].join('\n') + '\n');
  const s = new FileStore(dir);
  const rows = await s.listSignups();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Old2');
});
