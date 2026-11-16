import { applicationDefault } from "firebase-admin/app";

type Integration = "APPOINTMENT_STRIPE_CONFIG" | "APPOINTMENT_GOOGLE_CONFIG" | "APPOINTMENT_EMAIL_CONFIG";
const cache = new Map<Integration, { until: number; value: unknown }>();

export async function integrationConfig<T>(name: Integration): Promise<T | null> {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return process.env[name] ? JSON.parse(process.env[name]!) as T : null;
  }
  const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
  if (!project) return null;
  const existing = cache.get(name);
  if (existing && existing.until > Date.now()) return existing.value as T | null;
  const { access_token } = await applicationDefault().getAccessToken();
  const resource = `projects/${encodeURIComponent(project)}/secrets/${name}/versions/latest`;
  const response = await fetch(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
    headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(6000),
  });
  if (response.status === 403 || response.status === 404) {
    cache.set(name, { until: Date.now() + 30_000, value: null });
    return null;
  }
  if (!response.ok) throw new Error("integration_configuration_unavailable");
  const { payload } = await response.json() as { payload: { data: string } };
  const value: T = JSON.parse(Buffer.from(payload.data, "base64").toString("utf8"));
  cache.set(name, { until: Date.now() + 60_000, value });
  return value;
}
