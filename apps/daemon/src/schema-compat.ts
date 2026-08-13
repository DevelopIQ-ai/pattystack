/**
 * Generic JSON-schema compatibility layer for callers that do not want OpenAI
 * strict structured-output semantics to leak through.
 *
 * For `strict: false` schemas we:
 *   1. Keep the caller's original schema around.
 *   2. Translate it internally into a strict Codex-compatible schema by making
 *      every object property required and nullable, and forcing
 *      `additionalProperties: false`.
 *   3. After generation, parse the JSON output, strip the `null`s we forced
 *      onto optional properties, and validate the result against the original
 *      schema.
 *
 * For `strict: true` schemas we still validate the original schema with the
 * same strict rules as before and pass it through unchanged.
 */

import { InvalidSchemaError, validateStrictSchema } from './schema-strict.js';

export { InvalidSchemaError };

/** Non-enumerable key we attach to the internal `json_schema` object so the
 * original caller schema can travel with the turn without being forwarded to
 * providers (`JSON.stringify` ignores symbols). */
export const ORIGINAL_SCHEMA = Symbol.for('pattyd.original_schema');

/** Thrown when generated output cannot be parsed or does not satisfy the
 * caller's original schema. These are upstream failures, not client errors. */
export class OutputValidationError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message);
  }
}

const cloneDeep = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneDeep);
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneDeep(child);
  return copy;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');

const typeIncludesNull = (type: unknown, node?: Record<string, unknown>): boolean => {
  if (node?.nullable === true || node?.['x-nullable'] === true) return true;
  if (typeof type === 'string') return type === 'null';
  if (Array.isArray(type)) return type.includes('null');
  return false;
};

const typeNames = (type: unknown): string[] => {
  if (typeof type === 'string') return [type];
  if (isStringArray(type)) return type;
  return [];
};

const normalizeType = (type: unknown, nullable: boolean): string | string[] => {
  let types = typeNames(type);
  if (nullable) {
    if (!types.includes('null')) types = [...types, 'null'];
  } else {
    types = types.filter(t => t !== 'null');
  }
  if (types.length === 0) return nullable ? ['string', 'null'] : 'string';
  if (types.length === 1) return types[0]!;
  return types;
};

const isObjectSchema = (node: Record<string, unknown>): boolean =>
  node.type === 'object' ||
  (Array.isArray(node.type) && node.type.includes('object')) ||
  'properties' in node ||
  'additionalProperties' in node;

const isArraySchema = (node: Record<string, unknown>): boolean =>
  node.type === 'array' ||
  (Array.isArray(node.type) && node.type.includes('array')) ||
  'items' in node;

/**
 * A light structural check that avoids surprises when we normalise a caller
 * schema: we do *not* enforce strict rules here, but we do make sure the
 * structure is something we can translate without crashing.
 */
export function validateOriginalSchema(schema: unknown, path = '$'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    if (typeof schema === 'boolean') return;
    throw new InvalidSchemaError(path, 'JSON schema must be an object.');
  }
  const node = schema as Record<string, unknown>;

  if (node.type !== undefined && typeof node.type !== 'string' && !isStringArray(node.type)) {
    throw new InvalidSchemaError(`${path}.type`, 'type must be a string or an array of strings.');
  }

  for (const combiner of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[combiner];
    if (branches !== undefined && !Array.isArray(branches)) {
      throw new InvalidSchemaError(`${path}.${combiner}`, `${combiner} must be an array of schemas.`);
    }
    if (Array.isArray(branches)) {
      for (let i = 0; i < branches.length; i++) {
        validateOriginalSchema(branches[i], `${path}.${combiner}[${i}]`);
      }
    }
  }

  if (node.properties !== undefined) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
      throw new InvalidSchemaError(`${path}.properties`, 'properties must be an object.');
    }
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      validateOriginalSchema(child, `${path}.properties.${key}`);
    }
  }

  if (node.required !== undefined && !isStringArray(node.required)) {
    throw new InvalidSchemaError(`${path}.required`, 'required must be an array of strings.');
  }

  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean' &&
      (typeof node.additionalProperties !== 'object' || node.additionalProperties === null || Array.isArray(node.additionalProperties))) {
    throw new InvalidSchemaError(`${path}.additionalProperties`, 'additionalProperties must be a boolean or a schema object.');
  }

  if (node.additionalProperties !== undefined && typeof node.additionalProperties === 'object' && !Array.isArray(node.additionalProperties) && node.additionalProperties !== null) {
    validateOriginalSchema(node.additionalProperties, `${path}.additionalProperties`);
  }

  if (node.items !== undefined) {
    if (typeof node.items !== 'object' || node.items === null) {
      throw new InvalidSchemaError(`${path}.items`, 'items must be a schema object or array of schemas.');
    }
    if (Array.isArray(node.items)) {
      for (let i = 0; i < node.items.length; i++) {
        validateOriginalSchema(node.items[i], `${path}.items[${i}]`);
      }
    } else {
      validateOriginalSchema(node.items, `${path}.items`);
    }
  }
}

