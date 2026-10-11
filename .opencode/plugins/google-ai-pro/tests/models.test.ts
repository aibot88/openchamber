import { describe, expect, test } from "bun:test";
import { Model, Provider } from "@opencode/plugin";
import { subscriptionModels } from "../models.ts";

describe("subscription model catalog", () => {
  test("registers Pro and Flash under the existing subscription provider", () => {
    expect(subscriptionModels.map((model) => model.id)).toEqual(["gemini-3.1-pro", "gemini-3.8-flash"].map((id) => Model.ID.make(id)));
    for (const model of subscriptionModels) {
      expect(model.providerID).toBe(Provider.ID.make("google-ai-pro"));
      expect(model.enabled).toBe(true);
      expect(model.capabilities.tools).toBe(true);
      expect(model.limit).toEqual({ context: 200_000, output: 32_000 });
    }
  });

  test("keeps public IDs stable while declaring Pro's subscription budgets", () => {
    const pro = subscriptionModels.find((model) => model.id === "gemini-3.1-pro");
    expect(pro?.modelID).toBe(Model.ID.make("gemini-3.1-pro"));
    expect(pro?.variants.map((variant) => variant.id)).toEqual(["low", "high"].map((id) => Model.VariantID.make(id)));
  });

  test("leaves Flash wire mapping to discovery and exposes explicit thinking budgets", () => {
    const flash = subscriptionModels.find((model) => model.id === "gemini-3.8-flash");
    expect(flash?.modelID).toBe(Model.ID.make("gemini-3.8-flash"));
    expect(flash?.settings).toEqual({ thinkingConfig: { thinkingBudget: 4000, includeThoughts: true } });
    expect(flash?.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high"].map((id) => Model.VariantID.make(id)));
    for (const variant of flash?.variants ?? []) {
      expect(variant.settings).toEqual({ thinkingConfig: { thinkingBudget: variant.id === "low" ? 1000 : variant.id === "high" ? -1 : 4000, includeThoughts: true } });
    }
  });
});
