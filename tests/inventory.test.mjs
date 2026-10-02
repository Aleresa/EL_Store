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
  assert.throws(()=>inv.importShipment({...catalog,products:[{...catalog.products[0],image:'javascript:alert(1)'}]}),/неверный формат фотографии/);
  assert.throws(()=>inv.importShipment({...catalog,products:[{...catalog.products[0],image:'data:image/png;base64,'+'A'.repeat(180000)}]}),/фотография слишком большая/);
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
  assert.equal(calls.find(c=>c.method==='setChatMenuButton').body.menu_button.text,'Сделать Заказ');
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


test('removed catalogs cannot be imported or ordered while existing orders remain cancellable',()=>{
  const {inv,catalog,sql}=fixture();
  const order=inv.placeOrder(user,request('before-removal'));
  sql.exec('UPDATE shipments SET id=?,data=? WHERE id=?','retired',JSON.stringify({...catalog,id:'retired'}),'apple');
  sql.exec('UPDATE products SET shipment=? WHERE shipment=?','retired','apple');
  sql.exec('UPDATE orders SET shipment=?,data=? WHERE id=?','retired',JSON.stringify({...order,shipmentId:'retired'}),order.id);
  assert.deepEqual(inv.catalog(),[]);
  assert.deepEqual(inv.catalog(true),[]);
  assert.throws(()=>inv.importShipment({...catalog,id:'retired'}),/создайте бренд/);
  assert.throws(()=>inv.placeOrder(user,{...request('after-removal'),shipmentId:'retired'}),/закрыты/);
  assert.equal(inv.orders(user)[0].id,order.id);
  inv.changeOrder(user,order.id,'cancelled',false,1);
  assert.equal(inv.orders(user,true)[0].status,'cancelled');
  assert.equal(inv.one('SELECT placed FROM products WHERE shipment=? AND id=?','retired','p1').placed,0);
});

function mixedFixture(){
  const f=fixture();
  f.inv.importShipment({id:'remax',title:'Remax',status:'arrived',stockMode:'live',groupingMode:'manual',groups:['GL-27'],products:[{id:'p1',sku:'RM-1',name:'Стекло iPhone 15',group:'GL-27',stock:5,price:20000}]});
  return f;
}
const mixedRequest=key=>({requestKey:key,lines:[{shipmentId:'apple',id:'p1',quantity:2,expectedPrice:16000},{shipmentId:'remax',id:'p1',quantity:3,expectedPrice:20000}]});
const stock=(inv,brand,id)=>inv.catalog(true).find(s=>s.id===brand).products.find(p=>p.id===id).stock;

test('one mixed order deducts both brands, retries safely, edits and cancels independently with identical IDs',()=>{
  const {inv}=mixedFixture(),input=mixedRequest('mixed');
  const order=inv.placeOrder(user,input);
  assert.equal(order.shipmentId,'mixed');assert.equal(order.shipmentTitle,'Apple + Remax');assert.equal(order.total,92000);
  assert.equal(stock(inv,'apple','p1'),8);assert.equal(stock(inv,'remax','p1'),2);
  assert.equal(inv.placeOrder(user,input).id,order.id);assert.equal(inv.orders(user).length,1);
  const edit=editInput(order,[{shipmentId:'apple',id:'p1',quantity:1},{shipmentId:'remax',id:'p1',quantity:4}]);
  const edited=inv.editOrder(user,order.id,edit);
  assert.equal(stock(inv,'apple','p1'),9);assert.equal(stock(inv,'remax','p1'),1);
  assert.equal(inv.editOrder(user,order.id,edit).revision,edited.revision);
  inv.changeOrder(user,order.id,'cancelled');assert.equal(stock(inv,'apple','p1'),10);assert.equal(stock(inv,'remax','p1'),5);
  assert.equal(inv.orders(user).length,0);
});

test('mixed checkout rolls back all stock and notification writes on stale price, stock, or closed brand',()=>{
  for(const kind of ['stock','price','closed']){
    const {inv}=mixedFixture(),input=mixedRequest('failed');
    if(kind==='stock')input.lines[1].quantity=6;
    if(kind==='price')input.lines[1].expectedPrice=1;
    if(kind==='closed'){
      const catalog=inv.catalog(true).find(s=>s.id==='remax');inv.importShipment({...catalog,status:'closed'});
    }
    assert.throws(()=>inv.placeOrder(user,input),error=>error.status===409);
    assert.equal(stock(inv,'apple','p1'),10);assert.equal(stock(inv,'remax','p1'),5);
    assert.equal(inv.orders(user).length,0);assert.equal(inv.rows('SELECT * FROM outbox').length,0);
  }
});

