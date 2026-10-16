// Original Excel files are parsed locally in the browser, never uploaded as-is.
// A separate decompressed-size limit protects Telegram WebViews from ZIP bombs.
export const MAX_EXCEL_BYTES=100*1024*1024;
export const MAX_UNPACKED_XLSX_BYTES=500*1024*1024;
export function validateExcelFile(file){
  if(!/\.xlsx?$/i.test(file?.name||''))throw Error('Выберите файл .xls или .xlsx.');
  if(!Number.isFinite(file?.size)||file.size>MAX_EXCEL_BYTES)throw Error('Excel должен быть не больше 100 МБ.');
}
