module.exports = {
  apps: [
    {
      name: 'byreal-copybot',
      script: 'node_modules/.bin/ts-node',
      args: 'src/index.ts',
      cwd: '.',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '2G',
      kill_timeout: 10000,
      time: true,
      out_file: '/tmp/copybot.log',
      error_file: '/tmp/copybot.err.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TS_NODE_TRANSPILE_ONLY: 'true',
      },
    },
  ],
};
