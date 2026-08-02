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
        bg: hovered || justCrossed
          ? 'rgba(231,222,201,.2)'
          : (v > total ? 'rgba(231,222,201,.3)' : 'rgba(231,222,201,.14)'),
        label: bd[k].label || formatMoney(v),
        chipOpacity: hovered || justCrossed ? 1 : 0,
        chipInk: justCrossed && !hovered ? 'var(--accent-bright)' : 'var(--ink-bright)',
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
  if (!result || result.error) {
    return [
      { id: 'ord', name: 'Income Tax', current: '—', tone: 'var(--ink-bright)', footLabel: 'Room', foot: '—', ...BLANK_GEOM },
      { id: 'ltcg', name: 'Long-term gains', current: '—', tone: 'var(--ok)', footLabel: 'Room', foot: '—', ...BLANK_GEOM },
      { id: 'irmaa', name: 'Medicare IRMAA', current: '—', tone: 'var(--ink-faint)', footLabel: 'None', foot: '—', ...BLANK_GEOM },
      { id: 'ss', name: 'Social Security', current: '—', tone: 'var(--ink-bright)', footLabel: 'Room', foot: '—', ...BLANK_GEOM },
    ];
  }

  const ord = result.ordinary || {};
  const ltcg = result.ltcg || {};
  const ss = result.socialSecurity || {};
  const lad = result.ladders || {};
  const bl = result.baseline || {};
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
      { v: lad.ltcg?.zeroRateMax, label: '15%' },
      { v: lad.ltcg?.fifteenRateMax, label: '20%' },
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
      { v: lad.socialSecurity?.tier1, label: '50%' },
      { v: lad.socialSecurity?.tier2, label: '85%' },
    ],
    floorOf(bl.provisionalIncome, ss.provisionalIncome),
    (ss.provisionalIncome || 0) - floorOf(bl.provisionalIncome, ss.provisionalIncome),
    hoverMark,
    m,
    pc,
  );

  const gold = 'linear-gradient(180deg,rgba(198,166,98,.7),rgba(198,166,98,.3))';
  const sage = 'linear-gradient(180deg,rgba(143,165,126,.75),rgba(143,165,126,.32))';
  const dim = 'linear-gradient(180deg,rgba(198,166,98,.28),rgba(198,166,98,.13))';
  const blank = { fillBg: 'transparent', baseBg: 'transparent', edge: 'transparent', ...BLANK_GEOM };

  return [
    {
      id: 'ord',
      name: 'Income Tax',
      current: pc(ord.rate),
      tone: 'var(--ink-bright)',
      footLabel: 'Room',
      foot: m(ord.roomToNext),
      fillBg: gold,
      baseBg: dim,
      edge: 'rgba(216,192,132,.45)',
      ...(gOrd || blank),
    },
    {
      id: 'ltcg',
      name: 'Long-term gains',
      current: pc(ltcg.rate),
      tone: 'var(--ok)',
      footLabel: 'Room',
      foot: m(ltcg.roomToZeroCeiling),
      fillBg: sage,
      baseBg: dim,
      edge: 'rgba(169,193,154,.45)',
      ...(gLtcg || blank),
    },
    {
      id: 'irmaa',
      name: 'Medicare IRMAA',
      current: '—',
      tone: 'var(--ink-faint)',
      footLabel: 'None',
      foot: '—',
      ...blank,
    },
    {
      id: 'ss',
      name: 'Social Security',
      current: pc(ss.taxablePct),
      tone: 'var(--ink-bright)',
      footLabel: 'Room',
      foot: m(ss.roomToNext),
      fillBg: gold,
      baseBg: dim,
      edge: 'rgba(216,192,132,.45)',
      ...(gSs || blank),
    },
  ];
}
