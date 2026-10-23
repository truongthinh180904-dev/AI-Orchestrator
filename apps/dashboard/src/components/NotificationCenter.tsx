'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  type DashboardNotification,
  type NotificationSeverity,
  notificationStore,
  useNotifications,
} from '../lib/notifications.js';

export interface NotificationBellProps {
  store?: typeof notificationStore;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  store = notificationStore,
}) => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } =
    useNotifications(store);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const displayedNotifications =
    filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  const getSeverityStyle = (severity: NotificationSeverity) => {
    switch (severity) {
      case 'success':
        return { bg: '#dcfce7', text: '#15803d', border: '#86efac', icon: '✓' };
      case 'error':
        return { bg: '#fee2e2', text: '#b91c1c', border: '#fca5a5', icon: '✕' };
      case 'warning':
        return { bg: '#fef3c7', text: '#b45309', border: '#fcd34d', icon: '!' };
      case 'info':
      default:
        return { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc', icon: 'ℹ' };
    }
  };

  const formatTimestamp = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-testid="notification-bell-btn"
        aria-label="Thông báo hệ thống"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          backgroundColor: isOpen ? '#334155' : '#1e293b',
          color: '#ffffff',
          border: '1px solid #475569',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        <span style={{ fontSize: '16px' }} role="img" aria-label="bell">
          🔔
        </span>
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge-count"
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              backgroundColor: '#ef4444',
              color: '#ffffff',
              fontSize: '10px',
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: '9999px',
              border: '2px solid #0f172a',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          data-testid="notification-dropdown-menu"
          style={{
            position: 'absolute',
            top: '44px',
            right: 0,
            width: '380px',
            maxWidth: '90vw',
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            border: '1px solid #e2e8f0',
            zIndex: 1000,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#0f172a' }}>Thông báo</span>
              {unreadCount > 0 && (
                <span
                  style={{
                    backgroundColor: '#fee2e2',
                    color: '#b91c1c',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '1px 6px',
                    borderRadius: '10px',
                  }}
                >
                  {unreadCount} mới
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              {unreadCount > 0 && (
                <button
                  type="button"
                  data-testid="btn-mark-all-read"
                  onClick={() => markAllAsRead()}
                  style={{
                    fontSize: '11px',
                    color: '#2563eb',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 500,
                    padding: '2px 4px',
                  }}
                >
                  Đọc tất cả
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-clear-notifications"
                  onClick={() => clearAll()}
                  style={{
                    fontSize: '11px',
                    color: '#64748b',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 500,
                    padding: '2px 4px',
                  }}
                >
                  Xóa hết
                </button>
              )}
            </div>
          </div>

          {/* Filter Tabs */}
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid #f1f5f9',
              padding: '4px 16px',
              gap: '8px',
            }}
          >
            <button
              type="button"
              data-testid="tab-all-notifications"
              onClick={() => setFilter('all')}
              style={{
                fontSize: '12px',
                padding: '4px 8px',
                border: 'none',
                background: 'none',
                fontWeight: filter === 'all' ? 700 : 500,
                color: filter === 'all' ? '#2563eb' : '#64748b',
                borderBottom: filter === 'all' ? '2px solid #2563eb' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              Tất cả ({notifications.length})
            </button>
            <button
              type="button"
              data-testid="tab-unread-notifications"
              onClick={() => setFilter('unread')}
              style={{
                fontSize: '12px',
                padding: '4px 8px',
                border: 'none',
                background: 'none',
                fontWeight: filter === 'unread' ? 700 : 500,
                color: filter === 'unread' ? '#2563eb' : '#64748b',
                borderBottom: filter === 'unread' ? '2px solid #2563eb' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              Chưa đọc ({unreadCount})
            </button>
          </div>

          {/* Notification List */}
          <div
            data-testid="notification-items-container"
            style={{
              maxHeight: '340px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {displayedNotifications.length === 0 ? (
              <div
                data-testid="notification-empty-state"
                style={{
                  padding: '32px 16px',
                  textAlign: 'center',
                  color: '#94a3b8',
                  fontSize: '13px',
                }}
              >
                Không có thông báo nào.
              </div>
            ) : (
              displayedNotifications.map((n) => {
                const style = getSeverityStyle(n.severity);
                return (
                  <div
                    key={n.id}
                    data-testid={`notification-item-${n.id}`}
                    style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid #f1f5f9',
                      backgroundColor: n.read ? '#ffffff' : '#f8fafc',
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'flex-start',
                      transition: 'background-color 0.15s ease',
                    }}
                  >
                    <span
                      data-testid={`severity-badge-${n.severity}`}
                      style={{
                        flexShrink: 0,
                        width: '24px',
                        height: '24px',
                        borderRadius: '50%',
                        backgroundColor: style.bg,
                        color: style.text,
                        border: `1px solid ${style.border}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        fontWeight: 700,
                      }}
                    >
                      {style.icon}
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: '6px',
                        }}
                      >
                        <span
                          data-testid={`notification-title-${n.id}`}
                          style={{
                            fontSize: '13px',
                            fontWeight: n.read ? 600 : 700,
                            color: '#0f172a',
                          }}
                        >
                          {n.title}
                        </span>
                        <span style={{ fontSize: '11px', color: '#94a3b8', flexShrink: 0 }}>
                          {formatTimestamp(n.timestamp)}
                        </span>
                      </div>

                      <p
                        data-testid={`notification-message-${n.id}`}
                        style={{
                          margin: '3px 0 0 0',
                          fontSize: '12px',
                          color: '#475569',
                          lineHeight: 1.4,
                          wordBreak: 'break-word',
                        }}
                      >
                        {n.message}
                      </p>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          marginTop: '6px',
                        }}
                      >
                        {n.link && (
                          <a
                            href={n.link}
                            data-testid={`notification-link-${n.id}`}
                            onClick={() => {
                              markAsRead(n.id);
                              setIsOpen(false);
                            }}
                            style={{
                              fontSize: '11px',
                              color: '#2563eb',
                              textDecoration: 'none',
                              fontWeight: 500,
                            }}
                          >
                            Xem chi tiết →
                          </a>
                        )}

                        {!n.read && (
                          <button
                            type="button"
                            data-testid={`btn-mark-read-${n.id}`}
                            onClick={() => markAsRead(n.id)}
                            style={{
                              fontSize: '11px',
                              color: '#64748b',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                          >
                            Đánh dấu đã đọc
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export interface NotificationToastContainerProps {
  store?: typeof notificationStore;
  autoDismissMs?: number;
}

export const NotificationToastContainer: React.FC<NotificationToastContainerProps> = ({
  store = notificationStore,
  autoDismissMs = 6000,
}) => {
  const { notifications } = useNotifications(store);
  const [visibleToasts, setVisibleToasts] = useState<DashboardNotification[]>([]);
  const prevCountRef = useRef(0);

  useEffect(() => {
    // Show only the newest unread notifications as toasts
    if (notifications.length > prevCountRef.current) {
      const newest = notifications[0];
      if (newest && !newest.read) {
        setVisibleToasts((prev) => {
          if (prev.some((t) => t.id === newest.id)) return prev;
          return [newest, ...prev].slice(0, 4);
        });
      }
    }
    prevCountRef.current = notifications.length;
  }, [notifications]);

  const dismissToast = (id: string) => {
    setVisibleToasts((prev) => prev.filter((t) => t.id !== id));
  };

  useEffect(() => {
    if (visibleToasts.length === 0 || autoDismissMs <= 0) return;

    const timer = setTimeout(() => {
      setVisibleToasts((prev) => prev.slice(0, -1));
    }, autoDismissMs);

    return () => clearTimeout(timer);
  }, [visibleToasts, autoDismissMs]);

  if (visibleToasts.length === 0) return null;

  return (
    <div
      data-testid="notification-toast-container"
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        zIndex: 9999,
        maxWidth: '380px',
        width: 'calc(100vw - 48px)',
        pointerEvents: 'none',
      }}
    >
      {visibleToasts.map((toast) => {
        const isSuccess = toast.severity === 'success';
        const isError = toast.severity === 'error';
        const isWarning = toast.severity === 'warning';

        const borderColor = isSuccess
          ? '#22c55e'
          : isError
            ? '#ef4444'
            : isWarning
              ? '#f59e0b'
              : '#3b82f6';

        const bg = isSuccess ? '#f0fdf4' : isError ? '#fef2f2' : isWarning ? '#fffbeb' : '#eff6ff';

        return (
          <div
            key={toast.id}
            data-testid={`notification-toast-${toast.id}`}
            style={{
              pointerEvents: 'auto',
              backgroundColor: bg,
              borderLeft: `4px solid ${borderColor}`,
              borderRadius: '8px',
              padding: '12px 14px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '10px',
              animation: 'fadeIn 0.2s ease-in-out',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                data-testid={`toast-title-${toast.id}`}
                style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}
              >
                {toast.title}
              </div>
              <div
                data-testid={`toast-message-${toast.id}`}
                style={{ fontSize: '12px', color: '#475569', marginTop: '2px', lineHeight: 1.4 }}
              >
                {toast.message}
              </div>
            </div>

            <button
              type="button"
              data-testid={`btn-close-toast-${toast.id}`}
              onClick={() => dismissToast(toast.id)}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '2px 4px',
                fontSize: '14px',
                lineHeight: 1,
              }}
              title="Đóng thông báo"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
};

export const NotificationCenter: React.FC<NotificationBellProps> = (props) => {
  return (
    <div
      data-testid="notification-center-root"
      style={{ display: 'inline-flex', alignItems: 'center' }}
    >
      <NotificationBell {...props} />
    </div>
  );
};
