const config = require('../config');

let redisClient = null;

function isUpstashConfigured() {
  return Boolean(config.redis.upstashRestUrl && config.redis.upstashRestToken);
}

function getClient() {
  if (!redisClient) {
    if (isUpstashConfigured()) {
      const { Redis: UpstashRedis } = require('@upstash/redis');
      redisClient = new UpstashRedis({
        url: config.redis.upstashRestUrl,
        token: config.redis.upstashRestToken,
      });
      redisClient.isUpstash = true;
    } else {
      const Redis = require('ioredis');
      redisClient = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      redisClient.isUpstash = false;

      redisClient.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
      });

      redisClient.on('connect', () => {
        console.log('[Redis] Connected successfully');
      });
    }
  }
  return redisClient;
}

async function connectRedis() {
  try {
    const client = getClient();
    if (client.isUpstash) {
      const pingRes = await client.ping();
      if (pingRes === 'PONG') {
        console.log('[Redis] Connected successfully to Upstash Redis (REST API)');
      } else {
        console.warn('[Redis] Warning: Unexpected PING response from Upstash Redis:', pingRes);
      }
    } else {
      await client.connect();
    }
  } catch (err) {
    console.warn('[Redis] Warning: Initial connection failed:', err.message);
  }
}

// In-memory fallback when Redis server is unreachable (for local dev)
const inMemoryStore = new Map();

async function getLastProcessedTimestamp() {
  const client = getClient();
  try {
    const value = await client.get(config.redisKeys.lastProcessedTimestamp);
    return value ? new Date(value) : null;
  } catch (err) {
    const fallbackVal = inMemoryStore.get(config.redisKeys.lastProcessedTimestamp);
    return fallbackVal ? new Date(fallbackVal) : null;
  }
}

/**
 * Saves timestamp of the last successfully processed email.
 * Called immediately upon successful Telegram message sending.
 */
async function updateLastProcessedTimestamp(timestamp) {
  const client = getClient();
  const isoString = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  try {
    await client.set(config.redisKeys.lastProcessedTimestamp, isoString);
    console.log(`[Redis] Saved last processed timestamp: ${isoString}`);
  } catch (err) {
    inMemoryStore.set(config.redisKeys.lastProcessedTimestamp, isoString);
    console.log(`[Redis Fallback (In-Memory)] Saved last processed timestamp: ${isoString}`);
  }
}

async function acquireLock(lockName = config.redisKeys.distributedLock, ttlSeconds = 300) {
  const client = getClient();
  try {
    let result;
    if (client.isUpstash) {
      result = await client.set(lockName, process.pid.toString(), { ex: ttlSeconds, nx: true });
    } else {
      result = await client.set(lockName, process.pid.toString(), 'EX', ttlSeconds, 'NX');
    }
    return result === 'OK';
  } catch (err) {
    // If Redis is unreachable, fallback to allowing execution in single-instance dev mode
    if (!inMemoryStore.has(lockName)) {
      inMemoryStore.set(lockName, process.pid.toString());
      return true;
    }
    return false;
  }
}

async function releaseLock(lockName = config.redisKeys.distributedLock) {
  const client = getClient();
  try {
    await client.del(lockName);
  } catch (err) {
    inMemoryStore.delete(lockName);
  }
}

async function checkHealth() {
  const client = getClient();
  try {
    const pingRes = await client.ping();
    return pingRes === 'PONG';
  } catch (err) {
    return false;
  }
}

async function disconnectRedis() {
  if (redisClient) {
    if (!redisClient.isUpstash && typeof redisClient.quit === 'function') {
      await redisClient.quit().catch(() => {});
    }
    redisClient = null;
  }
}

async function getNotionLastMorningDate() {
  const client = getClient();
  try {
    return await client.get(config.redisKeys.notionLastMorningDate);
  } catch (err) {
    return inMemoryStore.get(config.redisKeys.notionLastMorningDate) || null;
  }
}

async function setNotionLastMorningDate(dateStr) {
  const client = getClient();
  try {
    await client.set(config.redisKeys.notionLastMorningDate, dateStr);
  } catch (err) {
    inMemoryStore.set(config.redisKeys.notionLastMorningDate, dateStr);
  }
}

async function getNotionLastEveningDate() {
  const client = getClient();
  try {
    return await client.get(config.redisKeys.notionLastEveningDate);
  } catch (err) {
    return inMemoryStore.get(config.redisKeys.notionLastEveningDate) || null;
  }
}

async function setNotionLastEveningDate(dateStr) {
  const client = getClient();
  try {
    await client.set(config.redisKeys.notionLastEveningDate, dateStr);
  } catch (err) {
    inMemoryStore.set(config.redisKeys.notionLastEveningDate, dateStr);
  }
}

module.exports = {
  connectRedis,
  getLastProcessedTimestamp,
  updateLastProcessedTimestamp,
  acquireLock,
  releaseLock,
  checkHealth,
  disconnectRedis,
  getNotionLastMorningDate,
  setNotionLastMorningDate,
  getNotionLastEveningDate,
  setNotionLastEveningDate,
};
