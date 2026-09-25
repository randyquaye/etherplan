import assert from 'node:assert/strict';
import test from 'node:test';
import { executionWaves } from '../src/scheduling/index.mjs';
import { dependencyWarnings, executionOrder, graph, parseSpec } from '../src/spec/index.mjs';

const ONE = '0x0000000000000000000000000000000000000001';
const ORACLE = '0x00000000000000000000000000000000000000e1';
const DOUBLER = 'src/Sample.sol:Doubler';
const salt = digit => `0x${digit.repeat(64)}`;

function holder(id, digit, arg, extra = {}) {
  return { id, artifact: 'Holder.json', salt: salt(digit), args: [arg], ...extra };
}

function call(id, target, extra = {}) {
  return { id, target, method: 'setValue', args: [{ ref: 'values.one' }], check: { function: 'value', equals: { ref: 'values.one' } }, before: { equals: { ref: 'values.zero' } }, ...extra };
}

function spec(fields) {
  return { schema: 2, chainId: 31337, values: { one: ONE, zero: '0x0000000000000000000000000000000000000000' }, ...fields };
}

function nodes(raw) {
  return new Map(graph(parseSpec(raw)).map(node => [node.id, node]));
}

function edges(node) {
  return { needs: node.resolutionEdges, after: node.executionEdges };
}

// Every reference position in one spec: b stores a's address, c links a, d checks a, e needs a live, f runs after a, g uses an external.
function referenceSpec(extra = {}) {
  return spec({
    externals: { oracle: { address: ORACLE } },
    contracts: [
      holder('a', '1', { ref: 'values.one' }),
      holder('b', '2', { ref: 'contracts.a.address' }),
      { id: 'c', artifact: 'Linked.json', salt: salt('3'), args: ['21'], libraries: { [DOUBLER]: { ref: 'contracts.a.address' } } },
      holder('d', '4', { ref: 'values.one' }, { checks: { UPSTREAM: { ref: 'contracts.a.address' } } }),
      holder('e', '5', { ref: 'contracts.a.address', requiresLive: true }),
      holder('f', '6', { ref: 'values.one' }, { after: ['contract:a'] }),
      holder('g', '7', { ref: 'externals.oracle.address' }),
    ],
    calls: [
      call('bind', 'b', { args: [{ ref: 'contracts.d.address' }] }),
      call('bindEmpty', 'b', { after: [] }),
    ],
    ...extra,
  });
}

test('split mode resolves address references without adding execution edges', () => {
  const graphNodes = nodes(referenceSpec());
  const a = { id: 'contract:a' };
  assert.deepEqual(edges(graphNodes.get('contract:a')), { needs: [], after: [] });
  assert.deepEqual(edges(graphNodes.get('contract:b')), { needs: [{ ...a, reasons: ['args[0] needs contracts.a.address'] }], after: [] });
  assert.deepEqual(edges(graphNodes.get('contract:c')), { needs: [{ ...a, reasons: [`libraries.${DOUBLER} needs contracts.a.address`] }], after: [] });
  assert.deepEqual(edges(graphNodes.get('contract:d')), { needs: [{ ...a, reasons: ['checks.UPSTREAM needs contracts.a.address'] }], after: [] });
  assert.deepEqual(edges(graphNodes.get('contract:e')), {
    needs: [{ ...a, reasons: ['args[0] needs contracts.a.address'] }],
    after: [{ ...a, reasons: ['requiresLive contracts.a.address'] }],
  });
  assert.deepEqual(edges(graphNodes.get('contract:f')), { needs: [], after: [{ ...a, reasons: ['explicit after'] }] });
  assert.deepEqual(edges(graphNodes.get('contract:g')), {
    needs: [{ id: 'external:oracle', reasons: ['args[0] needs externals.oracle.address'] }],
    after: [{ id: 'external:oracle', reasons: ['external verification externals.oracle.address'] }],
  });

  // A call always waits for its live target, even with after: []. Its address arguments stay resolution-only.
  assert.deepEqual(edges(graphNodes.get('call:bind')), {
    needs: [{ id: 'contract:b', reasons: ['call target address'] }, { id: 'contract:d', reasons: ['args[0] needs contracts.d.address'] }],
    after: [{ id: 'contract:b', reasons: ['live call target'] }],
  });
  assert.deepEqual(graphNodes.get('call:bindEmpty').executionEdges, [{ id: 'contract:b', reasons: ['live call target'] }]);
  for (const node of graphNodes.values()) assert.deepEqual(node.dependencies, node.executionDependencies);
});

