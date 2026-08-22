/* -- chart helpers -- */
// Smooth a series of [x,y] points into a path using Catmull-Rom -> bezier.
// Tension kept low so the line stays trackable, not wavy ("toddler-drawn").
// Monotone cubic interpolation (Fritsch-Carlson). Unlike Catmull-Rom it CANNOT
// overshoot the data, so the curve stays smooth without inventing humps/dips
// between points - the difference between a grown-up chart and a wobbly one.
export function monoPath(pts){
  const n=pts.length;
  if(n<2) return '';
  if(n===2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const dx=[], dy=[], m=[];
  for(let i=0;i<n-1;i++){ dx[i]=xs[i+1]-xs[i]; dy[i]=ys[i+1]-ys[i]; m[i]=dy[i]/(dx[i]||1e-9); }
  const t=new Array(n);
  t[0]=m[0]; t[n-1]=m[n-2];
  for(let i=1;i<n-1;i++) t[i] = (m[i-1]*m[i]<=0) ? 0 : (m[i-1]+m[i])/2;
  for(let i=0;i<n-1;i++){
    if(m[i]===0){ t[i]=0; t[i+1]=0; continue; }
    const a=t[i]/m[i], b=t[i+1]/m[i], s=a*a+b*b;
    if(s>9){ const tau=3/Math.sqrt(s); t[i]=tau*a*m[i]; t[i+1]=tau*b*m[i]; }
  }
  let d=`M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for(let i=0;i<n-1;i++){
    const h=dx[i];
    d+=` C ${(xs[i]+h/3).toFixed(1)} ${(ys[i]+t[i]*h/3).toFixed(1)}, ${(xs[i+1]-h/3).toFixed(1)} ${(ys[i+1]-t[i+1]*h/3).toFixed(1)}, ${xs[i+1].toFixed(1)} ${ys[i+1].toFixed(1)}`;
  }
  return d;
}

// Round a raw max up to a clean axis ceiling whose quarter-steps are round
// numbers (so ticks read $2M/$4M/... not $3.4M/$5.1M...).
export function niceCeil(v){
  if(!(v>0)) return 1;
  const step0=v/4, mag=Math.pow(10, Math.floor(Math.log10(step0))), n=step0/mag;
  const niceN = n<=1?1 : n<=2?2 : n<=2.5?2.5 : n<=5?5 : 10;
  return niceN*mag*4;
}

export function smoothPath(pts){
  if(pts.length<2) return '';
  if(pts.length===2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
  let d=`M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[i-1]||pts[i], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||pts[i+1];
    const c1x=p1[0]+(p2[0]-p0[0])/6, c1y=p1[1]+(p2[1]-p0[1])/6;
    const c2x=p2[0]-(p3[0]-p1[0])/6, c2y=p2[1]-(p3[1]-p1[1])/6;
    d+=` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export function axes(W,H,ageStart,ageEnd,maxBal,{ layout, fmtM, grid, axisInk }){
  const { padLeft:padL, padRight:padR, padTop:padT, padBottom:padB } = layout;
  const x0=padL, x1=W-padR, y0=padT, y1=H-padB;
  let g='';
  // Horizontal gridlines - faint rule color so the grid is legible without
  // competing with the data lines. (Was a dark-theme near-black; fixed for the
  // light "paper" theme.)
  for(let i=0;i<=4;i++){const y=y0+(y1-y0)/4*i; g+=`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${grid}"/>`;}
  // y labels (right-aligned in the left gutter)
  for(let i=0;i<=4;i++){const v=maxBal*(1-i/4); const y=y0+(y1-y0)/4*i;
    g+=`<text x="${x0-18}" y="${y+5}" fill="${axisInk}" font-size="13" style="font-family:var(--f)" text-anchor="end">${fmtM(v)}</text>`;}
  // x age ticks
  const span=ageEnd-ageStart;
  const ages=[ageStart];
  for(let age=Math.ceil((ageStart+1)/5)*5; age<ageEnd; age+=5) ages.push(age);
  if(ageEnd!==ageStart) ages.push(ageEnd);
  ages.forEach((age,index)=>{const x=span>0 ? x0+(x1-x0)*(age-ageStart)/span : x0;
    g+=`<text x="${x}" y="${H-12}" fill="${axisInk}" font-size="13" style="font-family:var(--f)" text-anchor="${index===0?'start':index===ages.length-1?'end':'middle'}">Age ${age}</text>`;});
  return g;
}

export function storyChart(rows,{ layout, fmtM }){
  const { width:W, height:H, padLeft:padL, padRight:padR, padTop:padT, padBottom:padB } = layout;
  const real = rows.filter(r => r.source != null);
  if(real.length < 2) return '';
  const hi = Math.max(...real.map(r => Math.max(r.balance, r.startBalance))) * 1.05;
  if(!(hi > 0)) return '';
  const x = i => padL + (W-padL-padR) * i / (real.length-1);
  const y = v => padT + (H-padT-padB) * (1 - v/hi);
  const pts = real.map((r,i) => [x(i), y(r.balance)]);
  let g = '';
  for(const f of [0,.5,1]){
    const gy = padT + (H-padT-padB)*f;
    g += `<line x1="${padL}" y1="${gy}" x2="${W-padR}" y2="${gy}" stroke="var(--rule-f)"/>`;
    g += `<text x="${padL-8}" y="${gy+4}" fill="var(--muted)" font-size="14" style="font-family:var(--f)" text-anchor="end">${fmtM(hi*(1-f))}</text>`;
  }
  const y0 = y(real[0].startBalance);
  g += `<line x1="${padL}" y1="${y0}" x2="${W-padR}" y2="${y0}" stroke="var(--muted)" stroke-dasharray="3 6"/>`;
  const a0 = real[0].age, a1 = real[real.length-1].age;
  for(let a = Math.ceil(a0/5)*5; a <= a1; a += 5){
    const ax = x(Math.round((a-a0)/(a1-a0)*(real.length-1)));
    g += `<text x="${ax}" y="${H-8}" fill="var(--muted)" font-size="14" style="font-family:var(--f)" text-anchor="middle">${a===Math.ceil(a0/5)*5?'Age '+a:a}</text>`;
  }
  const d = smoothPath(pts);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Balance path">
    ${g}
    <path d="${d} L ${pts[pts.length-1][0].toFixed(1)} ${H-padB} L ${padL} ${H-padB} Z" fill="var(--ink)" fill-opacity="0.05"/>
    <path d="${d}" fill="none" stroke="var(--acc)" stroke-width="2.2"/>
    <circle cx="${pts[pts.length-1][0].toFixed(1)}" cy="${pts[pts.length-1][1].toFixed(1)}" r="4.5" fill="var(--acc)"/>
  </svg>`;
}

export function seqChartSvg(runs, retAge,{ width:W, height:H, layout, fmtM, grid, axisInk }){
  // All lines share the retirement-entry balance (same plan), then diverge purely
  // by the market they retired into. Full width = the retirement years.
  const entry=runs[0].res.rows[0].startBalance||0;
  const series=res=>[entry, ...res.rows.map(x=>x.balance)];
  const all=runs.map(r=>series(r.res));
  const n=Math.max(...all.map(a=>a.length));
  const ageStart=retAge, ageEnd=retAge+n-1;
  // Decision-zone cap: for sequence risk the readable region is the entry balance
  // DOWN to zero (will the money last?). A kind market can compound well above
  // that and flatten the downside into an unreadable band. So cap the axis a bit
  // above the entry balance; any line that climbs past it rises off the top
  // (clipped) with its true ending still in its card. When nothing exceeds the
  // ceiling (e.g. all-stress markets) we use the real max, so no space is wasted.
  // Decision-zone ceiling (entry -> 0 is the readable region for sequence risk).
  // Fit everything when it stays under ~2.2x entry; only a true runaway gets
  // capped - and then values are CLAMPED to the ceiling so the line rides the top
  // cleanly instead of fragmenting in and out of view. Axis rounded to nice ticks.
  const realMax=Math.max(...all.map(a=>Math.max(...a)));
  const ceiling=entry>0 ? entry*2.2 : realMax;
  const maxBal=niceCeil(Math.min(realMax, ceiling));
  const { padLeft:padL, padRight:padR, padTop:padT, padBottom:padB } = layout;
  const x0=padL, x1=W-padR, y0=padT, y1=H-padB;
  const X=idx=> x0+(x1-x0)*(idx/(Math.max(1,n-1)));
  const Y=v => y1-(Math.min(Math.max(0,v),maxBal)/maxBal)*(y1-y0);
  let h=axes(W,H,ageStart,ageEnd,maxBal,{ layout, fmtM, grid, axisInk });
  h+=`<defs><clipPath id="seqclip"><rect x="${x0}" y="${y0-2}" width="${x1-x0}" height="${y1-y0+2}"/></clipPath></defs><g clip-path="url(#seqclip)">`;
  // Per line: a paper-colored HALO underneath, then the colored line on top. The
  // halo knocks out the lines below at every crossing, so the crowded middle
  // reads cleanly and the top line is unambiguous. Monotone curve = no overshoot.
  // A depleted line STOPS at $0 (no crawl along the floor) - the x marks the end.
  const ends=[];
  runs.forEach((r,i)=>{
    const full=all[i];
    const dep=r.res.depletionAge!=null;
    let ei=full.length-1;
    if(dep){ const k=full.findIndex((v,idx)=>idx>0 && v<=0.01); if(k>0) ei=k; }
    const col=r.m.c;
    const d=monoPath(full.slice(0,ei+1).map((v,k)=>[X(k),Y(v)]));
    h+=`<path d="${d}" fill="none" stroke="var(--panel)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    h+=`<path d="${d}" fill="none" stroke="${col}" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round"/>`;
    ends.push({c:col, y:r.m.y, dep, px:X(ei), py:Y(full[ei])});
  });
  // Shared launch node - one plan, all markets start here, then diverge.
  h+=`<circle cx="${X(0).toFixed(1)}" cy="${Y(entry).toFixed(1)}" r="2.2" fill="var(--panel)" stroke="${axisInk}" stroke-width="1.1"/>`;
  h+=`</g>`;
  // Endpoint treatment (outside the clip so labels are never cut): a x where a
  // line runs dry, a dot where it survives - each tagged with its market year so
  // the eye never has to leave the chart for the legend.
  // Markers first: x where a line runs dry, a dot where it survives.
  ends.forEach(e=>{
    if(e.dep){
      const s=2.8;
      h+=`<path d="M ${(e.px-s).toFixed(1)} ${(e.py-s).toFixed(1)} L ${(e.px+s).toFixed(1)} ${(e.py+s).toFixed(1)} M ${(e.px-s).toFixed(1)} ${(e.py+s).toFixed(1)} L ${(e.px+s).toFixed(1)} ${(e.py-s).toFixed(1)}" stroke="${e.c}" stroke-width="1.4" stroke-linecap="round"/>`;
    } else {
      h+=`<circle cx="${e.px.toFixed(1)}" cy="${e.py.toFixed(1)}" r="2.2" fill="${e.c}" stroke="var(--panel)" stroke-width="1.1"/>`;
    }
  });
  // No year labels on the lines - the chip row above the chart and the fingerprint
  // cards below already say which color is which market. Adding a year on each
  // line just adds visual noise that has to be de-collided every redraw.
  return h;
}
