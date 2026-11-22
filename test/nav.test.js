import test from 'node:test';
import assert from 'node:assert/strict';
import { createNav } from '../server/nav.js';
import { classicLevel } from '../shared/level.js';

const level = classicLevel();
const { findPath, clearLine } = createNav(level);
const hitsWall = level.hitsWall;

const segClear = (path, r = 0.4) => path.every((p, i) => i === 0 || clearLine(path[i - 1], p, r));

test('path from the bedroom to the truck ramp goes through doors, never through walls', () => {
  const path = findPath({ x: -19, z: -9 }, { x: 11, z: 0 });
  assert.ok(path && path.length >= 2, 'path exists');
  assert.ok(segClear(path), 'every segment is clear of walls');
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - 11, last.z) < 0.6);
});

test('path from the office to the kitchen exists and is wall-free', () => {
  const path = findPath({ x: -16.5, z: 8 }, { x: -3, z: 9 });
  assert.ok(path);
  assert.ok(segClear(path));
});

test('target inside a wall snaps to nearest walkable cell', () => {
  const path = findPath({ x: 5, z: 5 }, { x: 0, z: 8 }); // x=0 is the house's outer wall
  assert.ok(path);
  const last = path[path.length - 1];
  assert.equal(hitsWall(last.x, last.z, 0.45), false);
});

test('straight line in open yard is a 2-point path', () => {
  const path = findPath({ x: 4, z: -8 }, { x: 8, z: -6 });
  assert.equal(path.length, 2);
});
