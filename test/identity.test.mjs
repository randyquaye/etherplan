import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpec } from '../src/core.mjs';
import { canonicalJson, hashJson } from '../src/identity.mjs';
import { exampleSpec, normalizedArtifact, plan } from './interface-fixtures.mjs';

test('identity hashes ignore object key insertion order and exclude self hashes', () => {
  assert.equal(canonicalJson({ b: [2, { z: 1, a: 3 }], a: 1 }), '{"a":1,"b":[2,{"a":3,"z":1}]}');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
  const { artifactHash, ...artifactFields } = normalizedArtifact;
  const { planHash, ...planFields } = plan;
  assert.equal(artifactHash, hashJson(artifactFields));
  assert.equal(planHash, hashJson(planFields));
  assert.equal(plan.specHash, hashJson(parseSpec(structuredClone(exampleSpec))));
});

test('identity hashes reject non-JSON values', () => {
  assert.throws(() => hashJson({ nonce: 1n }), /Canonical JSON/);
  assert.throws(() => hashJson({ value: undefined }), /Canonical JSON/);
});