/**
 * Recursively turn a caller schema into a strict Codex-compatible one.
 * `optional` is true when the schema describes a property that was not listed
 * in its parent's `required`; those properties become nullable so the model can
 * emit `null`, which we later strip.
 */
export function toStrictSchema(schema: unknown, optional = false, path = '$'): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new InvalidSchemaError(path, 'JSON schema must be an object.');
  }
  const node = schema as Record<string, unknown>;

  if (isObjectSchema(node)) {
    const properties: Record<string, unknown> = {};
    const rawProperties = node.properties;
    if (rawProperties !== undefined && rawProperties !== null) {
      if (typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
        throw new InvalidSchemaError(`${path}.properties`, 'properties must be an object.');
      }
      for (const [key, child] of Object.entries(rawProperties as Record<string, unknown>)) {
        properties[key] = child;
      }
    }

    const requiredSet = new Set<string>(isStringArray(node.required) ? node.required : []);
    const strictProperties: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      const childOriginal = properties[key] as Record<string, unknown>;
      const childPath = `${path}.properties.${key}`;
      const childOptional = !requiredSet.has(key);
      const childStrict = toStrictSchema(childOriginal, childOptional, childPath);
      strictProperties[key] = childStrict;
    }

    return {
      ...copyExtras(node, ['properties', 'required', 'additionalProperties', 'type']),
      type: 'object',
      properties: strictProperties,
      required: Object.keys(strictProperties),
      additionalProperties: false,
    };
  }

  if (isArraySchema(node)) {
    const items = node.items;
    let strictItems: unknown;
    if (items === undefined) {
      strictItems = {};
    } else if (Array.isArray(items)) {
      strictItems = items.map((item, i) => toStrictSchema(item as Record<string, unknown>, false, `${path}.items[${i}]`));
    } else {
      strictItems = toStrictSchema(items as Record<string, unknown>, false, `${path}.items`);
    }

    return {
      ...copyExtras(node, ['items', 'type']),
      type: 'array',
      items: strictItems,
    };
  }

  // Primitive / combiner schema.
  const strict = copyExtras(node, []);
  strict.type = normalizeType(node.type, optional || typeIncludesNull(node.type, node));

  if (Array.isArray(node.enum) && optional) {
    strict.enum = Array.from(new Set([...(node.enum as unknown[]), null]));
  }

  for (const combiner of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[combiner];
    if (Array.isArray(branches)) {
      strict[combiner] = branches.map((branch, i) => toStrictSchema(branch as Record<string, unknown>, optional, `${path}.${combiner}[${i}]`));
    }
  }

  return strict;
}

const copyExtras = (node: Record<string, unknown>, exclude: string[]): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!exclude.includes(key)) copy[key] = cloneDeep(value);
  }
  return copy;
};

/** Re-attach the original schema to an internal `json_schema` object. */
export function setOriginalSchema(format: { json_schema: Record<string, unknown> } | undefined, original: unknown): void {
  if (format?.json_schema) (format.json_schema as Record<symbol, unknown>)[ORIGINAL_SCHEMA] = original;
}

/** Read the original schema back from an internal `json_schema` object. */
export function getOriginalSchema(format: unknown): unknown {
  if (!format || typeof format !== 'object' || Array.isArray(format)) return undefined;
  const json_schema = (format as Record<string, unknown>).json_schema;
  if (!json_schema || typeof json_schema !== 'object' || Array.isArray(json_schema)) return undefined;
  return (json_schema as Record<symbol, unknown>)[ORIGINAL_SCHEMA];
}

