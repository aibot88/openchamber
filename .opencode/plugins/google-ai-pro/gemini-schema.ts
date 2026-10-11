// Gemini-only policy based on CLIProxyAPI/internal/util/gemini_schema.go and
// CortexKit/core/transform/gemini.ts. The private subscription Schema is NOT a
// general JSON Schema carrier. Build an allowlisted object, never pass through
// unrecognized fields. Constraints/union projections are model-facing hints,
// not equivalent server-side validation. OpenCode's tool definitions stay intact.
// Never walk contents, functionCall arguments, functionResponse results or IDs.
type Schema = Record<string, unknown>;
type Kind = "tool" | "response";
export type SchemaOptions = { kind?: Kind };
const types = new Set(["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT", "NULL"]);
const constraints = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems",
  "contains", "minContains", "maxContains", "minProperties", "maxProperties", "default", "examples",
  "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "dependencies",
  "propertyNames", "patternProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems",
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hint(schema: Schema, text: string): void {
  schema.description = schema.description ? `${schema.description}\n${text}` : text;
}
function score(schema: Schema): number {
  return schema.properties || schema.type === "OBJECT" ? 3 : schema.items || schema.type === "ARRAY" ? 2 : schema.type ? 1 : 0;
}
function valueType(value: unknown): string | undefined {
  return value === null ? "NULL" : Array.isArray(value) ? "ARRAY" : record(value) ? "OBJECT" :
    typeof value === "string" ? "STRING" : typeof value === "boolean" ? "BOOLEAN" :
    typeof value === "number" ? Number.isInteger(value) ? "INTEGER" : "NUMBER" : undefined;
}

// Merge only normalized fields. Intersections must not silently replace one
// branch's properties/type with another. Description constraints remain hints.
function intersect(a: Schema, b: Schema, depth: number): Schema {
  if (depth > 64) throw new Error("A schema intersection exceeded the subscription nesting limit.");
  const result = { ...a, ...b };
  if (a.type && b.type && a.type !== b.type) {
    if ([a.type, b.type].every((type) => type === "NUMBER" || type === "INTEGER")) result.type = "INTEGER";
    else throw new Error("Incompatible schema intersection types; the subscription adapter will not overwrite them.");
  }
  if (a.description && b.description && a.description !== b.description) result.description = `${a.description}\n${b.description}`;
  if (record(a.properties) || record(b.properties)) {
    const left = record(a.properties) ? a.properties : {};
    const right = record(b.properties) ? b.properties : {};
    result.properties = Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((name) => [name,
      Object.hasOwn(left, name) && Object.hasOwn(right, name) ? intersect(left[name] as Schema, right[name] as Schema, depth + 1) : Object.hasOwn(left, name) ? left[name] : right[name],
    ]));
  }
  if (Array.isArray(a.required) || Array.isArray(b.required)) result.required = [...new Set([
    ...(Array.isArray(a.required) ? a.required : []), ...(Array.isArray(b.required) ? b.required : []),
  ])];
  if (record(a.items) && record(b.items)) result.items = intersect(a.items, b.items, depth + 1);
  if (Object.hasOwn(a, "nullable") && Object.hasOwn(b, "nullable")) result.nullable = a.nullable === true && b.nullable === true;
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    result.enum = a.enum.filter((value) => (b.enum as unknown[]).includes(value));
    if (!(result.enum as unknown[]).length) throw new Error("An empty schema enum intersection cannot be sent to the subscription API.");
  }
  return result;
}

// The private route uses a single structural branch. Keep all object variant
// fields and only common required fields, and retain the complete union as a
// description hint. Do not emit anyOf/oneOf/allOf as unknown protobuf fields.
function projectUnion(branches: Schema[], depth: number): Schema {
  if (depth > 64) throw new Error("A schema union exceeded the subscription nesting limit.");
  if (branches.length === 1) return { ...branches[0] };
  const best = branches.reduce((a, b) => score(b) > score(a) ? b : a, branches[0] ?? {});
  const result = { ...best };
  if (branches.some((branch) => branch.nullable)) result.nullable = true;
  if (score(best) === 3) {
    const objects = branches.filter((branch) => score(branch) === 3);
    const names = [...new Set(objects.flatMap((branch) => Object.keys(record(branch.properties) ? branch.properties : {})))];
    result.properties = Object.fromEntries(names.map((name) => [name, projectUnion(objects
      .filter((branch) => record(branch.properties) && Object.hasOwn(branch.properties, name))
      .map((branch) => (branch.properties as Schema)[name] as Schema), depth + 1)]));
    result.required = branches.length === objects.length ? (Array.isArray(best.required) ? best.required : [])
      .filter((name) => objects.every((branch) => Array.isArray(branch.required) && branch.required.includes(name))) : [];
    // One branch's response enum/closed-object restriction is not a union-wide contract.
    if (!objects.every((branch) => branch.additionalProperties === false)) delete result.additionalProperties;
  }
  if (Array.isArray(best.enum)) {
    if (branches.every((branch) => branch.type === best.type && Array.isArray(branch.enum))) {
      result.enum = [...new Set(branches.flatMap((branch) => branch.enum as unknown[]))];
    } else delete result.enum;
  }
  return result;
}