test('mixed edits reject stale revisions and unavailable new stock without partial changes, preserve prices, allow removal of a brand',()=>{
  const {inv}=mixedFixture(),order=inv.placeOrder(user,mixedRequest('edit-mixed'));
  const apple=inv.catalog(true).find(s=>s.id==='apple');inv.importShipment({...apple,products:apple.products.map(p=>({...p,price:99999}))});
  const originalStock=stock(inv,'apple','p1');
  assert.throws(()=>inv.editOrder(user,order.id,editInput(order,[{shipmentId:'apple',id:'p1',quantity:1},{shipmentId:'remax',id:'p1',quantity:6}])),error=>error.status===409);
  assert.equal(stock(inv,'apple','p1'),originalStock);
  const edited=inv.editOrder(user,order.id,editInput(order,[{shipmentId:'apple',id:'p1',quantity:1}]));
  assert.equal(edited.shipmentId,'apple');assert.equal(edited.total,16000);assert.equal(stock(inv,'remax','p1'),5);
  assert.throws(()=>inv.editOrder(user,order.id,editInput(order,[{shipmentId:'apple',id:'p1',quantity:2}])),/уже изменён/);
});

test('mixed explicit and legacy lines deduct the correct catalog and duplicate composite IDs are rejected',()=>{
  const {inv}=mixedFixture(),input={...mixedRequest('hybrid'),shipmentId:'apple'};delete input.lines[0].shipmentId;
  inv.placeOrder(user,input);assert.equal(stock(inv,'apple','p1'),8);assert.equal(stock(inv,'remax','p1'),2);
  const duplicate=mixedRequest('duplicate');duplicate.lines.push(duplicate.lines[0]);
  assert.throws(()=>inv.placeOrder(user,duplicate),/повтор/);
});

test('newness survives reimport and reappearance; newly added SKUs get their first-seen date',()=>{
  const {inv,catalog,sql}=fixture();
  const old=JSON.parse(inv.one('SELECT data FROM products WHERE shipment=? AND id=?','apple','p1').data);
  sql.exec('UPDATE products SET data=? WHERE shipment=? AND id=?',JSON.stringify({...old,addedAt:'2020-01-01T00:00:00Z'}),'apple','p1');
  inv.importShipment({...catalog,products:[catalog.products[1]]});
  inv.importShipment({...catalog,products:[...catalog.products,{id:'new',name:'Новинка',group:'Копия',stock:1,price:1}]});
  const products=inv.catalog()[0].products;
  assert.equal(products.find(p=>p.id==='p1').addedAt,'2020-01-01T00:00:00Z');
  assert(Date.parse(products.find(p=>p.id==='new').addedAt)>Date.parse('2020-01-01'));
});

