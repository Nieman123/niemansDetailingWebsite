"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationConfig = integrationConfig;
const app_1 = require("firebase-admin/app");
const cache = new Map();
async function integrationConfig(name) {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
        return process.env[name] ? JSON.parse(process.env[name]) : null;
    }
    const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
    if (!project)
        return null;
    const existing = cache.get(name);
    if (existing && existing.until > Date.now())
        return existing.value;
    const { access_token } = await (0, app_1.applicationDefault)().getAccessToken();
    const resource = `projects/${encodeURIComponent(project)}/secrets/${name}/versions/latest`;
    const response = await fetch(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
        headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(6000),
    });
    if (response.status === 403 || response.status === 404) {
        cache.set(name, { until: Date.now() + 30000, value: null });
        return null;
    }
    if (!response.ok)
        throw new Error("integration_configuration_unavailable");
    const { payload } = await response.json();
    const value = JSON.parse(Buffer.from(payload.data, "base64").toString("utf8"));
    cache.set(name, { until: Date.now() + 60000, value });
    return value;
}
