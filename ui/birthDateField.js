import { splitIsoBirthDate } from '../src/household/birthDateInput.js';

export function renderBirthDateField({
  owner,
  iso,
  esc,
}){
  const parts = splitIsoBirthDate(iso);
  return `
    <div class="hh-birth-date" data-birth-date-group="${esc(owner)}">
      <input type="hidden"
        data-birth-date-value
        data-wizard-scope="family"
        data-wizard-field="${esc(owner)}.birthDate"
        value="${esc(iso)}">
      <input type="text" inputmode="numeric" maxlength="2" pattern="[0-9]{1,2}"
        class="hh-birth-date-part"
        aria-label="Birth month"
        placeholder="MM"
        data-birth-part="month"
        value="${esc(parts.month)}">
      <span class="hh-birth-date-sep" aria-hidden="true">/</span>
      <input type="text" inputmode="numeric" maxlength="2" pattern="[0-9]{1,2}"
        class="hh-birth-date-part"
        aria-label="Birth day"
        placeholder="DD"
        data-birth-part="day"
        value="${esc(parts.day)}">
      <span class="hh-birth-date-sep" aria-hidden="true">/</span>
      <input type="text" inputmode="numeric" maxlength="4" pattern="[0-9]{4}"
        class="hh-birth-date-part hh-birth-date-part--year"
        aria-label="Birth year"
        placeholder="YYYY"
        data-birth-part="year"
        value="${esc(parts.year)}">
    </div>
  `;
}
