'use client';

import React, { useState, useEffect } from 'react';
import { TestReportReviewFindings } from '../../components/TestReportReviewFindings.js';
import { ApiClient, api as defaultApi } from '../../lib/api.js';
import type { TaskWithDependencies } from '@ai-orchestrator/shared';

export interface QualityPageProps {
  apiClient?: ApiClient;
}

export default function QualityPage({ apiClient }: QualityPageProps) {
  const client = apiClient ?? defaultApi;
  const [tasks, setTasks] = useState<TaskWithDependencies[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [customInput, setCustomInput] = useState<string>('');
  const [loadingTasks, setLoadingTasks] = useState(true);

  useEffect(() => {
    let active = true;
    const loadTasks = async () => {
      try {
        const list = await client.getTasks();
        if (active) {
          setTasks(list);
          if (list.length > 0 && list[0]?.id) {
            setSelectedTaskId(list[0].id);
          }
        }
      } catch {
        // fallback
      } finally {
        if (active) setLoadingTasks(false);
      }
    };

    void loadTasks();
    return () => {
      active = false;
    };
  }, [client]);

  const activeId = selectedTaskId || customInput.trim();

  return (
    <div data-testid="dashboard-quality-page" style={{ padding: '8px 0' }}>
      {/* Page Title & Selector */}
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '10px',
          border: '1px solid #e2e8f0',
          padding: '18px 24px',
          marginBottom: '20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ marginBottom: '12px' }}>
          <h2 style={{ margin: '0 0 6px 0', fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>
            🧪 Báo Cáo Kiểm Định & Review Findings (Quality Gate)
          </h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            Xem bằng chứng kiểm tra toàn diện: test execution reports, review findings từ AI Reviewer (QLT-004),
            kiểm tra file lạ ngoài phạm vi (QLT-003) và chính sách "Không PASS chỉ vì CLI báo SUCCESS" (QLT-007).
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            paddingTop: '8px',
            borderTop: '1px solid #f1f5f9',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label htmlFor="quality-task-select" style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}>
              Chọn Tác Vụ:
            </label>
            <select
              id="quality-task-select"
              data-testid="quality-task-select"
              value={selectedTaskId}
              onChange={(e) => {
                setSelectedTaskId(e.target.value);
                setCustomInput('');
              }}
              disabled={loadingTasks || tasks.length === 0}
              style={{
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                color: '#0f172a',
                minWidth: '220px',
              }}
            >
              {tasks.length === 0 ? (
                <option value="">
                  {loadingTasks ? 'Đang nạp danh sách...' : 'Không có tác vụ nào'}
                </option>
              ) : (
                tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} — {t.title} ({t.status})
                  </option>
                ))
              )}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>hoặc nhập mã:</span>
            <input
              type="text"
              data-testid="quality-custom-task-input"
              placeholder="VD: TSK-001"
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                if (e.target.value.trim()) {
                  setSelectedTaskId('');
                }
              }}
              style={{
                fontSize: '13px',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                width: '130px',
              }}
            />
          </div>
        </div>
      </div>

      {activeId ? (
        <TestReportReviewFindings taskId={activeId} />
      ) : (
        <div
          data-testid="quality-no-task-selected"
          style={{
            padding: '40px',
            textAlign: 'center',
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            border: '1px dashed #cbd5e1',
            color: '#64748b',
            fontSize: '14px',
          }}
        >
          Vui lòng chọn hoặc nhập mã tác vụ để xem báo cáo kiểm thử và review findings.
        </div>
      )}
    </div>
  );
}
