import { createHash, timingSafeEqual } from 'crypto';
import { readFile, statfs } from 'fs/promises';
import { cpus } from 'os';
import { NextRequest, NextResponse } from 'next/server';
import { redis, REDIS_KEYS } from '@/lib/redis';
import { getServiceCounts } from '@/lib/analytics';

// ===========================================
// Health: what the status page reads
// ===========================================
//
// The status page (status.rutwik.dev) runs on Cloudflare, off the Pi, and has
// no other way to learn what this container is running or how the Pi is doing.
//
// Anyone gets the first half: that the site answers, and which commit it was
// built from (the repo is public, so that gives nothing away). The second half
// describes the machine the site is hosted on, which is a flatmate's Pi, so it
// is only sent to a caller that knows STATUS_TOKEN.
//
// The Pi's figures are read from /proc and /sys. Docker does not virtualise
// those, so from inside this container they are the host's numbers, and no
// extra permission is needed to read them. Off the Pi (a Mac, Vercel) the
// files do not exist and each figure comes back null.

// Asked for on every check; a cached answer would be a stale reading.
export const dynamic = 'force-dynamic';

// Written by scripts on the Pi, not by this app, which is why they sit outside
// the `portfolio:` namespace: the nightly backup leaves its result, and the
// auto-deploy job leaves the latest thing that happened plus a heartbeat that
// proves it is still running.
const BACKUP_STATUS_KEY = 'ops:backup';
const DEPLOY_STATUS_KEY = 'ops:deploy';
const DEPLOY_BEAT_KEY = 'ops:deploy-beat';
// ~/sites/server-snapshot.sh, every 5 minutes: what only the host can see
// (containers, Wi-Fi, OS updates), so this container never needs Docker.
const SERVER_STATUS_KEY = 'ops:server';
// The status page's window for chat and contact counts.
const ACTIVITY_DAYS = 7;

type Host = {
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cores: number;
  tempC: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  uptimeSeconds: number | null;
};

type RedisStatus = {
  keys: number;
  usedMemoryBytes: number | null;
  maxMemoryBytes: number | null;
  lastSaveAt: number | null;
  visitors: number;
};

// ====== Who is asking ======

function knowsToken(request: NextRequest): boolean {
  const expected = process.env.STATUS_TOKEN;
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '');
  // No token configured means nobody gets the details, rather than everybody.
  if (!expected || !given) return false;
  // Hashing first gives both sides the same length, which timingSafeEqual
  // requires, and keeps the comparison from leaking how much of it matched.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(given));
}

// ====== The Pi ======

async function firstNumber(path: string): Promise<number | null> {
  try {
    const value = Number((await readFile(path, 'utf8')).trim().split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    // The file only exists on Linux. Anywhere else the status page shows this
    // figure as unknown, which is the truth.
    return null;
  }
}

async function readMemory(): Promise<Pick<Host, 'memTotalBytes' | 'memAvailableBytes'>> {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const kilobytes = (field: string) => {
      const match = meminfo.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'));
      return match ? Number(match[1]) * 1024 : null;
    };
    return { memTotalBytes: kilobytes('MemTotal'), memAvailableBytes: kilobytes('MemAvailable') };
  } catch {
    // Same as above: not on Linux, so memory is reported as unknown.
    return { memTotalBytes: null, memAvailableBytes: null };
  }
}

async function readLoad(): Promise<Pick<Host, 'load1' | 'load5' | 'load15'>> {
  try {
    const [load1, load5, load15] = (await readFile('/proc/loadavg', 'utf8')).split(/\s+/).map(Number);
    const ok = (n: number) => (Number.isFinite(n) ? n : null);
    return { load1: ok(load1), load5: ok(load5), load15: ok(load15) };
  } catch {
    // Not on Linux: all three are reported as unknown.
    return { load1: null, load5: null, load15: null };
  }
}

async function readHost(): Promise<Host> {
  const [load, milliDegrees, uptimeSeconds, memory, disk] = await Promise.all([
    readLoad(),
    firstNumber('/sys/class/thermal/thermal_zone0/temp'),
    firstNumber('/proc/uptime'),
    readMemory(),
    // The container's root sits on the Pi's SD card, so this is the card's
    // free space. A failure only costs the disk figure.
    statfs('/').catch(() => null),
  ]);
  return {
    ...load,
    cores: cpus().length,
    tempC: milliDegrees === null ? null : milliDegrees / 1000,
    ...memory,
    diskTotalBytes: disk ? disk.blocks * disk.bsize : null,
    diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
    uptimeSeconds,
  };
}

// ====== Redis and the backup ======

function infoNumber(info: string, field: string): number | null {
  const match = info.match(new RegExp(`^${field}:(\\d+)`, 'm'));
  return match ? Number(match[1]) : null;
}

async function readRedis(): Promise<RedisStatus> {
  const [keys, visitors, memory, persistence] = await Promise.all([
    redis.dbsize(),
    redis.get<number>(REDIS_KEYS.VISITOR_COUNT),
    // INFO is answered by the Pi's own Redis. Hosted Upstash may refuse it;
    // then only the memory and last-save figures are missing.
    redis.exec<string>(['INFO', 'memory']).catch(() => ''),
    redis.exec<string>(['INFO', 'persistence']).catch(() => ''),
  ]);
  return {
    keys,
    usedMemoryBytes: infoNumber(memory, 'used_memory'),
    maxMemoryBytes: infoNumber(memory, 'maxmemory'),
    lastSaveAt: infoNumber(persistence, 'rdb_last_save_time'),
    visitors: visitors ?? 0,
  };
}

export async function GET(request: NextRequest) {
  const summary = {
    ok: true,
    commit: process.env.GIT_SHA ?? null,
    uptimeSeconds: Math.round(process.uptime()),
  };
  if (!knowsToken(request)) return NextResponse.json(summary);

  const [host, redisStatus, backup, deployLast, deployBeat, server, activity] = await Promise.all([
    readHost(),
    // Redis being down must not take this route down with it: the site still
    // answers, and the status page needs to say exactly that.
    readRedis().catch(() => null),
    redis.get<Record<string, unknown>>(BACKUP_STATUS_KEY).catch(() => null),
    // Same reason: the page then says "no report", not "the site is down".
    redis.get<Record<string, unknown>>(DEPLOY_STATUS_KEY).catch(() => null),
    redis.get<number>(DEPLOY_BEAT_KEY).catch(() => null),
    // Both fall back to null for the same reason: "not reported" on the page.
    redis.get<Record<string, unknown>>(SERVER_STATUS_KEY).catch(() => null),
    getServiceCounts(ACTIVITY_DAYS).catch(() => null),
  ]);
  return NextResponse.json({
    ...summary,
    host,
    redis: redisStatus,
    backup,
    deploy: { last: deployLast, beatAt: deployBeat },
    server,
    activity,
  });
}
