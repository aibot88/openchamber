import { Integration, Provider } from "@opencode/plugin";

export const PROVIDER_ID = Provider.ID.make("devin-subscription");
export const INTEGRATION_ID = Integration.ID.make("devin-subscription");
export const IMPORT_METHOD_ID = "devin-desktop-import";
export const ORIGIN = "https://server.codeium.com";
export const CATALOG_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const CLIENT_VERSION = "2026.8.18";
export const MAX_BYTES = 8 * 1024 * 1024;
export type Send = (request: Request) => Promise<Response>;
