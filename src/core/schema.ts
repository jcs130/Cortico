type Schema = {
  type?: string;
  anyOf?: readonly Schema[];
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};
/** The limited JSON Schema vocabulary emitted by this package's tool declarations. */
export function validateToolInput(
  schema: Schema,
  value: unknown,
  path = "arguments",
  depth = 0,
): void {
  if (depth > 12) throw Error("Tool arguments are too deeply nested");
  if (schema.anyOf && !schema.anyOf.some(candidate => {
    try { validateToolInput(candidate, value, path, depth + 1); return true; }
    catch { return false; }
  })) throw Error('No matching argument format at ' + path);
  if (schema.enum && !schema.enum.includes(value))
    throw Error("Invalid " + path);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Expected object at " + path);
    const input = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in input)) throw Error("Missing " + path + "." + key);
    for (const [key, v] of Object.entries(input)) {
      if (
        schema.additionalProperties === false &&
        !(key in (schema.properties ?? {}))
      )
        throw Error("Unknown " + path + "." + key);
      if (schema.properties?.[key])
        validateToolInput(
          schema.properties[key],
          v,
          path + "." + key,
          depth + 1,
        );
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        validateToolInput(
          schema.additionalProperties,
          v,
          path + "." + key,
          depth + 1,
        );
    }
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 1000)
    )
      throw Error("Invalid array at " + path);
    if (schema.items)
      value.forEach((v, i) =>
        validateToolInput(schema.items!, v, path + "[" + i + "]", depth + 1),
      );
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 10000)
    )
      throw Error("Invalid text at " + path);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      throw Error("Invalid number at " + path);
  } else if (schema.type === "boolean" && typeof value !== "boolean")
    throw Error("Invalid boolean at " + path);
}