function notificationFixture(env={}){
  const {sql,txn}=fixture();let alarm=null;
  const ctx={storage:{sql,transactionSync:txn,getAlarm:async()=>alarm,setAlarm:async value=>alarm=value,deleteAlarm:async()=>alarm=null},waitUntil:()=>{}};
  const store=new NewsletterStore(ctx,{BOT_TOKEN:'test:notifications',ORDER_CHAT_ID:' -100123 ',BOT_USERNAME:'E_NewSletters_Bot',ADMIN_IDS:'123',...env});
  return {store,ctx,alarm:()=>alarm};
}
test('Telegram error is retained for admin and queued order is delivered on retry without creating another message',async t=>{
  const {store,alarm}=notificationFixture(),calls=[];let permitted=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    return permitted?Response.json({ok:true,result:{message_id:77}}):Response.json({ok:false,error_code:403,description:'Forbidden: bot is not a member of the channel chat'},{status:403});
  });
  store.inventory.placeOrder(user,request('pending',1));await store.flush();
  const failure=store.notificationStatus();
  assert.equal(failure.pending,1);assert.equal(failure.lastError.code,403);assert.match(failure.lastError.message,/право/);assert(alarm());
  assert.equal(calls[0].chat_id,'-100123');
  permitted=true;await store.flush();
  assert.equal(store.notificationStatus().pending,0);assert.equal(store.notificationStatus().lastError,null);assert(store.notificationStatus().lastSuccess);
  const sentCalls=calls.length;await store.flush();assert.equal(calls.length,sentCalls);
});
test('channel diagnostics check actual publishing rights and never send a test message',async t=>{
  const {store}=notificationFixture(),methods=[];let permitted=false;
  t.mock.method(globalThis,'fetch',async(url)=>{
    const method=new URL(url).pathname.split('/').pop();methods.push(method);
    const result=method==='getMe'?{id:7,username:'E_NewSletters_Bot'}:method==='getChat'?{id:-100123,title:'Рабочий канал',type:'channel'}:{status:'administrator',can_post_messages:permitted};
    return Response.json({ok:true,result});
  });
  assert.equal((await store.checkNotifications()).check.ok,false);
  permitted=true;const result=await store.checkNotifications();assert.equal(result.check.ok,true);assert.equal(result.channel.title,'Рабочий канал');
  assert(!methods.includes('sendMessage'));
  const invalid=notificationFixture({ORDER_CHAT_ID:'https://t.me/+invite'}).store;
  assert.match((await invalid.checkNotifications()).check.message,/Пригласительная ссылка/);
});
test('notification diagnostics and retry are admin-only',async()=>{
  const {store}=notificationFixture();
  for(const [path,method] of [['/api/admin/notifications','GET'],['/api/admin/notifications/check','POST'],['/api/admin/notifications/retry','POST']]){
    const headers={'Content-Type':'application/json','X-Telegram-Init-Data':signedData('test:notifications',{user:JSON.stringify({id:456,first_name:'Buyer'})})};
    const response=await store.fetch(new Request('https://app'+path,{method,headers,...(method==='POST'?{body:'{}'}:{})}));
    assert.equal(response.status,403);
  }
});
test('menu update changes global and private-chat buttons without touching the webhook',async t=>{
  const {store}=notificationFixture(),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:new URL(url).pathname.split('/').pop(),body:JSON.parse(options.body)});return Response.json({ok:true,result:true});});
  await store.syncMenu('123');await store.syncMenu('123');
  assert.equal(calls.length,2);assert(calls.every(c=>c.method==='setChatMenuButton'&&c.body.menu_button.text==='Сделать Заказ'));
  assert.equal(calls[1].body.chat_id,'123');
});

test('invalid saved Telegram message ID is replaced and the rest of the notification queue drains',async t=>{
  const {store}=notificationFixture(),calls=[];let nextMessageId=200;
  const orders=Array.from({length:7},(_,i)=>store.inventory.placeOrder(user,request('stale-message-'+i,1)));
  store.inventory.sql.exec('INSERT INTO order_messages(order_id,target,part,message_id,text) VALUES(?,?,?,?,?)',orders[0].id,'-100123',0,77,'Previous order text');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=new URL(url).pathname.split('/').pop(),body=JSON.parse(options.body);calls.push({method,body});
    if(method==='editMessageText'&&body.message_id===77)return Response.json({ok:false,error_code:400,description:'Bad Request: MESSAGE_ID_INVALID'},{status:400});
    return Response.json({ok:true,result:{message_id:method==='sendMessage'?++nextMessageId:body.message_id}});
  });
  await store.flush();
  assert.equal(store.notificationStatus().pending,0);
  assert.equal(store.notificationStatus().lastError,null);
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,7);
  const replacement=store.inventory.one('SELECT message_id FROM order_messages WHERE order_id=?',orders[0].id).message_id;
  assert.equal(replacement,201);
  const sentCount=calls.length;await store.flush();assert.equal(calls.length,sentCount);
  store.inventory.editOrder(user,orders[0].id,editInput(orders[0],[{id:'p1',quantity:1}],{comment:'Обновлённый заказ'}));
  await store.flush();
  assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,replacement);
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,7);
});

test('failed replacement delivery retains the queued order for a later retry',async t=>{
  const {store,alarm}=notificationFixture();let available=false;
  const order=store.inventory.placeOrder(user,request('replacement-retry',1));
  store.inventory.sql.exec('INSERT INTO order_messages(order_id,target,part,message_id,text) VALUES(?,?,?,?,?)',order.id,'-100123',0,77,'Previous order text');
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(new URL(url).pathname.endsWith('/editMessageText'))return Response.json({ok:false,error_code:400,description:'Bad Request: MESSAGE_ID_INVALID'},{status:400});
    return available?Response.json({ok:true,result:{message_id:202}}):Response.json({ok:false,error_code:503,description:'Service Unavailable'},{status:503});
  });
  await store.flush();assert.equal(store.notificationStatus().pending,1);assert(alarm());
  assert.equal(store.notificationStatus().lastError.code,503);
  available=true;await store.flush();assert.equal(store.notificationStatus().pending,0);
  assert.equal(store.inventory.one('SELECT message_id FROM order_messages WHERE order_id=?',order.id).message_id,202);
});

