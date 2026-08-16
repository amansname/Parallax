/** Split stored YYYY-MM-DD into wizard month/day/year fields. */
export function splitIsoBirthDate(iso){
  if(typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    return { month: '', day: '', year: '' };
  }
  const [year, month, day] = iso.split('-');
  return {
    month,
    day,
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

export function readBirthDateGroup(group){
  if(!group?.querySelector) return null;
  const part = name => group.querySelector(`[data-birth-part="${name}"]`)?.value;
  return assembleIsoBirthDate({
    month: part('month'),
    day: part('day'),
    year: part('year'),
  });
}
