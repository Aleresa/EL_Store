// Browser smoke test for EL Store: Brand -> Category -> Products.
import {chromium} from 'playwright';
import JSZip from 'jszip';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {NewsletterStore} from '../server/worker.mjs';

const token='local-test-only',db=new DatabaseSync(':memory:');
const sql={exec(q,...args){const stmt=db.prepare(q);if(/^SELECT/i.test(q))return stmt.all(...args);stmt.run(...args);return [];}};
let alarm=null;
const ctx={storage:{sql,getAlarm:async()=>alarm,setAlarm:async value=>alarm=value,deleteAlarm:async()=>alarm=null,transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}},waitUntil:()=>{}};
const store=new NewsletterStore(ctx,{BOT_TOKEN:token,ADMIN_IDS:'123',ORDER_CHAT_ID:'test-only',MINI_APP_URL:'https://el-store.elereas.workers.dev'});
store.flush=async()=>{};
store.syncMenu=async()=>{};

const source=JSON.parse(await readFile('public/data/catalog.json','utf8'));
for(const catalog of source.shipments)store.inventory.importShipment({...catalog,status:'arrived',publishedAt:'2026-10-01'});

const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:123,first_name:'Test'})});
const check=[...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
params.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));
const initData=params.toString(),root=resolve('public');

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/')){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await store.fetch(new Request('http://localhost:4174'+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    const pathname=new URL(req.url,'http://localhost').pathname;
    const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!path.startsWith(root+sep))throw Error('invalid path');
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)];
    res.writeHead(200,{'Content-Type':type||'application/octet-stream'});res.end(await readFile(path));
  }catch{res.writeHead(500);res.end('Test server error');}
});

function supplierXlsx(rows){
  const zip=new JSZip();
  zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Catalog" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${row.map((value,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({type:'nodebuffer'});
}

