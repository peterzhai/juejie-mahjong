/** 深拷贝配置中的普通对象和数组，兼容没有 structuredClone 的小游戏运行时。 */
export function cloneConfigData<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return clonePlainData(value, new Map());
}

function clonePlainData<T>(value: T, copies: Map<object, object>): T {
  if (value === null || typeof value !== 'object') return value;
  const existing = copies.get(value);
  if (existing) return existing as T;

  const copy = Array.isArray(value) ? new Array(value.length) : {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: clonePlainData(item, copies),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}
