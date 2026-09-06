import { expect, test } from 'vitest'
import { Store } from '../src/store'
test('dbg3', () => {
  const store = new Store()
  store.createSession('sessB', '/path', 'title')
  let thrown = 0
  for (let i = 0; i < 25; i++) {
    try { store.activate(`WRONG${i}`.slice(0, 6).padEnd(6, 'X'), 'sessB', `ip_bf_${i}`); console.log(`i=${i} NO THROW`) }
    catch(e){ thrown++; const m=(e as Error).message; if(m!=='invalid code') console.log(`i=${i} threw: ${m}`) }
  }
  console.log('total thrown:', thrown)
  console.log('sessionFails:', JSON.stringify((store as any).sessionFails.get('sessB')))
  console.log('threshold:', (store as any).sessionFails.get('sessB')?.count, '>= 20 ?', ((store as any).sessionFails.get('sessB')?.count ?? 0) >= 20)
})
