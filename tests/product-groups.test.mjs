import test from 'node:test';
import assert from 'node:assert/strict';
import {groupProducts,manualProducts} from '../public/product-groups.js';
const products=[{id:'z',name:'Защитное стекло',group:'',image:'photo1'},{id:'a',name:'Провод',group:''},{id:'m',name:'Чехол',group:''}];
test('without assignments there are no named groups and original order is retained',()=>{
  assert.deepEqual(groupProducts(products),[{name:'',products}]);
  assert.deepEqual(groupProducts(products,['Созданная, но пустая']),[{name:'',products}]);
  assert.deepEqual(groupProducts([]),[]);
});
test('manual grouping supports partial assignments without duplicating or losing products',()=>{
  const list=products.map((p,i)=>({...p,group:i===1?'':'Чехлы и стёкла'}));
  const groups=groupProducts(list,['Чехлы и стёкла']);
  assert.deepEqual(groups.map(g=>[g.name,g.products.map(p=>p.id)]),[['Чехлы и стёкла',['z','m']],['',['a']]]);
  assert.equal(groups[0].products[0],list[0]);
});
test('reimport retains only explicit assignments, preserving new file order and leaving new items ungrouped',()=>{
  const previous=products.map(p=>({...p,group:'Вручную'}));
  const imported=manualProducts([products[2],products[0],{id:'new',name:'Кабель'}],['Вручную'],previous);
  assert.deepEqual(imported.map(p=>[p.id,p.group]),[['m','Вручную'],['z','Вручную'],['new','']]);
  assert.equal(imported[1].image,'photo1');
  assert(manualProducts(previous,[]).every(p=>!p.group));
  assert(!('subgroup' in manualProducts([{id:'1',subgroup:'Удалена'}],[])[0]));
});
