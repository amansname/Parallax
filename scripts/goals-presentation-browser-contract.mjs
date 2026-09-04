import assert from 'node:assert/strict';
import { join } from 'node:path';
import { selectHouseholdVisible, waitForWizard } from './wizard-browser-contract.mjs';

const goalName = 'Goals precision check';

async function clickUnique(page, selector){
  await page.waitForSelector(selector, { visible:true });
  assert.equal(await page.$$eval(selector, nodes => nodes.length),1,selector);
  await page.click(selector);
}

async function typeAmount(page, value){
  await clickUnique(page,'.gh-amount-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(value));
}

async function timeline(page){
  return page.evaluate(() => [...document.querySelectorAll('.gh-lane')].map(lane => {
    const band=lane.querySelector('.gh-band');
    const label=lane.querySelector('.gh-chip__name');
    const amount=lane.querySelector('.gh-chip__amount');
    return {
      id:lane.dataset.goalLane,
      name:label.textContent,
      amount:amount.textContent,
      color:getComputedStyle(lane).getPropertyValue('--goal-color').trim(),
      shadow:band ? getComputedStyle(band).boxShadow : null,
      animation:band ? getComputedStyle(band).animationName : null,
      icon:lane.querySelector('.gh-chip__icon img').src,
      laneHeight:lane.getBoundingClientRect().height,
      font:getComputedStyle(label).fontSize,
      expectedFont:getComputedStyle(label).getPropertyValue('--fs-body').trim(),
      amountFont:getComputedStyle(amount).fontSize,
      expectedAmountFont:getComputedStyle(amount).getPropertyValue('--fs-caption').trim(),
    };
  }));
}

async function checkGlows(page, rows, failures, phase){
  const bands=rows.filter(row => row.shadow !== null);
  assert.ok(bands.length >= 2,'fixture must include multiple recurring goals');
  for(const row of bands){
    // Read the actual SVG stroke, independently of the lane's category token.
    const stroke=await page.evaluate(async url => {
      const response=await fetch(url);
      if(!response.ok) throw new Error(`goal icon unavailable: ${response.status}`);
      return new DOMParser().parseFromString(await response.text(),'image/svg+xml')
        .documentElement.getAttribute('stroke');
    },row.icon);
    assert.equal(row.color.toLowerCase(),stroke.toLowerCase(),`${phase}: ${row.name} icon/category`);
    const expected=[1,3,5].map(offset => parseInt(stroke.slice(offset,offset+2),16)/255);
    const actual=row.shadow.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+) \/ ([\d.]+)\)/);
    if(!actual || !expected.every((value,index) => Math.abs(value-Number(actual[index+1])) < 0.00001)
        || Number(actual[4]) <= 0 || Number(actual[4]) > 0.25){
      failures.push(`${phase}: ${row.name} lacks its faint icon-colored glow: ${row.shadow}`);
    }
    assert.equal(row.animation,'none',`${phase}: persistent glow must not animate away`);
    assert.equal(row.laneHeight,62,`${phase}: lane spacing remains unchanged`);
    assert.equal(row.font,row.expectedFont,`${phase}: canonical goal-name typography`);
    assert.equal(row.amountFont,row.expectedAmountFont,`${phase}: canonical amount typography`);
  }
}

