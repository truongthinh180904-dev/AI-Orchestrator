'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api as defaultApi, ApiClient } from '../lib/api.js';

export interface ConnectionStatusProps {
  apiClient?: ApiClient;
  pollIntervalMs?: number;
  onStatusChange?: (status: 'checking' | 'connected' | 'disconnected') => void;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  apiClient = defaultApi,
  pollIntervalMs,
  onStatusChange,
}) => {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [backendUrl, setBackendUrl] = useState<string>(apiClient.getBaseUrl());
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const checkConnection = useCallback(async () => {
    setIsRefreshing(true);
    setErrorMessage(null);
    try {
      const res = await apiClient.checkHealth();
      if (res && res.status === 'ok') {
        setStatus('connected');
        onStatusChange?.('connected');
      } else {
        setStatus('connected');
        onStatusChange?.('connected');
      }
    } catch (err) {
      setStatus('disconnected');
      setErrorMessage(err instanceof Error ? err.message : String(err));
      onStatusChange?.('disconnected');
    } finally {
      setLastChecked(new Date());
      setIsRefreshing(false);
      setBackendUrl(apiClient.getBaseUrl());
    }
  }, [apiClient, onStatusChange]);

  useEffect(() => {
    void checkConnection();

    if (pollIntervalMs && pollIntervalMs > 0) {
      const timer = setInterval(() => {
        void checkConnection();
      }, pollIntervalMs);
      return () => clearInterval(timer);
    }
  }, [checkConnection, pollIntervalMs]);

  const isConnected = status === 'connected';
  const isChecking = status === 'checking';

  const badgeBg = isChecking ? '#fef3c7' : isConnected ? '#dcfce7' : '#fee2e2';
  const badgeBorder = isChecking ? '#f59e0b' : isConnected ? '#22c55e' : '#ef4444';
  const badgeText = isChecking ? '#92400e' : isConnected ? '#15803d' : '#b91c1c';
  const dotColor = isChecking ? '#f59e0b' : isConnected ? '#16a34a' : '#dc2626';

  const statusLabel = isChecking
    ? 'Đang kiểm tra API...'
    : isConnected
      ? 'API Trực tuyến'
      : 'Mất kết nối API';

  return (
    <div
      data-testid="connection-status-container"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
      }}
    >
      <div
        data-testid="connection-status-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '9999px',
          backgroundColor: badgeBg,
          border: `1px solid ${badgeBorder}`,
          color: badgeText,
          fontWeight: 600,
        }}
        title={
          errorMessage ?? (lastChecked ? `Kiểm tra lúc: ${lastChecked.toLocaleTimeString()}` : '')
        }
      >
        <span
          data-testid="connection-status-dot"
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: dotColor,
            display: 'inline-block',
          }}
        />
        <span>{statusLabel}</span>
      </div>

      <span
        data-testid="connection-backend-url"
        style={{
          color: '#64748b',
          fontFamily: 'monospace',
          fontSize: '11px',
        }}
      >
        {backendUrl}
      </span>

      <button
        type="button"
        data-testid="connection-refresh-btn"
        onClick={() => void checkConnection()}
        disabled={isRefreshing}
        style={{
          padding: '2px 8px',
          fontSize: '11px',
          border: '1px solid #cbd5e1',
          borderRadius: '4px',
          backgroundColor: '#ffffff',
          color: '#475569',
          cursor: isRefreshing ? 'not-allowed' : 'pointer',
        }}
        title="Kiểm tra lại kết nối API"
      >
        {isRefreshing ? '...' : 'Làm mới'}
      </button>
    </div>
  );
};
