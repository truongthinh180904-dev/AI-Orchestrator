#!/usr/bin/env node
/**
 * Mock AGY CLI for Orchestrator testing (AGY-007, AGY-008)
 * Emits NDJSON events to simulate various agent behavior scenarios:
 * - success: 정상적인 완료
 * - error / error_exit_only / error_result_zero_exit: Các tình huống lỗi
 * - timeout / hang / stubborn / delay: Các tình huống timeout / treo tiến trình
 * - crash / crash_segfault / crash_uncaught / crash_signal: Các tình huống crash đột ngột
 * - invalid_output / no_result / invalid_result_schema / garbage_stream / empty / huge_line: Các tình huống output rác / sai định dạng
 */

const mode = process.env.MOCK_SCENARIO || process.argv[2] || 'success';

function finish(code = 0) {
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

function emit(type, fields = {}) {
  if (typeof fields === 'string') {
    process.stdout.write(JSON.stringify({ type, message: fields }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ type, ...fields }) + '\n');
  }
}

switch (mode) {
  // ==========================================
  // Thành công bình thường
  // ==========================================
  case 'success': {
    emit('status', { message: 'Agent initialized' });
    emit('stdout', { text: 'Analyzing repository files...' });
    emit('stdout', { text: 'Writing implementation...' });
    emit('result', { status: 'SUCCESS', details: 'All tasks completed successfully' });
    process.exit(0);
    break;
  }

  // ==========================================
  // Nhóm tình huống 1: Lỗi (Error)
  // ==========================================
  case 'error': {
    emit('status', { message: 'Agent starting...' });
    process.stderr.write('Fatal: compile error in target file\n');
    emit('result', { status: 'ERROR', error: 'Compilation failed' });
    process.exit(1);
    break;
  }

  case 'error_exit_only': {
    emit('status', { message: 'Agent encountered critical failure' });
    process.stderr.write('Process exited with code 1 without result event\n');
    process.exit(1);
    break;
  }

  case 'error_exit_2': {
    process.stderr.write('Syntax error or fatal configuration error\n');
    process.exit(2);
    break;
  }

  case 'error_result_zero_exit': {
    emit('status', { message: 'Agent finished execution with logical failure' });
    emit('stdout', { text: 'Quality gate checks reported 3 errors' });
    emit('result', { status: 'ERROR', error: 'Quality checks failed', details: 'ESLint found 3 errors' });
    process.exit(0);
    break;
  }

  // ==========================================
  // Nhóm tình huống 2: Timeout (Treo / Quá hạn)
  // ==========================================
  case 'hang':
  case 'timeout': {
    emit('status', { message: 'Agent starting long task...' });
    // Keep alive indefinitely until terminated by timeout / stop
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      clearInterval(timer);
      process.exit(0);
    });
    break;
  }

  case 'stubborn': {
    emit('status', { message: 'Agent ignoring termination...' });
    // Ignore SIGTERM to require SIGKILL escalation
    process.on('SIGTERM', () => {
      // Intentionally ignored to simulate unresponsive process
    });
    setInterval(() => {}, 1000);
    break;
  }

  case 'delay': {
    const delayMs = Number.parseInt(process.argv[3] || '2000', 10);
    emit('status', { message: `Agent sleeping for ${delayMs}ms...` });
    setTimeout(() => {
      emit('result', { status: 'SUCCESS', details: `Finished after ${delayMs}ms` });
      process.exit(0);
    }, delayMs);
    break;
  }

  // ==========================================
  // Nhóm tình huống 3: Crash đột ngột
  // ==========================================
  case 'crash':
  case 'crash_segfault': {
    process.stderr.write('Segmentation fault / unhandled crash (core dumped)\n');
    process.exit(139);
    break;
  }

  case 'crash_uncaught': {
    emit('status', { message: 'Agent encountering unhandled exception...' });
    process.nextTick(() => {
      throw new Error('Fatal: Uncaught TypeError in worker runtime');
    });
    break;
  }

  case 'crash_signal': {
    emit('status', { message: 'Agent committing suicide via SIGKILL...' });
    process.kill(process.pid, 'SIGKILL');
    break;
  }

  // ==========================================
  // Nhóm tình huống 4: Output rác / Sai định dạng
  // ==========================================
  case 'invalid_output':
  case 'no_result': {
    process.stdout.write('Plain text output without any result event\n');
    process.stdout.write('Additional plain text log line\n');
    process.exit(0);
    break;
  }

  case 'invalid_result_schema': {
    emit('status', { message: 'Agent completed with invalid result payload' });
    // result payload missing required status or success boolean field
    process.stdout.write(JSON.stringify({ type: 'result', payload: { unexpected_field: 12345 } }) + '\n');
    process.exit(0);
    break;
  }

  case 'invalid_result_non_object': {
    emit('status', { message: 'Agent completed with non-object result payload' });
    process.stdout.write('{"type":"result","payload":12345}\n');
    process.exit(0);
    break;
  }

  case 'empty': {
    // Process exits immediately without emitting any lines
    process.exit(0);
    break;
  }

  case 'garbage_stream': {
    // Mix of valid events and corrupted/garbage lines, ending with valid SUCCESS result
    emit('status', { message: 'Agent starting with garbage stream test' });
    process.stdout.write('>>> RAW LOG: Compiling packages...\n');
    process.stdout.write('{"corrupted_json: true\n');
    process.stdout.write('\x00\x01\x02binary noise\x03\n');
    process.stdout.write('   \n'); // Whitespace-only line
    emit('stdout', { text: 'Valid stdout message after garbage' });
    process.stdout.write('{"type": "broken", invalid json content\n');
    emit('result', { status: 'SUCCESS', details: 'Handled garbage lines cleanly' });
    process.exit(0);
    break;
  }

  case 'garbage_stream_no_result': {
    // Mix of corrupted lines without any result event -> INVALID_OUTPUT
    process.stdout.write('Initial plain log\n');
    process.stdout.write('{"bad: json\n');
    process.stdout.write('More junk text here...\n');
    process.exit(0);
    break;
  }

  case 'garbage_stream_error': {
    // Garbage lines followed by an ERROR result
    emit('status', { message: 'Agent failing with garbage' });
    process.stdout.write('Broken json line {"foo":\n');
    process.stderr.write('Error output on stderr\n');
    emit('result', { status: 'ERROR', error: 'Failed with garbage output' });
    process.exit(1);
    break;
  }

  case 'huge_line': {
    emit('status', { message: 'Testing huge NDJSON line handling' });
    const hugePayload = 'A'.repeat(200000); // 200KB line
    emit('stdout', { text: hugePayload });
    emit('result', { status: 'SUCCESS', details: 'Huge line processed' });
    finish(0);
    break;
  }

  default: {
    // If command line arguments passed prompt, echo success
    emit('status', { message: `Running scenario: ${mode}` });
    emit('result', { status: 'SUCCESS' });
    process.exit(0);
  }
}
