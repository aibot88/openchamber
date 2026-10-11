import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { normalizeGeminiSchemas, toGeminiSchema } from "../gemini-schema.ts";
import { assertSubscriptionSchema } from "../fixtures/schema-validator.ts";

describe("Gemini declaration schema adapter", () => {
  test("inlines local definitions without erasing property names that look like keywords", () => {
    expect(toGeminiSchema({
      type: "object", $defs: { Value: { type: "string" } },
      properties: { $ref: { $ref: "#/$defs/Value" }, default: { type: "string" } }, required: ["$ref", "default"],
    })).toEqual({ type: "OBJECT", properties: { $ref: { type: "STRING" }, default: { type: "STRING" } }, required: ["$ref", "default"] });
  });

  test("projects nullable and union types without emitting union protobuf fields", () => {
    const nullable = toGeminiSchema({ type: ["string", "null"], enum: ["object", "title"] }) as any;
    expect(nullable.type).toBe("STRING");
    expect(nullable.nullable).toBe(true);
    expect(nullable.description).toContain('["object","title"]');
    const union = toGeminiSchema({ oneOf: [{ type: "string" }, { type: "number" }] }) as any;
    expect(union.type).toBe("STRING");
    expect(union.description).toContain("oneOf:");
    assertSubscriptionSchema(union);
  });

  test("rejects recursive, external and unresolved references instead of silently weakening schemas", () => {
    for (const $ref of ["https://attacker.invalid/schema", "#/missing", "#/$defs/Recursive", "#", "#/constructor"]) {
      expect(() => toGeminiSchema({ $ref, $defs: { Recursive: { $ref: "#/$defs/Recursive" } } })).toThrow();
    }
  });

  test.each([
    ["exclusiveMinimum", 0], ["exclusiveMaximum", 100], ["minimum", 1], ["maximum", 100], ["multipleOf", 2],
    ["minLength", 1], ["maxLength", 10], ["pattern", "^[a-z]+$"], ["format", "uri"],
    ["minItems", 1], ["maxItems", 10], ["uniqueItems", true], ["contains", { type: "string" }],
    ["minProperties", 1], ["maxProperties", 5], ["minContains", 1], ["maxContains", 3],
    ["default", 3], ["examples", [1, 3]], ["not", { const: 5 }],
    ["dependentRequired", { a: ["b"] }], ["dependentSchemas", { a: { required: ["b"] } }],
    ["if", { properties: { mode: { const: "safe" } } }], ["then", { required: ["mode"] }], ["else", { required: ["other"] }],
    ["patternProperties", { "^x-": { type: "string" } }], ["propertyNames", { pattern: "^x" }],
    ["unevaluatedProperties", false], ["unevaluatedItems", false], ["additionalItems", false],
  ])("moves %s into a description at any schema depth", (key, value) => {
    const schema: any = { type: "object", properties: {
      rows: { type: "array", items: { type: "object", properties: { limit: { type: "integer", description: "Existing help.", [key as string]: value } } } },
    } };
    const before = JSON.stringify(schema);
    const wire: any = toGeminiSchema(schema);
    const limit = wire.properties.rows.items.properties.limit;
    expect(limit[key as string]).toBeUndefined();
    expect(limit.description).toContain("Existing help.");
    expect(limit.description).toContain(`${key}:`);
    assertSubscriptionSchema(wire);
    expect(JSON.stringify(schema)).toBe(before);
  });

  test("rejects unknown schema fields by construction, but preserves same-named properties", () => {
    const names = ["exclusiveMinimum", "minimum", "enum", "const", "format", "$ref", "default", "x-extra", "__proto__", "constructor"];
    const wire: any = toGeminiSchema({
      type: "object", title: "metadata", deprecated: true, readOnly: true, contentEncoding: "base64", "x-extra": { type: "never" }, mysteryField: 42,
      properties: Object.fromEntries(names.map((name) => [name, { type: "string", "x-extra": true, mysteryField: true }])),
      required: [...names, "missing", "minimum"],
    });
    expect(Object.keys(wire.properties)).toEqual(names);
    expect(wire.required).toEqual(names);
    expect(wire.title).toBeUndefined();
    expect(wire.mysteryField).toBeUndefined();
    for (const name of names) expect(wire.properties[name]).toEqual({ type: "STRING" });
    assertSubscriptionSchema(wire);
  });

  test("handles real Zod positive integers and nested tool constraints", () => {
    const schema = z.toJSONSchema(z.object({
      limit: z.number().int().positive().max(100), timeout: z.number().positive().max(120),
      pattern: z.string().min(1), questions: z.array(z.object({ options: z.array(z.string()).min(1) })).min(1),
      mode: z.enum(["quick", "medium", "thorough"]), nullable: z.string().nullable(),
    }));
    const wire: any = toGeminiSchema(schema);
    expect(wire.properties.limit.type).toBe("INTEGER");
    expect(wire.properties.limit.description).toContain("exclusiveMinimum: 0");
    expect(wire.properties.mode.description).toContain('"thorough"');
    expect(wire.properties.questions.items.properties.options.description).toContain("minItems: 1");
    expect(wire.properties.nullable.nullable).toBe(true);
    assertSubscriptionSchema(wire);
  });

  test("keeps enum/const values as opaque hints without changing numeric or boolean types", () => {
    for (const [type, values] of [["integer", [1, 2]], ["boolean", [true, false]], ["object", [{ title: "data", const: 9, default: "data", exclusiveMinimum: 0 }]]] as const) {
      const wire: any = toGeminiSchema({ type, enum: values });
      expect(wire.type).toBe(type.toUpperCase());
      expect(wire.enum).toBeUndefined();
      expect(wire.description).toContain(JSON.stringify(values));
      assertSubscriptionSchema(wire);
    }
    const constant: any = toGeminiSchema({ const: false });
    expect(constant.type).toBe("BOOLEAN");
    expect(constant.description).toContain("const: false");
  });

  test("uses a separate response policy, retaining supported response contracts", () => {
    const wire: any = toGeminiSchema({ type: "object", additionalProperties: false, properties: {
      mode: { type: "string", enum: ["a", "b"] }, count: { type: "integer", enum: [1, 2] }, enabled: { type: "boolean", enum: [true] },
    } }, { kind: "response" });
    expect(wire.additionalProperties).toBe(false);
    expect(wire.properties.mode.enum).toEqual(["a", "b"]);
    expect(wire.properties.count.type).toBe("INTEGER");
    expect(wire.properties.count.enum).toEqual(["1", "2"]);
    expect(wire.properties.enabled.enum).toBeUndefined();
    expect(wire.properties.enabled.description).toContain("[true]");
    assertSubscriptionSchema(wire, true);
  });

  test("merges compatible intersections and reference siblings without losing properties", () => {
    const wire: any = toGeminiSchema({ $defs: { Base: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
      $ref: "#/$defs/Base", properties: { b: { type: "integer" } }, required: ["b"],
      allOf: [{ properties: { a: { minLength: 1 }, c: { type: "boolean" } }, required: ["c"] }],
    });
    expect(Object.keys(wire.properties)).toEqual(["a", "b", "c"]);
    expect(wire.properties.a.type).toBe("STRING");
    expect(wire.properties.a.description).toContain("minLength: 1");
    expect(wire.required).toEqual(["a", "b", "c"]);
    assertSubscriptionSchema(wire);
  });

  test("does not silently overwrite incompatible intersection types", () => {
    expect(() => toGeminiSchema({ allOf: [{ type: "string" }, { type: "object" }] })).toThrow("intersection");
  });

  test("projects a union branch compatible with the parent type rather than rejecting a valid union", () => {
    const wire = toGeminiSchema({ type: "number", anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }] });
    expect(wire.type).toBe("INTEGER");
    expect(wire.description).toContain("minimum: 1");
    assertSubscriptionSchema(wire);
  });

  test("resolves escaped local pointers, including array segments, without prototype lookup", () => {
    const schema = { $defs: { "slash/tilde~": { type: "number", exclusiveMinimum: 0 }, Choices: [{ type: "string" }] },
      properties: { number: { $ref: "#/$defs/slash~1tilde~0" }, text: { $ref: "#/$defs/Choices/0" } },
    };
    const wire: any = toGeminiSchema(schema);
    expect(wire.properties.number.type).toBe("NUMBER");
    expect(wire.properties.number.description).toContain("exclusiveMinimum: 0");
    expect(wire.properties.text.type).toBe("STRING");
    assertSubscriptionSchema(wire);
  });

  test("normalizes repeated keyword-named properties through intersections without prototype mutation", () => {
    const wire: any = toGeminiSchema({ allOf: [
      { properties: Object.fromEntries(["__proto__", "constructor", "minimum"].map((name) => [name, { type: "integer" }])) },
      { properties: Object.fromEntries(["__proto__", "constructor", "minimum"].map((name) => [name, { exclusiveMinimum: 0 }])) },
    ] });
    for (const name of ["__proto__", "constructor", "minimum"]) {
      expect(wire.properties[name].type).toBe("INTEGER");
      expect(wire.properties[name].description).toContain("exclusiveMinimum: 0");
    }
    expect(Object.getPrototypeOf(wire.properties)).toBe(Object.prototype);
    assertSubscriptionSchema(wire);
  });

  test("projects object alternatives without losing branch properties or parent constraints", () => {
    const wire: any = toGeminiSchema({ properties: { common: { type: "string" } }, required: ["common"], anyOf: [
      { properties: { a: { type: "string" } }, required: ["a"] },
      { properties: { b: { type: "integer" } }, required: ["b"] }, { type: "null" },
    ] });
    expect(wire.type).toBe("OBJECT");
    expect(Object.keys(wire.properties)).toEqual(["common", "a", "b"]);
    expect(wire.required).toEqual(["common"]);
    expect(wire.nullable).toBe(true);
    expect(wire.description).toContain("anyOf:");
    assertSubscriptionSchema(wire);
  });

  test("normalizes tuple items, type inference, missing items and malformed required", () => {
    for (const schema of [
      { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false },
      { items: [{ type: "string" }, { type: "integer" }] },
      { type: "array" }, { properties: { count: { type: "integer" } }, required: ["count", "missing", 1] },
      { type: "string", required: ["missing"], items: { type: "integer" } },
    ]) assertSubscriptionSchema(toGeminiSchema(schema));
    expect((toGeminiSchema({ type: "array" }) as any).items).toEqual({ type: "STRING" });
  });

  test("rejects impossible, dynamic and malformed schemas before sending", () => {
    for (const schema of [false, null, [], 1, { type: "made-up" }, { $dynamicRef: "#node" }, { properties: [] }]) {
      expect(() => toGeminiSchema(schema)).toThrow();
    }
  });

  test("does not use another schema carrier to bypass an invalid selected schema", () => {
    expect(() => normalizeGeminiSchemas({ tools: [{ functionDeclarations: [{ name: "bad", parameters: false, parametersJsonSchema: { type: "object" } }] }] })).toThrow();
    expect(() => normalizeGeminiSchemas({ generationConfig: { responseSchema: false, responseJsonSchema: { type: "object" } } })).toThrow();
  });

  test("normalizes every schema carrier, including snake_case, but no history/data subtree", () => {
    const schema = { type: "object", properties: { count: { type: "integer", exclusiveMinimum: 0 } }, required: ["count"] };
    const data = { exclusiveMinimum: 0, format: "data", title: "data", enum: [{ default: "data" }], $ref: "data" };
    const payload: any = { contents: [{ role: "model", parts: [{ functionCall: { id: "call-id", name: "read", args: data }, thoughtSignature: "unchanged-signature" }] },
      { role: "user", parts: [{ functionResponse: { id: "call-id", name: "read", response: data } }] }],
      systemInstruction: { parts: [{ text: "Keep original instructions" }] }, toolConfig: data,
      tools: [{ functionDeclarations: [{ name: "read", parameters: schema, responseJsonSchema: schema }] },
        { function_declarations: [{ name: "other", parameters_json_schema: schema, response: schema }] }, { googleSearch: {} }],
      generationConfig: { responseJsonSchema: schema, temperature: 0.5 },
    };
    const before = JSON.stringify(payload);
    const wire: any = normalizeGeminiSchemas(payload);
    expect(wire.contents).toBe(payload.contents);
    expect(wire.systemInstruction).toBe(payload.systemInstruction);
    expect(wire.toolConfig).toBe(payload.toolConfig);
    for (const tool of wire.tools.slice(0, 2)) for (const declaration of tool.functionDeclarations) {
      assertSubscriptionSchema(declaration.parameters);
      assertSubscriptionSchema(declaration.response, true);
      expect(declaration.parametersJsonSchema).toBeUndefined();
      expect(declaration.parameters_json_schema).toBeUndefined();
    }
    expect(wire.tools[2]).toBe(payload.tools[2]);
    assertSubscriptionSchema(wire.generationConfig.responseSchema, true);
    expect(wire.generationConfig.responseJsonSchema).toBeUndefined();
    expect(JSON.stringify(payload)).toBe(before);
    expect(normalizeGeminiSchemas(wire)).toEqual(wire);
  });
});
