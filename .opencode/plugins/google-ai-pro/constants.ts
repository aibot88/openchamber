import { Integration, Provider } from "@opencode/plugin";

export const PROVIDER_ID = Provider.ID.make("google-ai-pro");
export const INTEGRATION_ID = Integration.ID.make("google-ai-pro");
export const METHOD_ID = Integration.MethodID.make("antigravity-oauth");
// A missed hook must fail DNS resolution, never reach a billable Gemini API.
export const BASE_URL = "https://subscription.invalid/v1beta";
export const ENDPOINT = "https://cloudcode-pa.googleapis.com";
// CLIProxyAPI uses production for project lookup, daily for consumer inference
// and account model discovery. Never fall back between these service tiers.
export const SUBSCRIPTION_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
// Pinned to CLIProxyAPI f1d4a94 (2026-10-11). This is a wire identity, not the
// version of an installed CLI. CortexKit's older CLI identity is not mixed in.
export const USER_AGENT = `antigravity/hub/2.9.1 ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
export const PROJECT_LOOKUP_USER_AGENT = USER_AGENT;
export const ONBOARD_USER_AGENT = `${USER_AGENT} google-api-nodejs-client/10.3.0`;
export const TERMS_URL = "https://antigravity.google/terms";
