'use client';

import React, { useState, useEffect } from 'react';
import { DiffViewer } from '../../components/DiffViewer.js';
import { ApiClient, api as defaultApi } from '../../lib/api.js';
import type { TaskWithDependencies } from '@ai-orchestrator/shared';

export interface DiffPageProps {
  apiClient?: ApiClient;
}

export default function DiffPage({ apiClient }: DiffPageProps) {
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
    <div data-testid="dashboard-diff-page" style={{ padding: '8px 0' }}>
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
            🔍 Trình Xem Git Diff (Diff Viewer)
          </h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            Xem chi tiết thay đổi code theo cú pháp unified git diff, tô màu trực quan dòng thêm/xóa
            và kiểm tra tính tuân thủ phạm vi task (Quality Gate QLT-003).
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* Select task from DB */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label
              htmlFor="diff-task-select"
              style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}
            >
              Chọn tác vụ:
            </label>
            <select
              id="diff-task-select"
              data-testid="diff-task-select"
              value={selectedTaskId}
              onChange={(e) => {
                setSelectedTaskId(e.target.value);
                setCustomInput('');
              }}
              disabled={loadingTasks || tasks.length === 0}
              style={{
                padding: '6px 12px',
                fontSize: '13px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                backgroundColor: '#ffffff',
                outline: 'none',
              }}
            >
              {tasks.length === 0 ? (
                <option value="">{loadingTasks ? 'Đang tải danh sách...' : 'Không có tác vụ nào'}</option>
              ) : (
                tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} - {t.title} ({t.status})
                  </option>
                ))
              )}
            </select>
          </div>

          <span style={{ fontSize: '12px', color: '#94a3b8' }}>hoặc</span>

          {/* Custom Task ID text input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="text"
              data-testid="diff-custom-task-input"
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                if (e.target.value) {
                  setSelectedTaskId('');
                }
              }}
              placeholder="Nhập mã tác vụ (vd: UI-005)..."
              style={{
                padding: '6px 10px',
                fontSize: '13px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                width: '220px',
                outline: 'none',
              }}
            />
          </div>
        </div>
      </div>

      {/* Diff Viewer Area */}
      {activeId ? (
        <DiffViewer key={activeId} taskId={activeId} apiClient={client} />
      ) : (
        <div
          data-testid="diff-no-task-selected"
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            border: '1px solid #e2e8f0',
            color: '#64748b',
          }}
        >
          Vui lòng chọn hoặc nhập mã tác vụ để xem git diff.
        </div>
      )}
    </div>
  );
}
