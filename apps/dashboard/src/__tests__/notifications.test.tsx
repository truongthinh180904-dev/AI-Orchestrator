/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  NotificationStore,
  createNotificationFromEvent,
  type DashboardNotification,
} from '../lib/notifications.js';
import {
  NotificationBell,
  NotificationToastContainer,
  NotificationCenter,
} from '../components/NotificationCenter.js';
import type { EventRecord } from '@ai-orchestrator/shared';

describe('Notification System & NotificationCenter (UI-004)', () => {
  let store: NotificationStore;

  beforeEach(() => {
    store = new NotificationStore(20);
  });

  afterEach(() => {
    cleanup();
  });

  it('NotificationStore manages notifications and unread counts', () => {
    expect(store.getNotifications()).toHaveLength(0);
    expect(store.getUnreadCount()).toBe(0);

    const n1 = store.notify({
      title: 'Task Created',
      message: 'New task queued',
      severity: 'info',
    });

    const n2 = store.notify({
      title: 'Run Failed',
      message: 'Process returned non-zero code',
      severity: 'error',
    });

    expect(store.getNotifications()).toHaveLength(2);
    expect(store.getUnreadCount()).toBe(2);

    store.markAsRead(n1.id);
    expect(store.getUnreadCount()).toBe(1);

    store.markAllAsRead();
    expect(store.getUnreadCount()).toBe(0);

    store.remove(n2.id);
    expect(store.getNotifications()).toHaveLength(1);

    store.clearAll();
    expect(store.getNotifications()).toHaveLength(0);
  });

  it('createNotificationFromEvent correctly maps event types', () => {
    // 1. process_start
    const startEvt: EventRecord = {
      id: 1,
      run_id: 'run-notif-1',
      seq: 1,
      type: 'process_start',
      payload: { pid: 100 },
      ts: '2026-10-23T00:00:00Z',
    };
    const startNotif = createNotificationFromEvent(startEvt, { taskId: 'TSK-1' });
    expect(startNotif?.severity).toBe('info');
    expect(startNotif?.title).toContain('Tiến trình bắt đầu');
    expect(startNotif?.link).toBe('/tasks/TSK-1');

    // 2. checkpoint
    const cpEvt: EventRecord = {
      id: 2,
      run_id: 'run-notif-1',
      seq: 2,
      type: 'checkpoint',
      payload: { step: 'compile_code' },
      ts: '2026-10-23T00:01:00Z',
    };
    const cpNotif = createNotificationFromEvent(cpEvt);
    expect(cpNotif?.severity).toBe('info');
    expect(cpNotif?.title).toContain('Checkpoint hoàn thành');
    expect(cpNotif?.message).toContain('compile_code');

    // 3. process_exit (success)
    const exitOkEvt: EventRecord = {
      id: 3,
      run_id: 'run-notif-1',
      seq: 3,
      type: 'process_exit',
      payload: { exitCode: 0 },
      ts: '2026-10-23T00:02:00Z',
    };
    const exitOkNotif = createNotificationFromEvent(exitOkEvt);
    expect(exitOkNotif?.severity).toBe('success');
    expect(exitOkNotif?.message).toContain('mã thoát 0');

    // 4. process_exit (failure)
    const exitFailEvt: EventRecord = {
      id: 4,
      run_id: 'run-notif-1',
      seq: 4,
      type: 'process_exit',
      payload: { exitCode: 137 },
      ts: '2026-10-23T00:03:00Z',
    };
    const exitFailNotif = createNotificationFromEvent(exitFailEvt);
    expect(exitFailNotif?.severity).toBe('error');
    expect(exitFailNotif?.message).toContain('137');

    // 5. parse_error
    const parseErrEvt: EventRecord = {
      id: 5,
      run_id: 'run-notif-1',
      seq: 5,
      type: 'parse_error',
      payload: { raw: 'invalid json line' },
      ts: '2026-10-23T00:04:00Z',
    };
    const parseNotif = createNotificationFromEvent(parseErrEvt);
    expect(parseNotif?.severity).toBe('warning');

    // 6. stdout (ignored, no spam)
    const stdoutEvt: EventRecord = {
      id: 6,
      run_id: 'run-notif-1',
      seq: 6,
      type: 'stdout',
      payload: 'normal log line',
      ts: '2026-10-23T00:05:00Z',
    };
    expect(createNotificationFromEvent(stdoutEvt)).toBeNull();
  });

  it('NotificationBell renders unread badge and dropdown menu with filters and actions', async () => {
    store.notify({
      title: 'Tác vụ hoàn thành',
      message: 'Run #run-1 thành công',
      severity: 'success',
      link: '/tasks/TSK-1',
    });
    store.notify({
      title: 'Tiến trình lỗi',
      message: 'Run #run-2 thất bại',
      severity: 'error',
    });

    render(<NotificationBell store={store} />);

    // Bell button and badge count
    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(bellBtn).toBeDefined();
    expect(screen.getByTestId('notification-badge-count').textContent).toBe('2');

    // Click to open dropdown
    fireEvent.click(bellBtn);
    expect(screen.getByTestId('notification-dropdown-menu')).toBeDefined();

    // Items rendered
    const items = screen.getByTestId('notification-items-container');
    expect(items).toBeDefined();

    // Check filter tabs
    const unreadTab = screen.getByTestId('tab-unread-notifications');
    fireEvent.click(unreadTab);

    // Mark all as read
    const markAllBtn = screen.getByTestId('btn-mark-all-read');
    fireEvent.click(markAllBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('notification-badge-count')).toBeNull();
    });

    // Clear all
    const clearAllBtn = screen.getByTestId('btn-clear-notifications');
    fireEvent.click(clearAllBtn);

    expect(screen.getByTestId('notification-empty-state')).toBeDefined();
  });

  it('NotificationToastContainer renders toasts with close button', () => {
    const { rerender } = render(<NotificationToastContainer store={store} autoDismissMs={0} />);

    // No toasts initially
    expect(screen.queryByTestId('notification-toast-container')).toBeNull();

    // Add notification
    let n!: DashboardNotification;
    act(() => {
      n = store.notify({
        title: 'Toast Title',
        message: 'Toast message body',
        severity: 'warning',
      });
    });

    rerender(<NotificationToastContainer store={store} autoDismissMs={0} />);

    expect(screen.getByTestId('notification-toast-container')).toBeDefined();
    expect(screen.getByTestId(`notification-toast-${n.id}`)).toBeDefined();
    expect(screen.getByTestId(`toast-title-${n.id}`).textContent).toBe('Toast Title');

    // Close toast
    const closeBtn = screen.getByTestId(`btn-close-toast-${n.id}`);
    fireEvent.click(closeBtn);

    expect(screen.queryByTestId(`notification-toast-${n.id}`)).toBeNull();
  });

  it('NotificationCenter wrapper renders cleanly', () => {
    render(<NotificationCenter store={store} />);
    expect(screen.getByTestId('notification-center-root')).toBeDefined();
    expect(screen.getByTestId('notification-bell-btn')).toBeDefined();
  });
});
