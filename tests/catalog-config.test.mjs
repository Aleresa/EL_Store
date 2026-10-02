import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchCatalog} from '../public/catalog-config.js';

test('search combines brand, category, name and SKU and excludes unavailable products',()=>{
  const product={id:'one',sku:'GL27P',name:'Стекло для iPhone',group:'GL-27 Privacy',stock:5};
  const catalog={id:'remax',status:'arrived',products:[product,{...product,id:'hidden',hidden:true},{...product,id:'empty',stock:0},{...product,id:'uncategorized',group:''}]};
  assert.equal(searchCatalog([catalog],'  REMAX   privacy ')[0].product.id,'one');
  assert.equal(searchCatalog([catalog],'gl27p iphone').length,1);
  assert.equal(searchCatalog([catalog],'apple').length,0);
  assert.equal(searchCatalog([catalog],' ').length,0);
  assert.equal(searchCatalog([{...catalog,status:'closed'}],'iphone').length,0);
  assert.equal(searchCatalog([{...catalog,id:'retired'}],'iphone').length,0);
});
