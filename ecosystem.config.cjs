// PM2 process file. From backend/: `pm2 start ecosystem.config.cjs`
// Then `pm2 status` for the process, and `pm2 logs innovbit-api` for every API hit.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'innovbit-api',
      cwd: __dirname,
      script: path.join(__dirname, 'src', 'server.js'),
      node_args: '--env-file-if-exists=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      merge_logs: true,
      // Timestamps are already on each log line.
      time: false,
      out_file: path.join(__dirname, 'logs', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'error.log'),
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
    },
  ],
};
