// One line per event on stdout (info/debug) or stderr (warn/error).
// PM2 records those streams: `pm2 logs` shows every line, and warn/error land in the error log.

const RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const min = RANK[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? RANK.info;

function formatValue(value) {
  const text = typeof value === 'string' ? value : String(value);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

function emit(level, message, fields) {
  if ((RANK[level] ?? RANK.error) < min) return;
  const parts = [new Date().toISOString(), level.padEnd(5), message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
