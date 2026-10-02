import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cartEntry,readCart,reconcileCart,repeatCart} from '../public/cart.js';
import {phoneModels,sortProducts} from '../public/catalog-tools.js';
const apple={id:'apple',status:'arrived',products:[{id:'same',sku:'A',name:'Кабель',group:'Оригинал',stock:2,price:100}]};
const remax={id:'remax',status:'arrived',products:[{id:'same',sku:'R',name:'Стекло iPhone 15 Pro',group:'GL-27',stock:5,price:200}]};

test('restored cart validates data, keeps same ID across brands, reconciles price, stock and removal',()=>{
  const cart=readCart({a:cartEntry('apple',{...apple.products[0],price:80},4),r:cartEntry('remax',remax.products[0],3),bad:{shipmentId:'apple',id:'bad',quantity:-1}});
  assert.equal(Object.keys(cart).length,2);
  const checked=reconcileCart(cart,[apple,remax]);
  assert.equal(checked.cart['apple:same'].quantity,2);assert.equal(checked.cart['apple:same'].price,100);
  assert.equal(checked.cart['remax:same'].quantity,3);assert.equal(checked.changes.length,2);
  const removed=reconcileCart(cart,[apple,{...remax,status:'closed'}]);assert.equal(removed.cart['remax:same'],undefined);
  assert.deepEqual(readCart('broken'),{});
});

test('repeat merges into existing cart at current prices, caps stock and explains missing products',()=>{
  const result=repeatCart({'apple:same':cartEntry('apple',apple.products[0],1)}, {shipmentId:'mixed',lines:[{...remax.products[0],shipmentId:'remax',quantity:8,price:50},{...apple.products[0],shipmentId:'apple',quantity:1},{id:'gone',sku:'G',name:'Удалённый',shipmentId:'apple',price:1,quantity:1}]},[apple,remax]);
  assert.equal(result.cart['apple:same'].quantity,2);assert.equal(result.cart['remax:same'].quantity,5);
  assert.equal(result.cart['remax:same'].price,200);assert.equal(Object.keys(result.cart).length,2);
  assert.equal(result.changes.length,3);
});

test('phone filters distinguish base, Pro and Pro Max and parse explicit multi-model compatibility',()=>{
  assert.deepEqual(phoneModels('Стекло iPhone 15 Pro Max'),['iPhone 15 Pro Max']);
  assert.deepEqual(phoneModels('Стекло для iPhone 12/12 Pro, 13 mini'),['iPhone 12','iPhone 12 Pro','iPhone 13 Mini']);
  assert.deepEqual(phoneModels('GL-27 Privacy IP 16e'),['iPhone 16e']);
  assert.deepEqual(phoneModels('iPhone SE 2022 / iPhone XR'),['iPhone SE 2022','iPhone XR']);
  assert.deepEqual(phoneModels('Стекло iPhone XS Max'),['iPhone XS Max']);
  assert.deepEqual(phoneModels('Стекло GL-27 9H 15 шт 200 руб'),[]);
});

test('sort by price, name and first-added date without modifying the catalog',()=>{
  const items=[{id:'a',name:'Б',price:200,position:0,addedAt:'2020-01-01'},{id:'b',name:'А',price:100,position:1,addedAt:'2026-10-01'}];
  assert.deepEqual(sortProducts(items,'price-asc').map(p=>p.id),['b','a']);
  assert.deepEqual(sortProducts(items,'price-desc').map(p=>p.id),['a','b']);
  assert.deepEqual(sortProducts(items,'name').map(p=>p.id),['b','a']);
  assert.deepEqual(sortProducts(items,'new').map(p=>p.id),['b','a']);
  assert.equal(items[0].id,'a');
});
