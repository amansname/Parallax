export function hasDigits(value) {
  return /\d/.test(String(value ?? ''));
}
export function formatNetWorthCurrency(raw) {
  let value = String(raw ?? '').replace(/[^0-9.]/g, '');
  const dot = value.indexOf('.');
  if (dot !== -1) {
    value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, '');
  }
  if (!value) return '$';
  const parts = value.split('.');
  const integer = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1 ? `$${grouped}.${parts[1].slice(0, 2)}` : `$${grouped}`;
}
export function blankNetWorthDraft(categoryId) {
  return {
    categoryId,
    name: '',
    type: '',
    custom: false,
    owner: '',
    link: '',
    linkLabel: '',
    linkAvailable: false,
    value: '$',
    accountTypeId: '',
    allocationPresetId: '',
    initialAllocationPresetId: '',
    allocationSelectionChanged: false,
    canonicalTax: '',
    shellOnly: false,
    owners: ['client', 'spouse', 'joint']
  };
}
export function updateNetWorthDraft(transientState, control) {
  const field = control.dataset.netWorthDraft;
  if (!field || !transientState.netWorthDraft) return false;
  let value = control.value;
  if (field === 'value') {
    value = formatNetWorthCurrency(value);
    control.value = value;
  }
  const next = {
    ...transientState.netWorthDraft,
    [field]: value
  };
  if (field === 'allocationPresetId') {
    next.allocationSelectionChanged = value !== (next.initialAllocationPresetId || '');
  }
  if (field === 'link') {
    const selected = control.selectedOptions?.[0];
    next.linkLabel = selected?.textContent?.trim() || '';
    next.linkAvailable = selected?.dataset.netWorthLinkAvailable === 'true';
    const save = control.closest?.('.nw-panel')?.querySelector('[data-hh-action="net-worth-save-entry"]');
    if (save) {
      save.dataset.netWorthResolvedLink = next.linkAvailable ? next.link : '';
      save.dataset.netWorthResolvedLinkLabel = next.linkAvailable ? next.linkLabel : '';
      save.dataset.netWorthResolvedLinkAvailable = next.linkAvailable ? 'true' : 'false';
    }
  }
  const save = control.closest?.('.nw-panel')?.querySelector('[data-hh-action="net-worth-save-entry"]');
  if (save) {
    const ownerRequired = save.dataset.netWorthOwnerRequired === 'true';
    const ownerValid = !ownerRequired || Boolean(next.owner && next.owners.includes(next.owner));
    const linkRequired = save.dataset.netWorthLinkRequired === 'true';
    const linkValid = !linkRequired || save.dataset.netWorthResolvedLinkAvailable === 'true' && Boolean(save.dataset.netWorthResolvedLink);
    save.disabled = !ownerValid || !linkValid;
  }
  transientState.netWorthDraft = next;
  return true;
}
