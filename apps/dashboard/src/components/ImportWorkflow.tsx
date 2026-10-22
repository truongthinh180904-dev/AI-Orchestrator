'use client';

import React, { useState } from 'react';
import { api as defaultApi, ApiClient, type ImportSourceParams } from '../lib/api.js';
import { RepoSelector } from './RepoSelector.js';
import { ImportPreview } from './ImportPreview.js';
import type { ImportDryRunResult, ImportCommitResult } from '@ai-orchestrator/shared';

export interface ImportWorkflowProps {
  apiClient?: ApiClient;
  onImportSuccess?: (result: ImportCommitResult) => void;
}

export const ImportWorkflow: React.FC<ImportWorkflowProps> = ({
  apiClient = defaultApi,
  onImportSuccess,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<ImportCommitResult | null>(null);
  const [previewResult, setPreviewResult] = useState<ImportDryRunResult | null>(null);
  const [lastParams, setLastParams] = useState<ImportSourceParams | null>(null);

  const handlePreview = async (params: ImportSourceParams) => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessResult(null);
    setLastParams(params);

    try {
      const result = await apiClient.previewImport(params);
      setPreviewResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setPreviewResult(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!lastParams || !previewResult || !previewResult.valid || isLoading) return;

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const result = await apiClient.commitImport(lastParams);
      setSuccessResult(result);
      if (onImportSuccess) {
        onImportSuccess(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    if (isLoading) return;
    setPreviewResult(null);
    setLastParams(null);
    setErrorMessage(null);
    setSuccessResult(null);
  };

  const canConfirm = Boolean(previewResult && previewResult.valid && !isLoading && !successResult);

  return (
    <div
      data-testid="import-workflow-root"
      style={{
        maxWidth: '960px',
        margin: '0 auto',
        padding: '24px 16px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>
          Nhập Nhiệm Vụ & Tính Năng (Import Tasks)
        </h2>
        <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
          Chọn repository và nguồn file dữ liệu (Excel .xlsx hoặc CSV), kiểm tra tính hợp lệ trước
          khi nạp vào hệ thống.
        </p>
      </div>

      {/* Error Banner */}
      {errorMessage && (
        <div
          data-testid="import-error-banner"
          style={{
            marginBottom: '16px',
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #f87171',
            borderRadius: '6px',
            color: '#991b1b',
            fontSize: '14px',
          }}
        >
          <strong>Lỗi: </strong>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Success Banner */}
      {successResult && (
        <div
          data-testid="import-success-banner"
          style={{
            marginBottom: '16px',
            padding: '16px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '6px',
            color: '#166534',
          }}
        >
          <h4 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600 }}>
            Nhập dữ liệu thành công!
          </h4>
          <p style={{ margin: 0, fontSize: '14px' }}>
            Đã nạp thành công <strong>{successResult.imported.tasksCount}</strong> tasks và{' '}
            <strong>{successResult.imported.featuresCount}</strong> features vào cơ sở dữ liệu.
          </p>
        </div>
      )}

      {/* Step 1: Repo & Source Selection */}
      <RepoSelector
        onPreview={handlePreview}
        isLoading={isLoading}
        disabled={isLoading || Boolean(successResult)}
      />

      {/* Step 2: Preview Details */}
      <ImportPreview preview={previewResult} />

      {/* Step 3: Action Controls */}
      <div
        data-testid="import-actions-bar"
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '12px',
          padding: '16px',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
          background: '#ffffff',
        }}
      >
        <button
          type="button"
          data-testid="cancel-import-btn"
          onClick={handleCancel}
          disabled={isLoading || (!previewResult && !successResult && !errorMessage)}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            backgroundColor: '#ffffff',
            color: '#475569',
            fontSize: '14px',
            fontWeight: 500,
            cursor:
              isLoading || (!previewResult && !successResult && !errorMessage)
                ? 'not-allowed'
                : 'pointer',
            opacity: isLoading || (!previewResult && !successResult && !errorMessage) ? 0.6 : 1,
          }}
        >
          Hủy bỏ (Reset)
        </button>

        <button
          type="button"
          data-testid="confirm-import-btn"
          onClick={handleConfirm}
          disabled={!canConfirm}
          style={{
            padding: '8px 20px',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: canConfirm ? '#16a34a' : '#94a3b8',
            color: '#ffffff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: canConfirm ? 'pointer' : 'not-allowed',
            transition: 'background-color 0.2s',
          }}
        >
          {isLoading ? 'Đang thực thi...' : 'Xác nhận Nhập (Confirm Import)'}
        </button>
      </div>
    </div>
  );
};
