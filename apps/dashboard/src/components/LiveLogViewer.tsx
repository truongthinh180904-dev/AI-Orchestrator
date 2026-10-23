'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { EventRecord } from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi, type StreamConnectionState } from '../lib/api.js';
import { createNotificationFromEvent } from '../lib/notifications.js';

export interface LiveLogViewerProps {
  runId: string;
  taskId?: string;
  apiClient?: ApiClient;
  maxBufferSize?: number;
  initialEvents?: EventRecord[];
  onEventReceived?: (event: EventRecord) => void;
  onCompleted?: (status: string) => void;
  autoScrollDefault?: boolean;
  dispatchNotifications?: boolean;
}

export const LiveLogViewer: React.FC<LiveLogViewerProps> = ({
  runId,
  taskId,
  apiClient = defaultApi,
  maxBufferSize = 5000,
  initialEvents = [],
  onEventReceived,
  onCompleted,
  autoScrollDefault = true,
  dispatchNotifications = true,
}) => {
  const [events, setEvents] = useState<EventRecord[]>(initialEvents);
  const [connectionState, setConnectionState] = useState<StreamConnectionState>('connecting');
  const [autoScroll, setAutoScroll] = useState<boolean>(autoScrollDefault);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [lastSeq, setLastSeq] = useState<number>(() => {
    if (initialEvents.length > 0) {
      return Math.max(...initialEvents.map((e) => e.seq));
    }
    return 0;
  });
  const [reconnectKey, setReconnectKey] = useState<number>(0);

  const terminalRef = useRef<HTMLDivElement>(null);

  // Auto-scroll effect when new events arrive
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // Connect to SSE stream
  useEffect(() => {
    if (!runId) return;

    let highestSeq = lastSeq;

    const unsubscribe = apiClient.subscribeToRunStream(
      runId,
      {
        onEvent: (event) => {
          if (event.seq > highestSeq) {
            highestSeq = event.seq;
            setLastSeq(highestSeq);
          }

          setEvents((prev) => {
            // Avoid duplicate events by seq
            if (prev.some((e) => e.seq === event.seq)) {
              return prev;
            }
            const next = [...prev, event];
            if (next.length > maxBufferSize) {
              return next.slice(next.length - maxBufferSize);
            }
            return next;
          });

          onEventReceived?.(event);

          if (dispatchNotifications) {
            createNotificationFromEvent(event, { taskId, runId });
          }
        },
        onDone: (data) => {
          setConnectionState('completed');
          onCompleted?.(data.status);
        },
        onError: () => {
          setConnectionState('error');
        },
        onStateChange: (state) => {
          setConnectionState(state);
        },
      },
      {
        afterSeq: highestSeq > 0 ? highestSeq : undefined,
        live: true,
      },
    );

    return () => {
      unsubscribe();
    };
  }, [
    runId,
    taskId,
    apiClient,
    maxBufferSize,
    onEventReceived,
    onCompleted,
    dispatchNotifications,
    reconnectKey,
  ]);

  // Handle manual scroll to detect if user scrolled up
  const handleScroll = () => {
    if (!terminalRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    if (!isAtBottom && autoScroll) {
      // User scrolled up: we can optionally keep autoScroll or user can toggle
    }
  };

  // Filter events by type and search query
  const filteredEvents = useMemo(() => {
    let result = events;

    if (selectedType !== 'all') {
      if (selectedType === 'ndjson') {
        result = result.filter(
          (e) =>
            e.type !== 'stdout' &&
            e.type !== 'stderr' &&
            e.type !== 'process_start' &&
            e.type !== 'process_exit',
        );
      } else {
        result = result.filter((e) => e.type === selectedType);
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((e) => {
        if (e.type.toLowerCase().includes(q)) return true;
        if (typeof e.payload === 'string' && e.payload.toLowerCase().includes(q)) return true;
        if (e.payload && typeof e.payload === 'object') {
          return JSON.stringify(e.payload).toLowerCase().includes(q);
        }
        return false;
      });
    }

    return result;
  }, [events, selectedType, searchQuery]);

  // Clear displayed logs
  const handleClearLogs = () => {
    setEvents([]);
  };

  // Download logs
  const handleDownloadLogs = () => {
    const lines = filteredEvents.map((e) => {
      let payloadStr = '';
      if (typeof e.payload === 'string') {
        payloadStr = e.payload;
      } else if (e.payload) {
        payloadStr = JSON.stringify(e.payload);
      }
      return `[${e.ts}] [#${e.seq}] [${e.type}] ${payloadStr}`;
    });

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-${runId}-logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Format timestamp helper
  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    } catch {
      return iso;
    }
  };

  // Status Badge styles
  const getStatusBadgeStyle = () => {
    switch (connectionState) {
      case 'connected':
        return {
          bg: '#dcfce7',
          color: '#15803d',
          border: '#86efac',
          label: 'TRỰC TUYẾN (LIVE)',
          dotColor: '#22c55e',
        };
      case 'completed':
        return {
          bg: '#f1f5f9',
          color: '#475569',
          border: '#cbd5e1',
          label: 'HOÀN THÀNH',
          dotColor: '#64748b',
        };
      case 'error':
        return {
          bg: '#fee2e2',
          color: '#b91c1c',
          border: '#fca5a5',
          label: 'LỖI KẾT NỐI',
          dotColor: '#ef4444',
        };
      case 'disconnected':
        return {
          bg: '#fef3c7',
          color: '#b45309',
          border: '#fcd34d',
          label: 'MẤT KẾT NỐI',
          dotColor: '#f59e0b',
        };
      case 'connecting':
      default:
        return {
          bg: '#e0f2fe',
          color: '#0369a1',
          border: '#7dd3fc',
          label: 'ĐANG KẾT NỐI...',
          dotColor: '#0284c7',
        };
    }
  };

  const statusStyle = getStatusBadgeStyle();

  const getEventTypeColor = (type: string) => {
    switch (type) {
      case 'stderr':
        return { badgeBg: '#450a0a', badgeText: '#f87171', textColor: '#fca5a5' };
      case 'stdout':
        return { badgeBg: '#052e16', badgeText: '#4ade80', textColor: '#e2e8f0' };
      case 'process_start':
        return { badgeBg: '#082f49', badgeText: '#38bdf8', textColor: '#bae6fd' };
      case 'process_exit':
        return { badgeBg: '#3b0764', badgeText: '#c084fc', textColor: '#e9d5ff' };
      case 'checkpoint':
        return { badgeBg: '#451a03', badgeText: '#fbbf24', textColor: '#fef08a' };
      case 'parse_error':
        return { badgeBg: '#431407', badgeText: '#fb923c', textColor: '#fed7aa' };
      default:
        return { badgeBg: '#1e293b', badgeText: '#94a3b8', textColor: '#cbd5e1' };
    }
  };

  return (
    <div
      data-testid="live-log-viewer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#090d16',
        borderRadius: '10px',
        border: '1px solid #1e293b',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
        overflow: 'hidden',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      {/* 1. Header & Toolbar */}
      <div
        data-testid="live-log-toolbar"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid #1e293b',
          gap: '12px',
        }}
      >
        {/* Left: Run ID & Connection Badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span
            data-testid="live-run-id"
            style={{
              fontSize: '12px',
              fontWeight: 700,
              color: '#38bdf8',
              backgroundColor: '#082f49',
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid #0284c7',
            }}
          >
            RUN #{runId.slice(0, 8)}
          </span>

          <span
            data-testid="live-status-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              fontWeight: 700,
              padding: '3px 8px',
              borderRadius: '9999px',
              backgroundColor: statusStyle.bg,
              color: statusStyle.color,
              border: `1px solid ${statusStyle.border}`,
              letterSpacing: '0.04em',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: statusStyle.dotColor,
                display: 'inline-block',
              }}
            />
            {statusStyle.label}
          </span>

          <span
            data-testid="live-event-count"
            style={{
              fontSize: '12px',
              color: '#94a3b8',
              fontWeight: 500,
            }}
          >
            {filteredEvents.length} / {events.length} sự kiện
          </span>
        </div>

        {/* Right: Controls & Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Search Input */}
          <input
            type="text"
            data-testid="input-log-search"
            placeholder="Tìm kiếm log..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '6px',
              color: '#f8fafc',
              width: '140px',
              outline: 'none',
            }}
          />

          {/* Event Type Filter */}
          <select
            data-testid="select-event-filter"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '6px',
              color: '#f8fafc',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="all">Tất cả</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
            <option value="checkpoint">checkpoint</option>
            <option value="process_start">process_start</option>
            <option value="process_exit">process_exit</option>
            <option value="parse_error">parse_error</option>
            <option value="ndjson">NDJSON khác</option>
          </select>

          {/* Auto Scroll Toggle */}
          <button
            type="button"
            data-testid="btn-toggle-autoscroll"
            data-autoscroll={autoScroll ? 'true' : 'false'}
            onClick={() => setAutoScroll((prev) => !prev)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
              fontSize: '12px',
              fontWeight: 600,
              backgroundColor: autoScroll ? '#1e3a8a' : '#1e293b',
              color: autoScroll ? '#93c5fd' : '#94a3b8',
              border: `1px solid ${autoScroll ? '#3b82f6' : '#334155'}`,
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            title={autoScroll ? 'Đang tự động cuộn xuống cuối' : 'Tự động cuộn đang tắt'}
          >
            {autoScroll ? '⬇ Cuộn: BẬT' : '⏸ Cuộn: TẮT'}
          </button>

          {/* Reconnect button */}
          <button
            type="button"
            data-testid="btn-reconnect"
            onClick={() => setReconnectKey((k) => k + 1)}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              fontWeight: 500,
              backgroundColor: '#1e293b',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            title="Kết nối lại luồng SSE"
          >
            🔄 Kết nối lại
          </button>

          {/* Clear button */}
          <button
            type="button"
            data-testid="btn-clear-logs"
            onClick={handleClearLogs}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              fontWeight: 500,
              backgroundColor: '#1e293b',
              color: '#94a3b8',
              border: '1px solid #334155',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            title="Xóa log hiện tại khỏi màn hình"
          >
            🧹 Xóa
          </button>

          {/* Download button */}
          <button
            type="button"
            data-testid="btn-download-logs"
            onClick={handleDownloadLogs}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              fontWeight: 500,
              backgroundColor: '#1e293b',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            title="Tải toàn bộ log dạng file text"
          >
            📥 Tải log
          </button>
        </div>
      </div>

      {/* 2. Terminal Output Stream */}
      <div
        ref={terminalRef}
        data-testid="live-terminal-container"
        onScroll={handleScroll}
        style={{
          minHeight: '380px',
          maxHeight: '520px',
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          backgroundColor: '#090d16',
        }}
      >
        {filteredEvents.length === 0 ? (
          <div
            data-testid="empty-logs-message"
            style={{
              padding: '48px 16px',
              textAlign: 'center',
              color: '#64748b',
              fontSize: '13px',
              fontStyle: 'italic',
            }}
          >
            {events.length === 0
              ? 'Đang chờ luồng sự kiện từ tiến trình thực thi...'
              : 'Không có dòng log nào khớp với bộ lọc tìm kiếm.'}
          </div>
        ) : (
          filteredEvents.map((evt) => {
            const colors = getEventTypeColor(evt.type);

            let payloadText = '';
            if (typeof evt.payload === 'string') {
              payloadText = evt.payload;
            } else if (evt.payload && typeof evt.payload === 'object') {
              payloadText = JSON.stringify(evt.payload);
            }

            return (
              <div
                key={evt.id || `${evt.run_id}-${evt.seq}`}
                data-testid={`log-line-${evt.seq}`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  padding: '2px 4px',
                  borderRadius: '4px',
                  backgroundColor:
                    evt.type === 'stderr' ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                }}
              >
                {/* Sequence */}
                <span
                  data-testid={`log-seq-${evt.seq}`}
                  style={{
                    color: '#64748b',
                    fontSize: '11px',
                    width: '38px',
                    textAlign: 'right',
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  #{evt.seq}
                </span>

                {/* Timestamp */}
                <span
                  data-testid={`log-time-${evt.seq}`}
                  style={{
                    color: '#475569',
                    fontSize: '11px',
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  {formatTime(evt.ts)}
                </span>

                {/* Type Badge */}
                <span
                  data-testid={`log-type-${evt.seq}`}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: '4px',
                    backgroundColor: colors.badgeBg,
                    color: colors.badgeText,
                    flexShrink: 0,
                    minWidth: '70px',
                    textAlign: 'center',
                    textTransform: 'uppercase',
                    userSelect: 'none',
                  }}
                >
                  {evt.type}
                </span>

                {/* Content */}
                <span
                  data-testid={`log-content-${evt.seq}`}
                  style={{
                    color: colors.textColor,
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap',
                    flex: 1,
                  }}
                >
                  {payloadText}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
