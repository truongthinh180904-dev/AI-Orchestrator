import { describe, expect, it } from 'vitest';
import {
  formatConventionalCommit,
  parseConventionalCommit,
  validateConventionalCommit,
  isConventionalCommit,
  CONVENTIONAL_COMMIT_TYPES,
  AppError,
} from '../index.js';

describe('Conventional Commits Specification', () => {
  describe('formatConventionalCommit', () => {
    it('formats a simple commit without scope', () => {
      const msg = formatConventionalCommit({
        type: 'feat',
        subject: 'add new feature',
      });
      expect(msg).toBe('feat: add new feature');
    });

    it('formats a commit with scope', () => {
      const msg = formatConventionalCommit({
        type: 'fix',
        scope: 'parser',
        subject: 'resolve newline escaping',
      });
      expect(msg).toBe('fix(parser): resolve newline escaping');
    });

    it('formats a breaking change with exclamation mark', () => {
      const msg = formatConventionalCommit({
        type: 'feat',
        scope: 'api',
        is_breaking: true,
        subject: 'change response structure',
      });
      expect(msg).toBe('feat(api)!: change response structure');
    });

    it('formats a commit with body and footer', () => {
      const msg = formatConventionalCommit({
        type: 'refactor',
        scope: 'db',
        subject: 'migrate connection pool',
        body: 'This improves database query latency and resource cleanup.',
        footer: 'Closes #123',
      });
      expect(msg).toBe(
        'refactor(db): migrate connection pool\n\nThis improves database query latency and resource cleanup.\n\nCloses #123',
      );
    });

    it('throws validation error if subject is empty', () => {
      expect(() =>
        formatConventionalCommit({
          type: 'chore',
          subject: '',
        }),
      ).toThrow();
    });
  });

  describe('parseConventionalCommit', () => {
    it.each(CONVENTIONAL_COMMIT_TYPES)('parses valid type "%s"', (type) => {
      const parsed = parseConventionalCommit(`${type}(REL-004): message for ${type}`);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(type);
      expect(parsed?.scope).toBe('REL-004');
      expect(parsed?.subject).toBe(`message for ${type}`);
      expect(parsed?.is_breaking).toBe(false);
    });

    it('parses commit without scope', () => {
      const parsed = parseConventionalCommit('docs: update README');
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('docs');
      expect(parsed?.scope).toBeNull();
      expect(parsed?.subject).toBe('update README');
    });

    it('detects breaking change marked with "!"', () => {
      const parsed = parseConventionalCommit('feat(auth)!: require multi-factor auth');
      expect(parsed).not.toBeNull();
      expect(parsed?.is_breaking).toBe(true);
    });

    it('detects breaking change in footer', () => {
      const msg = 'feat(config): change options\n\nBREAKING CHANGE: environment variables renamed';
      const parsed = parseConventionalCommit(msg);
      expect(parsed).not.toBeNull();
      expect(parsed?.is_breaking).toBe(true);
      expect(parsed?.body).toBe('BREAKING CHANGE: environment variables renamed');
    });

    it('parses multiline body and footer', () => {
      const msg =
        'test(e2e): add integration suite\n\nDetailed explanation of tests.\n\nCo-authored-by: AI <ai@orchestrator.local>';
      const parsed = parseConventionalCommit(msg);
      expect(parsed).not.toBeNull();
      expect(parsed?.body).toBe('Detailed explanation of tests.');
      expect(parsed?.footer).toBe('Co-authored-by: AI <ai@orchestrator.local>');
    });

    it('returns null for non-conventional messages', () => {
      expect(parseConventionalCommit('updated some files')).toBeNull();
      expect(parseConventionalCommit('Fixed bug')).toBeNull();
      expect(parseConventionalCommit('random(scope): message')).toBeNull();
      expect(parseConventionalCommit('')).toBeNull();
      expect(parseConventionalCommit('feat:')).toBeNull();
    });
  });

  describe('validateConventionalCommit & isConventionalCommit', () => {
    it('returns parsed commit when valid', () => {
      const parsed = validateConventionalCommit('feat(REL-004): standardized commits and save SHA');
      expect(parsed.type).toBe('feat');
      expect(parsed.scope).toBe('REL-004');
      expect(isConventionalCommit('feat(REL-004): standardized commits and save SHA')).toBe(true);
    });

    it('throws AppError("INVALID_COMMIT_MESSAGE") when invalid', () => {
      try {
        validateConventionalCommit('just some commit message');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_COMMIT_MESSAGE');
      }

      expect(isConventionalCommit('just some commit message')).toBe(false);
    });
  });
});
