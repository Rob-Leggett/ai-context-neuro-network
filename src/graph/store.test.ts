import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../db/index.js';
import { GraphStore } from './store.js';

test('connections exclude weak related edges and rank by evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-store-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  try {
    const store = new GraphStore(db);
    const source = store.upsertSource('manual', 'test', 'test');
    const sara = store.upsertNode({ label: 'Sara' });
    const aws = store.upsertNode({ label: 'AWS', reinforce: 100 });
    const diana = store.upsertNode({ label: 'Diana' });
    const rob = store.upsertNode({ label: 'Rob' });
    store.linkNodes(sara.id, aws.id, 'related', 1.5);
    store.linkNodes(sara.id, diana.id, 'related', 8);
    store.linkNodes(sara.id, rob.id, 'related', 4);
    for (const node of [sara, diana, rob]) store.addObservation(node.id, source.id, node.label);

    const result = store.connections(sara.id);
    assert.deepEqual(result.nodes.map((node) => node.label), ['Diana', 'Rob']);
    assert.equal(result.nodes[0].connectionWeight, 8);
    assert.equal(result.nodes[0].sharedSources, 1);
    assert.deepEqual(
      store.neighborhood(sara.id).nodes.map((node) => node.label).sort(),
      ['Diana', 'Rob', 'Sara'],
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true });
  }
});
