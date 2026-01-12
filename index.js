#!/usr/bin/env node
/**
 * Mac Mini iMessage Daemon with Health Monitoring
 *
 * Combines:
 * - iMessage sync (polls Messages database)
 * - Health endpoint for Exit OS monitoring
 * - Heartbeat to Exit OS database
 *
 * Run on Mac Mini:
 *   ADFORGE_WEBHOOK_URL=https://... EXITOS_HUB_IP=100.92.203.87 node mac-mini-daemon.js
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');

// Configuration
const CONFIG = {
  // iMessage sync
  pollInterval: 30000,
  dbPath: path.join(process.env.HOME, 'Library/Messages/chat.db'),
  stateFile: path.join(process.env.HOME, '.imessage-sync-state.json'),
  webhookUrl: process.env.ADFORGE_WEBHOOK_URL || 'https://adforge-backend-api.vercel.app/api/imessage/incoming',
  apiKey: process.env.ADFORGE_API_KEY || '',

  // Health server
  healthPort: parseInt(process.env.HEALTH_PORT) || 5088,

  // Exit OS heartbeat
  exitosHubIp: process.env.EXITOS_HUB_IP || '100.92.203.87',
  exitosApiPort: process.env.EXITOS_API_PORT || 5050,
  heartbeatInterval: 60000,

  // Retry settings
  maxRetries: 5,
  initialBackoff: 5000,
  maxBackoff: 300000
};

// Business keywords for detection
const BUSINESS_KEYWORDS = [
  'clean', 'tile', 'grout', 'marble', 'stone', 'floor', 'polish',
  'estimate', 'quote', 'price', 'cost', 'how much',
  'appointment', 'schedule', 'available', 'come out',
  'address', 'sqft', 'square feet', 'sq ft',
  'stain', 'seal', 'strip', 'wax', 'buff',
  'kitchen', 'bathroom', 'basement', 'shower',
  'travertine', 'granite', 'terrazzo', 'epoxy', 'lvt', 'vinyl',
  'etch', 'scratch', 'damage', 'repair',
  'victory', 'vcleaning'
];

// Runtime state
let shutdownRequested = false;
const stats = {
  startedAt: new Date().toISOString(),
  lastPoll: null,
  lastMessageAt: null,
  messagesProcessed: 0,
  businessMessages: 0,
  webhookSuccesses: 0,
  webhookFailures: 0,
  consecutiveFailures: 0,
  dbErrors: 0,
  lastError: null,
  lastHeartbeat: null
};

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ============================================
// STATE MANAGEMENT
// ============================================

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    }
  } catch (e) {
    log(`Failed to load state: ${e.message}`, 'ERROR');
  }
  return { lastRowid: 0, lastRun: null };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  try {
    const tmp = CONFIG.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, CONFIG.stateFile);
  } catch (e) {
    log(`Failed to save state: ${e.message}`, 'ERROR');
  }
}

// ============================================
// DATABASE ACCESS
// ============================================

function checkDatabaseAccessible() {
  if (!fs.existsSync(CONFIG.dbPath)) {
    return { ok: false, error: 'Database file does not exist' };
  }
  try {
    const db = new Database(CONFIG.dbPath, { readonly: true, timeout: 5000 });
    db.prepare('SELECT 1').get();
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function waitForDatabase(maxWait = 120000) {
  const start = Date.now();
  let waitTime = 2000;

  while (Date.now() - start < maxWait) {
    const { ok, error } = checkDatabaseAccessible();
    if (ok) {
      log('Database is now accessible');
      return true;
    }
    log(`Database not accessible: ${error}. Waiting ${waitTime / 1000}s...`, 'WARN');
    await sleep(waitTime);
    waitTime = Math.min(waitTime * 2, 30000);
  }
  log(`Database not accessible after ${maxWait / 1000}s`, 'ERROR');
  return false;
}

function extractTextFromAttributedBody(body) {
  if (!body) return null;
  try {
    const text = body.toString('utf8');
    const match = text.match(/NSString.{1,20}(.{5,500}?)(?:NSDictionary|NSNumber|$)/);
    if (match) {
      const clean = match[1].replace(/[^\x20-\x7E]/g, '').trim();
      if (clean.length > 3) return clean;
    }
  } catch (e) {}
  return null;
}

function isBusinessMessage(text) {
  if (!text) return { isBusiness: false, keywords: [] };
  const lower = text.toLowerCase();
  const matched = BUSINESS_KEYWORDS.filter(kw => lower.includes(kw));
  return { isBusiness: matched.length > 0, keywords: matched };
}

function getNewMessages(lastRowid) {
  try {
    const db = new Database(CONFIG.dbPath, { readonly: true, timeout: 10000 });

    const query = `
      SELECT
        m.ROWID as rowid,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as timestamp,
        h.id as phone,
        m.is_from_me,
        m.text,
        m.attributedBody,
        m.service
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.ROWID > ?
        AND h.id LIKE '+1%'
        AND length(replace(h.id, '+', '')) = 11
      ORDER BY m.ROWID ASC
      LIMIT 100
    `;

    const rows = db.prepare(query).all(lastRowid);
    db.close();

    const messages = rows.map(row => ({
      rowid: row.rowid,
      timestamp: row.timestamp,
      phone: row.phone,
      is_from_me: !!row.is_from_me,
      text: row.text || extractTextFromAttributedBody(row.attributedBody),
      service: row.service || 'iMessage'
    }));

    return { messages, error: null };

  } catch (e) {
    stats.dbErrors++;
    if (e.message.includes('database is locked')) {
      return { messages: null, error: 'database_locked' };
    } else if (e.message.includes('unable to open')) {
      return { messages: null, error: 'database_unavailable' };
    }
    return { messages: null, error: e.message };
  }
}

// ============================================
// WEBHOOK
// ============================================

function sendToWebhook(messages) {
  return new Promise((resolve) => {
    if (!messages || messages.length === 0) {
      resolve({ ok: true });
      return;
    }

    const payload = JSON.stringify({
      messages,
      source: 'mac-mini-daemon',
      timestamp: new Date().toISOString()
    });

    const url = new URL(CONFIG.webhookUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(CONFIG.apiKey && { 'Authorization': `Bearer ${CONFIG.apiKey}` })
      },
      timeout: 120000
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          stats.webhookSuccesses++;
          stats.consecutiveFailures = 0;
          resolve({ ok: true });
        } else if (res.statusCode >= 500) {
          resolve({ ok: false, retry: true, status: res.statusCode });
        } else {
          stats.lastError = `Webhook ${res.statusCode}`;
          resolve({ ok: false, retry: false });
        }
      });
    });

    req.on('error', (e) => {
      stats.lastError = e.message;
      resolve({ ok: false, retry: true, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      stats.lastError = 'Webhook timeout';
      resolve({ ok: false, retry: true, error: 'timeout' });
    });

    req.write(payload);
    req.end();
  });
}

async function sendWithRetry(messages, state) {
  if (!messages || messages.length === 0) return true;

  let backoff = CONFIG.initialBackoff;

  for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
    const result = await sendToWebhook(messages);

    if (result.ok) return true;
    if (!result.retry) {
      stats.webhookFailures++;
      return false;
    }

    if (attempt < CONFIG.maxRetries - 1) {
      log(`Retry in ${backoff / 1000}s (attempt ${attempt + 1})`, 'WARN');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, CONFIG.maxBackoff);
    }
  }

  stats.webhookFailures++;
  stats.consecutiveFailures++;
  return false;
}

// ============================================
// HEALTH SERVER
// ============================================

function startHealthServer() {
  const app = express();

  app.get('/health', (req, res) => {
    const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
    const dbCheck = checkDatabaseAccessible();

    const healthy = dbCheck.ok && stats.consecutiveFailures < 5;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      service: 'imessage-gateway',
      hostname: require('os').hostname(),
      uptime,
      database: dbCheck.ok ? 'connected' : dbCheck.error,
      stats: {
        ...stats,
        uptimeSeconds: uptime
      }
    });
  });

  app.get('/stats', (req, res) => {
    res.json(stats);
  });

  app.listen(CONFIG.healthPort, '0.0.0.0', () => {
    log(`Health server listening on port ${CONFIG.healthPort}`);
  });
}

// ============================================
// EXIT OS HEARTBEAT
// ============================================

async function sendHeartbeat() {
  try {
    const payload = JSON.stringify({
      service: 'imessage-gateway',
      hostname: require('os').hostname(),
      ip: '100.125.160.89', // Mac Mini Tailscale IP
      status: stats.consecutiveFailures < 5 ? 'healthy' : 'degraded',
      stats: {
        messagesProcessed: stats.messagesProcessed,
        businessMessages: stats.businessMessages,
        lastPoll: stats.lastPoll,
        consecutiveFailures: stats.consecutiveFailures
      },
      timestamp: new Date().toISOString()
    });

    const options = {
      hostname: CONFIG.exitosHubIp,
      port: CONFIG.exitosApiPort,
      path: '/api/heartbeat/imessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200 || res.statusCode === 404) {
        // 404 is OK - endpoint may not exist yet
        stats.lastHeartbeat = new Date().toISOString();
      }
    });

    req.on('error', () => {
      // Silently ignore - hub may be unreachable
    });

    req.write(payload);
    req.end();
  } catch (e) {
    // Ignore heartbeat failures
  }
}

// ============================================
// MAIN DAEMON LOOP
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDaemon() {
  process.on('SIGTERM', () => { shutdownRequested = true; log('Received SIGTERM'); });
  process.on('SIGINT', () => { shutdownRequested = true; log('Received SIGINT'); });

  log('═══════════════════════════════════════════════');
  log('  MAC MINI iMESSAGE DAEMON');
  log('═══════════════════════════════════════════════');
  log(`  Database: ${CONFIG.dbPath}`);
  log(`  Webhook: ${CONFIG.webhookUrl}`);
  log(`  Health port: ${CONFIG.healthPort}`);
  log(`  Exit OS hub: ${CONFIG.exitosHubIp}:${CONFIG.exitosApiPort}`);
  log('═══════════════════════════════════════════════');

  // Start health server
  startHealthServer();

  // Start heartbeat
  setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  sendHeartbeat();

  const state = loadState();
  log(`Starting from ROWID: ${state.lastRowid}`);

  if (!await waitForDatabase(60000)) {
    log('Cannot access database on startup. Exiting.', 'ERROR');
    process.exit(1);
  }

  let consecutiveDbErrors = 0;

  while (!shutdownRequested) {
    try {
      stats.lastPoll = new Date().toISOString();
      const { messages, error } = getNewMessages(state.lastRowid);

      if (error) {
        consecutiveDbErrors++;
        stats.lastError = error;

        if (error === 'database_locked') {
          log(`Database locked, will retry... (errors: ${consecutiveDbErrors})`, 'WARN');
          await sleep(5000);
          continue;
        } else if (error === 'database_unavailable') {
          log('Database unavailable - Mac may be waking from sleep', 'WARN');
          await waitForDatabase();
          continue;
        } else {
          log(`Database error: ${error}`, 'ERROR');
          if (consecutiveDbErrors > 10) {
            log('Too many consecutive database errors, waiting 60s', 'ERROR');
            await sleep(60000);
            consecutiveDbErrors = 0;
          }
          continue;
        }
      }

      consecutiveDbErrors = 0;

      if (messages && messages.length > 0) {
        log(`Found ${messages.length} new messages`);
        stats.messagesProcessed += messages.length;
        stats.lastMessageAt = new Date().toISOString();

        for (const msg of messages) {
          const { isBusiness } = isBusinessMessage(msg.text);
          if (isBusiness && !msg.is_from_me) {
            stats.businessMessages++;
            log(`  Business: ${msg.phone} - ${(msg.text || '[attachment]').slice(0, 50)}...`);
          }
        }

        if (await sendWithRetry(messages, state)) {
          state.lastRowid = messages[messages.length - 1].rowid;
          saveState(state);
        } else if (stats.consecutiveFailures > 10) {
          log('Extended webhook failures - saving state to prevent reprocessing', 'WARN');
          state.lastRowid = messages[messages.length - 1].rowid;
          saveState(state);
        }
      }

      await sleep(CONFIG.pollInterval);

    } catch (e) {
      stats.lastError = e.message;
      log(`Unexpected error: ${e.message}`, 'ERROR');
      await sleep(30000);
    }
  }

  log('Daemon shutting down cleanly');
  saveState(state);
}

runDaemon().catch(e => {
  log(`Fatal error: ${e.message}`, 'ERROR');
  process.exit(1);
});
