// Compare the complete prepared engine input, including values JSON normally
// drops or conflates. Unsupported/cyclic data simply disables reuse.
function encode(value, parents = new Set()) {
  if (value === null) return ['null'];
  const type = typeof value;
  if (type === 'undefined') return ['undefined'];
  if (type === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (type === 'string' || type === 'boolean') return [type, value];
  if (type !== 'object' || parents.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error('Uncacheable input');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Uncacheable input');
  parents.add(value);
  const entries = Object.keys(value).map(key => [key, encode(value[key], parents)]);
  parents.delete(value);
  return array ? ['array', value.length, entries] : ['object', entries];
}

export function scenarioRunKey(entry, baseTaxYear) {
  try { return JSON.stringify(encode({ entry, baseTaxYear })); }
  catch { return null; }
}
