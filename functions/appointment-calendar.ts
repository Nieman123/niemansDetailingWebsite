import { integrationConfig } from "./appointment-secrets";

type CalendarConfig = {
  clientId: string; clientSecret: string; refreshToken: string;
  detailingId: string; personalId: string; plutoId: string;
};
type CalendarEvent = { id: string; status?: string; transparency?: string };
type AppointmentEvent = { start: number; end: number; service: string; status: string };
let access: { token: string; until: number; refreshToken: string } | undefined;

export async function calendarConfig() {
  const config = await integrationConfig<CalendarConfig>("APPOINTMENT_GOOGLE_CONFIG");
  if (!config || ![config.clientId, config.clientSecret, config.refreshToken, config.detailingId, config.personalId, config.plutoId].every(
    field => typeof field === "string" && field.trim(),
  ) || new Set([config.detailingId, config.personalId, config.plutoId]).size !== 3) return null;
  return config;
}

async function accessToken(config: CalendarConfig) {
  if (access && access.until > Date.now() && access.refreshToken === config.refreshToken) return access.token;
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: config.clientId,
      client_secret: config.clientSecret, refresh_token: config.refreshToken,
    }),
  });
  if (!result.ok) throw new Error("calendar_authorization_failed");
  const { access_token, expires_in } = await result.json() as { access_token: string; expires_in: number };
  access = { token: access_token, until: Date.now() + (expires_in - 60) * 1000, refreshToken: config.refreshToken };
  return access_token;
}

async function google(config: CalendarConfig, path: string, method = "GET", body?: object) {
  const token = await accessToken(config);
  return fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
}

const eventId = (id: string) => `a${id}`;

export async function busyWindows(config: CalendarConfig, start: number, end: number, except?: string) {
  const timeMin = new Date(start).toISOString();
  const timeMax = new Date(end).toISOString();
  // On a move, look up the current mirror and ignore only that event.
  const calendars = except ? [config.personalId, config.plutoId] : [config.detailingId, config.personalId, config.plutoId];
  const response = await google(config, "freeBusy", "POST", { timeMin, timeMax, items: calendars.map(id => ({ id })) });
  if (!response.ok) throw new Error("calendar_availability_failed");
  const data = await response.json() as { calendars?: Record<string, { errors?: unknown[]; busy?: { start: string; end: string }[] }> };
  const windows = calendars.flatMap(id => {
    const entry = data.calendars?.[id];
    if (!entry || entry.errors?.length || !Array.isArray(entry.busy)) throw new Error("calendar_availability_failed");
    return entry.busy.map(slot => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }));
  });
  if (except) {
    const query = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", showDeleted: "false" });
    do {
      const result = await google(config, `calendars/${encodeURIComponent(config.detailingId)}/events?${query}`);
      if (!result.ok) throw new Error("calendar_availability_failed");
      const page = await result.json() as { items?: CalendarEvent[]; nextPageToken?: string };
      if (page.items?.some(evt => evt.id !== eventId(except) && evt.status !== "cancelled" && evt.transparency !== "transparent")) {
        windows.push({ start, end });
        break;
      }
      if (!page.nextPageToken) break;
      query.set("pageToken", page.nextPageToken);
    } while (true);
  }
  if (windows.some(slot => !Number.isFinite(slot.start) || !Number.isFinite(slot.end))) throw new Error("calendar_availability_failed");
  return windows;
}

export async function mirrorAppointment(config: CalendarConfig, id: string, appointment: AppointmentEvent) {
  const path = `calendars/${encodeURIComponent(config.detailingId)}/events`;
  const mirrorId = eventId(id);
  const show = ["awaiting_deposit", "pending_approval", "confirmed", "in_progress", "completed", "no_show"].includes(appointment.status);
  if (!show) {
    const removed = await google(config, `${path}/${mirrorId}?sendUpdates=none`, "DELETE");
    if (!removed.ok && ![404, 410].includes(removed.status)) throw new Error("calendar_delete_failed");
    return;
  }
  const prefix = appointment.status === "awaiting_deposit" ? "Awaiting deposit: " : appointment.status === "pending_approval" ? "Pending approval: " : "";
  const data = {
    id: mirrorId, summary: `${prefix}${appointment.service}`, visibility: "private",
    start: { dateTime: new Date(appointment.start).toISOString(), timeZone: "America/New_York" },
    end: { dateTime: new Date(appointment.end).toISOString(), timeZone: "America/New_York" },
    extendedProperties: { private: { detailingAppointmentId: id } },
  };
  const update = await google(config, `${path}/${mirrorId}?sendUpdates=none`, "PATCH", data);
  if (update.ok) return;
  if (update.status !== 404) throw new Error("calendar_update_failed");
  const created = await google(config, `${path}?sendUpdates=none`, "POST", data);
  if (!created.ok && created.status !== 409) throw new Error("calendar_create_failed");
}
