import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../lib/poll.js';

describe('matchesFilter', () => {
  describe('exact match', () => {
    it('matches identical event type', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.test.run.completed')).toBe(true);
    });

    it('does not match different event type', () => {
      expect(matchesFilter('wicked.test.run.started', 'x', 'wicked.test.run.completed')).toBe(false);
    });
  });

  describe('single-level wildcard', () => {
    it('matches one level deep', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.test.run.*')).toBe(true);
      expect(matchesFilter('wicked.test.run.started', 'x', 'wicked.test.run.*')).toBe(true);
      expect(matchesFilter('wicked.test.run.failed', 'x', 'wicked.test.run.*')).toBe(true);
    });

    it('does not match different prefix', () => {
      expect(matchesFilter('wicked.test.verdict.created', 'x', 'wicked.test.run.*')).toBe(false);
    });

    it('does not match multi-level', () => {
      expect(matchesFilter('wicked.test.run.sub.level', 'x', 'wicked.test.run.*')).toBe(false);
    });

    it('wicked.test.* does NOT match four-segment types (AC-49)', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.test.*')).toBe(false);
    });

    it('wicked.test.* matches three-segment types like wicked.test.run', () => {
      expect(matchesFilter('wicked.test.run', 'x', 'wicked.test.*')).toBe(true);
    });
  });

  describe('multi-level wildcard (**)', () => {
    it('wicked.** matches every event under the wicked prefix (the intuitive filter)', () => {
      // The naming convention is wicked.<noun>.<verb> (3+ segments), so the
      // "subscribe to everything under wicked" filter must be wicked.**
      expect(matchesFilter('wicked.fact.extracted', 'x', 'wicked.**')).toBe(true);
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.**')).toBe(true);
      expect(matchesFilter('wicked.a.b.c.d', 'x', 'wicked.**')).toBe(true);
    });

    it('prefix.** matches one segment deep', () => {
      expect(matchesFilter('wicked.test.run', 'x', 'wicked.test.**')).toBe(true);
    });

    it('prefix.** matches two segments deep', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.test.**')).toBe(true);
    });

    it('prefix.** matches three-plus segments deep', () => {
      expect(matchesFilter('wicked.a.b.c.d.e', 'x', 'wicked.a.**')).toBe(true);
    });

    it('prefix.** does not match a different prefix', () => {
      expect(matchesFilter('wicked.other.run', 'x', 'wicked.test.**')).toBe(false);
    });

    it('prefix.** requires at least one trailing segment (does not match bare prefix)', () => {
      expect(matchesFilter('wicked.test', 'x', 'wicked.test.**')).toBe(false);
    });

    it('** combines with @domain scoping', () => {
      expect(matchesFilter('wicked.fact.extracted', 'wicked-brain', 'wicked.**@wicked-brain')).toBe(true);
      expect(matchesFilter('wicked.fact.extracted', 'other', 'wicked.**@wicked-brain')).toBe(false);
    });
  });

  describe('single-level wildcard is unchanged by ** support', () => {
    it('wicked.* still does NOT match three-segment types', () => {
      // Regression guard: adding ** must not loosen single-* semantics.
      expect(matchesFilter('wicked.fact.extracted', 'x', 'wicked.*')).toBe(false);
    });

    it('wicked.* still matches a two-segment type', () => {
      expect(matchesFilter('wicked.fact', 'x', 'wicked.*')).toBe(true);
    });

    it('exact match still wins and is unaffected', () => {
      expect(matchesFilter('wicked.fact.extracted', 'x', 'wicked.fact.extracted')).toBe(true);
    });
  });

  describe('@domain suffix', () => {
    it('matches with correct domain', () => {
      expect(matchesFilter('wicked.test.run.completed', 'wicked-testing', 'wicked.test.run.*@wicked-testing')).toBe(true);
    });

    it('does not match with wrong domain', () => {
      expect(matchesFilter('wicked.test.run.completed', 'other-plugin', 'wicked.test.run.*@wicked-testing')).toBe(false);
    });

    it('catch-all *@domain matches all types from that domain', () => {
      expect(matchesFilter('wicked.test.run.completed', 'wicked-garden', '*@wicked-garden')).toBe(true);
      expect(matchesFilter('wicked.anything.here', 'wicked-garden', '*@wicked-garden')).toBe(true);
    });

    it('catch-all *@domain does not match other domains', () => {
      expect(matchesFilter('wicked.test.run.completed', 'wicked-testing', '*@wicked-garden')).toBe(false);
    });

    it('exact type with @domain suffix', () => {
      expect(matchesFilter('wicked.test.run.completed', 'wicked-testing', 'wicked.test.run.completed@wicked-testing')).toBe(true);
      expect(matchesFilter('wicked.test.run.completed', 'other', 'wicked.test.run.completed@wicked-testing')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('empty filter matches nothing', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', '')).toBe(false);
    });

    it('filter without wildcard and no match', () => {
      expect(matchesFilter('wicked.test.run.completed', 'x', 'wicked.test.run.started')).toBe(false);
    });
  });
});
