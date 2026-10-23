import { z } from 'zod';
import { AppError } from '../errors.js';

/**
 * Standard Conventional Commits 1.0.0 allowed types.
 */
export const CONVENTIONAL_COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export const ConventionalCommitTypeSchema = z.enum(CONVENTIONAL_COMMIT_TYPES);
export type ConventionalCommitType = z.infer<typeof ConventionalCommitTypeSchema>;

/**
 * Parsed representation of a Conventional Commit message.
 */
export const ParsedConventionalCommitSchema = z.object({
  type: ConventionalCommitTypeSchema,
  scope: z.string().nullable().default(null),
  is_breaking: z.boolean().default(false),
  subject: z.string().min(1, 'Subject cannot be empty'),
  body: z.string().nullable().default(null),
  footer: z.string().nullable().default(null),
  raw: z.string().min(1),
});

export type ParsedConventionalCommit = z.infer<typeof ParsedConventionalCommitSchema>;

/**
 * Input for formatting a Conventional Commit message.
 */
export const FormatConventionalCommitInputSchema = z.object({
  type: ConventionalCommitTypeSchema,
  scope: z.string().optional().nullable(),
  is_breaking: z.boolean().optional().default(false),
  subject: z.string().min(1, 'Subject cannot be empty'),
  body: z.string().optional().nullable(),
  footer: z.string().optional().nullable(),
});

export type FormatConventionalCommitInput = z.input<typeof FormatConventionalCommitInputSchema>;

/**
 * Regular expression parsing Conventional Commit header:
 * Format: <type>(<scope>)<!>: <subject>
 */
const CONVENTIONAL_HEADER_REGEX =
  /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)\r\n]+)\))?(?<breaking>!)?:\s*(?<subject>[^\r\n]+)$/;

/**
 * Formats structured input into a standardized Conventional Commit message.
 */
export function formatConventionalCommit(input: FormatConventionalCommitInput): string {
  const validated = FormatConventionalCommitInputSchema.parse(input);
  const scopePart = validated.scope && validated.scope.trim().length > 0 ? `(${validated.scope.trim()})` : '';
  const breakingPart = validated.is_breaking ? '!' : '';
  const subjectClean = validated.subject.trim();

  const header = `${validated.type}${scopePart}${breakingPart}: ${subjectClean}`;

  const parts = [header];
  if (validated.body && validated.body.trim().length > 0) {
    parts.push('', validated.body.trim());
  }
  if (validated.footer && validated.footer.trim().length > 0) {
    parts.push('', validated.footer.trim());
  }

  return parts.join('\n');
}

/**
 * Parses a commit message string into a Conventional Commit object.
 * Returns null if the message does not adhere to Conventional Commits specification.
 */
export function parseConventionalCommit(message: string): ParsedConventionalCommit | null {
  if (!message || typeof message !== 'string') {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  const headerLine = lines[0] ?? '';

  const headerMatch = CONVENTIONAL_HEADER_REGEX.exec(headerLine.trim());
  if (!headerMatch || !headerMatch.groups) {
    return null;
  }

  const rawType = headerMatch.groups.type?.toLowerCase();
  if (!rawType || !CONVENTIONAL_COMMIT_TYPES.includes(rawType as ConventionalCommitType)) {
    return null;
  }

  const scope = headerMatch.groups.scope?.trim() || null;
  const hasExclamation = Boolean(headerMatch.groups.breaking);
  const subject = headerMatch.groups.subject?.trim();

  if (!subject) {
    return null;
  }

  // Parse remaining lines as body and footers
  let body: string | null = null;
  let footer: string | null = null;
  let hasBreakingInFooter = false;

  if (lines.length > 1) {
    const remaining = lines.slice(1).join('\n').trim();
    if (remaining.length > 0) {
      // Check for BREAKING CHANGE or BREAKING-CHANGE in body/footer
      if (remaining.includes('BREAKING CHANGE:') || remaining.includes('BREAKING-CHANGE:')) {
        hasBreakingInFooter = true;
      }

      // Check if there is a distinct footer separated by double newline
      const sections = remaining.split(/\r?\n\r?\n/);
      if (sections.length > 1) {
        const lastSection = sections[sections.length - 1]?.trim() ?? '';
        if (
          lastSection.startsWith('BREAKING CHANGE:') ||
          lastSection.startsWith('BREAKING-CHANGE:') ||
          /^[A-Za-z0-9_-]+:\s+.+/.test(lastSection)
        ) {
          footer = lastSection;
          body = sections.slice(0, -1).join('\n\n').trim();
        } else {
          body = remaining;
        }
      } else {
        body = remaining;
      }
    }
  }

  const isBreaking = hasExclamation || hasBreakingInFooter;

  return {
    type: rawType as ConventionalCommitType,
    scope,
    is_breaking: isBreaking,
    subject,
    body: body || null,
    footer: footer || null,
    raw: trimmed,
  };
}

/**
 * Validates whether a commit message strictly complies with Conventional Commits.
 * Throws AppError('INVALID_COMMIT_MESSAGE') if invalid.
 */
export function validateConventionalCommit(message: string): ParsedConventionalCommit {
  const parsed = parseConventionalCommit(message);
  if (!parsed) {
    throw new AppError(
      'INVALID_COMMIT_MESSAGE',
      `Commit message "${message.split('\n')[0]}" does not adhere to Conventional Commits specification (e.g. "feat(scope): description")`,
      {
        message,
        allowedTypes: CONVENTIONAL_COMMIT_TYPES,
        example: 'feat(REL-004): standardized commits and save SHA to DB',
      },
    );
  }
  return parsed;
}

/**
 * Returns true if the message adheres to Conventional Commits specification.
 */
export function isConventionalCommit(message: string): boolean {
  return parseConventionalCommit(message) !== null;
}