/** Build a normalized `json_schema` object ready to be sent to providers. */
export function formatJsonSchema(
  name: unknown,
  description: unknown,
  strict: unknown,
  schema: unknown
): { type: 'json_schema'; json_schema: { name?: string; description?: string; strict: boolean; schema: Record<string, unknown> } } {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('invalid_request');
  const original = cloneDeep(schema) as Record<string, unknown>;
  const strictRequested = strict === true;

  if (strictRequested) {
    validateStrictSchema(original, '$');
  } else {
    validateOriginalSchema(original, '$');
  }

  const strictSchema = strictRequested ? original : toStrictSchema(original, false, '$');
  validateStrictSchema(strictSchema, '$');

  const result: { type: 'json_schema'; json_schema: { name?: string; description?: string; strict: boolean; schema: Record<string, unknown> } } = {
    type: 'json_schema',
    json_schema: {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      strict: true,
      schema: strictSchema,
    },
  };
  if (!strictRequested) (result.json_schema as Record<symbol, unknown>)[ORIGINAL_SCHEMA] = original;
  return result;
}

const valueType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const typeMatches = (value: unknown, type: unknown): boolean => {
  const names = typeNames(type);
  if (names.length === 0) return true;
  const actual = valueType(value);
  if (names.includes(actual)) return true;
  if (names.includes('number') && actual === 'integer') return true;
  if (names.includes('integer') && actual === 'number' && Number.isInteger(value as number)) return true;
  return false;
};

const matchesEnum = (value: unknown, node: Record<string, unknown>): boolean => {
  if (!Array.isArray(node.enum)) return true;
  return (node.enum as unknown[]).some(candidate => JSON.stringify(candidate) === JSON.stringify(value));
};

/**
 * Strip the `null` placeholders we forced onto optional properties.
 * A `null` is kept when the original schema already declared the property
 * nullable (type includes `null`, `nullable: true`, or the property is in
 * `required` and its type allows `null`).
 */
export function stripOptionalNulls(value: unknown, schema: unknown, path = '$'): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || typeof schema === 'boolean') {
    return value;
  }
  const node = schema as Record<string, unknown>;

  if (isArraySchema(node)) {
    if (!Array.isArray(value)) return value;
    if (Array.isArray(node.items)) {
      const tupleItems = node.items as unknown[];
      return value.map((item, i) => stripOptionalNulls(item, tupleItems[i], `${path}[${i}]`));
    }
    if (node.items !== undefined && typeof node.items === 'object' && !Array.isArray(node.items)) {
      const itemSchema = node.items as Record<string, unknown>;
      return value.map((item, i) => stripOptionalNulls(item, itemSchema, `${path}[${i}]`));
    }
    return value;
  }

  // Try to resolve anyOf/oneOf/allOf for objects so nested optional properties
  // can be stripped correctly.
  const objectBranches = [
    ...(node.anyOf ? (node.anyOf as unknown[]).filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b)) : []),
    ...(node.oneOf ? (node.oneOf as unknown[]).filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b)) : []),
    ...(node.allOf ? (node.allOf as unknown[]).filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b)) : []),
  ];
  if (objectBranches.length && !isObjectSchema(node)) {
    const matching = objectBranches.find(branch => {
      const props = branch.properties ? Object.keys(branch.properties as Record<string, unknown>) : [];
      if (!props.length) return true;
      const required = branch.required ?? [];
      if (!Array.isArray(required) || !Array.isArray(value) && typeof value === 'object' && value !== null) return false;
      const keys = Object.keys(value as Record<string, unknown>);
      return keys.every(key => props.includes(key));
    }) ?? objectBranches[0];
    return stripOptionalNulls(value, matching, path);
  }

  if (!isObjectSchema(node) || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const originalValue = value as Record<string, unknown>;
  const requiredSet = new Set<string>(isStringArray(node.required) ? node.required : []);
  const properties = node.properties as Record<string, unknown> | undefined;
  const result: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(originalValue)) {
    if (properties && key in properties) {
      const childSchema = properties[key] as Record<string, unknown>;
      const nullable = typeIncludesNull(childSchema.type, childSchema) || requiredSet.has(key);
      if (childValue === null && !nullable) {
        continue;
      }
      result[key] = stripOptionalNulls(childValue, childSchema, `${path}.${key}`);
      continue;
    }
    result[key] = childValue;
  }

  return result;
}

