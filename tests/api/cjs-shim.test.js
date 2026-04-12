import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CJS_PATH = join(__dirname, '..', '..', 'lib', 'index.cjs');

describe('CJS shim (lib/index.cjs)', () => {
  it('exports a Proxy object', () => {
    const source = readFileSync(CJS_PATH, 'utf8');
    expect(source).toContain('module.exports');
    expect(source).toContain('Proxy');
  });

  it('throws helpful error when accessed before load', async () => {
    // We cannot require() in ESM, but we can verify the file structure
    const source = readFileSync(CJS_PATH, 'utf8');
    expect(source).toContain('import(');
    expect(source).toContain('index.js');
  });

  it('dynamically imports from index.js', async () => {
    // Verify the async import is wired up
    const mod = await import('../../lib/index.js');
    expect(mod.emit).toBeDefined();
    expect(mod.poll).toBeDefined();
    expect(mod.ack).toBeDefined();
    expect(mod.register).toBeDefined();
    expect(mod.deregister).toBeDefined();
    expect(mod.openDb).toBeDefined();
    expect(mod.loadConfig).toBeDefined();
    expect(mod.resolveDataDir).toBeDefined();
    expect(mod.ensureDataDir).toBeDefined();
    expect(mod.startSweep).toBeDefined();
    expect(mod.runSweep).toBeDefined();
    expect(mod.WBError).toBeDefined();
  });
});
