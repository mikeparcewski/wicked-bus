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
