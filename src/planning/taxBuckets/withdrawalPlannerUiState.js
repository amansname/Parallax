/** Ephemeral UI state for Tax-Aware Withdrawal — never written to household plan. */

export function createWithdrawalPlannerUiState(initialFilingStatus = null) {
  return Object.freeze({
    taxYear: 2026,
    hoverMark: null,
    facts: Object.freeze({
      filingStatus: initialFilingStatus,
      livedWithSpouse: false,
      socialSecurityBenefits: 0,
      wages: 0,
      otherIncome: 0,
    }),
    levers: Object.freeze({
      taxableWithdrawal: 0,
      deferredWithdrawal: 0,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    }),
    caps: Object.freeze({ taxable: null, traditional: null, roth: null }),
    result: null,
    attribution: null,
    adapterReady: false,
    adapterError: null,
  });
}

export function patchWithdrawalPlannerUiState(prev, patch) {
  return Object.freeze({
    ...prev,
    ...patch,
    facts: patch.facts ? Object.freeze({ ...prev.facts, ...patch.facts }) : prev.facts,
    levers: patch.levers ? Object.freeze({ ...prev.levers, ...patch.levers }) : prev.levers,
    caps: patch.caps ? Object.freeze({ ...prev.caps, ...patch.caps }) : prev.caps,
  });
}
