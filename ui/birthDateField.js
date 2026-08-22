import { formatIsoBirthDate } from '../src/household/birthDateInput.js';

export function renderBirthDateField({
  owner,
  iso,
  esc,
}){
  return `
    <div class="hh-birth-date" data-birth-date-group="${esc(owner)}">
      <input type="hidden"
        data-birth-date-value
        data-wizard-scope="family"
        data-wizard-field="${esc(owner)}.birthDate"
        value="${esc(iso)}">
      <input type="text" inputmode="numeric" autocomplete="bday"
        class="hh-birth-date-input"
        aria-label="Date of birth"
        placeholder="MM / DD / YYYY"
        data-birth-date-display
        value="${esc(formatIsoBirthDate(iso))}">
    </div>
  `;
}
