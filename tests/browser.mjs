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
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:`window.Telegram={WebApp:{initData:${JSON.stringify(initData)},ready(){},expand(){},isVersionAtLeast(){return false},BackButton:{show(){},hide(){},onClick(){}}}};`}));

  await page.goto('http://localhost:4174');
  await page.waitForSelector('.brand-card');
  assert.equal(await page.locator('.brand-card').count(),3);
  assert.deepEqual(await page.locator('.brand-name').allTextContents(),['Apple','Remax','Gurdini']);
  assert.equal(await page.locator('[data-view="shipments"]').textContent(),'Товары');
  assert.equal(await page.locator('#admin-tab').textContent(),'Управление');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  // Apple -> Оригинал / Копия -> products.
  await page.locator('[data-brand="apple"]').click();
  await page.waitForSelector('.category-card');
  assert.deepEqual(await page.locator('[data-category]').allTextContents(),['Оригинал10 товаров→','Копия8 товаров→'].map(()=>null).filter(Boolean));
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['Оригинал','Копия']);
  await page.locator('[data-category="Оригинал"]').click();
  await page.waitForSelector('[data-product="MM0A3"]');
  assert.equal(await page.locator('[data-product]').count(),1);
  assert.equal(await page.locator('#product-search').count(),1);

  // Checkout has no manager selector.
  await page.locator('[data-step="1"][data-id="MM0A3"]').click();
  await page.locator('#open-cart').click();
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
  for(const name of ['Оригинал','Копия','GL-27','GL-27 Privacy','ES-01','Стекла','Чехлы','Аккумуляторы'])assert(adminText.includes(name));

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

  // Back to categories, then brands, then Gurdini.
  await page.locator('#back').click();
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['GL-27','GL-27 Privacy','ES-01']);
  await page.locator('#back').click();
  await page.locator('[data-brand="gurdini"]').click();
  assert.deepEqual(await page.locator('[data-category] strong').allTextContents(),['Стекла','Чехлы','Аккумуляторы']);
  await page.locator('[data-category="Чехлы"]').click();
  await page.waitForSelector('[data-product="G-CASE"]');

  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'test-results/store-categories.png',fullPage:true});

  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: brand categories, product drill-down, checkout without managers, Excel category assignment.');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
