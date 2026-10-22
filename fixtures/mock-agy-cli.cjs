#!/usr/bin/env node
/**
 * Mock AGY CLI for Orchestrator testing (AGY-007, AGY-008)
 * Emits NDJSON events to simulate various agent behavior scenarios.
 */

const mode = process.env.MOCK_SCENARIO || process.argv[2] || 'success';

function emit(type, fields = {}) {
  if (typeof fields === 'string') {
    process.stdout.write(JSON.stringify({ type, message: fields }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ type, ...fields }) + '\n');
  }
}

switch (mode) {
  case 'success': {
    emit('status', { message: 'Agent initialized' });
    emit('stdout', { text: 'Analyzing repository files...' });
    emit('stdout', { text: 'Writing implementation...' });
    emit('result', { status: 'SUCCESS', details: 'All tasks completed successfully' });
    process.exit(0);
    break;
  }

  case 'error': {
    emit('status', { message: 'Agent starting...' });
    process.stderr.write('Fatal: compile error in target file\n');
    emit('result', { status: 'ERROR', error: 'Compilation failed' });
    process.exit(1);
    break;
  }

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
    // Ignore SIGTERM to require SIGKILL
    process.on('SIGTERM', () => {
      // Ignored
    });
    setInterval(() => {}, 1000);
    break;
  }

  case 'invalid_output': {
    process.stdout.write('Plain text output without any result event\n');
    process.exit(0);
    break;
  }

  case 'crash': {
    process.stderr.write('Segmentation fault / unhandled crash\n');
    process.exit(139);
    break;
  }

  default: {
    // If command line arguments passed prompt, echo success
    emit('status', { message: `Running scenario: ${mode}` });
    emit('result', { status: 'SUCCESS' });
    process.exit(0);
  }
}
