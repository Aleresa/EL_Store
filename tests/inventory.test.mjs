import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {Inventory} from '../server/store.mjs';
import {authenticate} from '../server/auth.mjs';
import {NewsletterStore} from '../server/worker.mjs';

const user={id:'123',name:'Иван',username:'ivan'};
const baseCatalog=()=>({
  id:'apple',title:'Apple',brand:'Apple',status:'arrived',stockMode:'live',
  groupingMode:'manual',groups:['Оригинал','Копия'],
  products:[
    {id:'p1',sku:'MM0A3',name:'Кабель Apple',group:'Оригинал',stock:10,price:16000},
    {id:'p2',sku:'COPY-1',name:'Кабель Copy',group:'Копия',stock:2,price:50000}
  ]
});

function fixture(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(query,...args){const stmt=db.prepare(query);if(/^SELECT/i.test(query))return stmt.all(...args);stmt.run(...args);return [];}};
  const txn=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const inv=new Inventory(sql,txn),catalog=baseCatalog();
  inv.importShipment(catalog);
  return {inv,catalog,sql,txn};
}
const request=(key,qty=3)=>({shipmentId:'apple',requestKey:key,lines:[{id:'p1',quantity:qty}],comment:''});
const editInput=(order,lines,extra={})=>({requestKey:crypto.randomUUID(),expectedRevision:order.revision||1,lines,comment:order.comment||'',...extra});

test('order needs no manager, uses server price and deducts stock',()=>{
  const {inv}=fixture();
  const order=inv.placeOrder(user,{...request('one'),managerId:'ignored',total:1,lines:[{id:'p1',quantity:3,price:1}]});
  assert.equal(order.total,48000);
  assert.equal('manager' in order,false);
  assert.equal(inv.catalog()[0].products.find(p=>p.id==='p1').stock,7);
  const notification=JSON.parse(inv.rows('SELECT data FROM outbox')[0].data).text;
  assert.match(notification,/Клиент: Иван @ivan/);
  assert.doesNotMatch(notification,/Менеджер/);
});

test('order retries are idempotent and changed payload is rejected',()=>{
  const {inv}=fixture();
  const first=inv.placeOrder(user,request('same'));
  const repeated=inv.placeOrder(user,request('same'));
  assert.equal(first.id,repeated.id);
  assert.equal(inv.catalog()[0].products.find(p=>p.id==='p1').stock,7);
  assert.throws(()=>inv.placeOrder(user,request('same',4)),/другим содержимым/);
});

test('competing orders cannot oversell stock',async()=>{
  const {inv}=fixture();
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>Promise.resolve().then(()=>inv.placeOrder({id:String(i+1),name:'Buyer'},request('r-'+i,1)))));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,10);
  assert.equal(results.filter(x=>x.status==='rejected').length,10);
  assert.equal(inv.catalog()[0].products.find(p=>p.id==='p1'),undefined);
});

test('live Excel import updates price and stock by SKU and hides missing products',()=>{
  const {inv,catalog}=fixture();
  inv.placeOrder(user,request('reserved',2));
  inv.importShipment({...catalog,products:[
    {...catalog.products[0],stock:20,price:19900},
    {id:'p3',sku:'NEW-1',name:'Новый товар',group:'Копия',stock:5,price:9900}
  ]});
  const publicCatalog=inv.catalog()[0],adminCatalog=inv.catalog(true)[0];
  const p1=publicCatalog.products.find(p=>p.id==='p1');
  assert.equal(p1.stock,20);
  assert.equal(p1.price,19900);
  assert.deepEqual(publicCatalog.products.map(p=>p.id),['p1','p3']);
  const missing=adminCatalog.products.find(p=>p.id==='p2');
  assert.equal(missing.hidden,true);
  assert.equal(missing.stock,0);
});

test('zero-stock and hidden products are not shown or orderable',()=>{
  const {inv,catalog}=fixture();
  inv.importShipment({...catalog,products:[
    {...catalog.products[0],stock:0},
    {...catalog.products[1],stock:2}
  ]});
  assert.deepEqual(inv.catalog()[0].products.map(p=>p.id),['p2']);
  assert.throws(()=>inv.placeOrder(user,request('zero',1)),/свободно/);
  inv.importShipment({...catalog,products:[catalog.products[1]]});
  assert.throws(()=>inv.placeOrder(user,request('hidden',1)),/больше не доступен/);
});

test('editing and cancelling an order restores quantities without manager state',()=>{
  const {inv}=fixture();
  const order=inv.placeOrder(user,request('edit',3));
  const edited=inv.editOrder(user,order.id,editInput(order,[{id:'p1',quantity:2}],{comment:'Изменено'}));
  assert.equal(edited.revision,2);
  assert.equal(edited.total,32000);
  assert.equal(inv.catalog()[0].products.find(p=>p.id==='p1').stock,8);
  const cancelled=inv.changeOrder(user,order.id,'cancelled');
  assert.equal(cancelled.status,'cancelled');
  assert.equal('manager' in cancelled,false);
  assert.equal(inv.catalog()[0].products.find(p=>p.id==='p1').stock,10);
});

