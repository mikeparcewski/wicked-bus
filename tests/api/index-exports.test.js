import { describe, it, expect } from 'vitest';
import * as wickedBus from '../../lib/index.js';

describe('ESM exports', () => {
  it('exports emit', () => {
    expect(typeof wickedBus.emit).toBe('function');
  });

  it('exports poll', () => {
    expect(typeof wickedBus.poll).toBe('function');
  });

  it('exports ack', () => {
    expect(typeof wickedBus.ack).toBe('function');
  });

  it('exports register', () => {
    expect(typeof wickedBus.register).toBe('function');
  });

  it('exports deregister', () => {
    expect(typeof wickedBus.deregister).toBe('function');
  });

  it('exports openDb', () => {
    expect(typeof wickedBus.openDb).toBe('function');
  });

  it('exports loadConfig', () => {
    expect(typeof wickedBus.loadConfig).toBe('function');
  });

  it('exports resolveDataDir', () => {
    expect(typeof wickedBus.resolveDataDir).toBe('function');
  });

  it('exports ensureDataDir', () => {
    expect(typeof wickedBus.ensureDataDir).toBe('function');
  });

  it('exports startSweep', () => {
    expect(typeof wickedBus.startSweep).toBe('function');
  });

  it('exports runSweep', () => {
    expect(typeof wickedBus.runSweep).toBe('function');
  });

  it('exports WBError', () => {
    expect(typeof wickedBus.WBError).toBe('function');
  });

  it('exports matchesFilter', () => {
    expect(typeof wickedBus.matchesFilter).toBe('function');
  });
});
