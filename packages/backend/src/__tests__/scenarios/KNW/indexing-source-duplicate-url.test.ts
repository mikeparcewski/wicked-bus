/**
 * Test harness for incident 603c7f29 — duplicate indexing source registration
 * 
 * This test reproduces the UNIQUE constraint violation on indexing_sources.normalized_remote_url
 * that occurs when the same repository URL is registered twice.
 * 
 * On main (pre-fix): second insert() call throws "UNIQUE constraint failed: indexing_sources.normalized_remote_url"
 * After fix: second insert() call returns cleanly and exactly 1 row exists
 * 
 * File location: packages/backend/src/__tests__/scenarios/KNW/indexing-source-duplicate-url.test.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test-scoped database setup
function createTestDb(): Database.Database {
  const testDbPath = path.join(os.tmpdir(), `test-knw-${Date.now()}.db`);
  const db = new Database(testDbPath);
  
  // Create minimal schema matching production indexing_sources table
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexing_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      remote_url TEXT,
      normalized_remote_url TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  
  return db;
}

// Simplified IndexingRepo.insert() that mirrors production behavior (pre-fix)
class IndexingRepoPreFix {
  constructor(private db: Database.Database) {}
  
  insert(params: { id: string; name: string; remote_url?: string; normalized_remote_url?: string }) {
    const stmt = this.db.prepare(`
      INSERT INTO indexing_sources (id, name, remote_url, normalized_remote_url)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(
      params.id,
      params.name,
      params.remote_url || null,
      params.normalized_remote_url || null
    );
    
    return params.id;
  }
}

// Simplified IndexingRepo.insert() with ON CONFLICT fix (post-fix behavior)
class IndexingRepoPostFix {
  constructor(private db: Database.Database) {}
  
  insert(params: { id: string; name: string; remote_url?: string; normalized_remote_url?: string }) {
    const stmt = this.db.prepare(`
      INSERT INTO indexing_sources (id, name, remote_url, normalized_remote_url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(normalized_remote_url) DO NOTHING
    `);
    
    stmt.run(
      params.id,
      params.name,
      params.remote_url || null,
      params.normalized_remote_url || null
    );
    
    return params.id;
  }
}

describe('KNW — Indexing Source Duplicate URL Registration (AC-1, AC-3)', () => {
  let db: Database.Database;
  
  beforeEach(() => {
    db = createTestDb();
  });
  
  afterEach(() => {
    db.close();
  });
  
  describe('Pre-fix behavior (reproduces incident 603c7f29)', () => {
    it('should throw UNIQUE constraint error when inserting duplicate normalized_remote_url', () => {
      const repo = new IndexingRepoPreFix(db);
      
      const params1 = {
        id: 'source-1',
        name: 'wicked-bus',
        remote_url: 'https://github.com/user/wicked-bus.git',
        normalized_remote_url: 'https://github.com/user/wicked-bus.git',
      };
      
      const params2 = {
        id: 'source-2',
        name: 'wicked-bus',
        remote_url: 'https://github.com/user/wicked-bus.git',
        normalized_remote_url: 'https://github.com/user/wicked-bus.git',
      };
      
      // First insert succeeds
      expect(() => repo.insert(params1)).not.toThrow();
      
      // Second insert with same normalized_remote_url throws
      // This is the documented failure mode on main
      expect(() => repo.insert(params2)).toThrow(/UNIQUE constraint failed.*normalized_remote_url/);
      
      // Verify only 1 row exists
      const count = db.prepare('SELECT COUNT(*) as count FROM indexing_sources').get() as { count: number };
      expect(count.count).toBe(1);
    });
  });
  
  describe('Post-fix behavior (AC-1, AC-3)', () => {
    it('should handle duplicate normalized_remote_url idempotently via ON CONFLICT DO NOTHING', () => {
      const repo = new IndexingRepoPostFix(db);
      
      const params1 = {
        id: 'source-1',
        name: 'wicked-bus',
        remote_url: 'https://github.com/user/wicked-bus.git',
        normalized_remote_url: 'https://github.com/user/wicked-bus.git',
      };
      
      const params2 = {
        id: 'source-2',
        name: 'wicked-bus',
        remote_url: 'https://github.com/user/wicked-bus.git',
        normalized_remote_url: 'https://github.com/user/wicked-bus.git',
      };
      
      // First insert succeeds
      repo.insert(params1);
      
      // Second insert with same normalized_remote_url returns cleanly (AC-3)
      expect(() => repo.insert(params2)).not.toThrow();
      
      // Verify exactly 1 row exists (AC-3)
      const count = db.prepare('SELECT COUNT(*) as count FROM indexing_sources').get() as { count: number };
      expect(count.count).toBe(1);
      
      // Verify it's the FIRST insert that was preserved
      const row = db.prepare('SELECT id FROM indexing_sources LIMIT 1').get() as { id: string };
      expect(row.id).toBe('source-1');
    });
    
    it('should handle duplicate exact URL with different metadata', () => {
      const repo = new IndexingRepoPostFix(db);
      
      const params1 = {
        id: 'source-1',
        name: 'first-name',
        remote_url: 'https://github.com/user/repo.git',
        normalized_remote_url: 'https://github.com/user/repo.git',
      };
      
      const params2 = {
        id: 'source-2',
        name: 'second-name-different',
        remote_url: 'https://github.com/user/repo.git',
        normalized_remote_url: 'https://github.com/user/repo.git',
      };
      
      repo.insert(params1);
      repo.insert(params2);
      
      // Only 1 row should exist despite different name metadata
      const count = db.prepare('SELECT COUNT(*) as count FROM indexing_sources').get() as { count: number };
      expect(count.count).toBe(1);
      
      // First insert wins
      const row = db.prepare('SELECT name FROM indexing_sources LIMIT 1').get() as { name: string };
      expect(row.name).toBe('first-name');
    });
  });
  
  describe('Edge cases', () => {
    it('should allow different normalized_remote_url values', () => {
      const repo = new IndexingRepoPostFix(db);
      
      repo.insert({
        id: 'source-1',
        name: 'repo-a',
        normalized_remote_url: 'https://github.com/user/repo-a.git',
      });
      
      repo.insert({
        id: 'source-2',
        name: 'repo-b',
        normalized_remote_url: 'https://github.com/user/repo-b.git',
      });
      
      const count = db.prepare('SELECT COUNT(*) as count FROM indexing_sources').get() as { count: number };
      expect(count.count).toBe(2);
    });
    
    it('should handle null normalized_remote_url without collision', () => {
      const repo = new IndexingRepoPostFix(db);
      
      // NULL values don't trigger UNIQUE constraint in SQLite
      repo.insert({
        id: 'source-1',
        name: 'local-source-1',
        normalized_remote_url: undefined,
      });
      
      repo.insert({
        id: 'source-2',
        name: 'local-source-2',
        normalized_remote_url: undefined,
      });
      
      const count = db.prepare('SELECT COUNT(*) as count FROM indexing_sources').get() as { count: number };
      expect(count.count).toBe(2);
    });
  });
});