function normalize(schema: unknown, root: unknown, depth: number, kind: Kind): Schema {
  if (depth > 64) throw new Error("A tool schema exceeded the subscription nesting limit.");
  if (schema === true) return {};
  if (!record(schema)) throw new Error("Malformed or impossible schema; the subscription adapter requires a schema object.");
  if (Object.hasOwn(schema, "$dynamicRef") || Object.hasOwn(schema, "$recursiveRef")) throw new Error("Dynamic tool schema references are unsupported by this subscription adapter.");
  if (Object.hasOwn(schema, "$ref")) {
    if (typeof schema.$ref !== "string" || (schema.$ref !== "#" && !schema.$ref.startsWith("#/"))) throw new Error("External tool schema references are unsupported by this subscription adapter.");
    let referenced: unknown = root;
    for (const escaped of schema.$ref === "#" ? [] : schema.$ref.slice(2).split("/")) {
      const segment = escaped.replace(/~1/g, "/").replace(/~0/g, "~");
      referenced = (record(referenced) || Array.isArray(referenced)) && Object.hasOwn(referenced, segment)
        ? (referenced as Schema)[segment] : undefined;
    }
    if (!record(referenced) && typeof referenced !== "boolean") throw new Error("A tool schema contains an unresolved local reference.");
    const { $ref, ...rest } = schema;
    return intersect(normalize(referenced, root, depth + 1, kind), normalize(rest, root, depth + 1, kind), depth + 1);
  }
  let result: Schema = {};
  if (typeof schema.description === "string") result.description = schema.description;
  if (typeof schema.nullable === "boolean") result.nullable = schema.nullable;
  if (Object.hasOwn(schema, "type")) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.length || declared.some((type) => typeof type !== "string" || !types.has(type.toUpperCase()))) throw new Error("Invalid schema type for the subscription API.");
    const nonNull = [...new Set((declared as string[]).map((type) => type.toUpperCase()).filter((type) => type !== "NULL"))];
    if (declared.some((type) => (type as string).toUpperCase() === "NULL")) result.nullable = true;
    if (nonNull.length) result.type = record(schema.properties) && nonNull.includes("OBJECT") ? "OBJECT" :
      (schema.items || schema.prefixItems) && nonNull.includes("ARRAY") ? "ARRAY" : nonNull[0];
    else hint(result, "Only null is allowed.");
    if (nonNull.length > 1) hint(result, `Accepts: ${nonNull.join(" | ")}`);
  }
  if (Object.hasOwn(schema, "properties")) {
    if (!record(schema.properties)) throw new Error("Malformed schema properties for the subscription API.");
    result.type = "OBJECT";
    // Property names are DATA, not schema keywords. Object.fromEntries also keeps
    // __proto__/constructor as own properties without prototype mutation.
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, normalize(child, root, depth + 1, kind)]));
  }
  if (Array.isArray(schema.required)) result.required = schema.required.filter((name) => typeof name === "string");
  const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : undefined;
  if (tuple) {
    result.type ??= "ARRAY";
    const children = tuple.map((child) => normalize(child, root, depth + 1, kind));
    if (record(schema.items)) children.push(normalize(schema.items, root, depth + 1, kind));
    result.items = projectUnion(children, depth + 1);
    hint(result, `Tuple items: ${JSON.stringify(tuple)}`);
    if (schema.items === false) hint(result, "items: false (no elements after the tuple)");
  } else if (Object.hasOwn(schema, "items")) {
    result.type ??= "ARRAY";
    if (schema.items === false) hint(result, "items: false (no elements allowed)");
    else result.items = normalize(schema.items, root, depth + 1, kind);
  }
  const values = Object.hasOwn(schema, "const") ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
  if (values) {
    if (!values.length) throw new Error("An empty schema enum cannot be sent to the subscription API.");
    const inferred = values.map(valueType).find((type) => type && type !== "NULL");
    if (inferred) result.type ??= inferred;
    if (values.includes(null)) result.nullable = true;
    // Antigravity ignores tool enums and rejects non-string protobuf enum
    // members. Never force INTEGER/BOOLEAN to STRING to work around that.
    if (kind === "response" && values.every((value) => typeof value === "string" || typeof value === "number")) result.enum = values.map(String);
    else hint(result, `${Object.hasOwn(schema, "const") ? "const" : "enum"}: ${JSON.stringify(Object.hasOwn(schema, "const") ? schema.const : values)}`);
  }
  if (schema.additionalProperties === false && kind === "response") {
    result.type ??= "OBJECT";
    if (result.type === "OBJECT") result.additionalProperties = false;
  } else if (schema.additionalProperties === false) hint(result, "No extra properties allowed.");
  else if (record(schema.additionalProperties)) hint(result, `additionalProperties: ${JSON.stringify(schema.additionalProperties)}`);
  for (const [key, value] of Object.entries(schema)) {
    if (constraints.has(key)) hint(result, `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    // All other keys are omitted; new keywords/extensions cannot leak to wire.
  }
  if (Object.hasOwn(schema, "allOf")) {
    if (!Array.isArray(schema.allOf)) throw new Error("Malformed schema intersection.");
    for (const branch of schema.allOf) result = intersect(result, normalize(branch, root, depth + 1, kind), depth + 1);
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (!Object.hasOwn(schema, key)) continue;
    if (!Array.isArray(schema[key]) || !(schema[key] as unknown[]).length) throw new Error("Malformed schema union.");
    const branches = (schema[key] as unknown[]).filter((branch) => branch !== false).map((branch) => normalize(branch, root, depth + 1, kind))
      .filter((branch) => !result.type || !branch.type || branch.type === result.type ||
        [result.type, branch.type].every((type) => type === "NUMBER" || type === "INTEGER"));
    if (!branches.length) throw new Error("An impossible schema union cannot be sent to the subscription API.");
    result = intersect(result, projectUnion(branches, depth + 1), depth + 1);
    hint(result, `${key}: ${JSON.stringify(schema[key])}`);
  }
  return result;
}

function finish(schema: Schema, depth = 0): Schema {
  if (depth > 64) throw new Error("A tool schema exceeded the subscription nesting limit.");
  const result = { ...schema };
  if (record(schema.properties)) {
    result.type = "OBJECT";
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, finish(child as Schema, depth + 1)]));
  }
  if (result.type === "ARRAY") result.items = record(schema.items) ? finish(schema.items, depth + 1) : { type: "STRING" };
  else delete result.items;
  const required = Array.isArray(schema.required) && record(result.properties) ? [...new Set(schema.required
    .filter((name) => typeof name === "string" && Object.hasOwn(result.properties as object, name)))] : [];
  if (required.length) result.required = required;
  else delete result.required;
  return result;
}

export function toGeminiSchema(schema: unknown, options: SchemaOptions = {}): Schema {
  return finish(normalize(schema, schema, 0, options.kind ?? "tool"));
}

export function normalizeGeminiSchemas(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  if (Array.isArray(payload.tools)) result.tools = payload.tools.map((tool: unknown) => {
    if (!record(tool)) return tool;
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (!Array.isArray(declarations)) return tool;
    const normalizedTool: Schema = { ...tool, functionDeclarations: declarations.map((declaration: unknown) => {
      if (!record(declaration)) return declaration;
      const normalized = { ...declaration };
      for (const [carrier, kind] of [["parameters", "tool"], ["response", "response"]] as const) {
        const aliases = [carrier, `${carrier}JsonSchema`, `${carrier}_json_schema`];
        const selected = aliases.find((key) => Object.hasOwn(declaration, key));
        if (selected) normalized[carrier] = toGeminiSchema(declaration[selected], { kind });
        for (const alias of aliases.slice(1)) delete normalized[alias];
      }
      return normalized;
    }) };
    delete normalizedTool.function_declarations;
    return normalizedTool;
  });
  if (record(payload.generationConfig)) {
    const config = { ...payload.generationConfig };
    if (Object.hasOwn(config, "responseJsonSchema") || Object.hasOwn(config, "responseSchema")) {
      config.responseSchema = toGeminiSchema(Object.hasOwn(config, "responseSchema") ? config.responseSchema : config.responseJsonSchema, { kind: "response" });
      delete config.responseJsonSchema;
    }
    result.generationConfig = config;
  }
  return result;
}
