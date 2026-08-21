import { renderBirthDateField } from './birthDateField.js';

export function renderHouseholdWizardFamily(ctx){
  const {
    plan,
    esc,
    fieldValue,
    moneyFieldValue,
    optionList,
    states,
    ageFor,
  } = ctx;
  const filingStatus = plan.meta?.filingStatus || 'single';
  const supportedFilingStatus = [
    'marriedFilingJointly',
    'single',
    'headOfHousehold',
  ].includes(filingStatus);
  const hasSpouse = filingStatus === 'marriedFilingJointly' || Boolean(plan.household?.spouse);

  const personCard = (owner, label) => {
    const nameField = owner === 'client' ? 'primaryName' : 'spouseName';
    const name = plan.meta?.[nameField] || '';
    const person = owner === 'client'
      ? plan.household?.primary || {}
      : plan.household?.spouse || {};
    const ssKey = owner === 'client' ? 'primary' : 'spouse';
    const birthDate = plan.taxProfiles?.[owner]?.birthDate?.value || '';
    const age = ageFor(owner);
    const status = person.employmentStatus || 'employed';
    return `
      <section class="hh-person-card" data-person-owner="${owner}">
        <div class="hh-card-head">
          <div class="hh-card-kicker">${esc(label)}</div>
          ${owner === 'spouse' ? `
            <button type="button" class="hh-card-action"
              data-hh-action="remove-spouse">Remove co-client</button>
          ` : ''}
        </div>
        <div class="hh-person-fields">
          <label class="hh-field hh-field--wide">
            <span>Legal name</span>
            <input type="text" value="${esc(name)}"
              data-hh-field="${owner}.legalName"
              data-wizard-scope="family" data-wizard-field="${nameField}">
          </label>
          <label class="hh-field hh-field--date">
            <span>Date of birth</span>
            ${renderBirthDateField({ owner, iso: birthDate, esc })}
          </label>
          <div class="hh-field hh-field--age">
            <span>Age</span>
            <output data-hh-age="${owner}">${age == null ? '—' : esc(age)}</output>
          </div>
          <label class="hh-field">
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
          <label class="hh-field">
            <span>Retires at</span>
            <input type="number" min="45" max="90" value="${fieldValue(person.retirementAge)}"
              data-hh-field="${owner}.retirementAge"
              data-wizard-scope="family" data-wizard-field="${owner}.retirementAge">
          </label>
          <label class="hh-field">
            <span>Social Security at</span>
            <input type="number" min="62" max="70"
              value="${fieldValue(plan.income?.socialSecurity?.[ssKey]?.claimAge)}"
              data-hh-field="${owner}.socialSecurityAge"
              data-wizard-scope="family" data-wizard-field="${owner}.socialSecurityAge">
          </label>
          <label class="hh-field">
            <span>Live to age</span>
            <input type="number" min="45" max="125" value="${fieldValue(person.planEndAge)}"
              data-hh-field="${owner}.planEndAge"
              data-wizard-scope="family" data-wizard-field="${owner}.planEndAge">
          </label>
          <label class="hh-field hh-field--wide">
            <span>Annual Social Security at full retirement age</span>
            <input type="text" inputmode="decimal"
              value="${moneyFieldValue(plan.income?.socialSecurity?.[ssKey]?.pia)}"
              data-hh-field="${owner}.socialSecurityBenefit"
              data-wizard-scope="family" data-wizard-field="${owner}.socialSecurityBenefit">
          </label>
        </div>
      </section>
    `;
  };

  return `
    <div class="hh-screen hh-family-screen" data-hh-wizard-screen="family"
      id="hh-panel-family" role="tabpanel" aria-labelledby="hh-nav-family">
      <header class="hh-screen-intro">
        <span class="t-eyebrow">Step 01</span>
      </header>
      <div class="hh-family-people${hasSpouse ? '' : ' is-single'}">
        ${personCard('client', 'Client')}
        ${hasSpouse ? personCard('spouse', 'Co-client') : ''}
      </div>

      <section class="hh-form-section">
        <div class="hh-family-filing">
          <label class="hh-field">
            <span>Filing status</span>
            <select data-hh-field="filingStatus"
              data-wizard-scope="family" data-wizard-field="filingStatus">
              ${supportedFilingStatus ? '' : `
                <option value="${esc(filingStatus)}" selected disabled>
                  Unsupported saved filing status · choose a supported status
                </option>
              `}
              ${optionList([
                ['marriedFilingJointly', 'Married filing jointly'],
                ['single', 'Single'],
                ['headOfHousehold', 'Head of household'],
              ], filingStatus)}
            </select>
          </label>
          <label class="hh-field">
            <span>State of residence</span>
            <select data-hh-field="state"
              data-wizard-scope="family" data-wizard-field="state">
              ${optionList(states, plan.meta?.state || 'VA')}
            </select>
          </label>
        </div>
      </section>
    </div>
  `;
}
