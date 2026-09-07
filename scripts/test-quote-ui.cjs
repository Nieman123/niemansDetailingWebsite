const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 const errors = [];
 const setup = async (width=390, reducedMotion='no-preference', fakeClock=true) => {
  const context = await browser.newContext({ viewport: {width, height:844}, reducedMotion });
  const page = await context.newPage();
  if (fakeClock) await page.clock.install();
  page.on('pageerror', e => errors.push(e.message));
  let requests=[], addons=[], failSave=false, failSubmit=false;
  await context.route('**/*', async route => {
   const url = new URL(route.request().url());
   if (url.hostname !== '127.0.0.1') return route.abort();
   if(url.pathname === '/thank-you') return route.fulfill({contentType:'text/html',body:fs.readFileSync('public/thank-you.html','utf8')});
   if(url.pathname === '/api/createLead') {
    requests.push(route.request().postDataJSON());
    if(failSubmit) { failSubmit=false; return route.fulfill({status:500,json:{ok:false}}); }
    return route.fulfill({json:{ok:true,id:'testlead123',update_token:'a'.repeat(64)}});
   }
   if(url.pathname === '/api/leadOptions') {
    const body=route.request().postDataJSON();
    if(body.action==='save') {
     if(failSave) {failSave=false; return route.fulfill({status:500,json:{ok:false}});}
     addons=body.addons;
    }
    return route.fulfill({json:{ok:true,vehicle:'sedan',service:'full',addons,quoted_total:300+addons.reduce((s,k)=>s+({wax:25,pethair:30,soiled:40,headlights:75}[k]),0),addon_prices:{wax:25,pethair:30,soiled:40,headlights:75}}});
   }
   return route.continue();
  });
  await page.goto('http://127.0.0.1:5173/quote.html');
  return {page,context,requests, failSave:()=>failSave=true, failSubmit:()=>failSubmit=true};
 };
 const choose = async page => { await page.locator('[data-value="sedan"]').click(); await page.locator('[data-value="full"]').click(); };
 const overflow = async page => assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'horizontal overflow');
 for (const width of [320,390,768,1280]) {
  const {page,context}=await setup(width);
  await overflow(page);
  await page.clock.runFor(500);
  await page.screenshot({animations:'disabled',path:`/tmp/quote-vehicle-${width}.png`});
  await page.locator('[data-value="sedan"]').click();
  assert.equal(await page.locator('[data-service-price="full"]').innerText(),'Starting at $300');
  await overflow(page);
  await page.clock.runFor(500);
  await page.screenshot({animations:'disabled',path:`/tmp/quote-package-${width}.png`});
  await page.locator('[data-value="full"]').click();
  assert.equal(await page.locator('#step-count').innerText(),'Step 3 of 3');
  assert.equal(await page.locator('#step-3 [data-addon]').count(),0);
  await overflow(page);
  await page.clock.runFor(500);
  await page.screenshot({animations:'disabled',path:`/tmp/quote-contact-${width}.png`});
  await context.close();
 }
 const main=await setup();
 await choose(main.page);
 await main.page.locator('#quote-action-primary').click();
 assert(await main.page.locator('#name-error').isVisible());
 await main.page.locator('#name').fill('Local test');
 await main.page.locator('#phone').fill('8285550123');
 main.failSubmit();
 await main.page.locator('#quote-action-primary').click();
 await main.page.locator('#submit-error').waitFor({state:'visible'});
 await main.page.locator('#quote-action-primary').click();
 await main.page.waitForURL('**/thank-you*');
 await main.page.locator('#addon-section').waitFor({state:'visible'});
 assert.equal(main.requests.length,2);
 assert.equal(main.requests[0].update_token,main.requests[1].update_token);
 assert.deepEqual(main.requests[1].addons,[]);
 assert.equal(await main.page.evaluate(()=>JSON.parse(localStorage.getItem('quoteState')).phone),'');
 assert.equal(await main.page.evaluate(()=>location.hash),'');
 await main.page.locator('[data-addon="wax"]').click();
 main.failSave();
 await main.page.locator('#save-addons').click();
 await main.page.waitForFunction(()=>document.querySelector('#addon-status').textContent.includes('didn’t save'));
 await main.page.locator('#save-addons').click();
 await main.page.waitForFunction(()=>document.querySelector('#addon-status').textContent.startsWith('Saved'));
 assert((await main.page.locator('#saved-quote').innerText()).includes('$325'));
 await main.page.reload();
 await main.page.locator('#addon-section').waitFor({state:'visible'});
 assert.equal(await main.page.locator('[data-addon="wax"]').getAttribute('aria-pressed'),'true');
 await main.page.evaluate(()=>scrollTo(0,0));
 await main.page.clock.runFor(500);
 await main.page.screenshot({animations:'disabled',path:'/tmp/quote-thanks-390.png'});
 await main.context.close();
 const idle=await setup();

 await idle.page.clock.fastForward(31000);
 assert.equal(await idle.page.locator('#exit-sheet').getAttribute('open'),null, 'No reminder before price selection');
 await choose(idle.page);
 await idle.page.locator('#name').focus();
 await idle.page.clock.fastForward(31000);
 assert.equal(await idle.page.locator('#exit-sheet').getAttribute('open'),null, 'No reminder while typing');
 await idle.page.locator('#step3-label').focus();
 await idle.page.clock.fastForward(31000);
 assert(await idle.page.locator('#exit-sheet').isVisible());
 await idle.page.clock.runFor(500);
 await idle.page.screenshot({animations:'disabled',path:'/tmp/quote-exit-390.png'});
 const closeSize=await idle.page.locator('#exit-close').boundingBox();
 assert(closeSize.width>=44 && closeSize.height>=44);
 assert((await idle.page.locator('#exit-phone').boundingBox()).width >= 150, 'Phone field must stay usable');
 await idle.page.locator('#exit-submit').click();
 assert(await idle.page.locator('#exit-error').isVisible());
 await idle.page.locator('#exit-phone').fill('8285550123');
 await idle.page.locator('#exit-submit').click();
 await idle.page.clock.runFor(1000);
 await idle.page.waitForURL('**/thank-you*');
 assert.equal(idle.requests[0].capture_method,'exit_intent');
 assert.equal(idle.requests[0].name,'');
 await idle.context.close();
 const scroll=await setup(390, 'no-preference', false);
 await choose(scroll.page);

 await scroll.page.waitForTimeout(1600);
 await scroll.page.evaluate(()=>scrollTo(0,900));
 await scroll.page.waitForTimeout(100);
 await scroll.page.evaluate(()=>scrollTo(0,650));
 await scroll.page.waitForTimeout(100);
 assert(await scroll.page.locator('#exit-sheet').isVisible(),'rapid upward scroll trigger');
 await scroll.page.locator('#exit-close').click();
 await scroll.page.reload();
 await scroll.page.waitForTimeout(1600);
 await scroll.page.evaluate(()=>scrollTo(0,900));
 await scroll.page.waitForTimeout(100);
 await scroll.page.evaluate(()=>scrollTo(0,650));
 await scroll.page.waitForTimeout(100);
 assert.equal(await scroll.page.locator('#exit-sheet').getAttribute('open'),null,'only once per session');
 await scroll.context.close();
 const reduced=await setup(390,'reduce'); await choose(reduced.page);
 assert.equal(await reduced.page.locator('#progress').evaluate(e=>getComputedStyle(e).animationName),'none');
 await reduced.context.close();
 const absent=await setup(); await absent.page.goto('http://127.0.0.1:5173/thank-you');
 assert((await absent.page.locator('#thanks-message').innerText()).includes('choose your vehicle'));
 await absent.context.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: mobile/tablet/desktop layout, 3-step flow, validation, failed-submit retry, receipt reload, add-on save failure/retry, idle suppression, phone-only capture, rapid scroll, dismissal, reduced motion, missing receipt; no browser errors.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
