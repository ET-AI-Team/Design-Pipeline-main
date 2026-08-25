import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Carries the HTTP status alongside the message so callers (the query
 *  client's retry policy in particular) can tell "not found / bad
 *  request - retrying won't help" apart from "transient/network -
 *  worth one retry" without re-parsing anything. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Shared response-unwrapping for every `fetch('/api/v1/...')` queryFn -
 *  throws an HttpError on a non-ok response instead of silently handing
 *  back `undefined` data, which is what let a 404'd job sit on
 *  "Loading…" forever instead of surfacing an error. */
export async function unwrapJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new HttpError(res.status, body.error?.message ?? `Request failed (${res.status})`);
  return body.data as T;
}

/** "just now" / "5m ago" / "3h ago", falling back to a locale date once
 *  it's more than a day old - the sidebar's job list is scanned quickly,
 *  and a relative time reads faster than a full timestamp for anything
 *  recent. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
