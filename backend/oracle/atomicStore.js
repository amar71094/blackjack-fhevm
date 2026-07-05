const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function acquireProcessLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    const existing = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = Number(existing);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Another oracle is already running (pid ${pid}). Stop it before starting a new one.`);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  }
  fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
}

function releaseProcessLock(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  const existing = fs.readFileSync(lockPath, 'utf8').trim();
  if (existing === String(process.pid)) {
    fs.unlinkSync(lockPath);
  }
}

module.exports = { atomicWriteJson, acquireProcessLock, releaseProcessLock };