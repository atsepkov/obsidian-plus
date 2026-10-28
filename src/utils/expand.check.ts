// Self-check for expand.ts. Run: ./node_modules/.bin/esbuild src/utils/expand.check.ts --bundle --platform=node | node
import { strict as assert } from 'assert';
import { expandLine, parseExpansionRule, type ExpansionRule } from './expand';

const jira = parseExpansionRule('- `\\b(?:DEVPLAT|INFRA)-\\d+\\b` → `[$0](https://jira.example.com/browse/$0)`')!;
assert.deepEqual(jira, { pattern: '\\b(?:DEVPLAT|INFRA)-\\d+\\b', template: '[$0](https://jira.example.com/browse/$0)' });
assert.equal(parseExpansionRule('- just a note with `one` span'), null);

const rules: ExpansionRule[] = [jira];
const linked = '- see [DEVPLAT-9458](https://jira.example.com/browse/DEVPLAT-9458)';

// Bare key expands; the output is stable on a second pass.
assert.equal(expandLine('- see DEVPLAT-9458', rules), linked);
assert.equal(expandLine(linked, rules), linked);

// Keys inside links, wikilinks, URLs and inline code stay as written.
for (const line of [
    '- [the ticket](https://x.test/DEVPLAT-1)',
    '- [[DEVPLAT-1 notes]]',
    '- https://jira.example.com/browse/DEVPLAT-1',
    '- `DEVPLAT-1`',
]) {
    assert.equal(expandLine(line, rules), line);
}

// Several matches on one line, one of them protected.
assert.equal(
    expandLine('- INFRA-2 and `DEVPLAT-3`', rules),
    '- [INFRA-2](https://jira.example.com/browse/INFRA-2) and `DEVPLAT-3`',
);

// Numbered and named groups, $$ escape; an invalid pattern is skipped.
assert.equal(expandLine('- PR 42', [{ pattern: '\\bPR (\\d+)', template: '[#$1](https://gh.test/pull/$1)' }]), '- [#42](https://gh.test/pull/42)');
assert.equal(expandLine('- cost 5', [{ pattern: 'cost (?<n>\\d+)', template: '$$$<n>' }]), '- $5');
assert.equal(expandLine('- DEVPLAT-1', [{ pattern: '(', template: 'x' }]), '- DEVPLAT-1');

console.log('expand.check: ok');
