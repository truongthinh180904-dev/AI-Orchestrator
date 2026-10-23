import React from 'react';

export default function ControlsPage() {
  return (
    <div data-testid="dashboard-controls-page">
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>
          Bảng Điều Khiển Hệ Thống (Controls)
        </h2>
        <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
          Quản trị các lệnh vận hành: Pause, Resume, Stop khẩn cấp và Phê duyệt (sẵn sàng cho
          UI-007).
        </p>
      </div>

      <div
        data-testid="controls-placeholder-box"
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
          Khung Điều Khiển Trạng Thái Hệ Thống (UI-007)
        </p>
        <p style={{ margin: 0, fontSize: '14px' }}>
          Trang đang sẵn sàng tích hợp API điều phối hàng đợi và xác nhận trước khi Stop.
        </p>
      </div>
    </div>
  );
}
