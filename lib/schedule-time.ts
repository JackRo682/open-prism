export type ScheduleRecurrence = 'once' | 'daily' | 'weekly';

const DAY = 86_400_000;
type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 80) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

function wallTime(timestamp: number, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const values: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') values[part.type] = Number(part.value);
  return values as WallTime;
}

const wallTimestamp = (value: WallTime) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);

/** Resolve a local clock time using the zone's actual offsets, including DST. */
function resolveWallTime(value: WallTime, timezone: string, allowGap: boolean): number {
  const target = wallTimestamp(value), offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = target + hours * 3_600_000;
    offsets.add(wallTimestamp(wallTime(sample, timezone)) - sample);
  }
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  const exact = candidates.find(candidate => wallTimestamp(wallTime(candidate, timezone)) === target);
  // During a repeated hour choose its first occurrence. A recurring job whose
  // clock time falls in the spring gap moves forward by that gap for that day.
  if (exact !== undefined) return exact;
  if (allowGap) {
    const after = candidates.filter(candidate => wallTimestamp(wallTime(candidate, timezone)) > target);
    if (after.length) return Math.min(...after);
  }
  throw new Error('선택한 시간대에 존재하지 않는 시각입니다. 다른 시각을 선택해 주세요.');
}

export function formatScheduleDateTime(timestamp: number, timezone: string): string {
  const p = wallTime(timestamp, timezone), pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function parseScheduleDateTime(value: string, timezone: string): number {
  if (!isTimeZone(timezone)) throw new Error('올바른 시간대를 입력해 주세요. 예: Asia/Seoul');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('실행 날짜와 시각을 입력해 주세요.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const p = { year, month, day, hour, minute, second: 0 };
  const date = new Date(wallTimestamp(p));
  if (year < 2000 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    throw new Error('실행 날짜와 시각을 확인해 주세요.');
  }
  return resolveWallTime(p, timezone, false);
}

/** Return the next future occurrence; missed runs are not replayed in a burst. */
export function nextScheduledAt(anchor: number, recurrence: ScheduleRecurrence, timezone: string, after: number): number | null {
  if (anchor > after) return anchor;
  if (recurrence === 'once') return null;
  const start = wallTime(anchor, timezone), current = wallTime(after, timezone);
  const dateStart = Date.UTC(start.year, start.month - 1, start.day);
  const dateCurrent = Date.UTC(current.year, current.month - 1, current.day);
  const interval = recurrence === 'weekly' ? 7 : 1;
  let steps = Math.max(0, Math.floor((dateCurrent - dateStart) / DAY / interval));
  for (let attempts = 0; attempts < 4; attempts++, steps++) {
    const day = new Date(dateStart + steps * interval * DAY);
    const candidate = resolveWallTime({ ...start, year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }, timezone, true);
    if (candidate > after) return candidate;
  }
  throw new Error('다음 실행 시각을 계산하지 못했습니다. 예약을 다시 설정해 주세요.');
}
