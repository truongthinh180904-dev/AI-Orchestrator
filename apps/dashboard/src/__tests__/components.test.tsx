/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RepoSelector } from '../components/RepoSelector.js';
import { ImportPreview } from '../components/ImportPreview.js';
import { ImportWorkflow } from '../components/ImportWorkflow.js';
import { ApiClient } from '../lib/api.js';
import type { ImportDryRunResult, ImportCommitResult } from '@ai-orchestrator/shared';

describe('Dashboard Components (TSK-007)', () => {
  afterEach(() => {
    cleanup();
  });

  describe('RepoSelector', () => {
    it('renders repository input and file path input by default', () => {
      render(<RepoSelector onPreview={vi.fn()} isLoading={false} />);

      const repoInput = screen.getByTestId('repo-path-input') as HTMLInputElement;
      expect(repoInput.value).toBe('.');

      const filePathInput = screen.getByTestId('file-path-input') as HTMLInputElement;
      expect(filePathInput.value).toBe('fixtures/sample-tasks.xlsx');

      const submitBtn = screen.getByTestId('preview-import-btn');
      expect(submitBtn).toBeDefined();
      expect(submitBtn.hasAttribute('disabled')).toBe(false);
    });

    it('switches to raw CSV mode and updates inputs', () => {
      render(<RepoSelector onPreview={vi.fn()} isLoading={false} />);

      const csvRadio = screen.getByTestId('source-type-rawcsv');
      fireEvent.click(csvRadio);

      const textarea = screen.getByTestId('raw-csv-input');
      expect(textarea).toBeDefined();
    });

    it('disables submit button and controls when isLoading is true', () => {
      render(<RepoSelector onPreview={vi.fn()} isLoading={true} />);

      const submitBtn = screen.getByTestId('preview-import-btn');
      expect(submitBtn.hasAttribute('disabled')).toBe(true);
      expect(submitBtn.textContent).toContain('Đang kiểm tra...');

      const repoInput = screen.getByTestId('repo-path-input');
      expect(repoInput.hasAttribute('disabled')).toBe(true);
    });

    it('calls onPreview with parameters on form submit', () => {
      const handlePreview = vi.fn();
      render(<RepoSelector onPreview={handlePreview} isLoading={false} />);

      const repoInput = screen.getByTestId('repo-path-input');
      fireEvent.change(repoInput, { target: { value: './my-repo' } });

      const filePathInput = screen.getByTestId('file-path-input');
      fireEvent.change(filePathInput, { target: { value: 'custom/tasks.xlsx' } });

      const submitBtn = screen.getByTestId('preview-import-btn');
      fireEvent.click(submitBtn);

      expect(handlePreview).toHaveBeenCalledTimes(1);
      expect(handlePreview).toHaveBeenCalledWith({
        repository: './my-repo',
        filePath: 'custom/tasks.xlsx',
      });
    });
  });

  describe('ImportPreview', () => {
    it('renders empty state placeholder when preview is null', () => {
      render(<ImportPreview preview={null} />);

      const emptyState = screen.getByTestId('preview-empty-state');
      expect(emptyState.textContent).toContain('Chưa có dữ liệu xem trước');
    });

    it('renders valid preview with summary and tasks table', () => {
      const validPreview: ImportDryRunResult = {
        dryRun: true,
        valid: true,
        summary: {
          tasksCount: 2,
          featuresCount: 1,
          errorsCount: 0,
          warningsCount: 0,
        },
        report: {
          valid: true,
          errors: [],
          warnings: [],
          errorCount: 0,
          warningCount: 0,
          summary: 'Valid',
        },
        preview: {
          tasks: [
            {
              id: 'TSK-101',
              title: 'First task',
              description: null,
              phase: 'GĐ 1',
              repository: '.',
              dependencies: [],
              status: 'TODO',
              feature_id: 'FEAT-1',
              worker_type: 'agy',
              acceptance_criteria: ['Pass test'],
              test_commands: ['pnpm test'],
              priority: 1,
              max_attempts: 3,
              timeout_minutes: 30,
              rowNumber: 2,
              raw: {},
            },
            {
              id: 'TSK-102',
              title: 'Second task',
              description: null,
              phase: 'GĐ 1',
              repository: '.',
              dependencies: ['TSK-101'],
              status: 'TODO',
              feature_id: 'FEAT-1',
              worker_type: 'agy',
              acceptance_criteria: [],
              test_commands: [],
              priority: 2,
              max_attempts: 3,
              timeout_minutes: 30,
              rowNumber: 3,
              raw: {},
            },
          ],
          features: [
            {
              id: 'FEAT-1',
              name: 'Core Feature',
              description: 'Initial feature',
              required_tasks: ['TSK-101', 'TSK-102'],
              integration_tests: [],
              release_policy: null,
              status: 'TODO',
              rowNumber: 2,
              raw: {},
            },
          ],
        },
      };

      render(<ImportPreview preview={validPreview} />);

      const badge = screen.getByTestId('preview-status-badge');
      expect(badge.textContent).toContain('HỢP LỆ');

      expect(screen.getByTestId('summary-tasks-count').textContent).toBe('2');
      expect(screen.getByTestId('summary-features-count').textContent).toBe('1');
      expect(screen.getByTestId('summary-errors-count').textContent).toBe('0');

      const taskRows = screen.getAllByTestId('preview-task-row');
      expect(taskRows).toHaveLength(2);
      expect(taskRows[0]?.textContent).toContain('TSK-101');
      expect(taskRows[1]?.textContent).toContain('TSK-102');

      const featureRows = screen.getAllByTestId('preview-feature-row');
      expect(featureRows).toHaveLength(1);
      expect(featureRows[0]?.textContent).toContain('FEAT-1');
    });

    it('renders error list table when preview contains errors', () => {
      const invalidPreview: ImportDryRunResult = {
        dryRun: true,
        valid: false,
        summary: {
          tasksCount: 1,
          featuresCount: 0,
          errorsCount: 1,
          warningsCount: 0,
        },
        report: {
          valid: false,
          errors: [
            {
              sheet: 'Tasks',
              row: 5,
              column: 'dependencies',
              code: 'CIRCULAR_DEPENDENCY',
              message: 'Cycle detected: TSK-A -> TSK-B -> TSK-A',
              severity: 'error',
            },
          ],
          warnings: [],
          errorCount: 1,
          warningCount: 0,
          summary: 'Errors found',
        },
        preview: {
          tasks: [],
          features: [],
        },
      };

      render(<ImportPreview preview={invalidPreview} />);

      const badge = screen.getByTestId('preview-status-badge');
      expect(badge.textContent).toContain('KHÔNG HỢP LỆ');

      const errorSection = screen.getByTestId('preview-errors-section');
      expect(errorSection).toBeDefined();

      const errorRows = screen.getAllByTestId('preview-error-row');
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0]?.textContent).toContain('CIRCULAR_DEPENDENCY');
      expect(errorRows[0]?.textContent).toContain('Cycle detected');
    });
  });

  describe('ImportWorkflow', () => {
    it('executes preview -> commit workflow successfully from UI', async () => {
      const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });

      const mockPreviewResult: ImportDryRunResult = {
        dryRun: true,
        valid: true,
        summary: {
          tasksCount: 3,
          featuresCount: 1,
          errorsCount: 0,
          warningsCount: 0,
        },
        report: {
          valid: true,
          errors: [],
          warnings: [],
          errorCount: 0,
          warningCount: 0,
          summary: 'Valid',
        },
        preview: {
          tasks: [
            {
              id: 'TSK-001',
              title: 'Init',
              description: null,
              phase: 'GĐ 1',
              repository: '.',
              dependencies: [],
              status: 'DONE',
              feature_id: 'FEAT-001',
              worker_type: 'agy',
              acceptance_criteria: [],
              test_commands: [],
              priority: 1,
              max_attempts: 3,
              timeout_minutes: 30,
              rowNumber: 2,
              raw: {},
            },
          ],
          features: [],
        },
      };

      const mockCommitResult: ImportCommitResult = {
        dryRun: false,
        valid: true,
        imported: {
          tasksCount: 3,
          featuresCount: 1,
        },
        tasks: [],
        features: [],
      };

      const previewSpy = vi
        .spyOn(mockApiClient, 'previewImport')
        .mockResolvedValueOnce(mockPreviewResult);

      const commitSpy = vi
        .spyOn(mockApiClient, 'commitImport')
        .mockResolvedValueOnce(mockCommitResult);

      const onImportSuccess = vi.fn();

      render(<ImportWorkflow apiClient={mockApiClient} onImportSuccess={onImportSuccess} />);

      // Confirm button should initially be disabled
      const confirmBtn = screen.getByTestId('confirm-import-btn');
      expect(confirmBtn.hasAttribute('disabled')).toBe(true);

      // 1. Click Preview
      const previewBtn = screen.getByTestId('preview-import-btn');
      fireEvent.click(previewBtn);

      await waitFor(() => {
        expect(previewSpy).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('preview-status-badge').textContent).toContain('HỢP LỆ');
      });

      // Confirm button is now enabled
      expect(confirmBtn.hasAttribute('disabled')).toBe(false);

      // 2. Click Confirm
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(commitSpy).toHaveBeenCalledTimes(1);
        const successBanner = screen.getByTestId('import-success-banner');
        expect(successBanner.textContent).toContain('Nhập dữ liệu thành công!');
        expect(successBanner.textContent).toContain('3 tasks');
        expect(successBanner.textContent).toContain('1 features');
      });

      expect(onImportSuccess).toHaveBeenCalledWith(mockCommitResult);
    });

    it('keeps confirm button disabled if preview has validation errors', async () => {
      const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });

      const invalidPreviewResult: ImportDryRunResult = {
        dryRun: true,
        valid: false,
        summary: {
          tasksCount: 2,
          featuresCount: 0,
          errorsCount: 1,
          warningsCount: 0,
        },
        report: {
          valid: false,
          errors: [
            {
              sheet: 'Tasks',
              row: 3,
              column: 'task_id',
              code: 'DUPLICATE_TASK_ID',
              message: 'Duplicate task_id: TSK-001',
              severity: 'error',
            },
          ],
          warnings: [],
          errorCount: 1,
          warningCount: 0,
          summary: 'Errors found',
        },
        preview: { tasks: [], features: [] },
      };

      vi.spyOn(mockApiClient, 'previewImport').mockResolvedValueOnce(invalidPreviewResult);

      render(<ImportWorkflow apiClient={mockApiClient} />);

      const previewBtn = screen.getByTestId('preview-import-btn');
      fireEvent.click(previewBtn);

      await waitFor(() => {
        expect(screen.getByTestId('preview-status-badge').textContent).toContain('KHÔNG HỢP LỆ');
      });

      const confirmBtn = screen.getByTestId('confirm-import-btn');
      expect(confirmBtn.hasAttribute('disabled')).toBe(true);
    });

    it('handles cancel/reset button by clearing preview and states', async () => {
      const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });

      const mockPreviewResult: ImportDryRunResult = {
        dryRun: true,
        valid: true,
        summary: { tasksCount: 1, featuresCount: 0, errorsCount: 0, warningsCount: 0 },
        report: {
          valid: true,
          errors: [],
          warnings: [],
          errorCount: 0,
          warningCount: 0,
          summary: 'Valid',
        },
        preview: { tasks: [], features: [] },
      };

      vi.spyOn(mockApiClient, 'previewImport').mockResolvedValueOnce(mockPreviewResult);

      render(<ImportWorkflow apiClient={mockApiClient} />);

      const previewBtn = screen.getByTestId('preview-import-btn');
      fireEvent.click(previewBtn);

      await waitFor(() => {
        expect(screen.getByTestId('preview-container')).toBeDefined();
      });

      // Click cancel
      const cancelBtn = screen.getByTestId('cancel-import-btn');
      fireEvent.click(cancelBtn);

      expect(screen.getByTestId('preview-empty-state')).toBeDefined();
      expect(screen.queryByTestId('preview-container')).toBeNull();
    });

    it('displays error banner when preview API fails', async () => {
      const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });

      vi.spyOn(mockApiClient, 'previewImport').mockRejectedValueOnce(
        new Error('Failed to parse Excel workbook: corrupt stream'),
      );

      render(<ImportWorkflow apiClient={mockApiClient} />);

      const previewBtn = screen.getByTestId('preview-import-btn');
      fireEvent.click(previewBtn);

      await waitFor(() => {
        const errorBanner = screen.getByTestId('import-error-banner');
        expect(errorBanner.textContent).toContain('corrupt stream');
      });
    });
  });
});