test('custom brand can be created, published, ordered, renamed and hidden without losing history',()=>{
  const {inv,sql,txn}=fixture();
  const brand=inv.saveBrand({name:'Baseus',categories:['Кабели','Зарядки'],cover:null,hidden:true});
  assert(!inv.brands().some(b=>b.id===brand.id));
  const input={id:brand.id,title:'Baseus',status:'arrived',stockMode:'live',groupingMode:'manual',groups:brand.categories,products:[{id:'p1',sku:'BS-1',name:'Кабель Baseus',group:'Кабели',stock:5,price:30000}],publishBrand:true,expectedBrandRevision:brand.revision};
  inv.importShipment(input);
  assert(inv.brands().some(b=>b.id===brand.id));
  const order=inv.placeOrder(user,{requestKey:'custom-brand',lines:[{shipmentId:brand.id,id:'p1',quantity:2,expectedPrice:30000},{shipmentId:'apple',id:'p1',quantity:1,expectedPrice:16000}]});
  assert.equal(order.total,76000);assert.equal(stock(inv,brand.id,'p1'),3);
  const current=inv.brand(brand.id);
  const hidden=inv.saveBrand({...current,name:'Baseus Pro',hidden:true,expectedRevision:current.revision},brand.id);
  assert(!inv.catalog().some(s=>s.id===brand.id));assert(!inv.brands().some(b=>b.id===brand.id));
  assert(inv.catalog(true).some(s=>s.id===brand.id));
  assert.throws(()=>inv.placeOrder(user,{requestKey:'hidden-brand',lines:[{shipmentId:brand.id,id:'p1',quantity:1}]}),/закрыты/);
  assert.equal(inv.orders(user)[0].shipmentTitle,'Apple + Baseus');
  inv.changeOrder(user,order.id,'cancelled');assert.equal(stock(inv,brand.id,'p1'),5);
  const restarted=new Inventory(sql,txn);assert.equal(restarted.brand(brand.id).hidden,true);
  restarted.saveBrand({...hidden,hidden:false,expectedRevision:hidden.revision},brand.id);
  assert.equal(restarted.catalog().find(s=>s.id===brand.id).title,'Baseus Pro');
});

test('brand settings reject duplicate names, invalid covers, stale changes and removal of occupied categories',()=>{
  const {inv}=fixture(),apple=inv.brand('apple');
  assert.throws(()=>inv.saveBrand({name:' apple ',categories:['Товары'],cover:null,hidden:true}),/уже существует/);
  assert.throws(()=>inv.saveBrand({name:'Brand',categories:['Товары','товары'],cover:null,hidden:true}),/уникальных/);
  assert.throws(()=>inv.saveBrand({name:'Brand',categories:['Товары'],cover:'https://example.com/image.png',hidden:true}),/Обложка/);
  assert.throws(()=>inv.saveBrand({...apple,categories:['Копия'],expectedRevision:apple.revision},apple.id),/есть товары/);
  const changed=inv.saveBrand({...apple,categories:[...apple.categories,'Адаптеры'],expectedRevision:apple.revision},apple.id);
  assert.throws(()=>inv.saveBrand({...apple,expectedRevision:apple.revision},apple.id),/уже изменён/);
  assert.deepEqual(inv.catalog()[0].groups,changed.categories);
  assert.equal(stock(inv,'apple','p1'),10);
});

test('stale Excel cannot undo visibility or category changes made in brand settings',()=>{
  const {inv,catalog}=fixture(),brand=inv.brand('apple');
  inv.saveBrand({...brand,hidden:true,expectedRevision:brand.revision},brand.id);
  assert.throws(()=>inv.importShipment({...catalog,publishBrand:true,expectedBrandRevision:brand.revision}),/изменились/);
  assert.equal(inv.brand('apple').hidden,true);assert.equal(stock(inv,'apple','p1'),10);
});

test('creating and changing brands requires administrator authentication',async()=>{
  const {store}=notificationFixture();
  const headers={'Content-Type':'application/json','X-Telegram-Init-Data':signedData('test:notifications',{user:JSON.stringify({id:456,first_name:'Buyer'})})};
  for(const [path,method] of [['/api/admin/brands','POST'],['/api/admin/brands/apple','PATCH']]){
    const response=await store.fetch(new Request('https://app'+path,{method,headers,body:JSON.stringify({name:'Forged',categories:['Category'],hidden:false,cover:null,expectedRevision:1})}));
    assert.equal(response.status,403);
  }
  assert.equal(store.inventory.brands(true).length,2);
});
