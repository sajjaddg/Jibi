import { describe, expect, it } from 'vitest';
import doc from '../../docs/SYNC_PROTOCOL.md?raw';
import { KINDS, RESERVED_ID_PREFIXES } from '../src/kinds';
import { ERROR_CODES, routeOf } from '../src/metrics';

/**
 * docs/SYNC_PROTOCOL.md is what the clients are written from, so its lists are held to the
 * Worker's: a kind, a call or an error code added on one side only fails here.
 */

/** The first cell of each row of the table between `<!-- name -->` and `<!-- /name -->`. */
function column(name: string): string[] {
  const block = doc.split(`<!-- ${name} -->`)[1]?.split(`<!-- /${name} -->`)[0] ?? '';
  return [...block.matchAll(/^\| `([^`]+)` \|/gm)].map((row) => row[1]);
}

describe('docs/SYNC_PROTOCOL.md', () => {
  it('lists exactly the kinds the Worker accepts', () => {
    expect(column('kinds').sort()).toEqual([...KINDS].sort());
  });

  it('names every reserved id prefix', () => {
    for (const [prefix] of RESERVED_ID_PREFIXES) expect(doc, prefix).toContain(`\`${prefix}`);
  });

  it('lists exactly the calls the Worker routes', () => {
    const calls = column('endpoints').map((call) => {
      const [method, path] = call.split(' ');
      return { call, route: routeOf(method, path.split('?')[0]) };
    });
    for (const { call, route } of calls) expect(route, call).not.toBeNull();
    // As many calls as routes: GET and POST of /v1/sync are two.
    expect(new Set(calls.map((c) => c.route)).size).toBe(19);
    expect(calls).toHaveLength(19);
  });

  it('lists exactly the error codes the Worker answers', () => {
    expect(column('errors').sort()).toEqual([...ERROR_CODES].sort());
  });
});
