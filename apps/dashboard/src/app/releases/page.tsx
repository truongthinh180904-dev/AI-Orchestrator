import React from 'react';

export default function ReleasesPage() {
  return (
    <div data-testid="dashboard-releases-page">
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>
          Phát Hành & Pull Requests (Releases)
        </h2>
        <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
          Theo dõi các feature releases, commit SHA, remote branch và liên kết PR GitHub (sẵn sàng
          cho UI-008).
        </p>
      </div>

      <div
        data-testid="releases-placeholder-box"
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
          Khung Quản Lý Bàn Giao & Pull Requests (UI-008)
        </p>
        <p style={{ margin: 0, fontSize: '14px' }}>
          Trang đang sẵn sàng tích hợp API hiển thị branch, SHA, và URL PR đã tạo thành công.
        </p>
      </div>
    </div>
  );
}
