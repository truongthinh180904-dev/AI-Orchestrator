'use client';

import React from 'react';
import type { ImportDryRunResult } from '@ai-orchestrator/shared';

export interface ImportPreviewProps {
  preview: ImportDryRunResult | null;
}

export const ImportPreview: React.FC<ImportPreviewProps> = ({ preview }) => {
  if (!preview) {
    return (
      <div
        data-testid="preview-empty-state"
        style={{
          padding: '32px 16px',
          textAlign: 'center',
          color: '#64748b',
          border: '1px dashed #cbd5e1',
          borderRadius: '8px',
          background: '#f8fafc',
          marginBottom: '16px',
        }}
      >
        <p style={{ margin: 0, fontSize: '15px' }}>
          Chưa có dữ liệu xem trước. Vui lòng chọn nguồn và bấm{' '}
          <strong>&ldquo;Xem trước (Preview Import)&rdquo;</strong>.
        </p>
      </div>
    );
  }

  const { valid, summary, report, preview: previewData } = preview;
  const tasks = previewData.tasks ?? [];
  const features = previewData.features ?? [];
  const errors = report.errors ?? [];
  const warnings = report.warnings ?? [];

  return (
    <div
      data-testid="preview-container"
      style={{
        padding: '16px',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        background: '#ffffff',
        marginBottom: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          2. Kết Quả Xem Trước (Import Preview)
        </h3>
        <span
          data-testid="preview-status-badge"
          style={{
            padding: '4px 12px',
            borderRadius: '9999px',
            fontSize: '13px',
            fontWeight: 600,
            backgroundColor: valid ? '#dcfce7' : '#fee2e2',
            color: valid ? '#15803d' : '#b91c1c',
            border: `1px solid ${valid ? '#86efac' : '#fca5a5'}`,
          }}
        >
          {valid ? 'HỢP LỆ (READY TO COMMIT)' : 'KHÔNG HỢP LỆ (HAS ERRORS)'}
        </span>
      </div>

      {/* Summary Cards */}
      <div
        data-testid="preview-summary"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '12px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            padding: '12px',
            background: '#f1f5f9',
            borderRadius: '6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '12px', color: '#64748b' }}>Tổng Tasks</div>
          <div
            data-testid="summary-tasks-count"
            style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}
          >
            {summary.tasksCount}
          </div>
        </div>
        <div
          style={{
            padding: '12px',
            background: '#f1f5f9',
            borderRadius: '6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '12px', color: '#64748b' }}>Tổng Features</div>
          <div
            data-testid="summary-features-count"
            style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}
          >
            {summary.featuresCount}
          </div>
        </div>
        <div
          style={{
            padding: '12px',
            background: summary.errorsCount > 0 ? '#fef2f2' : '#f1f5f9',
            borderRadius: '6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '12px', color: summary.errorsCount > 0 ? '#b91c1c' : '#64748b' }}>
            Lỗi (Errors)
          </div>
          <div
            data-testid="summary-errors-count"
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: summary.errorsCount > 0 ? '#dc2626' : '#0f172a',
            }}
          >
            {summary.errorsCount}
          </div>
        </div>
        <div
          style={{
            padding: '12px',
            background: summary.warningsCount > 0 ? '#fffbeb' : '#f1f5f9',
            borderRadius: '6px',
            textAlign: 'center',
          }}
        >
          <div
            style={{ fontSize: '12px', color: summary.warningsCount > 0 ? '#b45309' : '#64748b' }}
          >
            Cảnh báo
          </div>
          <div
            data-testid="summary-warnings-count"
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: summary.warningsCount > 0 ? '#d97706' : '#0f172a',
            }}
          >
            {summary.warningsCount}
          </div>
        </div>
      </div>

      {/* Errors Section */}
      {errors.length > 0 && (
        <div
          data-testid="preview-errors-section"
          style={{
            marginBottom: '16px',
            padding: '12px',
            border: '1px solid #fecaca',
            borderRadius: '6px',
            background: '#fef2f2',
          }}
        >
          <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#b91c1c' }}>
            Danh sách lỗi cần khắc phục ({errors.length}):
          </h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#fee2e2', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Sheet</th>
                <th style={{ padding: '6px 8px' }}>Dòng</th>
                <th style={{ padding: '6px 8px' }}>Cột</th>
                <th style={{ padding: '6px 8px' }}>Mã lỗi</th>
                <th style={{ padding: '6px 8px' }}>Nội dung lỗi</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((err, idx) => (
                <tr
                  key={idx}
                  data-testid="preview-error-row"
                  style={{ borderBottom: '1px solid #fed7d7' }}
                >
                  <td style={{ padding: '6px 8px' }}>{err.sheet}</td>
                  <td style={{ padding: '6px 8px' }}>{err.row ?? '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{err.column ?? '-'}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#991b1b' }}>
                    {err.code}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#7f1d1d' }}>{err.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Warnings Section */}
      {warnings.length > 0 && (
        <div
          data-testid="preview-warnings-section"
          style={{
            marginBottom: '16px',
            padding: '12px',
            border: '1px solid #fde68a',
            borderRadius: '6px',
            background: '#fffbeb',
          }}
        >
          <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#b45309' }}>
            Cảnh báo ({warnings.length}):
          </h4>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#92400e' }}>
            {warnings.map((warn, idx) => (
              <li key={idx}>
                {warn.sheet} {warn.row ? `(dòng ${warn.row})` : ''}: {warn.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tasks Table */}
      <div style={{ marginBottom: '16px' }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
          Tasks xem trước ({tasks.length}):
        </h4>
        {tasks.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#64748b' }}>Không có task nào trong dữ liệu.</p>
        ) : (
          <div
            style={{
              maxHeight: '280px',
              overflowY: 'auto',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    background: '#f8fafc',
                    position: 'sticky',
                    top: 0,
                    textAlign: 'left',
                    borderBottom: '1px solid #e2e8f0',
                  }}
                >
                  <th style={{ padding: '8px' }}>Task ID</th>
                  <th style={{ padding: '8px' }}>Tiêu đề</th>
                  <th style={{ padding: '8px' }}>Phase</th>
                  <th style={{ padding: '8px' }}>Repository</th>
                  <th style={{ padding: '8px' }}>Phụ thuộc (Dep)</th>
                  <th style={{ padding: '8px' }}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr
                    key={t.id}
                    data-testid="preview-task-row"
                    style={{ borderBottom: '1px solid #f1f5f9' }}
                  >
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontWeight: 600 }}>
                      {t.id}
                    </td>
                    <td style={{ padding: '8px' }}>{t.title}</td>
                    <td style={{ padding: '8px', color: '#64748b' }}>{t.phase ?? '-'}</td>
                    <td style={{ padding: '8px', color: '#64748b' }}>{t.repository || '.'}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>
                      {t.dependencies && t.dependencies.length > 0
                        ? t.dependencies.join(', ')
                        : '-'}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 500,
                          backgroundColor: t.status === 'DONE' ? '#dcfce7' : '#e0e7ff',
                          color: t.status === 'DONE' ? '#15803d' : '#3730a3',
                        }}
                      >
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Features Table */}
      {features.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
            Features xem trước ({features.length}):
          </h4>
          <div
            style={{
              maxHeight: '200px',
              overflowY: 'auto',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    background: '#f8fafc',
                    position: 'sticky',
                    top: 0,
                    textAlign: 'left',
                    borderBottom: '1px solid #e2e8f0',
                  }}
                >
                  <th style={{ padding: '8px' }}>Feature ID</th>
                  <th style={{ padding: '8px' }}>Tên Feature</th>
                  <th style={{ padding: '8px' }}>Required Tasks</th>
                  <th style={{ padding: '8px' }}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {features.map((f) => (
                  <tr
                    key={f.id}
                    data-testid="preview-feature-row"
                    style={{ borderBottom: '1px solid #f1f5f9' }}
                  >
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontWeight: 600 }}>
                      {f.id}
                    </td>
                    <td style={{ padding: '8px' }}>{f.name}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>
                      {f.required_tasks && f.required_tasks.length > 0
                        ? f.required_tasks.join(', ')
                        : '-'}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 500,
                          backgroundColor: '#f1f5f9',
                          color: '#475569',
                        }}
                      >
                        {f.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
