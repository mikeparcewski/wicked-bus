#!/usr/bin/env node

/**
 * wicked-bus CLI entry point.
 */

import { WBError, EXIT_CODES } from '../lib/errors.js';

// Argument parser. Returns flags + positional args (anything that isn't --flag
// or its value). Positional args are needed for subcommands like `dlq list`.
function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = argv[++i];
      }
    } else {
      positional.push(argv[i]);
    }
  }
  args._positional = positional;
  return args;
}

function printUsage() {
  const usage = {
    usage: 'wicked-bus <command> [options]',
    commands: [
      'init', 'emit', 'subscribe', 'status', 'replay',
      'cleanup', 'register', 'deregister', 'list', 'ack',
      'dlq',
    ],
    global_flags: ['--db-path <path>', '--json', '--log-level <level>'],
  };
  process.stdout.write(JSON.stringify(usage, null, 2) + '\n');
}

function handleError(err) {
  if (err instanceof WBError) {
    process.stderr.write(JSON.stringify(err.toJSON()) + '\n');
    process.exit(EXIT_CODES[err.error] || 1);
  }
  process.stderr.write(JSON.stringify({
    error: 'UNKNOWN',
    code: 'INTERNAL_ERROR',
    message: err.message,
  }) + '\n');
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flagArgv = argv.slice(1);
  const args = parseArgs(flagArgv);

  // Extract global flags
  const globals = {
    db_path: args['db-path'] || null,
    json: args.json !== false,
    log_level: args['log-level'] || null,
  };

  // Remove global flags from args
  delete args['db-path'];
  delete args.json;
  delete args['log-level'];

  try {
    switch (command) {
      case 'init': {
        const { cmdInit } = await import('./cmd-init.js');
        await cmdInit(args, globals);
        break;
      }
      case 'emit': {
        const { cmdEmit } = await import('./cmd-emit.js');
        await cmdEmit(args, globals);
        break;
      }
      case 'subscribe': {
        const { cmdSubscribe } = await import('./cmd-subscribe.js');
        await cmdSubscribe(args, globals);
        break;
      }
      case 'status': {
        const { cmdStatus } = await import('./cmd-status.js');
        await cmdStatus(args, globals);
        break;
      }
      case 'replay': {
        const { cmdReplay } = await import('./cmd-replay.js');
        await cmdReplay(args, globals);
        break;
      }
      case 'cleanup': {
        const { cmdCleanup } = await import('./cmd-cleanup.js');
        await cmdCleanup(args, globals);
        break;
      }
      case 'register': {
        const { cmdRegister } = await import('./cmd-register.js');
        await cmdRegister(args, globals);
        break;
      }
      case 'deregister': {
        const { cmdDeregister } = await import('./cmd-deregister.js');
        await cmdDeregister(args, globals);
        break;
      }
      case 'list': {
        const { cmdList } = await import('./cmd-list.js');
        await cmdList(args, globals);
        break;
      }
      case 'ack': {
        const { cmdAck } = await import('./cmd-ack.js');
        await cmdAck(args, globals);
        break;
      }
      case 'dlq': {
        const { cmdDlq } = await import('./cmd-dlq.js');
        await cmdDlq(args, globals, args._positional || []);
        break;
      }
      default:
        printUsage();
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    handleError(err);
  }
}

main();
