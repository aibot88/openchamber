// Independent, deliberately strict fixture backend. Do not import the adapter's
// policy here: sharing an allowlist would let the same omission pass both sides.
export function assertSubscriptionSchema(value: unknown, response = false, path = "schema"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected a schema object`);
  const node = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(node)) {
    switch (key) {
      case "type":
        if (!["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"].includes(child as string)) throw new Error(`${path}.type: invalid type`);
        break;
      case "description":
        if (typeof child !== "string") throw new Error(`${path}.description: expected string`);
        break;
      case "nullable":
        if (typeof child !== "boolean") throw new Error(`${path}.nullable: expected boolean`);
        break;
      case "properties":
        if (node.type !== "OBJECT" || !child || typeof child !== "object" || Array.isArray(child)) throw new Error(`${path}.properties: invalid object schema`);
        for (const [name, schema] of Object.entries(child)) assertSubscriptionSchema(schema, response, `${path}.properties[${name}]`);
        break;
      case "items":
        if (node.type !== "ARRAY") throw new Error(`${path}.items: invalid array schema`);
        assertSubscriptionSchema(child, response, `${path}.items`);
        break;
      case "required":
        if (node.type !== "OBJECT" || !Array.isArray(child) || child.some((name) => typeof name !== "string" || !node.properties || !Object.hasOwn(node.properties, name))) throw new Error(`${path}.required: undefined property`);
        break;
      case "enum":
        if (!response || !Array.isArray(child) || child.some((item) => typeof item !== "string")) throw new Error(`${path}.enum: invalid enum`);
        break;
      case "additionalProperties":
        if (!response || node.type !== "OBJECT" || child !== false) throw new Error(`${path}.additionalProperties: unsupported`);
        break;
      default: throw new Error(`${path}: unknown field ${key}`);
    }
  }
  if (node.type === "ARRAY" && !node.items) throw new Error(`${path}.items: missing field`);
}
