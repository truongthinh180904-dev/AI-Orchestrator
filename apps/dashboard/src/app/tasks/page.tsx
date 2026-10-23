import React from 'react';

export default function TasksPage() {
  return (
    <div data-testid="dashboard-tasks-page">
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>
          Danh Sách Tác Vụ (Tasks)
        </h2>
        <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
          Theo dõi tiến độ, trạng thái và bộ lọc các tác vụ trong hệ thống điều phối (sẵn sàng cho
          UI-002).
        </p>
      </div>

      <div
        data-testid="tasks-placeholder-box"
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          border: '1px dashed #cbd5e1',
          color: '#64748b',
        }}
      >
        <p style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600, color: '#334155' }}>
          Khung hiển thị Danh Sách Task & Bộ Lọc (UI-002)
        </p>
        <p style={{ margin: 0, fontSize: '14px' }}>
          Trang đang sẵn sàng tích hợp truy vấn API và bộ lọc trạng thái (TODO, IN_PROGRESS, DONE,
          FAILED).
        </p>
      </div>
    </div>
  );
}
