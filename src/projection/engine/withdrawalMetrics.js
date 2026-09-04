/**
 * Annual portfolio-draw pressure after applying the year's investment return.
 * Taxes are not added here; `withdrawal` is the engine-owned Draw amount.
 */
export function effectiveWithdrawalRate({ withdrawal, startBalance, returnDollars }){
  const returnAdjustedBalance = startBalance + returnDollars;
  if(!(returnAdjustedBalance > 0.01)) return null;
  return withdrawal > 0 ? (withdrawal / returnAdjustedBalance) * 100 : 0;
}
