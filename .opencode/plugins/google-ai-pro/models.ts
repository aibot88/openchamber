import { Model } from "@opencode/plugin";
import { PROVIDER_ID } from "./constants.ts";

export const subscriptionModels: readonly Model.Info[] = [{
  ...Model.Info.default(PROVIDER_ID, Model.ID.make("gemini-3.1-pro")),
  name: "Gemini 3.1 Pro · subscription (unofficial)",
  status: "beta",
  // Conservative budgets until each subscription model is verified live.
  limit: { context: 200_000, output: 32_000 },
  settings: { thinkingConfig: { thinkingBudget: 1001, includeThoughts: true } },
  variants: ["low", "high"].map((level) => ({
    id: Model.VariantID.make(level),
    settings: { thinkingConfig: { thinkingBudget: level === "high" ? 10001 : 1001, includeThoughts: true } },
  })),
}, {
  ...Model.Info.default(PROVIDER_ID, Model.ID.make("gemini-3.8-flash")),
  // Public ID only. The account catalog resolves each variant's wire route.
  name: "Gemini 3.8 Flash · subscription (unofficial)",
  status: "beta",
  limit: { context: 200_000, output: 32_000 },
  settings: { thinkingConfig: { thinkingBudget: 4000, includeThoughts: true } },
  variants: ["low", "medium", "high"].map((level) => ({
    id: Model.VariantID.make(level),
    settings: { thinkingConfig: { thinkingBudget: level === "high" ? -1 : level === "low" ? 1000 : 4000, includeThoughts: true } },
  })),
}];

export const budgets = {
  "gemini-3.1-pro": { low: 1001, high: 10001 },
  "gemini-3.8-flash": { low: 1000, medium: 4000, high: -1 },
} as const;
