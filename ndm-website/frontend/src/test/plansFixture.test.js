/**
 * The e2e plans fixture is the catalog the API actually serves.
 *
 * e2e/a11y.spec.js answers GET /api/subscription/plans with
 * e2e/fixtures/plans.json, so that the Pricing cards are on the page for axe
 * to measure (note 3 in that spec). The fixture was taken from the live
 * response, and it stayed a copy of the old response after the catalog
 * changed. The sweep kept rendering "Unlimited concurrent downloads" and
 * "Priority support" after the API had stopped serving both. The route
 * (backend routes/subscription.js) returns config/plans.js as it is, so this
 * test holds the fixture to that file. A catalog change now fails here until
 * the fixture is refreshed along with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// A variable, not a literal: vitest under jsdom rewrites
// new URL('…', import.meta.url) into a root-relative URL.
const HERE = import.meta.url;
const { PLANS } = createRequire(HERE)('../../../backend/src/config/plans.js');
const fixture = JSON.parse(readFileSync(new URL('../../e2e/fixtures/plans.json', HERE), 'utf8'));

describe('e2e/fixtures/plans.json', () => {
  it('has the shape the API sends: every plan plus the billing mode', () => {
    expect(fixture.ok).toBe(true);
    expect(Object.keys(fixture.data).sort()).toEqual([...Object.keys(PLANS), 'billing'].sort());
    expect(typeof fixture.data.billing).toBe('string');
  });

  it.each(Object.keys(PLANS))('serves the %s card exactly as config/plans.js defines it', (id) => {
    expect(fixture.data[id]).toEqual(PLANS[id]);
  });
});
