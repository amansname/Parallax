// Plain-language reasons for the structured issue codes the engine reports.
// The engine knows exactly why it could not finish; flattening that to one
// generic sentence is what made this class of failure undiagnosable.
const PROJECTION_ISSUE_MESSAGES = {
  PROJECTION_HORIZON_OUT_OF_RANGE: 'Plan length is outside the supported projection range',
  PROJECTION_ITERATIONS_OUT_OF_RANGE: 'Simulation count is outside the supported projection range',
  PROJECTION_RETURN_PATH_DIMENSIONS_INVALID: 'Market path data does not cover the supported projection range',
  TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE: 'Pre-tax money is not assigned to a person — open Net Worth and set the owner on each retirement account',
  TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE: 'A retirement account outlives its owner and cannot roll to the surviving spouse — check account ownership and plan-end ages',
  TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE: 'A retirement account type has no supported RMD rule yet',
  EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE: 'An employer plan needs a retirement date before its RMD can be calculated',
  EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE: 'Multiple employer plans for one person cannot be aggregated for RMDs — see Net Worth',
  RMD_BIRTH_COHORT_UNAVAILABLE: 'A birth date is missing, so the RMD starting age cannot be determined — check Family',
  RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE: 'A prior year-end balance is missing for an RMD calculation'
};
export function scenarioProjectionIssueMessage(result) {
  const base = PROJECTION_ISSUE_MESSAGES[result?.issue] || 'calculation inputs need review';
  return result?.issueAge != null ? `${base} (from age ${result.issueAge})` : base;
}
export function scenarioRunFailureMessage(error) {
  if (error?.code === 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE') {
    return 'federal tax funding did not settle';
  }
  if (/filing status|filingStatus/i.test(error?.message || '')) {
    return 'Household filing status needs review';
  }
  // A typed engine issue still carries its reason even when it arrives as a throw.
  if (error?.rmdIssue || error?.code) {
    const mapped = PROJECTION_ISSUE_MESSAGES[error.rmdIssue || error.code];
    if (mapped) return mapped;
  }
  return 'calculation inputs need review';
}
