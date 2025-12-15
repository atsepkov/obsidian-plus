/**
 * Shared utility: convert a bullet-tree (nodes with `text` + optional `children`) into a nested object.
 *
 * This is used both for:
 * - Tag config parsing (`ConfigLoader`) where users write:
 *     - auth:
 *       - type: bearer
 *       - token: `...`
 * - DSL parsing (`dsl/parser.ts`) for action options like:
 *     - fetch: `...`
 *       - headers:
 *         - Authorization: `Bearer ...`
 */
export type ChildTreeNode = {
  text?: string;
  children?: ChildTreeNode[];
};

export function childTreeToRecord(
  nodes: ChildTreeNode[] | undefined,
  options?: {
    normalizeKey?: (key: string) => any;
    normalizeValue?: (value: string) => any;
  }
): Record<string, any> {
  const normalizeKey = options?.normalizeKey ?? ((k: string) => k.trim());
  const normalizeValue = options?.normalizeValue ?? ((v: string) => v);

  const result: Record<string, any> = {};
  if (!nodes || !Array.isArray(nodes)) return result;

  for (const node of nodes) {
    const text = (node?.text ?? '').toString();
    if (!text.trim()) continue;

    // Split only once - values may contain additional colons.
    const idx = text.indexOf(':');
    if (idx === -1) continue;

    const rawKey = text.slice(0, idx).trim();
    const rawValue = text.slice(idx + 1).trim();
    const key = normalizeKey(rawKey);
    if (!key) continue;

    const hasExplicitValue = rawValue.length > 0;
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;

    if (!hasExplicitValue && hasChildren) {
      result[key] = childTreeToRecord(node.children, options);
    } else {
      result[key] = normalizeValue(rawValue);
    }
  }

  return result;
}


