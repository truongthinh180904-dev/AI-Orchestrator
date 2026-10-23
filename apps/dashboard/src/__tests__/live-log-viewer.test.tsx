/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { LiveLogViewer } from '../components/LiveLogViewer.js';
import { ApiClient, type StreamHandlers } from '../lib/api.js';
import type { EventRecord } from '@ai-orchestrator/shared';

describe('LiveLogViewer Component (UI-004)', () => {
  afterEach(() => {
    cleanup();
  });

  const mockEvents: EventRecord[] = [
    {
      id: 1,
      run_id: 'run-live-1',
      seq: 1,
      type: 'process_start',
      payload: { pid: 1234, command: 'node worker.js' },
      ts: '2026-10-23T08:00:00.000Z',
    },
    {
      id: 2,
      run_id: 'run-live-1',
      seq: 2,
      type: 'stdout',
      payload: 'Starting worker process initialization...',
      ts: '2026-10-23T08:00:01.000Z',
    },
    {
      id: 3,
      run_id: 'run-live-1',
      seq: 3,
      type: 'stderr',
      payload: 'Warning: Deprecated API warning in library',
      ts: '2026-10-23T08:00:02.000Z',
    },
  ];

  it('renders toolbar, run ID, status badge, and initial events', () => {
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockReturnValue(() => {});

    render(
      <LiveLogViewer
        runId="run-live-1"
        taskId="TSK-001"
        apiClient={mockApiClient}
        initialEvents={mockEvents}
      />,
    );

    expect(screen.getByTestId('live-log-viewer')).toBeDefined();
    expect(screen.getByTestId('live-run-id').textContent).toContain('run-live');
    expect(screen.getByTestId('live-status-badge')).toBeDefined();
    expect(screen.getByTestId('live-event-count').textContent).toContain('3 / 3 sự kiện');

    // Lines
    expect(screen.getByTestId('log-line-1')).toBeDefined();
    expect(screen.getByTestId('log-line-2')).toBeDefined();
    expect(screen.getByTestId('log-line-3')).toBeDefined();

    expect(screen.getByTestId('log-content-2').textContent).toContain(
      'Starting worker process initialization',
    );
    expect(screen.getByTestId('log-content-3').textContent).toContain(
      'Warning: Deprecated API warning in library',
    );
  });

  it('receives streaming events in realtime and appends to terminal', async () => {
    let capturedHandler: StreamHandlers | null = null;
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockImplementation((runId, handlers) => {
      capturedHandler = handlers;
      return () => {};
    });

    render(
      <LiveLogViewer
        runId="run-live-1"
        apiClient={mockApiClient}
        initialEvents={[]}
        dispatchNotifications={false}
      />,
    );

    // Initial state: empty
    expect(screen.getByTestId('empty-logs-message')).toBeDefined();

    // Stream arrives: process_start
    act(() => {
      capturedHandler?.onEvent?.({
        id: 10,
        run_id: 'run-live-1',
        seq: 1,
        type: 'process_start',
        payload: { pid: 999 },
        ts: '2026-10-23T08:10:00.000Z',
      });

      // Stream arrives: stdout
      capturedHandler?.onEvent?.({
        id: 11,
        run_id: 'run-live-1',
        seq: 2,
        type: 'stdout',
        payload: 'Running compilation step',
        ts: '2026-10-23T08:10:01.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('log-line-1')).toBeDefined();
      expect(screen.getByTestId('log-line-2')).toBeDefined();
      expect(screen.getByTestId('log-content-2').textContent).toContain('Running compilation step');
    });

    expect(screen.getByTestId('live-event-count').textContent).toContain('2 / 2 sự kiện');
  });

  it('toggles auto-scroll on and off', () => {
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockReturnValue(() => {});

    render(
      <LiveLogViewer
        runId="run-live-1"
        apiClient={mockApiClient}
        initialEvents={mockEvents}
        autoScrollDefault={true}
      />,
    );

    const toggleBtn = screen.getByTestId('btn-toggle-autoscroll');
    expect(toggleBtn.getAttribute('data-autoscroll')).toBe('true');
    expect(toggleBtn.textContent).toContain('Cuộn: BẬT');

    // Click to pause auto-scroll
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('data-autoscroll')).toBe('false');
    expect(toggleBtn.textContent).toContain('Cuộn: TẮT');

    // Click again to re-enable
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('data-autoscroll')).toBe('true');
    expect(toggleBtn.textContent).toContain('Cuộn: BẬT');
  });

  it('filters events by search query', () => {
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockReturnValue(() => {});

    render(
      <LiveLogViewer runId="run-live-1" apiClient={mockApiClient} initialEvents={mockEvents} />,
    );

    const searchInput = screen.getByTestId('input-log-search');
    fireEvent.change(searchInput, { target: { value: 'Deprecated' } });

    expect(screen.queryByTestId('log-line-1')).toBeNull();
    expect(screen.queryByTestId('log-line-2')).toBeNull();
    expect(screen.getByTestId('log-line-3')).toBeDefined();
    expect(screen.getByTestId('live-event-count').textContent).toContain('1 / 3 sự kiện');
  });

  it('filters events by event type select dropdown', () => {
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockReturnValue(() => {});

    render(
      <LiveLogViewer runId="run-live-1" apiClient={mockApiClient} initialEvents={mockEvents} />,
    );

    const selectFilter = screen.getByTestId('select-event-filter');
    fireEvent.change(selectFilter, { target: { value: 'stderr' } });

    expect(screen.queryByTestId('log-line-1')).toBeNull();
    expect(screen.queryByTestId('log-line-2')).toBeNull();
    expect(screen.getByTestId('log-line-3')).toBeDefined();
  });

  it('clears displayed logs when clear button is clicked', () => {
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockReturnValue(() => {});

    render(
      <LiveLogViewer runId="run-live-1" apiClient={mockApiClient} initialEvents={mockEvents} />,
    );

    expect(screen.getByTestId('log-line-1')).toBeDefined();

    const clearBtn = screen.getByTestId('btn-clear-logs');
    fireEvent.click(clearBtn);

    expect(screen.queryByTestId('log-line-1')).toBeNull();
    expect(screen.getByTestId('empty-logs-message')).toBeDefined();
  });

  it('enforces buffer limit and shifts oldest logs when exceeding maxBufferSize', async () => {
    let capturedHandler: StreamHandlers | null = null;
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockImplementation((runId, handlers) => {
      capturedHandler = handlers;
      return () => {};
    });

    render(
      <LiveLogViewer
        runId="run-live-1"
        apiClient={mockApiClient}
        maxBufferSize={3}
        initialEvents={[]}
        dispatchNotifications={false}
      />,
    );

    act(() => {
      for (let i = 1; i <= 5; i++) {
        capturedHandler?.onEvent?.({
          id: i,
          run_id: 'run-live-1',
          seq: i,
          type: 'stdout',
          payload: `Log message line ${i}`,
          ts: `2026-10-23T08:00:0${i}.000Z`,
        });
      }
    });

    await waitFor(() => {
      // Lines 1 and 2 should have been shifted out
      expect(screen.queryByTestId('log-line-1')).toBeNull();
      expect(screen.queryByTestId('log-line-2')).toBeNull();
      // Lines 3, 4, 5 are kept
      expect(screen.getByTestId('log-line-3')).toBeDefined();
      expect(screen.getByTestId('log-line-4')).toBeDefined();
      expect(screen.getByTestId('log-line-5')).toBeDefined();
    });

    expect(screen.getByTestId('live-event-count').textContent).toContain('3 / 3 sự kiện');
  });

  it('updates connection badge to completed when done event is received', async () => {
    let capturedHandler: StreamHandlers | null = null;
    const mockApiClient = new ApiClient({ baseUrl: 'http://localhost:3000' });
    vi.spyOn(mockApiClient, 'subscribeToRunStream').mockImplementation((runId, handlers) => {
      capturedHandler = handlers;
      return () => {};
    });

    const onCompletedMock = vi.fn();

    render(
      <LiveLogViewer
        runId="run-live-1"
        apiClient={mockApiClient}
        initialEvents={mockEvents}
        onCompleted={onCompletedMock}
      />,
    );

    act(() => {
      capturedHandler?.onDone?.({ runId: 'run-live-1', status: 'SUCCESS' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-status-badge').textContent).toContain('HOÀN THÀNH');
      expect(onCompletedMock).toHaveBeenCalledWith('SUCCESS');
    });
  });
});
