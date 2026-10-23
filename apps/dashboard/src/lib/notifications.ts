import { useSyncExternalStore } from 'react';
import type { EventRecord } from '@ai-orchestrator/shared';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';
export type WebNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface DashboardNotification {
  id: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  timestamp: string; // ISO string
  read: boolean;
  runId?: string;
  taskId?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export type CreateNotificationInput = {
  title: string;
  message: string;
  severity?: NotificationSeverity;
  runId?: string;
  taskId?: string;
  link?: string;
  metadata?: Record<string, unknown>;
};

export class NotificationStore {
  private notifications: DashboardNotification[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxCount: number;

  constructor(maxCount = 100) {
    this.maxCount = maxCount;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DashboardNotification[] => {
    return this.notifications;
  };

  getNotifications(): DashboardNotification[] {
    return [...this.notifications];
  }

  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  notify(input: CreateNotificationInput): DashboardNotification {
    const notification: DashboardNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      message: input.message,
      severity: input.severity ?? 'info',
      timestamp: new Date().toISOString(),
      read: false,
      runId: input.runId,
      taskId: input.taskId,
      link: input.link,
      metadata: input.metadata,
    };

    this.notifications = [notification, ...this.notifications].slice(0, this.maxCount);
    this.emitChange();

    // Trigger browser Web Notification if available and permitted
    const globalNotification =
      typeof globalThis !== 'undefined'
        ? (
            globalThis as unknown as {
              Notification?: {
                permission: string;
                new (title: string, options?: { body?: string; icon?: string }): unknown;
              };
            }
          ).Notification
        : undefined;

    if (globalNotification) {
      try {
        if (globalNotification.permission === 'granted') {
          new globalNotification(notification.title, {
            body: notification.message,
            icon: '/favicon.ico',
          });
        }
      } catch {
        // Ignore notification errors in unsupported/restricted environments
      }
    }

    return notification;
  }

  markAsRead(id: string): void {
    let changed = false;
    this.notifications = this.notifications.map((n) => {
      if (n.id === id && !n.read) {
        changed = true;
        return { ...n, read: true };
      }
      return n;
    });
    if (changed) {
      this.emitChange();
    }
  }

  markAllAsRead(): void {
    if (this.notifications.some((n) => !n.read)) {
      this.notifications = this.notifications.map((n) => ({ ...n, read: true }));
      this.emitChange();
    }
  }

  remove(id: string): void {
    const prevLen = this.notifications.length;
    this.notifications = this.notifications.filter((n) => n.id !== id);
    if (this.notifications.length !== prevLen) {
      this.emitChange();
    }
  }

  clearAll(): void {
    if (this.notifications.length > 0) {
      this.notifications = [];
      this.emitChange();
    }
  }

  async requestWebPermission(): Promise<WebNotificationPermission> {
    const globalNotification =
      typeof globalThis !== 'undefined'
        ? (
            globalThis as unknown as {
              Notification?: {
                requestPermission: () => Promise<string>;
              };
            }
          ).Notification
        : undefined;

    if (!globalNotification) {
      return 'unsupported';
    }
    try {
      const res = await globalNotification.requestPermission();
      return res as WebNotificationPermission;
    } catch {
      return 'denied';
    }
  }
}

export const notificationStore = new NotificationStore();

/**
 * Maps raw SSE EventRecord to appropriate user notification if significant
 */
export function createNotificationFromEvent(
  event: EventRecord,
  context?: { taskId?: string; runId?: string },
  targetStore: NotificationStore = notificationStore,
): DashboardNotification | null {
  const runId = event.run_id ?? context?.runId ?? 'N/A';
  const taskId = context?.taskId;
  const link = taskId ? `/tasks/${taskId}` : undefined;

  switch (event.type) {
    case 'process_start': {
      return targetStore.notify({
        title: 'Tiến trình bắt đầu',
        message: `Phiên chạy #${runId} đã khởi động tiến trình worker.`,
        severity: 'info',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq },
      });
    }

    case 'checkpoint': {
      const payload = event.payload as Record<string, unknown> | undefined;
      const stepName = typeof payload?.step === 'string' ? payload.step : 'checkpoint';
      return targetStore.notify({
        title: 'Mốc Checkpoint hoàn thành',
        message: `Run #${runId} đã đạt mốc "${stepName}".`,
        severity: 'info',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq, step: stepName },
      });
    }

    case 'process_exit': {
      const payload = event.payload as Record<string, unknown> | undefined;
      const exitCode = typeof payload?.exitCode === 'number' ? payload.exitCode : 0;
      const isSuccess = exitCode === 0;

      return targetStore.notify({
        title: isSuccess ? 'Tiến trình hoàn tất thành công' : 'Tiến trình kết thúc với lỗi',
        message: isSuccess
          ? `Run #${runId} hoàn tất thành công (mã thoát 0).`
          : `Run #${runId} thất bại với mã lỗi ${exitCode}.`,
        severity: isSuccess ? 'success' : 'error',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq, exitCode },
      });
    }

    case 'parse_error': {
      return targetStore.notify({
        title: 'Cảnh báo cú pháp NDJSON',
        message: `Run #${runId} phát hiện dòng log không đúng định dạng JSON.`,
        severity: 'warning',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq },
      });
    }

    case 'process_timeout': {
      return targetStore.notify({
        title: 'Tiến trình bị Timeout',
        message: `Run #${runId} đã vượt quá thời gian thực thi tối đa và bị dừng.`,
        severity: 'error',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq },
      });
    }

    case 'process_stopped': {
      return targetStore.notify({
        title: 'Tiến trình đã dừng',
        message: `Run #${runId} đã được dừng theo yêu cầu của người điều hành.`,
        severity: 'warning',
        runId,
        taskId,
        link,
        metadata: { eventId: event.id, seq: event.seq },
      });
    }

    default:
      return null;
  }
}

/**
 * React hook for consuming notifications reactively
 */
export function useNotifications(store: NotificationStore = notificationStore) {
  const notifications = useSyncExternalStore(store.subscribe, store.getSnapshot, () => []);
  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    unreadCount,
    notify: store.notify.bind(store),
    markAsRead: store.markAsRead.bind(store),
    markAllAsRead: store.markAllAsRead.bind(store),
    remove: store.remove.bind(store),
    clearAll: store.clearAll.bind(store),
    requestWebPermission: store.requestWebPermission.bind(store),
  };
}
