/**
 * Validates a caller-provided JSON Schema the way Codex's app-server actually
 * consumes it: it is always submitted as OpenAI strict structured output.
 *
 * Strict object schemas require:
 *   - every property to appear in `required`
 *   - `additionalProperties: false`
 *
 * This is intentionally not a generic JSON Schema validator; it only checks the
 * two rules that make upstream reject a turn with a useless "run failed" 502.
 */
export function validateStrictSchema(schema: unknown, path = 'schema'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  const type = node.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || 'properties' in node || 'additionalProperties' in node;
  const isArray = type === 'array' || (Array.isArray(type) && type.includes('array')) || 'items' in node;
  if (!isObject && !isArray) return;

  if (isObject) {
    if (node.additionalProperties !== false) {
      throw new Error(`${path}.additionalProperties must be false for strict structured output`);
    }

    const properties = node.properties ?? {};
    if (typeof properties !== 'object' || Array.isArray(properties) || properties === null) {
      throw new Error(`${path}.properties must be an object`);
    }

    const hasProperties = Object.keys(properties).length > 0;
    const required = node.required;
    if (hasProperties && !Array.isArray(required)) {
      throw new Error(`${path}.required must be an array of property names`);
    }

    const requiredSet = new Set<string>();
    if (Array.isArray(required)) {
      for (const entry of required) {
        if (typeof entry !== 'string') throw new Error(`${path}.required must contain only strings`);
        requiredSet.add(entry);
      }
    }

    for (const key of Object.keys(properties)) {
      if (!requiredSet.has(key)) {
        throw new Error(`${path}.properties.${key} is optional; every property must appear in ${path}.required for strict structured output`);
      }
      validateStrictSchema((properties as Record<string, unknown>)[key], `${path}.properties.${key}`);
    }
  }

  if (isArray && node.items && typeof node.items === 'object') {
    if (Array.isArray(node.items)) {
      for (let i = 0; i < node.items.length; i++) validateStrictSchema(node.items[i], `${path}.items[${i}]`);
    } else {
      validateStrictSchema(node.items, `${path}.items`);
    }
  }

  for (const combiner of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[combiner];
    if (Array.isArray(branches)) {
      for (let i = 0; i < branches.length; i++) {
        validateStrictSchema(branches[i], `${path}.${combiner}[${i}]`);
      }
    }
  }
}
