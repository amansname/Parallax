import { renderBirthDateField } from './birthDateField.js';

export function renderHouseholdWizardFamily(ctx){
  const {
    plan,
    uiState,
    esc,
    fieldValue,
    optionList,
    ageFor,
  } = ctx;
  const hasSpouse = Boolean(plan.household?.spouse);
  const children = Array.isArray(plan.household?.children)
    ? plan.household.children
    : [];
  const childrenExpanded = uiState.familyChildrenExpanded === true;

  const personCard = owner => {
    const nameField = owner === 'client' ? 'primaryName' : 'spouseName';
    const name = plan.meta?.[nameField] || '';
    const person = owner === 'client'
      ? plan.household?.primary || {}
      : plan.household?.spouse || {};
    const birthDate = plan.taxProfiles?.[owner]?.birthDate?.value || '';
    const age = ageFor(owner);
    const status = person.employmentStatus || 'employed';
    return `
      <section class="hh-person-card" data-person-owner="${owner}"
        aria-label="${owner === 'client' ? 'Client' : 'Co-client'}">
        ${owner === 'spouse' ? `
          <button type="button" class="hh-person-remove" data-hh-action="remove-spouse"
            aria-label="Remove co-client" title="Remove co-client">&times;</button>
        ` : ''}
        <div class="hh-person-fields">
          <label class="hh-field hh-field--name">
            <span>Legal name</span>
            <input type="text" value="${esc(name)}"
              data-hh-field="${owner}.legalName"
              data-wizard-scope="family" data-wizard-field="${nameField}">
          </label>
          <div class="hh-person-row hh-person-row--identity">
            <label class="hh-field hh-field--date">
              <span>Date of birth</span>
              ${renderBirthDateField({ owner, iso: birthDate, esc })}
            </label>
            <div class="hh-field hh-field--age">
              <span>Age</span>
              <output data-hh-age="${owner}">${age == null ? '&mdash;' : esc(age)}</output>
            </div>
          </div>
          <div class="hh-person-row hh-person-row--milestones">
            <label class="hh-field hh-field--status">
              <span>Status</span>
              <select data-hh-field="${owner}.status"
                data-wizard-scope="family" data-wizard-field="${owner}.status">
                ${optionList([
                  ['employed', 'Employed'],
                  ['self-employed', 'Self-employed'],
                  ['retired', 'Retired'],
                ], status)}
              </select>
            </label>
            <label class="hh-field hh-field--age-entry">
              <span>Retires at</span>
              <input type="number" min="45" max="90" value="${fieldValue(person.retirementAge)}"
                data-hh-field="${owner}.retirementAge"
                data-wizard-scope="family" data-wizard-field="${owner}.retirementAge">
            </label>
            <label class="hh-field hh-field--age-entry">
              <span>Live to age</span>
              <input type="number" min="45" max="125" value="${fieldValue(person.planEndAge)}"
                data-hh-field="${owner}.planEndAge"
                data-wizard-scope="family" data-wizard-field="${owner}.planEndAge">
            </label>
          </div>
        </div>
      </section>
    `;
  };

  const childRows = children.map((child, index) => `
    <div class="hh-child-row" data-child-row="${index}">
      <div class="hh-child-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</div>
      <label class="hh-field">
        <span class="hh-sr-only">Child ${index + 1} name</span>
        <input type="text" placeholder="Name" value="${esc(child?.name || '')}"
          data-wizard-scope="family" data-wizard-field="children.${index}.name">
      </label>
      <label class="hh-field">
        <span class="hh-sr-only">Child ${index + 1} birth year</span>
        <input type="text" inputmode="numeric" maxlength="4" pattern="[0-9]{4}"
          placeholder="YYYY" value="${fieldValue(child?.birthYear)}"
          data-wizard-scope="family" data-wizard-field="children.${index}.birthYear">
      </label>
      <button type="button" class="hh-child-remove" data-hh-action="remove-child"
        data-child-index="${index}" aria-label="Remove child ${index + 1}">&times;</button>
    </div>
  `).join('');

  return `
    <div class="hh-screen hh-family-screen" data-hh-wizard-screen="family"
      id="hh-panel-family" role="tabpanel" aria-labelledby="hh-nav-family">
      <div class="hh-family-people${hasSpouse ? '' : ' is-single'}">
        ${personCard('client')}
        ${hasSpouse ? personCard('spouse') : `
          <button type="button" class="hh-add-person" data-hh-action="add-spouse">
            Add co-client
          </button>
        `}
      </div>

      <section class="hh-form-section hh-family-children-section">
        <label class="hh-children-toggle">
          <input type="checkbox" data-family-children-toggle
            ${childrenExpanded ? 'checked' : ''}>
          <span>Children</span>
        </label>

        ${childrenExpanded ? `
          <div class="hh-children-block" data-family-children-block>
            <div class="hh-children-head" aria-hidden="true">
              <span></span><span>Name</span><span>Birth year</span><span></span>
            </div>
            <div class="hh-children-rows">${childRows}</div>
            <button type="button" class="hh-add-child" data-hh-action="add-child">
              Add child
            </button>
          </div>
        ` : ''}
      </section>
    </div>
  `;
}
