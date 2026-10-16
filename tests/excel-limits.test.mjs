import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_EXCEL_BYTES,MAX_UNPACKED_XLSX_BYTES,validateExcelFile} from '../public/excel-limits.js';
import {readSupplierExcel} from '../public/xlsx.js';
import {readStockExcel} from '../public/stock-sync.js';

test('both Excel paths accept the maximum size of 100 MiB before parsing',async()=>{
  assert.equal(MAX_EXCEL_BYTES,100*1024*1024);
  const file={name:'report.xls',size:MAX_EXCEL_BYTES,
    async arrayBuffer(){throw Error('read requested');}};
  validateExcelFile(file);
  await assert.rejects(readSupplierExcel(file),/read requested/);
  await assert.rejects(readStockExcel(file),/read requested/);
});

test('both import paths reject Excel larger than 100 MiB without reading it',async()=>{
  let reads=0;
  const file={name:'report.xlsx',size:MAX_EXCEL_BYTES+1,
    async arrayBuffer(){reads++;throw Error('should not read');}};
  await assert.rejects(readSupplierExcel(file),/100 МБ/);
  await assert.rejects(readStockExcel(file),/100 МБ/);
  assert.equal(reads,0);
});

test('unknown extensions are rejected and XLSX decompression guard remains in place',()=>{
  assert.throws(()=>validateExcelFile({name:'unsafe.zip',size:10}),/\.xls/);
  assert.equal(MAX_UNPACKED_XLSX_BYTES,500*1024*1024);
});
