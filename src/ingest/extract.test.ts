import assert from 'node:assert/strict';
import test from 'node:test';
import { extract } from './extract.js';

test('does not connect concepts from separate message sections', () => {
  const result = extract(
    '"Sara" discussed family plans with "Diana".\n"AWS" infrastructure uses "CDK" deployments.',
  );
  const pairs = new Set(result.relations.map((relation) =>
    [relation.a.toLowerCase(), relation.b.toLowerCase()].sort().join(':')));

  assert.ok(pairs.has('diana:sara'));
  assert.ok(pairs.has('aws:cdk'));
  assert.ok(!pairs.has('aws:sara'));
  assert.ok(!pairs.has('cdk:sara'));
});
