export function renderHouseholdWizardGoals(ctx){
  return `
    <div class="hh-screen hh-goals-screen" data-hh-wizard-screen="goals"
      id="hh-panel-goals" role="tabpanel" aria-labelledby="hh-nav-goals">
      <header class="hh-screen-head">
        <div><div class="hh-step-kicker">Step 04</div><h1>Goals</h1></div>
        <p>Define the spending the plan needs to fund and when it occurs.</p>
      </header>
      <div class="hh-goals-horizon" data-goals-horizon-mount>
        ${ctx.goalsContent || ''}
      </div>
    </div>
  `;
}
