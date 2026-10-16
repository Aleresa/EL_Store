import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Inventory} from '../server/store.mjs';
import {parseStockRows} from '../public/stock-rows.js';

function fixture(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(q,...args){const s=db.prepare(q);if(/^SELECT/i.test(q))return s.all(...args);s.run(...args);return [];}};
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
  const inv=new Inventory(sql,transaction);
  inv.importShipment({id:'apple',title:'Apple',brand:'Apple',stockMode:'live',status:'arrived',groupingMode:'manual',groups:['Оригинал','Копия'],products:[
    {id:'p1',sku:'0001',name:'Apple чехол',group:'Оригинал',stock:10,price:16000},
    {id:'not-in-report',sku:'UNTOUCHED',name:'Кабель',group:'Копия',stock:7,price:30000}
  ]});
  inv.importShipment({id:'remax',title:'Remax',brand:'Remax',stockMode:'live',status:'arrived',groupingMode:'manual',groups:['GL-27','GL-27 Privacy','ES-01'],products:[
    {id:'p2',sku:'0001',name:'Remax стекло',group:'GL-27',stock:8,price:50000}
  ]});
  return {inv,sql};
}

test('parser uses Код and Доступно, preserves zero and leading zeroes; category headings are ignored',()=>{
  const report=new Map([
    [1,{0:'Товарный отчёт'}],
    [8,{0:'Код',1:'Артикул',2:'Наименование',3:'Доступно',4:'Остаток'}],
    [9,{0:'1 - Group / Аксессуары',2:'',3:''}],
    [10,{0:'0001',1:'CASE-A',2:'Чехол',3:'0',4:'12'}],
    [11,{0:'UNTOUCHED',2:'Кабель',3:'1 200',4:'2000'}],
    [12,{0:'NO_STOCK',2:'Товар',3:'',4:5}]
  ]);
  const parsed=parseStockRows(report);
  assert.deepEqual(parsed.items,[{sku:'0001',stock:0},{sku:'UNTOUCHED',stock:1200}]);
  assert.equal(parsed.skipped,1);
});

test('conflicting duplicates, invalid counts and missing columns do not result in import',()=>{
  assert.throws(()=>parseStockRows(new Map([[1,{A:'Код',B:'Цена'}]])),/столбцы/);
  assert.throws(()=>parseStockRows(new Map([[1,{A:'Код',B:'Доступно'}],[2,{A:'A',B:2}],[3,{A:'A',B:3}]])),/разными остатками/);
  assert.throws(()=>parseStockRows(new Map([[1,{A:'Код',B:'Доступно'}],[2,{A:'A',B:'-2'}]])),/не найдено корректных/);
});

test('global sync previews without mutations, applies to two brands without creating or changing metadata',()=>{
  const {inv}=fixture();
  const input={items:[{sku:'0001',stock:0},{sku:'missing',stock:15}]};
  const old=JSON.stringify(inv.catalog(true));
  const preview=inv.stockSync(input);
  assert.equal(preview.matched,1);assert.equal(preview.matchedPositions,2);
  assert.equal(preview.changed,2);assert.equal(preview.missing,1);
  assert.equal(JSON.stringify(inv.catalog(true)),old);
  const applied=inv.stockSync(input,true);
  assert.equal(applied.changed,2);
  const catalogs=inv.catalog(true);
  const a=catalogs.find(s=>s.id==='apple'),b=catalogs.find(s=>s.id==='remax');
  assert.equal(a.products.find(p=>p.id==='p1').stock,0);
  assert.equal(b.products.find(p=>p.id==='p2').stock,0);
  assert.equal(a.products.find(p=>p.id==='p1').price,16000);
  assert.equal(a.products.find(p=>p.id==='p1').group,'Оригинал');
  assert.equal(b.products.find(p=>p.id==='p2').price,50000);
  assert.equal(a.products.find(p=>p.id==='not-in-report').stock,7);
  assert.equal(a.products.length,2);assert.equal(b.products.length,1);
  assert.equal(inv.stockSync(input,true).changed,0);
});

test('already placed orders remain in place and imported available stock is not deducted twice',()=>{
  const {inv}=fixture();
  const user={id:'123',name:'Клиент'};
  const placed=inv.placeOrder(user,{shipmentId:'apple',requestKey:'key-1',lines:[{id:'p1',quantity:5}]});
  assert.equal(inv.catalog(true).find(s=>s.id==='apple').products[0].stock,5);
  inv.stockSync({items:[{sku:'0001',stock:2}]},true);
  const updated=inv.catalog(true).find(s=>s.id==='apple').products[0];
  assert.equal(updated.stock,2);assert.equal(updated.total,7);assert.equal(updated.placed,5);
  assert.equal(inv.orders(user)[0].id,placed.id);
  inv.changeOrder(user,placed.id,'cancelled');
  assert.equal(inv.catalog(true).find(s=>s.id==='apple').products[0].stock,7);
});

test('synchronization leaves hidden item hidden, rollback on bad input, and never creates unknown SKU',()=>{
  const {inv,sql}=fixture();
  const row=inv.one('SELECT data FROM products WHERE shipment=? AND id=?','apple','p1');
  sql.exec('UPDATE products SET data=? WHERE shipment=? AND id=?',JSON.stringify({...JSON.parse(row.data),hidden:true}),'apple','p1');
  inv.stockSync({items:[{sku:'0001',stock:30}]},true);
  assert.equal(inv.catalog(true).find(s=>s.id==='apple').products[0].hidden,true);
  const snapshot=JSON.stringify(inv.catalog(true));
  assert.throws(()=>inv.stockSync({items:[{sku:'0001',stock:0},{sku:'X',stock:-1}]},true),/Некорректный/);
  assert.throws(()=>inv.stockSync({items:[{sku:'0001',stock:1},{sku:'0001',stock:3}]},true),/Повтор/);
  assert.throws(()=>inv.stockSync({items:[{sku:'MISSING',stock:5}]},true),/Совпадающих/);
  assert.equal(JSON.stringify(inv.catalog(true)),snapshot);
});
