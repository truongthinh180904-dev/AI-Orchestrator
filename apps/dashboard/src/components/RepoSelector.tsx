'use client';

import React, { useState } from 'react';
import type { ImportSourceParams } from '../lib/api.js';

export interface RepoSelectorProps {
  onPreview: (params: ImportSourceParams) => void;
  isLoading: boolean;
  disabled?: boolean;
}

export const RepoSelector: React.FC<RepoSelectorProps> = ({
  onPreview,
  isLoading,
  disabled = false,
}) => {
  const [repoPath, setRepoPath] = useState<string>('.');
  const [sourceType, setSourceType] = useState<'filePath' | 'fileUpload' | 'rawCsv'>('filePath');
  const [filePath, setFilePath] = useState<string>('fixtures/sample-tasks.xlsx');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [csvContent, setCsvContent] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || isLoading) return;

    const params: ImportSourceParams = {
      repository: repoPath.trim() || '.',
    };

    if (sourceType === 'filePath') {
      if (!filePath.trim()) return;
      params.filePath = filePath.trim();
    } else if (sourceType === 'fileUpload') {
      if (!selectedFile) return;
      params.file = selectedFile;
      params.filename = selectedFile.name;
    } else if (sourceType === 'rawCsv') {
      if (!csvContent.trim()) return;
      params.fileContent = csvContent;
      params.filename = 'tasks.csv';
    }

    onPreview(params);
  };

  const isSubmitDisabled =
    disabled ||
    isLoading ||
    (sourceType === 'filePath' && !filePath.trim()) ||
    (sourceType === 'fileUpload' && !selectedFile) ||
    (sourceType === 'rawCsv' && !csvContent.trim());

  return (
    <div
      className="repo-selector-card"
      style={{
        padding: '16px',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        background: '#ffffff',
        marginBottom: '16px',
      }}
    >
      <h3 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600 }}>
        1. Chọn Repository & Nguồn Dữ Liệu
      </h3>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '12px' }}>
          <label
            htmlFor="repo-path-input"
            style={{ display: 'block', fontWeight: 500, marginBottom: '4px', fontSize: '14px' }}
          >
            Đường dẫn Repository (cwd):
          </label>
          <input
            id="repo-path-input"
            data-testid="repo-path-input"
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            disabled={disabled || isLoading}
            placeholder="."
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label
            style={{ display: 'block', fontWeight: 500, marginBottom: '4px', fontSize: '14px' }}
          >
            Phương thức nhập:
          </label>
          <div style={{ display: 'flex', gap: '16px' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="sourceType"
                value="filePath"
                checked={sourceType === 'filePath'}
                onChange={() => setSourceType('filePath')}
                disabled={disabled || isLoading}
                data-testid="source-type-filepath"
              />
              Đường dẫn file (Excel/CSV)
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="sourceType"
                value="fileUpload"
                checked={sourceType === 'fileUpload'}
                onChange={() => setSourceType('fileUpload')}
                disabled={disabled || isLoading}
                data-testid="source-type-upload"
              />
              Tải file lên (Upload)
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="sourceType"
                value="rawCsv"
                checked={sourceType === 'rawCsv'}
                onChange={() => setSourceType('rawCsv')}
                disabled={disabled || isLoading}
                data-testid="source-type-rawcsv"
              />
              Nhập trực tiếp CSV
            </label>
          </div>
        </div>

        {sourceType === 'filePath' && (
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="file-path-input"
              style={{ display: 'block', fontWeight: 500, marginBottom: '4px', fontSize: '14px' }}
            >
              Đường dẫn file Excel (.xlsx) hoặc CSV:
            </label>
            <input
              id="file-path-input"
              data-testid="file-path-input"
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              disabled={disabled || isLoading}
              placeholder="fixtures/sample-tasks.xlsx"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>
        )}

        {sourceType === 'fileUpload' && (
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="file-upload-input"
              style={{ display: 'block', fontWeight: 500, marginBottom: '4px', fontSize: '14px' }}
            >
              Chọn file từ máy tính (.xlsx, .xls, .csv):
            </label>
            <input
              id="file-upload-input"
              data-testid="file-upload-input"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              disabled={disabled || isLoading}
              style={{
                width: '100%',
                padding: '6px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>
        )}

        {sourceType === 'rawCsv' && (
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="raw-csv-input"
              style={{ display: 'block', fontWeight: 500, marginBottom: '4px', fontSize: '14px' }}
            >
              Nội dung CSV:
            </label>
            <textarea
              id="raw-csv-input"
              data-testid="raw-csv-input"
              rows={5}
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              disabled={disabled || isLoading}
              placeholder="task_id,title,dependencies&#10;TSK-001,Setup project,&#10;TSK-002,Configure DB,TSK-001"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '13px',
                fontFamily: 'monospace',
              }}
            />
          </div>
        )}

        <button
          type="submit"
          data-testid="preview-import-btn"
          disabled={isSubmitDisabled}
          style={{
            backgroundColor: isSubmitDisabled ? '#94a3b8' : '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: isSubmitDisabled ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.2s',
          }}
        >
          {isLoading ? 'Đang kiểm tra...' : 'Xem trước (Preview Import)'}
        </button>
      </form>
    </div>
  );
};
