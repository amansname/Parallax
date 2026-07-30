export const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

export function cloneWizardValue(value){
  return structuredClone(value);
}

export function wizardTaxError(message, field, code){
  const error = new Error(message);
  error.field = field;
  error.code = code;
  return error;
}