test('compatibility mode makes every reference an execution edge', () => {
  for (const mode of [{ dependencyMode: 'compatibility' }, { schema: 1 }]) {
    for (const node of nodes(referenceSpec(mode)).values()) {
      const expected = [...new Set([...node.resolutionDependencies, ...(node.item.after ?? [])])].sort();
      assert.deepEqual(node.executionDependencies, expected, `${node.id} in ${JSON.stringify(mode)}`);
    }
  }
  assert.deepEqual(nodes(referenceSpec({ dependencyMode: 'compatibility' })).get('contract:b').executionEdges, [
    { id: 'contract:a', reasons: ['compatibility reference contracts.a.address'] },
  ]);
});

test('an ownership transfer waits for every owner-only call on its own target', () => {
  const graphNodes = nodes(spec({
    contracts: [holder('vault', '1', { ref: 'values.one' }), holder('pool', '2', { ref: 'values.one' })],
    calls: [
      call('setA', 'vault', { ownerOnly: true }),
      call('setB', 'vault', { ownerOnly: true }),
      call('note', 'vault'),
      call('setPool', 'pool', { ownerOnly: true }),
      call('transferVault', 'vault', { method: 'transferOwnership' }),
      call('handOverPool', 'pool', { method: 'setOwner', transfersOwnership: true }),
    ],
  }));
  const rule = ['owner-only configuration before ownership transfer'];
  assert.deepEqual(graphNodes.get('call:transferVault').executionEdges, [
    { id: 'call:setA', reasons: rule },
    { id: 'call:setB', reasons: rule },
    { id: 'contract:vault', reasons: ['live call target'] },
  ]);
  assert.deepEqual(graphNodes.get('call:handOverPool').executionEdges, [
    { id: 'call:setPool', reasons: rule },
    { id: 'contract:pool', reasons: ['live call target'] },
  ]);
  assert.deepEqual(graphNodes.get('call:note').executionDependencies, ['contract:vault']);
});

test('resolution and execution cycles fail with different errors, and opposite orders are valid', () => {
  const resolutionCycle = spec({ contracts: [holder('a', '1', { ref: 'contracts.b.address' }), holder('b', '2', { ref: 'contracts.a.address' })] });
  const executionCycle = spec({ contracts: [holder('a', '1', { ref: 'values.one' }, { after: ['contract:b'] }), holder('b', '2', { ref: 'values.one' }, { after: ['contract:a'] })] });
  assert.throws(() => graph(parseSpec(resolutionCycle)), /^Error: Resolution dependency cycle at contract:a\.$/);
  assert.throws(() => graph(parseSpec(executionCycle)), /^Error: Execution dependency cycle at contract:a\.$/);
  assert.throws(() => graph(parseSpec({ ...resolutionCycle, schema: 1 })), /^Error: Dependency cycle at contract:a\.$/);
  assert.throws(() => graph(parseSpec(spec({ contracts: [holder('a', '1', { ref: 'values.one' }, { after: ['contract:a'] })] }))), /Execution dependency cycle at contract:a/);

  // a needs b's address, so b resolves first; b runs after a, so a executes first.
  const mixed = parseSpec(spec({ contracts: [holder('a', '1', { ref: 'contracts.b.address' }), holder('b', '2', { ref: 'values.one' }, { after: ['contract:a'] })] }));
  const ordered = graph(mixed);
  assert.deepEqual(ordered.map(node => node.id), ['contract:b', 'contract:a']);
  assert.deepEqual(executionOrder(ordered).map(node => node.id), ['contract:a', 'contract:b']);
  const planned = ordered.map(node => ({ id: node.id, dependencies: node.dependencies, action: 'deploy' }));
  assert.deepEqual(executionWaves(planned), { waves: [['contract:a'], ['contract:b']], deferred: [] });
});

