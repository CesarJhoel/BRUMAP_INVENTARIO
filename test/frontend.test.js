import test from 'node:test';
import assert from 'node:assert/strict';
import {esc,formatDate,dateOnly,dateTime} from '../public/assets/js/utils.js';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';

test('los nombres y observaciones se escapan antes de insertarlos en HTML',()=>{
  const input='<img src=x onerror="alert(1)"> & \'datos\'';
  const escaped=esc(input);
  assert.doesNotMatch(escaped,/[<>]/);
  assert.match(escaped,/&lt;img/);assert.match(escaped,/&quot;/);assert.match(escaped,/&#39;/);
});
test('las fechas de planificación no cambian de día',()=>{
  assert.equal(formatDate('2026-10-09'),'09/10/2026');
  assert.match(dateOnly(),/^\d{4}-\d{2}-\d{2}$/);
  assert.match(dateTime(),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});
test('la hora local de Lima se conserva al consultar desde otra zona horaria',()=>{
  const file=new URL('../public/assets/js/utils.js',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {formatDate} from ${JSON.stringify(file)};console.log(formatDate('2026-10-09T08:30:00'));`],{env:{...process.env,TZ:'Europe/Madrid'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/08:30/);
});
test('la interfaz funciona sin scripts ni hojas de estilos externas',()=>{
  for(const name of ['index.html','panel.html']){
    const html=fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(html,/<script[^>]+src=["']https?:/);
    assert.doesNotMatch(html,/<link[^>]+href=["']https?:/);
    assert.doesNotMatch(html,/\son(?:click|submit|change)\s*=/);
    const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g)].map(match=>match[1]);
    for(const asset of assets)assert.equal(fs.existsSync(new URL('../public'+asset,import.meta.url)),true,asset);
  }
});
