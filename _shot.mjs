import { chromium } from 'playwright';import fs from 'fs';
fs.mkdirSync('_shots',{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto('http://localhost:5173/login',{waitUntil:'networkidle'});
await page.fill('input[placeholder*="admin or email"]','admin');await page.fill('input[placeholder*="password"]','admin123');
await page.click('button[type="submit"]');await page.waitForURL('**/dashboard',{timeout:8000});await page.waitForTimeout(1200);
const shots=[['gold','/dashboard'],['noir','/dashboard'],['black-white','/dashboard'],['snow','/projects'],['glass-dark','/dashboard'],['midnight','/projects'],['slate','/dashboard'],['sepia','/queries']];
for(const [th,p] of shots){
  await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),th);
  await page.goto('http://localhost:5173'+p,{waitUntil:'networkidle'}).catch(()=>{});await page.waitForTimeout(800);
  await page.screenshot({path:`_shots/${th}_${p.replace('/','')}.png`});
}
// custom combos
const cust=[['#3B82F6','gold'],['#8B5CF6','noir'],['#F97316','gold'],['#FFFFFF','noir']];
for(const [acc,base] of cust){
  await page.evaluate(({acc,base})=>{localStorage.setItem('fapoms_theme','custom');localStorage.setItem('fapoms_custom',JSON.stringify({base,accent:acc}));},{acc,base});
  await page.reload({waitUntil:'networkidle'}).catch(()=>{});await page.waitForTimeout(700);
  await page.goto('http://localhost:5173/dashboard',{waitUntil:'networkidle'}).catch(()=>{});await page.waitForTimeout(700);
  await page.screenshot({path:`_shots/custom_${base}_${acc.replace('#','')}_dashboard.png`});
}
console.log('saved');await browser.close();