test('creation warnings clear only for an execution edge or an assumption that names the exact contract', () => {
  const warningsFor = fields => {
    const parsed = parseSpec(spec({
      contracts: [
        holder('portal', '1', { ref: 'values.one' }),
        holder('registry', '2', { ref: 'values.one' }),
        { id: 'doubler', artifact: 'Doubler.json', salt: salt('3'), args: [] },
        holder('usesPortal', '4', { ref: 'contracts.portal.address' }),
        holder('usesRegistry', '5', { ref: 'contracts.registry.address' }, { checks: { UPSTREAM: { ref: 'contracts.portal.address' } } }),
        { id: 'linked', artifact: 'Linked.json', salt: salt('6'), args: ['21'], libraries: { [DOUBLER]: { ref: 'contracts.doubler.address' } } },
      ],
      ...fields,
    }));
    return dependencyWarnings(parsed, graph(parsed));
  };
  const portal = 'contract:usesPortal constructor references contracts.portal.address without an execution dependency; confirm its constructor does not call the referenced contract.';
  const registry = 'contract:usesRegistry constructor references contracts.registry.address without an execution dependency; confirm its constructor does not call the referenced contract.';
  const library = 'contract:linked links library contracts.doubler.address without an execution dependency; confirm its constructor does not call the referenced contract.';

  assert.deepEqual(warningsFor({}), [library, portal, registry]);
  assert.deepEqual(warningsFor({ executionAssumptions: ['constructor does not call contracts.portal'] }), [library, registry]);
  assert.deepEqual(warningsFor({ executionAssumptions: ['constructor does not call contracts.portal.address', 'Doubler is pure: contracts.doubler'] }), [registry]);
  assert.deepEqual(warningsFor({ executionAssumptions: ['constructor does not call contracts.portalV2', 'constructor does not call xcontracts.registry'] }), [library, portal, registry]);
  assert.deepEqual(warningsFor({ dependencyMode: 'compatibility' }), []);
});

test('an execution edge from after or requiresLive clears the creation warning', () => {
  for (const reference of [{ ref: 'contracts.portal.address', requiresLive: true }, { ref: 'contracts.portal.address' }]) {
    const parsed = parseSpec(spec({
      contracts: [holder('portal', '1', { ref: 'values.one' }), holder('user', '2', reference, reference.requiresLive ? {} : { after: ['contract:portal'] })],
    }));
    assert.deepEqual(dependencyWarnings(parsed, graph(parsed)), []);
  }
});

test('the spec rejects invalid dependency fields and undeclared outputs', () => {
  const base = () => spec({ contracts: [holder('a', '1', { ref: 'values.one' }), holder('b', '2', { ref: 'contracts.a.address' })], calls: [call('bind', 'b')] });
  const rejects = (edit, pattern) => {
    const raw = base();
    edit(raw);
    assert.throws(() => graph(parseSpec(raw)), pattern);
  };
  rejects(raw => { raw.schema = 3; }, /schema: 1 or 2/);
  rejects(raw => { raw.dependencyMode = 'loose'; }, /dependencyMode must be split or compatibility/);
  for (const assumptions of [[''], ['   '], 'constructor does not call contracts.a', [1]]) {
    rejects(raw => { raw.executionAssumptions = assumptions; }, /executionAssumptions must be nonempty strings/);
  }
  rejects(raw => { raw.contracts[1].args = [{ ref: 'contracts.a.address', requiresLive: 'true' }]; }, /optional boolean requiresLive/);
  rejects(raw => { raw.contracts[1].args = [{ ref: 'contracts.a.address', live: true }]; }, /optional boolean requiresLive/);
  rejects(raw => { raw.contracts[0].args = [{ ref: 'values.one', requiresLive: true }]; }, /cannot use requiresLive on value values\.one/);
  rejects(raw => { raw.calls[0].ownerOnly = 'yes'; }, /ownerOnly must be boolean/);
  rejects(raw => { raw.calls[0].transfersOwnership = 1; }, /transfersOwnership must be boolean/);
  rejects(raw => { raw.contracts[0].ownerOnly = true; }, /unknown field ownerOnly/);
  rejects(raw => { raw.contracts[0].after = ['a']; }, /invalid dependency a/);
  rejects(raw => { raw.contracts[0].after = ['call:missing']; }, /Missing execution dependency resource call:missing/);
  rejects(raw => { raw.contracts[1].args = [{ ref: 'contracts.a.codeHash' }]; }, /invalid reference contracts\.a\.codeHash/);
  rejects(raw => { raw.contracts[1].args = [{ ref: 'values.one.address' }]; }, /invalid reference values\.one\.address/);
  rejects(raw => { raw.contracts[1].args = [{ ref: 'contracts.missing.address' }]; }, /Missing graph node contract:missing/);
});