/** Validate parsed output against the caller's original schema. */
export function validateOriginalOutput(value: unknown, schema: unknown, path = '$'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || typeof schema === 'boolean') {
    return;
  }
  const node = schema as Record<string, unknown>;

  if (!typeMatches(value, node.type)) {
    throw new OutputValidationError(path, `Expected type ${JSON.stringify(node.type)}, got ${valueType(value)}.`);
  }

  if (Array.isArray(node.enum) && !matchesEnum(value, node)) {
    throw new OutputValidationError(path, `Value ${JSON.stringify(value)} is not in enum ${JSON.stringify(node.enum)}.`);
  }

  for (const combiner of ['anyOf', 'oneOf'] as const) {
    const branches = node[combiner];
    if (Array.isArray(branches)) {
      const valid = branches.some(branch => {
        try { validateOriginalOutput(value, branch, `${path}.${combiner}`); return true; } catch { return false; }
      });
      if (!valid) {
        throw new OutputValidationError(path, `Value does not match any ${combiner} branch.`);
      }
      break;
    }
  }

  const allOf = node.allOf;
  if (Array.isArray(allOf)) {
    for (let i = 0; i < allOf.length; i++) {
      validateOriginalOutput(value, allOf[i], `${path}.allOf[${i}]`);
    }
  }

  if (isArraySchema(node) && Array.isArray(value)) {
    if (Array.isArray(node.items)) {
      for (let i = 0; i < value.length; i++) {
        validateOriginalOutput(value[i], node.items[i], `${path}[${i}]`);
      }
    } else if (node.items !== undefined && typeof node.items === 'object' && !Array.isArray(node.items)) {
      for (let i = 0; i < value.length; i++) {
        validateOriginalOutput(value[i], node.items, `${path}[${i}]`);
      }
    }
    return;
  }

  if (!isObjectSchema(node) || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  const objectValue = value as Record<string, unknown>;
  const requiredSet = new Set<string>(isStringArray(node.required) ? node.required : []);
  const properties = node.properties as Record<string, unknown> | undefined;

  for (const key of requiredSet) {
    if (!(key in objectValue)) {
      throw new OutputValidationError(`${path}.${key}`, `Missing required property.`);
    }
  }

  for (const [key, childValue] of Object.entries(objectValue)) {
    if (properties && key in properties) {
      validateOriginalOutput(childValue, properties[key], `${path}.${key}`);
      continue;
    }
    if (node.additionalProperties === false) {
      throw new OutputValidationError(`${path}.${key}`, `Unexpected additional property.`);
    }
    if (typeof node.additionalProperties === 'object' && node.additionalProperties !== null && !Array.isArray(node.additionalProperties)) {
      validateOriginalOutput(childValue, node.additionalProperties, `${path}.${key}`);
    }
  }
}

/**
 * Parse provider text, strip translation artifacts, and validate against the
 * caller's schema. Returns the compact JSON string to send back.
 */
export function applyOriginalSchema(text: string, original: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/g, '');
    const firstObject = trimmed.indexOf('{');
    const lastObject = trimmed.lastIndexOf('}');
    if (firstObject !== -1 && lastObject > firstObject) {
      try { parsed = JSON.parse(trimmed.slice(firstObject, lastObject + 1)); }
      catch { /* ignore */ }
    }
    if (parsed === undefined) {
      const firstArray = trimmed.indexOf('[');
      const lastArray = trimmed.lastIndexOf(']');
      if (firstArray !== -1 && lastArray > firstArray) {
        try { parsed = JSON.parse(trimmed.slice(firstArray, lastArray + 1)); }
        catch { /* ignore */ }
      }
    }
    if (parsed === undefined) {
      throw new OutputValidationError('$', 'Generated output is not valid JSON.');
    }
  }

  const stripped = stripOptionalNulls(parsed, original);
  validateOriginalOutput(stripped, original);
  return JSON.stringify(stripped);
}
