import type { BookSourceRecord } from "@shared/bookSource/types";

type ConcurrentRecord = {
  time: number;
  accessLimit: number;
  interval: number;
  frequency: number;
};

/**
 * putConcurrent 书写的并发率记录。
 * 请求层已不再消费 concurrentRate 间隔限流（查看帖子、WS 脚本交互一律不限流），
 * 请求间隔只做在检查更新的批量循环里（useBookshelfUpdate.ts 读源 concurrentRate sleep）。
 * 此 map 仅保留 Legado java.putConcurrent API 兼容写入。
 */
const concurrentRecordMap = new Map<string, ConcurrentRecord>();

/**
 * 未配置并发率时的默认并发上限（仅防止单源同时打满请求，非间隔限流）。
 * Rhino 中 `list.map(() => java.ajax)` 实质串行；Node 升成 async map 后若无限制
 * 会同时打满列表项详情请求，易触发站点限流与 TimeoutError。
 */
const DEFAULT_MAX_INFLIGHT_PER_SOURCE = 3;

type InflightGate = {
  active: number;
  max: number;
  waiters: Array<() => void>;
};

const inflightGateMap = new Map<string, InflightGate>();

async function withInflightLimit<T>(
  key: string,
  max: number,
  block: () => Promise<T>,
): Promise<T> {
  let gate = inflightGateMap.get(key);
  if (!gate) {
    gate = { active: 0, max, waiters: [] };
    inflightGateMap.set(key, gate);
  } else if (gate.max !== max) {
    gate.max = max;
  }
  while (gate.active >= gate.max) {
    await new Promise<void>((resolve) => {
      gate!.waiters.push(resolve);
    });
  }
  gate.active += 1;
  try {
    return await block();
  } finally {
    gate.active -= 1;
    const next = gate.waiters.shift();
    if (next) next();
  }
}

/** Legado ConcurrentRateLimiter.updateConcurrentRate（仅记录，请求层不消费） */
export function updateConcurrentRate(key: string, concurrentRate: string): void {
  try {
    const rateIndex = concurrentRate.indexOf("/");
    const next =
      rateIndex > 0
        ? (() => {
            const accessLimit = Number.parseInt(concurrentRate.slice(0, rateIndex), 10);
            const interval = Number.parseInt(concurrentRate.slice(rateIndex + 1), 10);
            if (accessLimit <= 0 || interval <= 0) throw new Error("invalid");
            const prev = concurrentRecordMap.get(key);
            return {
              time: prev?.time ?? Date.now(),
              accessLimit,
              interval,
              frequency: prev?.frequency ?? 0,
            } satisfies ConcurrentRecord;
          })()
        : (() => {
            const interval = Number.parseInt(concurrentRate, 10);
            if (interval <= 0) throw new Error("invalid");
            const prev = concurrentRecordMap.get(key);
            return {
              time: prev?.time ?? Date.now(),
              accessLimit: 1,
              interval,
              frequency: prev?.frequency ?? 0,
            } satisfies ConcurrentRecord;
          })();
    concurrentRecordMap.set(key, next);
  } catch {
    /* ignore invalid rate */
  }
}

/**
 * 请求层统一入口：只做默认并发门（防单源打满），不再做 concurrentRate 间隔限流。
 * skip=true（WS 油猴通道、java.ajaxAll 等）连并发门也跳过——WS 之间交互一律不限流。
 */
export async function withSourceRateLimit<T>(
  source: BookSourceRecord | undefined,
  block: () => Promise<T>,
  skip = false,
): Promise<T> {
  if (skip || !source) return block();
  const key = source.bookSourceUrl?.trim();
  if (!key) return block();
  return withInflightLimit(key, DEFAULT_MAX_INFLIGHT_PER_SOURCE, block);
}
