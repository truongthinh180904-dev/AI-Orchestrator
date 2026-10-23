import React from 'react';

export default function HomePage() {
  return (
    <div data-testid="dashboard-home-page" style={{ padding: '8px 0' }}>
      <div
        style={{
          background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
          borderRadius: '12px',
          padding: '28px',
          color: '#ffffff',
          marginBottom: '28px',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        }}
      >
        <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700 }}>
          Hệ Thống Điều Phối & Vận Hành AI Coding (AI Orchestrator)
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: '15px',
            color: '#cbd5e1',
            maxWidth: '800px',
            lineHeight: 1.5,
          }}
        >
          Giám sát và điều phối tác vụ lập trình độc lập, theo dõi live log SSE, xác thực Quality
          Gate với bằng chứng thực tế, và tự động tạo pull request phát hành an toàn.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '20px',
        }}
      >
        <div
          data-testid="card-tasks"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              📋 Tác Vụ & Tiến Độ
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              Xem bảng danh sách tasks, lọc theo phase/feature/trạng thái và xem chi tiết tiến trình
              thực thi.
            </p>
          </div>
          <a
            href="/tasks"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Vào Danh Sách Tasks →
          </a>
        </div>

        <div
          data-testid="card-import"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              📥 Nhập Yêu Cầu (Import)
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              Nạp danh sách tasks và features từ file Excel (.xlsx) hoặc CSV, kiểm tra hợp lệ trước
              khi cam kết.
            </p>
          </div>
          <a
            href="/import"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#0f172a',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Mở Giao Diện Import →
          </a>
        </div>

        <div
          data-testid="card-controls"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              ⚙️ Bảng Điều Khiển
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              Tạm dừng hàng đợi (Pause), Tiếp tục (Resume), Dừng khẩn cấp an toàn (Stop) và Phê
              duyệt (Approve).
            </p>
          </div>
          <a
            href="/controls"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#475569',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Xem Bảng Điều Khiển →
          </a>
        </div>

        <div
          data-testid="card-releases"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              🚀 Releases & PRs
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              Xem trạng thái bàn giao tính năng, branch an toàn, commit SHA và đường dẫn Pull
              Request đã tạo.
            </p>
          </div>
          <a
            href="/releases"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#059669',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Quản Lý Phát Hành →
          </a>
        </div>

        <div
          data-testid="card-diff"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              🔍 Diff Viewer
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              So sánh mã nguồn thay đổi theo định dạng unified diff, tô màu trực quan dòng thêm/xóa
              và phát hiện file lạ ngoài scope (Quality Gate QLT-003).
            </p>
          </div>
          <a
            href="/diff"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#0284c7',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Xem Diff Thay Đổi →
          </a>
        </div>

        <div
          data-testid="card-quality"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div>
            <div
              style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}
            >
              🧪 Kiểm Định & Bằng Chứng (Quality Gate)
            </div>
            <p
              style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px 0', lineHeight: 1.4 }}
            >
              Xem báo cáo test lệnh chi tiết, review findings từ Reviewer Agent (QLT-004), kiểm tra
              secret, lỗ hổng phụ thuộc và tiêu chuẩn Không PASS chỉ vì CLI báo SUCCESS (QLT-007).
            </p>
          </div>
          <a
            href="/quality"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              backgroundColor: '#7c3aed',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Xem Bằng Chứng Kiểm Định →
          </a>
        </div>
      </div>
    </div>
  );
}
