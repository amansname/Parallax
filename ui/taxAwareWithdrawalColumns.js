/** Threshold column presentation geometry — display only, no tax math. */

export function formatWithdrawalMoney(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? (value < 0 ? '-$' : '$') + Math.abs(Math.round(value)).toLocaleString('en-US')
    : '—';
}

export function formatWithdrawalPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const n = Math.abs(value) <= 1 ? value * 100 : value;
  return `${Math.round(n * 10) / 10}%`;
}

function columnGeom(id, bounds, baseVal, addVal, hoverMark, formatMoney, formatPct) {
  const base = typeof baseVal === 'number' && Number.isFinite(baseVal) ? baseVal : 0;
  const add = typeof addVal === 'number' && Number.isFinite(addVal) ? addVal : 0;
  const bd = (bounds || []).filter(b => b && typeof b.v === 'number' && Number.isFinite(b.v) && b.v > 0)
    .sort((x, y) => x.v - y.v);
  const bs = bd.map(b => b.v);
  if (!bs.length) return null;
  const n = bs.length;
  const topV = bs[n - 1];
  const HMAX = 0.86;
  const P = 0.55;
  const curve = v => Math.pow(Math.max(0, v) / topV, P) * HMAX;
  const slot = i2 => curve(bs[i2]);
  const map = v => {
    if (!(v > 0)) return 0;
    if (v <= topV) return curve(v);
    const overflow = Math.min(1, (v - topV) / Math.max(topV * 0.6, 1));
    return HMAX + overflow * (1 - HMAX);
  };
  const pct = f => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`;
  const total = base + add;
  const baseH = map(base);
  const topH = map(total);
  const nextIdx = bs.findIndex(v => v > total);
  return {
    value: formatMoney(total),
    base: pct(baseH),
    fill: pct(Math.max(0, topH - baseH)),
    top: pct(topH),
    gap: pct(Math.max(0, (nextIdx < 0 ? 1 : slot(nextIdx)) - topH)),
    marks: bs.map((v, k) => {
      const below = bs.filter(x => x <= total);
      const lastCrossed = below.length ? below[below.length - 1] : null;
      const span = (bs[k + 1] ?? v * 1.6) - v;
      const window = Math.max(1500, span * 0.12);
      const justCrossed = lastCrossed === v && total - v <= window;
      const key = `${id}:${k}`;
      const hovered = hoverMark === key;
      return {
        key,
        pos: pct(slot(k)),
        hit: `calc(${pct(slot(k))} - 5px)`,
        tickW: hovered || justCrossed ? '50%' : '7px',
        bg: hovered || justCrossed || v <= total
          ? 'rgba(169,153,138,.32)'
          : 'rgba(169,153,138,.22)',
        label: bd[k].label || formatMoney(v),
        chipOpacity: hovered || justCrossed ? 1 : 0,
        chipInk: justCrossed && !hovered ? 'var(--acc)' : 'var(--ink)',
      };
    }),
  };
}

function floorOf(baseline, total) {
  const f = typeof baseline === 'number' && Number.isFinite(baseline) ? Math.max(0, baseline) : 0;
  return typeof total === 'number' && Number.isFinite(total) ? Math.min(f, total) : f;
}

const BLANK_GEOM = Object.freeze({
  value: '—',
  base: '0%',
  fill: '0%',
  top: '0%',
  gap: '0%',
  marks: [],
});

export function buildThresholdColumns({ result, hoverMark }) {
  const m = formatWithdrawalMoney;
  const pc = formatWithdrawalPct;
  if (!result || result.error || result.code) {
    return [
      { id: 'ord', name: 'Income Tax', current: '—', tone: 'var(--ink)', footLabel: '—', foot: '—', ...BLANK_GEOM },
      { id: 'ltcg', name: 'Long-term gains', current: '—', tone: 'var(--pos)', footLabel: '—', foot: '—', ...BLANK_GEOM },
      { id: 'irmaa', name: 'Medicare IRMAA', current: '—', tone: 'var(--muted)', footLabel: '—', foot: '—', ...BLANK_GEOM },
      { id: 'ss', name: 'Social Security', current: '—', tone: 'var(--ink)', footLabel: '—', foot: '—', ...BLANK_GEOM },
    ];
  }

  const ord = result.ordinary || {};
  const ltcg = result.ltcg || {};
  const ss = result.socialSecurity || {};
  const irmaa = result.irmaa || {};
  const lad = result.ladders || {};
  const bl = result.baseline || {};
  const taxDollars = result.thresholdTaxDollars || {};
  const ordL = lad.ordinary || [];

  const gOrd = columnGeom(
    'ord',
    ordL.map((b, i) => ({ v: b.upTo, label: pc(ordL[i + 1]?.rate) })),
    floorOf(bl.ordinaryIncome, ord.income),
    (ord.income || 0) - floorOf(bl.ordinaryIncome, ord.income),
    hoverMark,
    m,
    pc,
  );
  const gLtcg = columnGeom(
    'ltcg',
    [
      { v: lad.ltcg?.zeroRateMax, label: pc(lad.ltcg?.rates?.middle) },
      { v: lad.ltcg?.fifteenRateMax, label: pc(lad.ltcg?.rates?.top) },
    ],
    ltcg.stackedOn,
    ltcg.gains,
    hoverMark,
    m,
    pc,
  );
  const gSs = columnGeom(
    'ss',
    [
      { v: lad.socialSecurity?.tier1, label: pc(lad.socialSecurity?.rates?.lowerTier) },
      { v: lad.socialSecurity?.tier2, label: pc(lad.socialSecurity?.rates?.upperTier) },
    ],
    floorOf(bl.provisionalIncome, ss.provisionalIncome),
    (ss.provisionalIncome || 0) - floorOf(bl.provisionalIncome, ss.provisionalIncome),
    hoverMark,
    m,
    pc,
  );
  const irmaaL = Array.isArray(lad.irmaa) ? lad.irmaa : [];
  const gIrmaa = columnGeom(
    'irmaa',
    irmaaL.map((row, index) => ({
      v: row.upTo,
      label: Number.isInteger(irmaaL[index + 1]?.tier)
        ? `Tier ${irmaaL[index + 1].tier}`
        : '',
    })),
    floorOf(irmaa.baselineMagi, irmaa.magi),
    (irmaa.magi || 0) - floorOf(irmaa.baselineMagi, irmaa.magi),
    hoverMark,
    m,
    pc,
  );

  const gold = 'transparent';
  const sage = 'transparent';
  const dim = 'transparent';
  const blank = { fillBg: 'transparent', baseBg: 'transparent', edge: 'transparent', ...BLANK_GEOM };

  return [
    {
      id: 'ord',
      name: 'Income Tax',
      current: m(taxDollars.ordinaryIncomeTax),
      tone: 'var(--ink)',
      footLabel: pc(ord.rate),
      foot: Number.isFinite(ord.roomToNext) ? `${m(ord.roomToNext)} to next` : '—',
      fillBg: gold,
      baseBg: dim,
      edge: 'transparent',
      ...(gOrd || blank),
      value: m(taxDollars.ordinaryIncomeTax),
    },
    {
      id: 'ltcg',
      name: 'Long-term gains',
      current: m(taxDollars.preferentialIncomeTax),
      tone: 'var(--pos)',
      footLabel: Number.isFinite(ltcg.rate ?? lad.ltcg?.rates?.zero)
        ? `Next $ at ${pc(ltcg.rate ?? lad.ltcg.rates.zero)}`
        : '—',
      foot: Number.isFinite(ltcg.roomToZeroCeiling)
        ? `${m(ltcg.roomToZeroCeiling)} to next`
        : '—',
      fillBg: sage,
      baseBg: dim,
      edge: 'transparent',
      ...(gLtcg || blank),
      value: m(taxDollars.preferentialIncomeTax),
    },
    {
      id: 'irmaa',
      name: 'Medicare IRMAA',
      current: m(taxDollars.irmaaPremium),
      tone: 'var(--muted)',
      ...blank,
      footLabel: Number.isFinite(irmaa.incrementalAnnualHouseholdAdjustment)
        ? `${m(irmaa.incrementalAnnualHouseholdAdjustment)} vs baseline`
        : '\u2014',
      foot: Number.isInteger(irmaa.premiumYear)
        ? `${Number.isFinite(irmaa.roomToNext)
          ? `${m(irmaa.roomToNext)} to next`
          : 'Top tier'} · ${irmaa.premiumYear}`
        : '\u2014',
      fillBg: gold,
      baseBg: dim,
      edge: 'transparent',
      ...(gIrmaa || blank),
      value: m(taxDollars.irmaaPremium),
    },
    {
      id: 'ss',
      name: 'Social Security',
      current: m(taxDollars.socialSecurityIncrementalModeledFederalIncomeTax),
      tone: 'var(--ink)',
      footLabel: pc(ss.taxablePct),
      foot: Number.isFinite(ss.roomToNext) ? `${m(ss.roomToNext)} to next` : '—',
      fillBg: gold,
      baseBg: dim,
      edge: 'transparent',
      ...(gSs || blank),
      value: m(taxDollars.socialSecurityIncrementalModeledFederalIncomeTax),
    },
  ];
}