await new Promise(resolve=>server.listen(4174,'127.0.0.1',resolve));
await mkdir('test-results',{recursive:true});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{}),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:`window.Telegram={WebApp:{initData:${JSON.stringify(initData)},ready(){},expand(){},isVersionAtLeast(){return false},BackButton:{show(){},hide(){},onClick(){}}}};`}));

  await page.goto('http://localhost:4174');
  await page.waitForSelector('.brand-card');
  assert.equal(await page.locator('.brand-card').count(),2);
  assert.deepEqual(await page.locator('.brand-name').allTextContents(),['Apple','Remax']);
  assert.equal(await page.locator('[data-view="shipments"]').textContent(),'Товары');
  assert.equal(await page.locator('#admin-tab').textContent(),'Управление');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.fonts.check('16px Inter')),true);
  assert.equal(await page.locator('.brand-visual').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(199, 179, 240)');
  assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).color),'rgb(45, 41, 51)');
  const brandBoxes=await page.locator('.brand-card').evaluateAll(elements=>elements.map(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})));
  assert.equal(brandBoxes[0].y,brandBoxes[1].y);assert(brandBoxes[1].x>brandBoxes[0].x);
  await page.screenshot({path:'test-results/store-mobile-home.png',fullPage:true});
  await page.locator('#catalog-search').fill('remax privacy');
  await page.waitForFunction(()=>document.querySelectorAll('[data-search-result]').length===1);
  assert.match(await page.locator('#search-results').textContent(),/GL-27 Privacy/);
  await page.locator('#refresh').click();
  assert.equal(await page.locator('#catalog-search').inputValue(),'remax privacy');
  await page.locator('[data-search-result]').click();
  await page.waitForSelector('[data-product="GL27P-DEMO"]');
  await page.locator('#back').click();await page.locator('#back').click();
  assert.equal(await page.locator('#catalog-search').inputValue(),'remax privacy');
  await page.locator('#catalog-search').fill('MM0A3');
  await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent.includes('Оригинальный кабель'));
  assert.equal(await page.locator('[data-search-result]').count(),1);
  await page.locator('#catalog-search').fill('нет-такого-товара');
  await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent.includes('Ничего не найдено'));
  await page.locator('#catalog-search').fill('');
  await page.waitForSelector('#search-results',{state:'hidden'});

  // Apple -> Оригинал / Копия -> products.
  await page.locator('[data-brand="apple"]').click();
  await page.waitForSelector('.category-card');
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['Оригинал','Копия']);
  await page.locator('[data-category="Оригинал"]').click();
  await page.waitForSelector('[data-product="MM0A3"]');
  assert.equal(await page.locator('[data-product]').count(),1);
  assert.equal(await page.locator('#product-search').count(),1);
  assert(await page.locator('.category-heading').evaluate(el=>el.getBoundingClientRect().height)<110);
  assert.equal(await page.locator('.arrow').count(),0);

  // Checkout has no manager selector.
  await page.locator('[data-step="1"][data-id="MM0A3"]').click();
  await page.locator('#open-cart').click();await page.waitForSelector('#dialog[open] #submit-placeOrder');
  assert.equal(await page.locator('#placeOrder-manager').count(),0);
  assert.equal(await page.locator('#submit-placeOrder').isDisabled(),false);
  await page.locator('#submit-placeOrder').click();
  await page.waitForSelector('.order');
  const order=store.inventory.orders({id:'123'})[0];
  assert.equal('manager' in order,false);
  assert.equal(order.lines[0].id,'MM0A3');

  // Admin contains no manager controls and shows canonical category names.
  await page.locator('#admin-tab').click();
  assert.equal(await page.locator('#managers').count(),0);
  const adminText=await page.locator('.admin-panel').textContent();
  for(const name of ['Оригинал','Копия','GL-27','GL-27 Privacy','ES-01'])assert(adminText.includes(name));

  // Update Apple from Excel. Existing SKU keeps category, new SKU requires a fixed category.
  await page.locator('[data-brand-import="apple"]').click();
  const rows=[
    ['Наименование','Код','Доступно','Цена продажи'],
    ['Оригинальный кабель Lightning to USB-C 1 м','MM0A3','20','950'],
    ['Новый Apple кабель','APP-NEW','5','500']
  ];
  await page.locator('#xlsx-file').setInputFiles({name:'Apple.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await supplierXlsx(rows)});
  await page.waitForSelector('[data-product-category="MM0A3"]');
  assert.equal(await page.locator('[data-product-category="MM0A3"]').inputValue(),'Оригинал');
  assert.equal(await page.locator('[data-product-category="APP-NEW"]').inputValue(),'');
  await page.locator('[data-product-category="APP-NEW"]').selectOption('Копия');
  if(await page.locator('#accept-warnings').count())await page.locator('#accept-warnings').check();
  await page.locator('#save-shipment').click();
  await page.waitForSelector('#shipment-form',{state:'hidden'});

  const apple=store.inventory.catalog(true).find(c=>c.id==='apple');
  assert.equal(apple.products.find(p=>p.id==='MM0A3').price,95000);
  assert.equal(apple.products.find(p=>p.id==='MM0A3').group,'Оригинал');
  assert.equal(apple.products.find(p=>p.id==='APP-NEW').group,'Копия');
  assert.equal(apple.products.find(p=>p.id==='APPLE-COPY-1').hidden,true);

  // Remax fixed categories.
  await page.locator('[data-view="shipments"]').click();
  await page.locator('[data-brand="remax"]').click();
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['GL-27','GL-27 Privacy','ES-01']);
  await page.locator('[data-category="GL-27 Privacy"]').click();
  await page.waitForSelector('[data-product="GL27P-DEMO"]');

  // Return to the two-brand home on narrow and desktop screens.
  await page.screenshot({path:'test-results/store-mobile-products.png',fullPage:true});
  await page.locator('#back').click();
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['GL-27','GL-27 Privacy','ES-01']);
  await page.locator('#back').click();
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const desktopBoxes=await page.locator('.brand-card').evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().y));
  assert.equal(desktopBoxes[0],desktopBoxes[1]);
  await page.screenshot({path:'test-results/store-desktop-home.png',fullPage:true});

  // All five customer improvements, with two brands deliberately sharing a product ID.
  const remaxProducts=[
    {id:'MM0A3',sku:'RM-SAME',name:'Стекло iPhone 15',group:'GL-27',stock:5,price:30000,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGioAAAAASUVORK5CYII='},
    {id:'PRO',sku:'RM-PRO',name:'Стекло iPhone 15 Pro',group:'GL-27',stock:4,price:40000},
    {id:'MAX',sku:'RM-MAX',name:'Стекло iPhone 15 Pro Max',group:'GL-27',stock:3,price:50000}
  ];
  const remaxCatalog={id:'remax',title:'Remax',status:'arrived',stockMode:'live',groupingMode:'manual',groups:['GL-27'],products:remaxProducts};
  store.inventory.importShipment(remaxCatalog);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#refresh').click();
  await page.locator('[data-brand="apple"]').click();await page.locator('[data-category="Оригинал"]').click();
  await page.locator('[data-step="1"][data-id="MM0A3"]').click();
  await page.locator('[data-step="1"][data-id="MM0A3"]').click();
  await page.locator('#back').click();await page.locator('#back').click();
  assert.match(await page.locator('#open-cart').textContent(),/2 шт/);
  await page.locator('[data-brand="remax"]').click();await page.locator('[data-category="GL-27"]').click();
  await page.locator('#product-sort').selectOption('price-desc');
  assert.deepEqual(await page.locator('[data-product]').evaluateAll(els=>els.map(el=>el.dataset.product)),['MAX','PRO','MM0A3']);
  await page.locator('#product-sort').selectOption('price-asc');
  assert.equal(await page.locator('[data-product]').first().getAttribute('data-product'),'MM0A3');
  await page.locator('#product-sort').selectOption('name');
  await page.locator('#phone-model').selectOption('iPhone 15');
  assert.equal(await page.locator('[data-product]').count(),1);
  assert.equal(await page.locator('[data-enlarge="MM0A3"] img').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.locator('[data-enlarge="MM0A3"]').click();await page.waitForSelector('#photo-dialog[open]');
  await page.waitForFunction(()=>document.querySelector('#photo-dialog>img')?.naturalWidth===1);
  await page.keyboard.press('Escape');await page.waitForSelector('#photo-dialog',{state:'hidden'});
  await page.locator('[data-step="1"][data-id="MM0A3"]').click();
  await page.screenshot({path:'test-results/store-new-filters.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#open-cart').click();await page.waitForSelector('#dialog[open] #submit-placeOrder');
  assert.equal(await page.locator('[data-cart-qty]').count(),2);
  await page.locator('[data-cart-qty="remax:MM0A3"]').fill('2');await page.locator('[data-cart-qty="remax:MM0A3"]').press('Tab');
  await page.locator('#comment').fill('Сохранённая корзина');
  await page.reload();await page.waitForSelector('#open-cart');
  assert.match(await page.locator('#open-cart').textContent(),/4 шт/);
  const currentApple=store.inventory.catalog(true).find(s=>s.id==='apple');
  store.inventory.importShipment({...currentApple,products:currentApple.products.filter(p=>!p.hidden).map(p=>p.id==='MM0A3'?{...p,stock:1,price:99000}:p)});
  await page.locator('#open-cart').click();await page.waitForSelector('#dialog[open] #submit-placeOrder');
  assert.equal(await page.locator('#comment').inputValue(),'Сохранённая корзина');
  assert.equal(await page.locator('[data-cart-qty="apple:MM0A3"]').inputValue(),'1');
  assert.match(await page.locator('#dialog .warning').textContent(),/цена изменилась/);
  await page.screenshot({path:'test-results/store-shared-cart.png',fullPage:true});

  // Simulate a response lost AFTER the server committed the order, then reload the app.
  const orderCount=store.inventory.orders({id:'123'}).length;
  let lost=false;
  await page.route('**/api/orders',async route=>{
    if(route.request().method()==='POST'&&!lost){lost=true;await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тест: ответ потерян'})});}
    else await route.continue();
  });
  await page.locator('#submit-placeOrder').click();await page.waitForFunction(()=>document.querySelector('#submit-placeOrder')?.textContent==='Проверить отправку');
  assert.equal(store.inventory.orders({id:'123'}).length,orderCount+1);
  await page.reload();await page.waitForSelector('#open-cart');await page.locator('#open-cart').click();await page.waitForSelector('#dialog[open] #submit-placeOrder');
  assert.equal(await page.locator('#comment').isDisabled(),true);
  await page.locator('#submit-placeOrder').click();await page.waitForSelector('.order');
  assert.equal(store.inventory.orders({id:'123'}).length,orderCount+1);
  const mixed=store.inventory.orders({id:'123'})[0];
  assert.equal(mixed.shipmentId,'mixed');assert.equal(mixed.lines.length,2);assert.equal(mixed.total,159000);
  assert.equal(await page.locator('#cart-bar').isVisible(),false);
  await page.locator(`[data-edit-order="${mixed.id}"]`).click();
  await page.locator('[data-edit-qty="remax:MM0A3"]').fill('1');await page.locator('#save-order').click();
  await page.waitForSelector('#edit-order-form',{state:'hidden'});
  assert.equal(store.inventory.orders({id:'123'})[0].lines.find(l=>l.shipmentId==='remax').quantity,1);

  // Repeat uses current prices and stock, explains removals and never submits automatically.
  store.inventory.importShipment({...remaxCatalog,products:remaxProducts.map(p=>p.id==='MM0A3'?{...p,stock:1,price:35000}:p)});
  await page.locator(`[data-repeat-order="${mixed.id}"]`).click();
  await page.waitForSelector('[data-cart-qty="remax:MM0A3"]');
  assert.equal(await page.locator('[data-cart-qty]').count(),1);
  assert.match(await page.locator('#dialog .warning').textContent(),/недоступен/);
  assert.match(await page.locator('#dialog .warning').textContent(),/цена изменилась/);
  assert.equal(store.inventory.orders({id:'123'}).length,orderCount+1);
  await page.locator('[data-cart-remove="remax:MM0A3"]').click();
  assert.equal(await page.locator('#submit-placeOrder').isDisabled(),true);
  await page.locator('#close-dialog').click();
  await page.locator(`[data-cancel="${mixed.id}"]`).click();await page.locator('#confirm-action').click();
  await page.waitForSelector(`[data-cancel="${mixed.id}"]`,{state:'hidden'});
  assert.equal(store.inventory.orders({id:'123'}).some(o=>o.id===mixed.id),false);

  // Admin diagnostics exposes a useful error and retries the existing queue.
  store.checkNotifications=async()=>({...store.notificationStatus(),botUsername:'E_NewSletters_Bot',check:{ok:false,message:'Нет права публикации в канале.'}});
  await page.locator('#admin-tab').click();await page.locator('#notification-settings').click();
  await page.waitForSelector('#notification-details');
  assert.match(await page.locator('#notification-details').textContent(),/Нет права публикации/);
  store.flush=async()=>{store.inventory.sql.exec('UPDATE outbox SET sent=1 WHERE sent=0');};
  await page.locator('#retry-notifications').click();
  await page.waitForFunction(()=>document.querySelector('#retry-notifications')?.textContent==='Отправить ожидающие'&&document.querySelector('#retry-notifications')?.disabled);
  assert.match(await page.locator('#notification-details').textContent(),/Ожидают отправки: 0/);
  await page.locator('#close-dialog').click();

  // Create a third brand entirely through the admin UI, including cover and Excel.
  await page.locator('#add-brand').click();
  await page.locator('#brand-name').fill('Baseus');
  await page.locator('#brand-categories').fill('Кабели\nЗарядки');
  const coverData=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=40;const ctx=c.getContext('2d');ctx.fillStyle='#ffdd00';ctx.fillRect(0,0,40,40);return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#brand-cover-file').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from(coverData,'base64')});
  await page.waitForSelector('.brand-cover-preview');
  await page.locator('[data-category-cover="0"]').setInputFiles({name:'category.png',mimeType:'image/png',buffer:Buffer.from(coverData,'base64')});
  await page.waitForSelector('[data-category-preview="0"] img');
  await page.locator('#save-brand').click();
  await page.waitForSelector('#xlsx-file');
  const customBrand=store.inventory.brands(true).find(b=>b.name==='Baseus');
  assert(customBrand);assert.equal(customBrand.hidden,true);
  await page.locator('#xlsx-file').setInputFiles({name:'Baseus.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await supplierXlsx([['Наименование','Код','Доступно','Цена продажи'],['Кабель Baseus USB-C','BS1','6','300']])});
  await page.waitForSelector('[data-product-category="BS1"]');await page.locator('[data-product-category="BS1"]').selectOption('Кабели');
  if(await page.locator('#accept-warnings').count())await page.locator('#accept-warnings').check();
  assert.equal(await page.locator('#publish-brand').isChecked(),true);
  await page.locator('#save-shipment').click();await page.waitForSelector('#shipment-form',{state:'hidden'});
  await page.locator('[data-view="shipments"]').click();
  assert.equal(await page.locator('.brand-card').count(),3);
  const customCard=page.locator(`[data-brand="${customBrand.id}"]`);
  assert.equal(await customCard.locator('.brand-cover').count(),1);
  assert.equal(await customCard.locator('.brand-visual').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.screenshot({path:'test-results/store-custom-brand-home.png',fullPage:true});
  await page.locator('#catalog-search').fill('Baseus');await page.waitForSelector('[data-search-result]');
  assert.equal(await page.locator('[data-search-result]').count(),1);await page.locator('[data-search-result]').click();
  await page.locator('[data-step="1"][data-id="BS1"]').click();
  await page.reload();await page.waitForSelector('#open-cart');await page.locator('#open-cart').click();
  await page.waitForSelector('#dialog[open] #submit-placeOrder');
  assert.equal(await page.locator(`[data-cart-qty="${customBrand.id}:BS1"]`).inputValue(),'1');
  await page.locator('#submit-placeOrder').click();await page.waitForSelector('.order');
  const customOrder=store.inventory.orders({id:'123'})[0];assert.equal(customOrder.shipmentTitle,'Baseus');

  // Hiding and renaming retain inventory and order history; showing again restores the card.
  await page.locator('#admin-tab').click();await page.locator(`[data-brand-edit="${customBrand.id}"]`).click();
  await page.locator('#brand-name').fill('Baseus Pro');await page.locator('#brand-visible').uncheck();
  await page.locator('#brand-categories').fill('Кабели\nЗарядки\nАккумуляторы');
  await page.locator('#save-brand').click();await page.waitForSelector('#brand-form',{state:'hidden'});
  await page.locator('[data-view="shipments"]').click();assert.equal(await page.locator('.brand-card').count(),2);
  await page.locator('#catalog-search').fill('Baseus');await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent.includes('Ничего не найдено'));
  assert.equal(store.inventory.orders({id:'123'})[0].shipmentTitle,'Baseus');
  assert.equal(store.inventory.catalog(true).find(s=>s.id===customBrand.id).products[0].stock,5);
  await page.locator('#admin-tab').click();await page.locator(`[data-brand-edit="${customBrand.id}"]`).click();
  assert.equal(await page.locator('#brand-visible').isChecked(),false);await page.locator('#brand-visible').check();
  await page.locator('#save-brand').click();await page.waitForSelector('#brand-form',{state:'hidden'});
  await page.locator('[data-view="shipments"]').click();assert.equal(await page.locator('.brand-card').count(),3);
  await page.locator(`[data-brand="${customBrand.id}"]`).click();
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['Кабели','Зарядки','Аккумуляторы']);
  assert.equal(await page.locator('[data-category="Кабели"] .category-cover').count(),1);
  assert.equal(await page.locator('[data-category="Зарядки"] .category-cover').count(),0);
  await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  // Webviews without WebP encoders silently return PNG, which can exceed the API limit.
  const fallbackImage=await page.evaluate(async()=>{
    const {compressProductImage}=await import('/xlsx.js');
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(320,320);let seed=123;
    for(let i=0;i<pixels.data.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+c]=seed>>>24;}pixels.data[i+3]=255;}
    ctx.putImageData(pixels,0,0);
    const original=HTMLCanvasElement.prototype.toDataURL,source=canvas.toDataURL('image/png');
    const bytes=await (await fetch(source)).arrayBuffer();
    HTMLCanvasElement.prototype.toDataURL=function(type,quality){return original.call(this,type==='image/webp'?'image/png':type,quality);};
    try{return {sourceLength:source.length,image:await compressProductImage(bytes)};}
    finally{HTMLCanvasElement.prototype.toDataURL=original;}
  });
  assert.ok(fallbackImage.sourceLength>180000);
  assert.match(fallbackImage.image,/^data:image\/jpeg;base64,/);assert.ok(fallbackImage.image.length<=180000);
  store.inventory.importShipment({id:customBrand.id,title:'Baseus Pro',status:'arrived',stockMode:'live',groupingMode:'manual',products:[{id:'image-check',name:'Photo',price:100,stock:1,group:'Кабели',image:fallbackImage.image}]});

  await page.locator('#admin-tab').click();
  await page.locator('[data-brand-import="apple"]').click();
  await page.locator('#import-category').selectOption('Копия');
  const originalsBefore=store.inventory.catalog(true).find(s=>s.id==='apple').products.filter(p=>p.group==='Оригинал');
  await page.locator('#xlsx-file').setInputFiles({name:'copies.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await supplierXlsx([['Наименование','Код','Доступно','Цена продажи'],['Кабель копия','COPY-NEW','8','100']])});
  await page.waitForFunction(()=>!document.querySelector('#save-shipment').disabled);
  assert.equal(await page.locator('[data-product-category]').inputValue(),'Копия');
  assert.equal(await page.locator('[data-product-category]').isDisabled(),true);
  if(await page.locator('#accept-warnings').count())await page.locator('#accept-warnings').check();
  await page.locator('#save-shipment').click();await page.waitForSelector('#shipment-form',{state:'hidden'});
  const appleAfter=store.inventory.catalog(true).find(s=>s.id==='apple');
  assert.deepEqual(appleAfter.products.filter(p=>p.group==='Оригинал'),originalsBefore);
  assert.equal(appleAfter.products.find(p=>p.sku==='COPY-NEW').group,'Копия');

  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: shared persistent cart, cross-brand order/edit/cancel, lost-response recovery, price/stock reconciliation, photo viewer, repeat order, sorting/model filters, responsive layout and Excel import.');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