/** Real input -> saved annual amount -> reload -> exact label and persistent glow. */
export async function runGoalsPresentationContract(page,{householdId,outDir}={}){
  const failures=[];
  const initial=await timeline(page);
  assert.ok(initial.some(row => row.name === 'Essentials'),'Essentials fixture is required');
  assert.ok(initial.some(row => row.name === 'Healthcare'),'Healthcare fixture is required');
  await checkGlows(page,initial,failures,'initial load');
  await page.waitForSelector('.gh-starter',{visible:true});
  assert.equal(await page.$eval('.gh-add-toggle',node => node.getAttribute('aria-expanded')),'true');
  assert.equal(await page.$$eval('[data-goal-rail]',nodes => nodes.length),0);
  assert.deepEqual(await page.$$eval('.gh-starter',nodes => nodes.map(node => node.dataset.addCategory)),
    ['travel','home','vehicle','education','family','giving','health','custom']);
  await clickUnique(page,'.gh-starter[data-add-category="travel"]');
  await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count,
    {timeout:10000},initial.length+1);
  await clickUnique(page,'.gh-name-input');
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type(goalName);
  await clickUnique(page,'[data-action="per-month"]');
  await page.waitForFunction(() => document.querySelector('[data-action="per-month"]')?.classList.contains('is-selected'));
  await typeAmount(page,2500);
  await page.waitForFunction(({id,name}) => {
    const saved=JSON.parse(localStorage.getItem('parallax.households.v1') || '{}')[id];
    const goal=saved?.goals?.find(item => item.name === name);
    return goal?.amount === 30000 && goal.per === 'mo';
  },{timeout:10000},{id:householdId,name:goalName});
  const goalId=await page.$eval('.gh-rail',node => node.dataset.goalRail);
  const selector=`[data-goal-chip="${goalId}"]`;
  const checkAmount=async (label,phase) => {
    const actual=await page.$eval(`${selector} .gh-chip__amount`,node => node.textContent);
    if(actual !== label) failures.push(`${phase}: expected ${label}, got ${actual}`);
  };
  await checkAmount('$2.5k / mo','typed monthly amount');
  await clickUnique(page,'[data-action="per-year"]');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '30,000');
  await checkAmount('$30k / yr','annual cadence');
  await clickUnique(page,'[data-action="per-month"]');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '2,500');
  await page.waitForFunction(({id,goalId}) => {
    const goal=JSON.parse(localStorage.getItem('parallax.households.v1') || '{}')[id]?.goals?.find(item => item.id === goalId);
    return goal?.amount === 30000 && goal.per === 'mo';
  },{timeout:10000},{id:householdId,goalId});
  const savedGoal=await page.evaluate(({id,goalId}) =>
    JSON.parse(localStorage.getItem('parallax.households.v1'))[id].goals.find(item => item.id === goalId),
  {id:householdId,goalId});
  await page.reload({waitUntil:'domcontentloaded'});
  await waitForWizard(page,{householdId:'joe-household'});
  await selectHouseholdVisible(page,householdId);
  await clickUnique(page,'.htab[data-sub-target="goals"]');
  await page.waitForSelector(selector,{visible:true});
  await checkAmount('$2.5k / mo','saved household reload');
  const reloadedGoal=await page.evaluate(({id,goalId}) =>
    JSON.parse(localStorage.getItem('parallax.households.v1'))[id].goals.find(item => item.id === goalId),
  {id:householdId,goalId});
  assert.deepEqual(reloadedGoal,savedGoal,'reload retains every saved goal field');
  await clickUnique(page,selector);
  await page.waitForFunction(id => document.querySelector('.gh-rail')?.dataset.goalRail === id,{},goalId);
  assert.equal(await page.$eval('.gh-amount-input',node => node.value),'2,500');
  const selected=await timeline(page);
  assert.deepEqual(selected.map(row => row.name),[...initial.map(row => row.name),goalName]);
  assert.deepEqual(selected.slice(0,-1).map(({id,name,amount})=>({id,name,amount})),
    initial.map(({id,name,amount})=>({id,name,amount})),'existing goals and labels stay unchanged by input/reload');
  await checkGlows(page,selected,failures,'different goal selected');
  await clickUnique(page,'[data-action="done"]');
  await page.waitForSelector('.gh-rail',{hidden:true});
  await checkGlows(page,await timeline(page),failures,'editor closed');
  assert.equal(await page.$$eval('#gl-ledger,.glx-row,.glc-card,.ga-board,.gh-title',nodes=>nodes.length),0);
  const viewport=page.viewport();
  for(const width of [1440,390]){
    await page.setViewport({width,height:1000});
    await page.evaluate(() => document.fonts.ready);
    await checkGlows(page,await timeline(page),failures,`${width}px viewport`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth-document.documentElement.clientWidth <= 2),
      `${width}px viewport: no horizontal overflow`);
    if(outDir) await page.screenshot({path:join(outDir,`goals-presentation-${width}.png`),fullPage:true});
  }
  await page.setViewport(viewport);
  assert.deepEqual(failures,[],`Goals presentation regressions:\n${failures.join('\n')}`);
}
