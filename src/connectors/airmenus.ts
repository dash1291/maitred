// AirMenus platform client — reverse-engineered 2026-11-20 from
// bookings.airmenus.in (Guerilla Diner). These endpoints appear to serve
// the whole platform, parameterised by rest_short_name / outlet_id.

export interface AirMenusOutlet {
  id: number;
  name: string;
  short_name: string;
  phone_number?: string;
}

export interface AirMenusRestaurant {
  id: number;
  name: string;
  short_name: string;
  outlets: AirMenusOutlet[];
}

export interface AirMenuSlot {
  time: string; // "19:00"
  pax: number; // remaining pax field per config (see recon notes)
  price: string; // per-head deposit, "500"
  min_pax: number;
  max_pax: number;
  // guest_cancellation etc. omitted — not needed for grabbing
}

export interface AirMenuSlotGroup {
  title: string;
  description?: string;
  available_times: AirMenuSlot[];
}

export interface AirMenuDayConfig {
  is_open: boolean;
  slot_groups: AirMenuSlotGroup[];
}

export interface AirMenusConfig {
  id: number;
  setting: {
    days_ahead: number;
    preparation_hours: number;
    skip_dates: string[];
    cut_off_date: string;
    // weekday -> config
    [day: string]: unknown | AirMenuDayConfig | number | string | string[];
  };
}

const API = "https://apis.airmenus.in/api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`AirMenus ${path} -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(`AirMenus ${path} returned non-JSON (${ct})`);
  }
  return (await res.json()) as T;
}

export async function fetchRestaurant(
  restShortName: string,
): Promise<AirMenusRestaurant> {
  return getJSON<AirMenusRestaurant>(
    `/restaurant/details/bookings/?rest_short_name=${encodeURIComponent(restShortName)}`,
  );
}

export async function fetchOutletConfig(
  outletId: number,
): Promise<AirMenusConfig> {
  return getJSON<AirMenusConfig>(`/reservations/config/${outletId}/`);
}

// Remaining pax for a specific group+datetime. Empty object when no
// bookings exist yet (normal for popup-style restaurants before they flip).
export async function fetchRemainingPax(
  outletId: number,
  groupTitle: string,
  bookingDt: string, // ISO, e.g. 2026-11-21T19:00:00
): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({
    group_title: groupTitle,
    booking_dt: bookingDt,
    outlet_id: String(outletId),
  });
  return getJSON<Record<string, unknown>>(
    `/reservations/slot_group/remaining/paxs/?${q.toString()}`,
  );
}

// Bookings count for a group+datetime (how many pax are taken).
export async function fetchBookingCount(
  outletId: number,
  groupTitle: string,
  bookingDt: string,
): Promise<number> {
  const q = new URLSearchParams({
    groupTitle: groupTitle,
    booking_dt: bookingDt,
    outlet_id: String(outletId),
  });
  const raw = await getJSON<unknown>(
    `/reservations/bookings/count/?${q.toString()}`,
  );
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

// Does the day config look grabbable? (All days is_open:false during closed
// windows — the flip from false->true is the moment to race for.)
export interface DayOpenness {
  open: boolean;
  groups: { title: string; times: AirMenuSlot[] }[];
}

export function dayStatus(
  config: AirMenusConfig,
  weekday: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday",
): DayOpenness {
  const day = (config.setting as Record<string, AirMenuDayConfig>)[weekday];
  if (!day || !Array.isArray(day.slot_groups)) return { open: false, groups: [] };
  return {
    open: day.is_open,
    groups: day.slot_groups.map((g) => ({
      title: g.title,
      times: g.available_times ?? [],
    })),
  };
}
