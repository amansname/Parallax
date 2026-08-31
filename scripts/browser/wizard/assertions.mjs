// Wizard browser contract: assertions.

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
export async function countMatches(page, selector) {
  return page.evaluate(value => document.querySelectorAll(value).length, selector);
}
export async function requireUnique(page, selector, label = selector) {
  const count = await countMatches(page, selector);
  requireCondition(count === 1, `${label} must resolve exactly once; found ${count}`);
}