test('confirmed orders can only be changed by admin',()=>{
  const {inv}=fixture();
  const order=inv.placeOrder(user,request('confirm'));
  const confirmed=inv.changeOrder(user,order.id,'confirmed',true);
  assert.equal(confirmed.status,'confirmed');
  assert.throws(()=>inv.changeOrder(user,order.id,'cancelled'),/магазином/);
  const cancelled=inv.changeOrder(user,order.id,'cancelled',true);
  assert.equal(cancelled.status,'cancelled');
});

test('legacy stored manager field is stripped from reads and later updates',()=>{
  const {inv}=fixture();
  const order=inv.placeOrder(user,request('legacy'));
  const row=inv.one('SELECT data FROM orders WHERE id=?',order.id);
  const legacy={...JSON.parse(row.data),manager:{id:'old',name:'Old',username:'old'}};
  inv.sql.exec('UPDATE orders SET data=? WHERE id=?',JSON.stringify(legacy),order.id);
  assert.equal('manager' in inv.orders(user)[0],false);
  const changed=inv.editOrder(user,order.id,editInput(order,[{id:'p1',quantity:2}]));
  assert.equal('manager' in changed,false);
  assert.equal('manager' in JSON.parse(inv.one('SELECT data FROM orders WHERE id=?',order.id).data),false);
});

test('catalog validates groups and product data',()=>{
  const {inv,catalog}=fixture();
  assert.throws(()=>inv.importShipment({...catalog,groups:['Оригинал','оригинал']}),/уникальными/);
  assert.throws(()=>inv.importShipment({...catalog,products:[{...catalog.products[0],group:'Нет такой'}]}),/категорию/);
  assert.throws(()=>inv.importShipment({...catalog,products:[{...catalog.products[0],stock:-1}]}),/количество/);
  assert.throws(()=>inv.importShipment({...catalog,products:[{...catalog.products[0],image:'javascript:alert(1)'}]}),/изображение/);
});

function signedData(token,overrides={}){
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:123,first_name:'Иван'}),...overrides});
  const text=[...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  params.set('hash',createHmac('sha256',secret).update(text).digest('hex'));
  return params.toString();
}

test('Telegram signature validates and forged data fails',async()=>{
  const token='test:token',raw=signedData(token);
  assert.equal((await authenticate(raw,token)).id,'123');
  await assert.rejects(authenticate(raw,'other'));
  await assert.rejects(authenticate(raw.replace('123','124'),token));
});

test('worker requires auth, has no manager API, and blocks orders without channel',async()=>{
  const {sql,txn}=fixture(),token='test:worker';let alarm=null;
  const ctx={storage:{sql,transactionSync:txn,getAlarm:async()=>alarm,setAlarm:async value=>alarm=value,deleteAlarm:async()=>alarm=null},waitUntil:()=>{}};
  const store=new NewsletterStore(ctx,{BOT_TOKEN:token,ADMIN_IDS:'999'});
  const headers={'Content-Type':'application/json','X-Telegram-Init-Data':signedData(token)};
  assert.equal((await store.fetch(new Request('https://app/api/catalog'))).status,401);
  assert.equal((await store.fetch(new Request('https://app/api/catalog',{headers}))).status,200);
  assert.equal((await store.fetch(new Request('https://app/api/managers',{headers}))).status,404);
  assert.equal((await store.fetch(new Request('https://app/api/orders',{method:'POST',headers,body:JSON.stringify(request('api'))}))).status,503);
});

test('only admin can configure bot and setup uses the app URL',async t=>{
  const {sql,txn}=fixture(),token='test:setup',env={BOT_TOKEN:token,ADMIN_IDS:'123',MINI_APP_URL:'https://el-store.elereas.workers.dev'};
  const ctx={storage:{sql,transactionSync:txn},waitUntil:()=>{}};
  const store=new NewsletterStore(ctx,env),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:new URL(url).pathname.split('/').pop(),body:JSON.parse(options.body)});return Response.json({ok:true,result:true});});
  const configure=(data=signedData(token))=>new Request('https://app.example/api/admin/setup-bot',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Init-Data':data},body:'{}'});
  assert.equal((await store.fetch(configure(signedData(token,{user:JSON.stringify({id:456,first_name:'Buyer'})})))).status,403);
  const response=await store.fetch(configure());
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,webhookUrl:'https://el-store.elereas.workers.dev/telegram/webhook'});
  assert.deepEqual(calls.map(c=>c.method).sort(),['setChatMenuButton','setMyCommands','setWebhook'].sort());
  assert.equal(calls.find(c=>c.method==='setWebhook').body.url,'https://el-store.elereas.workers.dev/telegram/webhook');
  assert.equal(calls.find(c=>c.method==='setChatMenuButton').body.menu_button.text,'Товары');
});

test('order notification delivery sends no manager line',async t=>{
  const {sql,txn}=fixture(),token='test:delivery';let alarm=null;
  const ctx={storage:{sql,transactionSync:txn,getAlarm:async()=>alarm,setAlarm:async value=>alarm=value,deleteAlarm:async()=>alarm=null},waitUntil:()=>{}};
  const store=new NewsletterStore(ctx,{BOT_TOKEN:token,ORDER_CHAT_ID:'-100123'}),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:new URL(url).pathname.split('/').pop(),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:77}});});
  store.inventory.placeOrder(user,request('delivery',1));
  await store.flush();
  const sent=calls.find(c=>c.method==='sendMessage');
  assert(sent);
  assert.match(sent.body.text,/Новый заказ/);
  assert.doesNotMatch(sent.body.text,/Менеджер/);
});
