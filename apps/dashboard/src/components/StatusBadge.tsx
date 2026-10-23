import React from 'react';
import type { TaskStatus, FeatureStatus } from '@ai-orchestrator/shared';

export interface StatusBadgeProps {
  status: TaskStatus | FeatureStatus | string;
  size?: 'sm' | 'md';
}

export interface StatusStyle {
  bg: string;
  text: string;
  border: string;
  dot: string;
}

export function getStatusStyle(status: string): StatusStyle {
  switch (status.toUpperCase()) {
    case 'DONE':
    case 'SUCCESS':
    case 'COMPLETED':
    case 'MERGED':
      return { bg: '#dcfce7', text: '#166534', border: '#86efac', dot: '#16a34a' };
    case 'READY_FOR_REVIEW':
      return { bg: '#fef3c7', text: '#92400e', border: '#fcd34d', dot: '#d97706' };
    case 'PR_CREATED':
      return { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe', dot: '#9333ea' };
    case 'PUSHED':
      return { bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc', dot: '#4f46e5' };
    case 'COMMITTED':
      return { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd', dot: '#2563eb' };
    case 'BRANCH_CREATED':
      return { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc', dot: '#0284c7' };
    case 'RUNNING':
      return { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd', dot: '#2563eb' };
    case 'VERIFYING':
      return { bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc', dot: '#4f46e5' };
    case 'READY':
      return { bg: '#fef9c3', text: '#854d0e', border: '#fde047', dot: '#ca8a04' };
    case 'IN_PROGRESS':
      return { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc', dot: '#0284c7' };
    case 'FAILED':
    case 'ERROR':
      return { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', dot: '#dc2626' };
    case 'TIMEOUT':
      return { bg: '#fff7ed', text: '#c2410c', border: '#fed7aa', dot: '#ea580c' };
    case 'INVALID_OUTPUT':
      return { bg: '#fae8ff', text: '#86198f', border: '#f5d0fe', dot: '#c026d3' };
    case 'BLOCKED':
      return { bg: '#ffedd5', text: '#9a3412', border: '#fdba74', dot: '#ea580c' };
    case 'PAUSED':
      return { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe', dot: '#9333ea' };
    case 'CANCELLED':
    case 'SKIPPED':
      return { bg: '#f1f5f9', text: '#64748b', border: '#cbd5e1', dot: '#94a3b8' };
    case 'PENDING':
    case 'TODO':
    default:
      return { bg: '#f8fafc', text: '#475569', border: '#cbd5e1', dot: '#64748b' };
  }
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'sm' }) => {
  const style = getStatusStyle(status);
  const isSm = size === 'sm';
  return (
    <span
      data-testid={`status-badge-${status.toLowerCase()}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: isSm ? '2px 8px' : '4px 10px',
        borderRadius: '9999px',
        fontSize: isSm ? '12px' : '13px',
        fontWeight: 600,
        backgroundColor: style.bg,
        color: style.text,
        border: `1px solid ${style.border}`,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: isSm ? '6px' : '8px',
          height: isSm ? '6px' : '8px',
          borderRadius: '50%',
          backgroundColor: style.dot,
          flexShrink: 0,
        }}
      />
      {status}
    </span>
  );
};
