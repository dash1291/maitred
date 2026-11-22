import path from "node:path";

export const STATE_DIR = path.resolve(process.env.MAITRED_STATE_DIR ?? path.join(process.cwd(), "state"));
export const BUILTIN_RECIPES_DIR = path.resolve(process.cwd(), "recipes");
export const TIMEZONE = process.env.MAITRED_TZ ?? "Asia/Kolkata";

export function localDate(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

export function localStamp(epochMs: number, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
  return `${text} ${timeZone}`;
}
