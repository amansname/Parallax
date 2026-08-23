/** Split stored YYYY-MM-DD into wizard month/day/year fields. */
export function splitIsoBirthDate(iso){
  if(typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    return { month: '', day: '', year: '' };
  }
  const [year, month, day] = iso.split('-');
  return {
    month: String(Number(month)),
    day: String(Number(day)),
    year,
  };
}

/** Build ISO date from wizard parts; null when incomplete or not numeric. */
export function assembleIsoBirthDate(parts){
  const month = String(parts?.month ?? '').trim();
  const day = String(parts?.day ?? '').trim();
  const year = String(parts?.year ?? '').trim();
  if(!month || !day || !year) return null;
  if(!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)){
    return null;
  }
  const mm = Number(month);
  const dd = Number(day);
  const yyyy = Number(year);
  if(!Number.isInteger(mm) || !Number.isInteger(dd) || !Number.isInteger(yyyy)){
    return null;
  }
  if(mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900){
    return null;
  }
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Format stored YYYY-MM-DD for the single visible wizard field. */
export function formatIsoBirthDate(iso){
  const { month, day, year } = splitIsoBirthDate(iso);
  if(!month || !day || !year) return '';
  return `${month.padStart(2, '0')} / ${day.padStart(2, '0')} / ${year}`;
}

function birthDateDigits(value){
  return String(value ?? '').replace(/\D/g, '').slice(0, 8);
}

/** Keep the visible birth-date field in MM / DD / YYYY form while typing. */
export function formatBirthDateEntry(value){
  const digits = birthDateDigits(value);
  if(digits.length < 2) return digits;
  if(digits.length === 2) return `${digits} / `;

  const month = digits.slice(0, 2);
  const day = digits.slice(2, 4);
  if(digits.length < 4) return `${month} / ${day}`;
  if(digits.length === 4) return `${month} / ${day} / `;
  return `${month} / ${day} / ${digits.slice(4)}`;
}

/** Place the caret after a count of typed digits, skipping inserted separators. */
export function birthDateCaretAfterDigits(formatted, digitCount){
  const target = Math.max(0, Number(digitCount) || 0);
  if(target === 0) return 0;

  let seen = 0;
  for(let index = 0; index < formatted.length; index += 1){
    if(!/\d/.test(formatted[index])) continue;
    seen += 1;
    if(seen !== target) continue;
    let caret = index + 1;
    while(caret < formatted.length && /\D/.test(formatted[caret])) caret += 1;
    return caret;
  }
  return formatted.length;
}

/** Delete the adjacent digit when the browser caret is beside an inserted slash. */
export function deleteBirthDateDigit(value, caret, direction = 'backward'){
  const digits = birthDateDigits(value);
  const input = String(value ?? '');
  const position = Math.max(0, Math.min(Number(caret) || 0, input.length));
  const digitIndex = (input.slice(0, position).match(/\d/g) || []).length;
  const removeIndex = direction === 'forward' ? digitIndex : digitIndex - 1;
  if(removeIndex < 0 || removeIndex >= digits.length) return null;

  const nextDigits = `${digits.slice(0, removeIndex)}${digits.slice(removeIndex + 1)}`;
  const formatted = formatBirthDateEntry(nextDigits);
  const digitsBeforeCaret = direction === 'forward' ? digitIndex : digitIndex - 1;
  return {
    value: formatted,
    caret: birthDateCaretAfterDigits(formatted, digitsBeforeCaret),
  };
}

/** Parse the standalone field's MM / DD / YYYY presentation into ISO. */
export function parseDisplayedBirthDate(value){
  const match = String(value ?? '').trim().match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})$/);
  if(!match) return null;
  return assembleIsoBirthDate({ month: match[1], day: match[2], year: match[3] });
}

export function readBirthDateGroup(group){
  if(!group?.querySelector) return null;
  const display = group.querySelector('[data-birth-date-display]');
  if(display) return parseDisplayedBirthDate(display.value);
  const part = name => group.querySelector(`[data-birth-part="${name}"]`)?.value;
  return assembleIsoBirthDate({
    month: part('month'),
    day: part('day'),
    year: part('year'),
  });
}
