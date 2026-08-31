/* Consume exact engine row taxable-gain facts (no basis replay). */

/**
 * Read start-of-year taxable gain fraction exposed on an engine row.
 * Returns undefined when the row has no taxable withdrawal.
 */
export function gainFractionFromRow(row){
  if(row?.taxableGainFraction !== undefined) return row.taxableGainFraction;
  return undefined;
}

/** Exact aggregate capital gain across every taxable withdrawal tranche. */
export function capitalGainFromRow(row){
  if(row?.taxableCapitalGain !== undefined) return row.taxableCapitalGain;
  return undefined;
}

/**
 * Prefer exact per-row capital-gain dollars. Legacy rows retain the prior
 * taxableGainFraction fallback.
 */
export function buildRowTaxableGainPlanMeta(baseRowPlanMeta = null){
  return (row, index) => {
    const meta = baseRowPlanMeta ? { ...baseRowPlanMeta(row, index) } : {};
    const capitalGain = capitalGainFromRow(row);
    if(capitalGain !== undefined){
      meta.capitalGain = capitalGain;
    }else{
      const gainFraction = gainFractionFromRow(row);
      if(gainFraction !== undefined) meta.taxableGainFraction = gainFraction;
    }
    return Object.keys(meta).length > 0 ? meta : null;
  };
}
